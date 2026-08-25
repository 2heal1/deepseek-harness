# P0c Host、SDK、事件与启动安全审计

状态：完成

审计基线：`feat/configurable-cli` 的 `4f47c75590ae748bfaf47d40a75a3454e4f11335`

设计依据：[可配置 CLI agent 运行时与 Codex 风格 GUI](../notes/proposed/feature/2026-08-17-configurable-cli-agent-runtimes-and-gui.zh.md)

## 范围

本审计覆盖 `AgentRegistry` 与 `Agent` 公共 API、Web Host `apiproxy`、ACP Host、JSON-RPC SDK Server、Headless runner、Session Log 与 fork，以及现有 credentials、launch environment、subprocess 和外部 product subagent 实现。它记录 P1 必须冻结的接口与所有权问题，不实现 P1、F1、F4 或 F5。

当前唯一公开创建入口是 `ctx.agents.create()`／`resume()`，但 `AgentFactory` 由 `agent-loop` 安装，且公开 `Agent` 直接暴露 Native loop 的 inbox、step steering、maintenance 和 whole-agent idle 语义。四个 Host／SDK 调用方因此不是 runtime-neutral。

## 调用方行为矩阵

| 调用方与操作 | 当前依赖 | 当前完成或关联依据 | Runtime-neutral 基线 | 可选能力或迁移要求 |
| --- | --- | --- | --- | --- |
| Web Host 创建／恢复 | `ctx.agents.create()`／`resume()`；按 `AgentPreset` 组装 `setup`；从 Session Header 和日志恢复 preset | Factory 返回已发布 `AgentHandle`；失败映射为 Host RPC error | 保留 `AgentRegistry` 入口；Router 解析并固定 Runtime Profile，统一执行 prepare、scope setup、publish、rollback 和 dispose | `resume` 仅在 profile 与 Provider 声明支持时可用；缺失或不兼容必须返回类型化错误 |
| Web Host fork | 复制到完整 `turn/end` 的事件前缀，创建新 Agent，并继承 `cwd` 与 `agentPreset` | 新 Session 创建成功即返回；外部产品身份不存在 | 子 Session 继承父级完整非 secret Runtime Profile snapshot | 必须创建新的 external session identity；不得复用父级 external id；Provider 不支持从 transcript 启动时明确失败 |
| Web Host 普通 prompt | `agent.followup(message)` | RPC 只返回 `{ accepted: true }`；后续通过 Session event 和 `agent/status` 观察 | `submit()` 返回稳定 receipt，至少关联 submission、message 和最终 Harness turn | 图片、模型选择与 prompt 内容能力在 Host 入口独立校验 |
| Web Host steer | `agent.steer(message)` | 调用成功即 accepted；没有 submission settlement | 与普通提交共用 receipt | `steer` 是可选能力；未声明时返回类型化 capability error |
| Web Host 队列展示／编辑／取消／转 steer | 直接读取 `agent.inbox.nextTurn`／`nextStep`，调用 `replace()`／`remove()`，并以 `agent.status === 'running'` 判断转 steer | `agent/inbox/spliced` 重建 UI queue；Native inbox 是权威 | Agent 必选接口不得暴露 Native inbox | 队列查看与变更是一组 Native 可选能力；Host 和 UI 都按 capability 禁用，Host 仍需强制校验 |
| Web Host 取消 | `agent.cancel({ kind: 'user' }, { keepInbox: true })` | 只确认请求已接受；状态与 `turn/end` 异步到达 | 必选的当前工作取消操作，语义覆盖本次活动并保持幂等 | `keepInbox` 依赖 Native queue，应移入可选 queue capability 或由 Router 明确定义 |
| Web Host 状态与事件流 | `agent.status`、`agent/status`、`agent/error`、全量 `session/event` | `running` 是 whole-agent 状态，不标识具体 submission | 公共状态必须能表达 idle、starting、running、stopping、failed／unavailable 中 P1 选定的最小集合，并与 receipt 独立 | product activity、fidelity、process state 和 negotiated capabilities 使用独立 runtime 事件／projection |
| ACP Host `session/new` | `ctx.agents.create()`，每个 ACP session 持有 `AgentHandle` | 创建完成后返回 session id | 继续通过 Router 创建并持有 disposer | ACP Host 的 provider/model 参数需迁移为 Runtime Profile 选择或显式受支持覆盖 |
| ACP Host `session/prompt` | `followup()`；监听 `agent/inbox/claimed` 把 message id 关联到 turn；监听 `turn/end`、`agent/error`；最后等待 `whenIdle()` 和 output tail | 自建 in-flight 状态机把 Native inbox claim、turn end、whole-agent idle 和输出发送拼成精确 settlement | 直接消费 `submit()` receipt 的 accepted、turn correlation 和 terminal result | 不得要求外部 runtime 产生 `agent/inbox/claimed`；ACP 输出转换完成仍由 bridge 自己等待 |
| ACP Host cancel／shutdown | `agent.cancel()`；`whenIdle()`；再释放 continuable children 与 `AgentHandle` | cancel 可在附件 admission 前发生；shutdown 等 whole-agent 与输出队列停稳 | receipt 取消与 Agent dispose 分离；Router disposer 保证 runtime、scope 和 Session 停稳 | admission cancellation 仍属 ACP transport；continuable child drain 保持独立所有权 |
| JSON-RPC SDK `session/prompt` | `followup()` | 立即返回 message id，不关联 turn，也不提供 terminal settlement | 返回或另行暴露 common submit receipt | SDK protocol 需要兼容性决策；不能继续用 `agent/status` 猜某条 prompt 的完成 |
| JSON-RPC SDK 通知 | 转发全部 `session/event`；把 `agent/status` 转成 `session.status` | 全局 firehose，没有 runtime capability 或 submission id | Session event 继续是 durable truth；状态通知来自公共 Agent 状态 | SDK schema 必须新增 runtime/profile/capability 与 submission correlation，或显式版本化 |
| Headless one-shot | 创建 Agent，先 `whenIdle()`，记录 seq，`followup()`，再 `whenIdle()`，扫描最后 assistant 与 `turn/end` | 假设此 Agent 没有无关替代工作；seq 区间不等于 submission identity | 等待 receipt terminal result，再 flush receipt 对应的 Session 区间 | Headless 只需 baseline submit/cancel；不应依赖 inbox、steer 或 whole-agent idle |

## 事件表

事件分成 durable Session Log 与 process-local live bus。P1 必须为每类事件指定唯一生产所有者；Provider 不得为了兼容现有消费者而仿造 Native loop 事件。

| 事件或事件族 | 当前生产者 | 主要消费者 | 当前语义 | P1 所需归属 |
| --- | --- | --- | --- | --- |
| `session/created`、`session/disposed` | Session store，经当前 `agent-loop` Factory 生命周期调用 | Host、SDK、registry 观察者 | Session 的公开与移除 | Router 的公共事务触发，Session store 保持事件实现所有者 |
| `agent/created`、`agent/disposed` | 当前 `agent-loop` Factory | registry、Host 及 scoped lifecycle 消费者 | Agent 注册表生命周期 | Router 在 prepared runtime 与 scope 完成后统一发布；回滚保持成对通知 |
| `agent/status` | Native `AgentLoop` | Web Host、SDK、compaction、schedule、goal 等 | `idle`／`running` whole-agent driver 状态 | Router 公开 runtime-neutral 状态；Native-only 状态不能冒充所有 Provider 都可证明的事实 |
| `agent/error` | Native `AgentLoop` | ACP Host、Web Host、telemetry、goal | 带 Native turn／step 坐标的 live failure | 公共失败需要 runtime-neutral submission／runtime 坐标；现有事件可保留为 Native 扩展或被明确泛化 |
| `agent/inbox/inserted`、`claimed`、`discarded` | Native `AgentLoop` 的 `Inbox` 通知 | ACP Host、goal、subagent、jobs | Native 两级 inbox 生命周期 | Native-only；公共 submit receipt 取代 ACP Host 对 `claimed` 的依赖 |
| `agent/inbox/spliced` | `Inbox` 写入 Session Log | Web Host queue projection、SDK client | 两级 pending list 的 durable UI 状态 | Native queue capability 自有；不作为外部 runtime 必选事件 |
| `agent/session-start` | Native `AgentLoop` | context 注入与启动监听器 | Native Session lifecycle 开始，可调用 `inject()` | Native composition extension；Router 另行定义 Provider prepare/start，不要求外部 Provider 重放 |
| `agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping` | Native `AgentLoop` | prompt、routing、retry、goal 等插件 | Native model/tool loop extension points | Native-only；外部协议不得虚构 model request 或 step hook |
| `turn/start`、`turn/end` | Native `AgentLoop` 写入 Session | persistence、Host、ACP、stats、telemetry、SDK 等 | Harness 对话 turn 的规范边界和终止原因 | Router 分配 turn 与 submission correlation；Provider adapter 只能报告观察到的 terminal fact，最终 append 权限需在 P1 明确 |
| `user/message` | Native loop 在 step admission 后写入；其他插件可注入 | derived history、Host、persistence | 模型可见 user-role 输入 | Router 在 submission 被 runtime 接纳的明确时点写入，或定义可回滚 admission 规则；禁止仅因 RPC accepted 就假定模型已见 |
| `step/start`、`step/end`、`request/header`、`request/context` | Native `AgentLoop` | history、stats、title、telemetry、hooks | Harness LLM request 与工具 step | Native-only，除非外部 Provider 能提供等价且完整的 request 事实；不得从产品文案推导 |
| `assistant/chunk`、`assistant/message` | Native `AgentLoop` | Host、ACP、SDK、persistence、stats | 原始流和规范 assistant 消息 | Provider adapter 写入已观察的规范输出；必须带 P1 规定的 provenance，缺少可信来源的 Provider 不得作为 V1 main runtime |
| `tool/call`、`tool/result` | Harness ToolRuntime／Native loop | history、Host cards、telemetry、stats | Harness 实际选择并执行的模型工具 | 仅 Harness tool gateway 使用；product-native tool、command、file edit、diff 使用 runtime activity 事件 |
| runtime profile snapshot | 当前不存在 | resume、fork、Host/UI 将需要 | 会话没有可重建的 runtime 选择 | 创建时写入不可变 Session Header metadata；只含完整 effective config 与 `CredentialRef`，不含 secret 值 |
| negotiated runtime facts | 当前不存在 | Host/UI、诊断、resume 校验 | product version、capabilities、process state、external id 无规范记录 | 创建后追加 runtime-owned durable events；external id 必须是可安全持久化的 opaque id |
| runtime activity | 当前不存在 | Host/UI、telemetry | product-native 活动目前无法规范展示 | 新增与 Harness tool events 可区分的事件族，并声明 fidelity；不进入 derived model history |
| submission receipt settlement | 当前不存在 | ACP Host、SDK、Headless、Web Host | 各调用方自行拼接 message、turn、idle 和 output | Agent 公共行为直接提供稳定 receipt；事件携带或可查询 submission 到 turn 的关联 |

## 启动威胁模型

### 资产与信任边界

受保护资产包括 credential 值、Runtime Profile 配置、Harness Session Log、工作区文件、Harness tool 权限、外部 product session identity、Host 进程及其其他会话。可信代码包括本地管理员批准的 profile、Harness Router、Provider、secure launcher 和 subprocess provider；profile 名称与普通非特权选择可来自用户，但 executable、参数、环境继承、native tool 和 sandbox policy 是代码执行授权，只能由可信本地或管理员控制面写入。外部 CLI 及其协议输出按不可信进程输入处理，即使该 CLI 被用户允许执行。

### 现有可复用控制

- `SubprocessSpawnSpec.argv` 通过 `child_process.spawn(program, args, { shell: false })` 语义启动，不解释 shell command string。
- `resolveExecutable()` 拒绝含分隔符的相对路径，验证绝对文件，并按平台 `PATH`／`PATHEXT` 查找裸命令。
- subprocess 默认移除 credential-shaped 和全部 ambient `DSH_*` 环境键，显式 `env` 在清理后覆盖。
- 本地 subprocess 在 POSIX 使用 detached process group，在 Windows 使用 `taskkill /T`，并提供 TERM、grace、KILL 和 `waitForExit()` 的 whole-tree 生命周期。
- `CredentialRef` 只接受 POSIX identifier；credential provider 按操作重新解析值，并用 owner-only 文件、原子写入和分层来源管理本地 secret。
- Codex 与 ACP one-shot Provider 已证明协议握手、取消、进程回收和固定安全诊断的局部实现模式。

这些控制是 F4 的基础，但当前 scrubbed parent environment 仍保留 `PATH`、`HOME`、locale、proxy 等大量 ambient 值，不能满足设计要求的精确环境。

### 威胁与必需控制

| 威胁 | 失败后果 | 现状 | F4／Provider 必需控制与证据 |
| --- | --- | --- | --- |
| shell 与参数注入 | 执行 profile 未授权的命令或改变协议模式 | subprocess 使用 argv，无 shell；profile 可自由提供 args | secure launcher 只接受 executable + argv；Driver 声明并拒绝 reserved args、重复控制项和 secret 参数；测试元字符保持逐字参数 |
| PATH 劫持与 executable 替换 | 启动错误二进制 | 可验证绝对路径或搜索 scrubbed PATH；验证与 spawn 分离 | profile 固定解析策略与 probe 结果；启动前重新解析或使用已验证绝对路径；错误不得静默回退；覆盖 symlink／替换竞态的可接受范围 |
| Windows `.cmd`／扩展名与引用差异 | 解析失败、隐式 shell 或参数重解释 | `PATHEXT` 会找到 `.BAT`／`.CMD`，普通 spawn 没有独立 Launcher 约定 | 明确 `.exe` 与 `.cmd` 启动路径、引用规则和允许的解释器；原生 Windows 测试包含空格、引号、`&|%` 和扩展名优先级 |
| ambient environment 泄漏 | 子进程得到其他 Provider、会话或 Host secret／identity | 启发式 scrub，显式 env 可重新加入任意键 | 从空白策略构造 exact env：Driver 必需 OS 键、显式 allowlist、profile 非 secret 值和本次 credential；大小写折叠后校验 reserved keys |
| reserved env 覆盖 | profile 改写 gateway、session、协议或认证控制变量 | 无统一 reserved-key registry | Driver 声明保留键及来源；profile env 与 credential target 冲突在启动前失败；Windows 按大小写不敏感比较 |
| credential 持久化或串会话 | secret 进入 settings、argv、Session、API、日志，或传给错误 child | credentials seam 支持引用；当前 product configs 直接保存明文 `env` | profile 只保存 `CredentialRef`；每次启动重新解析；只注入目标进程；禁止 argv；跨 main/child canary 证明隔离 |
| error、stderr 与协议 payload 泄密 | secret 经诊断、事件或 GUI 外泄 | Codex 使用固定诊断，但 raw stderr 可写 Host stderr；无统一 redactor | 在 Provider error、bounded output、logger、Session append 和 API delivery 前对本次已知值脱敏；测试完整值、嵌入文本和多 secret；原始协议内容不得默认持久化 |
| cwd 混淆或目录越权 | 在错误 workspace 执行 | Session 保存绝对 cwd；部分 Provider 验证目录 | Router 从 Session snapshot 解析 cwd policy；Provider 不得回退 Host cwd；remote execution world 使用同一 FS/subprocess 语义 |
| 协议冒充与版本漂移 | 把任意输出当作受支持事实 | P0a/P0b 固定具体版本 fixture | Provider 校验 handshake、版本、关联 id、frame schema 和顺序；未知 request／terminal fail closed；绝不解析 terminal prose |
| 无界输出与背压 | Host 内存耗尽、事件队列阻塞 | subprocess collect 可限长；stdio protocol 为 raw pipes；Codex stderr 有局部 tail | codec 设置 frame、line、diagnostic 和 pending-request 上限；定义背压与 overflow failure；仅完整 frame 进入 adapter |
| 启动或 handshake 挂起 | 占用容量、阻止 teardown | subprocess 只响应 AbortSignal；Provider 局部逻辑没有统一 startup deadline | Router／secure launcher 拥有可配置 startup timeout；超时触发协议关闭、tree termination、waitForExit 和完整 rollback |
| 取消不合作与进程孤儿 | child 或 descendant 在 session 结束后继续运行 | subprocess 提供 tree escalation；Provider 各自拼 teardown | 公共 disposer 顺序为停止 admission、协议取消、grace、terminate、whole-tree wait；所有失败路径与 Host dispose 都验证完全停稳 |
| 半发布资源 | Session 已可见但 runtime、gateway 或 scope 不完整 | 当前 Agent Factory 有 unpublished setup 和 rollback；外部 runtime 尚未接入 | Router 单独拥有 prepare、resource creation、publication、rollback、dispose；Provider 只返回 prepared handle；通知保持成对 |
| 临时认证材料残留 | crash 后 secret 文件留存 | 当前 V1 Provider 未实现统一临时文件所有权 | owner-only 创建、最小生命周期、正常删除；记录不含 secret 的 cleanup metadata；下次 Host 启动清理 stale owned files |
| sandbox／approval 过度声称 | UI 显示受限但 product 实际可执行更高权限操作 | Codex one-shot 固定并验证部分 product policy；无通用证明 | 只有 verified product mapping 或 enforcing wrapper 可声明；`enforcement: required` 在 load/probe 失败；V1 product approval 无完整映射时 unattended fail closed |
| 跨会话 gateway 调用 | 外部 CLI 调用未授权工具或冒充另一 Session | per-session MCP server 尚不存在 | gateway token／endpoint 绑定 exact Session 与 process；发现和执行均校验 allowlist、parent subset、workspace、depth、capacity 和 cancellation |
| fork／resume 复用错误 external identity | 两个 Harness Session 操作同一 product state | 当前 Session 无 external id | resume 只读取固定 snapshot 与已记录 identity；fork 必须创建新 external identity；缺失 product state 明确失败，不回退 Native 或新会话 |

### 不在保证范围

已获授权的外部 CLI 可以读取其 workspace、访问其获准网络、转换 credential 后输出或执行不可回滚的文件与命令副作用。Known-value redaction 不是数据防泄漏系统，Harness permission preset 也不会自动约束 product-native tools；这些限制必须在 profile 和 UI 中准确表达。

## P1 冻结输入

P1 在 F1、F2、F4 和 F5 开始前必须接受或修订以下事项：

1. 定义 runtime-neutral `Agent` 必选行为：identity、Session、公共状态、`submit()` receipt、取消和 disposer；把 inbox、steer、maintenance、模型选择等放入显式可选能力。
2. 定义 receipt 的稳定 identity、accepted 时点、message／turn correlation、terminal reason、取消竞态与输出提交完成语义。`whenIdle()` 不能作为某次 submission 的替代。
3. 指定 Router 对 Session、scope、prepared runtime、registry publication、回滚和 dispose 的唯一顺序，以及每一步失败后的资源集合。
4. 为事件表中的公共、Native-only、Provider-owned 和 runtime activity 事件指定唯一生产者；明确 turn 编号与 canonical event append 权限。
5. 定义不可变 `RuntimeProfileSnapshot` 的 Session Header 字段、schema/version 影响、resume 校验、fork 继承和 external identity 新建规则。
6. 冻结 Host capability error taxonomy 与状态模型，并确定 Web Host、ACP Host、SDK 和 Headless 的迁移及协议版本策略。
7. 冻结 secure-launch 输入：exact environment allowlist、reserved args／env、credential target、known-value redaction、startup／shutdown deadlines、临时文件 ownership 和 Windows launcher 行为。
8. 冻结 runtime activity 与 provenance 最小字段、fidelity 声明，以及 product-native activity 不进入 Harness derived model history 的机械约束。

## 下游工作边界

F1 定义类型、能力和失败；F2 迁移 Router 与 Native runtime；F4 实现 secure launcher；F5 实现事件、projection、fork 与 Host API。P0c 不预先实现这些工作，也不改变现有 Agent Note 的运行时所有权、安全或持久化决定。
