# Agent Note: 可配置 CLI agent 运行时与 Codex 风格 GUI

[English](2026-08-17-configurable-cli-agent-runtimes-and-gui.md) | 中文

Status: proposed

## Problem

DeepSeek Harness 存在两种执行模型。主 agent（智能体）通过 `dsh-agent-loop` 安装的单一 `AgentFactory` 创建，而 [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md)按名称选择子提供方。现有 [Codex 和 Claude Code 提供方](../../implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.md)可以把官方产品进程作为一次性子 agent 运行，但它们没有提供可配置的外部主 agent、持久外部会话、中间活动，也没有为主执行与子执行提供统一配置模型。

当前 `Agent` API 也并非运行时无关。Web Host、ACP（Agent Client Protocol）、SDK 和 Headless 代码直接使用 inbox、`followup`、`steer`、模型选择和维护等原生 agent loop（智能体循环）概念。如果只用 Router 替换单例 Factory 而保留这些假设，外部运行时会在没有明确输入接纳、轮次关联、取消、能力报告和恢复语义的情况下看似兼容。

用户需要为主 agent 选择 coding agent（编程智能体）CLI（命令行界面），并为各条子 route 独立选择 CLI。每项选择都需要配置可执行文件、协议、模型、产品配置、工具、权限、环境、凭据引用、超时、容量、续接策略和兼容范围。Web Client 必须在不了解各产品协议的情况下展示对话和活动，也不能声称协议没有报告的事实。

仅启动任意命令不能满足要求。主运行时需要结构化流式输出、输入接纳、取消、进程所有权、活动和会话身份。Harness 不得主动把凭据序列化到设置、参数、事件、诊断或另一 agent 的环境。外部主 agent 还必须经过显式授权的桥接，才能调用 Harness 工具或委派给另一 CLI。

## Proposal

引入一项供主 agent 创建与运行时支持的子 route 共同使用的 agent 运行时能力 seam。DeepSeek Harness 继续负责 Harness 会话、profile 选择、凭据、公共生命周期事务、规范化持久化、进程策略和 GUI 状态。原生 `dsh-agent-loop`、兼容 Codex App Server 的 CLI、兼容 ACP 的 CLI 以及后续具有文档协议的 CLI 都成为同一 Router 后面的运行时提供方。

首个可用版本支持原生执行、兼容 Codex App Server 的流式主 agent、兼容 ACP 的一次性子 agent，以及每会话 MCP 网关。该版本不承诺冷恢复、可续接外部子 agent、通用 JSONL 执行、终端回放、跨会话进程池或桌面打包。

### P1 冻结约定

以下约定是 F1、F2、F4 和 F5 的实现输入。这些工作包可以增加私有辅助机制和提供方专用数据，但改变这些公共标识、所有权规则、事件生产者、持久化规则或安全保证时，必须再次更新决策。

#### Agent、submission 与能力

| 主题 | 冻结约定 |
| --- | --- |
| 必选 `Agent` | 暴露共享的 `SessionId`、`Session`、作用域 `Context`、已声明能力、`idle \| running` 调度状态、`submit`、定向 submission 取消和 `whenIdle`。创建调用方通过独立的 `AgentHandle` 获得 dispose 能力。`whenIdle` 仍是整个 agent 的完全停稳原语，绝不结算特定 submission。 |
| Submission 接纳 | `submit` 校验请求，分配品牌化 `SubmissionId` 和带标识的用户消息，追加 `agent/submission/accepted`，然后返回 receipt。在该追加之前发生的失败会拒绝操作且不返回 receipt；之后发生的失败会结算 receipt。接纳表示 Harness 已负责该工作，不表示外部模型已观察到消息。 |
| 启动关联 | Receipt 暴露启动 Promise。Router 分配轮次，并依次追加 `turn/start`、`agent/submission/started` 和规范 `user/message` 后完成该 Promise。排队期间被取消或随释放终止的 submission 以未启动结算，且不打开轮次。 |
| 终态关联 | Receipt 暴露唯一结算 Promise。对于已启动工作，Router 追加 `turn/end`，再追加 `agent/submission/settled`，然后以轮次、`TurnEndReason` 和终态事件序号完成 receipt。此时规范 assistant 事件已经追加并完成同步分发；持久化 flush 和 transport 输出队列仍由调用方负责。 |
| 取消竞态 | 取消以 `SubmissionId` 为目标、保持幂等，并返回它是否在终态结算前胜出。首个终态转换生效。Sink 关闭后观察到的提供方输出不能进入规范对话事件。Agent 释放会先用持久的 disposed cause 取消所有未结算 receipt，再返回。 |
| 调度状态 | `Agent.status` 保持 `idle \| running`：它回答已发布 agent 是否持有未结算工作。在 accepted 事件可见之前，接纳操作先把状态改为 `running`；只有 submission 与 maintenance 工作都不存在时，状态才恢复为 `idle`，`whenIdle` 观察同一边界。Profile 可用性和进程／协议阶段使用运行时事实，而不是增加 Agent 状态。失败的运行时会终结其 submission 并被释放；不可用 profile 不会发布 Agent。 |
| 可选能力 | 注册能力集为 `continuation`、`steering`、`queuedInputRead`、`queuedInputMutation`、`injection`、`maintenance`、`imageInput`、`modelOverride`、`approvals`、`runtimeActivity`、`harnessTools`、`resume` 和 `coldResume` 使用稳定 id。提供方 preparation 在发布前返回不可变的有效能力集；已保证的能力若丢失，运行时会失败，而不是改变该集合。能力专用 metadata 携带完整度或限制。空闲状态下的首次 submission、定向取消、规范 assistant 输出和结算是主运行时的必选能力。 |
| 执行约束 | 每个可选操作都在 Service 或 Host 执行边界检查已发布 Agent 的能力集。缺少能力时抛出 `AGENT_CAPABILITY_UNSUPPORTED`，并携带 agent id、能力 id 和 operation；UI 可见性绝不是授权。 |

#### Router 生命周期

Router 是唯一 `AgentFactory`，并执行一个覆盖回滚的事务：

1. 在创建运行时资源之前，解析并校验有效 profile、提供方注册、调用方覆盖项、会话 identity 和不可变快照。
2. 准备尚未发布的会话和 agent scope，再要求提供方返回包含不可变有效能力与初始规范化运行时事实的 prepared runtime 句柄。提供方可以分配协议与进程资源，但不能注册会话或 Agent、追加规范事件或接纳输入。
3. 运行调用方 setup 及其同步 publication commit。先 enter Session，再 enter Agent，announce `session/created`，通过 Router 追加初始 `agent/runtime/facts`，最后 announce `agent/created`。如果 runtime facts 追加失败，事务会在 announce Agent 前回滚已 announce 的 Session。只有返回的已发布 handle 可以接纳 submission。
4. 任何失败都会依次停止接纳、终结已接纳 submission、关闭提供方事件 sink、释放提供方并等待进程树完全停稳、展开 agent scope、detach Agent，最后 detach Session。任何已经开始的创建通知都会收到配对的释放通知。
5. 正常释放使用同一条 memoized 反向路径。它停止接纳并请求取消，只在所有活动 submission 结算或 graceful-shutdown deadline 到达前接收终态提供方输出，随后关闭 sink；如果 deadline 先到达，它会用持久的 disposed cause 终结所有剩余 receipt。最后，它通过最终进程树终止流程释放提供方，等待完全停稳，展开 scope 注册，发出 `agent/disposed`，再发出 `session/disposed`。重复或竞态释放等待同一个 Promise。

提供方只拥有其 prepared 句柄返回的资源，并且必须保证 `dispose` 幂等且完全停稳。Router 拥有 Session preparation、scope、registry publication、receipt 和全部回滚顺序。提供方卸载会在注册消失前 drain 它准备的每个句柄。

#### Durable 事件与来源

| 事件族 | 唯一生产者与规则 |
| --- | --- |
| `session/*`、`agent/created`、`agent/disposed`、`agent/status` | Session Store 和 Router 保留现有所有权。Router 包装层产生两态调度转换；提供方通过运行时事实报告进程阶段。 |
| `agent/submission/accepted`、`started`、`settled`；`turn/start`、`turn/end`；`user/message` | 仅由 Router 生产。Submission 事件携带 `SubmissionId` 和 `MessageId`；started 与 settled 记录携带已分配的轮次。未启动结算不携带轮次。 |
| `agent/runtime/facts` | 提供方只能通过 Router sink 报告事实。记录标识运行时和提供方，携带协商后的产品与协议版本、能力、安全的 external-session id 和 `starting \| ready \| running \| stopping \| stopped \| failed` 进程阶段，并标明每项事实来自 profile 或协议观察。 |
| `assistant/chunk`、`assistant/message` | 提供方只能通过 Router 为一个打开 submission 所有的事件 sink 写入。Native 记录包含步骤；外部记录省略步骤，并携带 `{ kind: "runtime", provider, source: "protocol" }` provenance。由 profile 得到的模型 identity 在运行时事实中使用 `source: "profile"`，而不作为 assistant 内容 provenance。 |
| `step/*`、`request/*`、`agent/pre-step`、`agent/request*`、`agent/turn-stopping`、`agent/inbox/*` | 仅属于 Native 运行时。F5 允许规范 user 和 assistant 事件直接出现在外部 open turn 中，不虚构 Harness 步骤。 |
| `tool/*` 与 `agent/runtime/activity` | 只有 Harness ToolRuntime 生产 `tool/call` 和 `tool/result`。提供方用运行时 activity 报告产品原生命令、工具、文件、diff、usage 和 status 观察结果，其中包含运行时 id、已知时的 submission id、kind、phase、`complete \| partial` 完整度以及有界且已脱敏的 JSON data。 |

`deriveMessages` 使用显式的规范事件 allowlist，并排除所有运行时事实与 activity 事件。运行时事件 sink 在追加前校验打开的 submission 与轮次、事件顺序、已声明的 activity 能力、JSON 上限、provenance 和脱敏。提供方绝不会获得不受限的 `Session.append` 权限。

F5 会改变 Session Header 和规范 assistant 事件表示，因此把 `SESSION_FORMAT_VERSION` 从 `0` 增加到 `1`；预发布 loader 会拒绝版本 `0`，而不是猜测 provenance 或运行时 identity。

#### 快照、恢复与 fork

每个新 Session Header 都包含一个不可变 `RuntimeProfileSnapshot`，其中包括 `schemaVersion`、`profileId`、Settings revision、provider id 与 provider-options version、executable 及 resolution policy、argument array、working-directory policy、model policy、product configuration、permissions 与 enforcement claim、native-tool policy、Harness-tool transport 与 allowlist、credential target 到 `CredentialRef` 的映射、process deadlines 及 capacity。在创建该快照前解析所有默认值和调用方覆盖项。快照不包含已解析 credential、生成的 gateway token、临时路径、process id、协商能力或 external-session id。

恢复只使用存储的快照。对应 Settings profile 可以已编辑或不存在。当提供方或快照 version 不兼容、运行时不具备 `resume`，或必需 product state／external identity 缺失时，恢复返回类型化错误；它绝不会选择当前默认值、创建替代 external identity 或回退到 Native。

普通 fork 按字节复制父会话的快照并记录普通会话 lineage，但排除协商事实和 external identity。Child 始终创建新的外部产品会话，并追加自己的运行时事实。New-from-transcript 操作可以解析不同 profile，但它会创建不带恢复语义的新会话，并展示为新 identity。

每次进程启动都从快照中的引用解析 credential。轮换会改变后续启动获得的值，但不修改快照；引用缺失时在创建进程前失败。

#### 错误与调用方迁移

运行时失败使用单一可序列化 `AgentRuntimeError`，包含稳定 code、phase、安全 message、可选提供方 id 和已脱敏的有界 details。冻结 code 为 `PROFILE_NOT_FOUND`、`PROFILE_INVALID`、`RUNTIME_UNAVAILABLE`、`RUNTIME_INCOMPATIBLE`、`AGENT_CAPABILITY_UNSUPPORTED`、`AGENT_BUSY`、`SUBMISSION_REJECTED`、`RESUME_UNSUPPORTED`、`EXTERNAL_STATE_MISSING`、`SECURITY_POLICY_UNSATISFIED`、`START_TIMEOUT`、`TURN_TIMEOUT`、`RUNTIME_FAILED` 和 `DISPOSE_FAILED`。创建、恢复、探测与接纳前失败会以该错误拒绝操作。接纳后失败会结算 receipt；对于已启动工作，`turn/end` 使用同一安全失败。取消是终态结果，不是 exception。`AgentHandle.dispose()` 会完成全部 teardown 与生命周期通知后再以 `DISPOSE_FAILED` 拒绝，因此清理失败不会遗留已发布 Agent，也不会取代更早的 submission 结果。

F1 增加运行时 Service Definition、identifier、receipt、capability、快照和错误类型，但不改变 active factory。F2 安装 Router 与 Native 提供方，并把 Native-only 行为移入能力。F5 将 Web Host、ACP Host、JSON-RPC SDK Server 与 Client 以及 Headless 原子迁移到 receipt，并移除它们对 inbox claim、`followup`、`steer` 或按消息猜测 `whenIdle` 的直接依赖。

Web RPC schema 在本预发布阶段同步更新。ACP 协议行为保持版本 1；ACP Host 把 receipt settlement 转换为现有 ACP 响应，并自行 flush 有序输出队列。JSON-RPC `serverInfo.version` 更新为 `0.0.2`；`session/prompt` 同时返回 message id 与 submission id，submission start 和 settlement 通知取代 inbox-splice 推断。旧 SDK Client 会因 version／schema 校验失败，而不会获得兼容模拟。Headless 等待 receipt settlement，随后只 flush 与其关联的会话区间。

#### 安全启动

F4 按以下规则实现供所有外部运行时使用的唯一 Launcher：

1. 不经 Shell 解析可执行文件。绝对路径在 spawn 前立即重新校验；裸名称只从启动策略的显式 search path 解析。失败绝不回退到其他可执行文件或 Native。
2. 从空映射构造子进程环境：Launcher 必需的操作系统条目、Driver 必需条目、显式 allowlist 中的非 secret ambient 环境键、profile literal，以及刚解析的 credential target。Windows key 比较不区分大小写。Ambient credential-shaped 环境键和所有 reserved key 即使列入 allowlist 也会被拒绝。
3. 每个 Driver 为 protocol mode、output mode、model、session、gateway、policy 和 credential 声明 reserved argument 与 environment key。只有 Driver-owned injection 可以写入它们；重复项或 profile 设置尝试在 spawn 前失败。V1 credential 只通过环境传入，绝不进入 argv。
4. Windows native executable 直接 spawn。Driver 只有通过共享的 `ComSpec /d /s /c` Launcher 才能选择 `.cmd` 或 `.bat`；其 encoder 拒绝动态 argument 中的 CR、LF、NUL、`%`、`!` 和命令元字符，并为带空格路径、引号、extension precedence 与拒绝行为提供原生 Windows fixture。Profile 不能提供 Shell command string。
5. 认证文件只能在随机 owner-only 目录中以 exclusive owner-only file 创建。Prepared 句柄在发布前记录不含 secret 的 cleanup metadata，在每条正常或回滚路径删除文件；启动 scavenger 会删除本安装拥有的 stale file，且不跟随 link。
6. 在任何提供方诊断到达 logger、错误、会话事件、API 响应或 retained output 前，安装 launch-scoped known-value redactor。它处理跨 stream 分片拆分的 value，并替换每个非空已解析 credential value；编码或转换后的 secret 不在保证范围内。
7. 执行快照中为正数的 startup、turn、graceful-shutdown 和 final-termination deadline。Timeout 会停止接纳，在可用时请求 protocol cancellation，关闭 protocol input，通过 subprocess process-tree terminator 逐级升级，等待 `waitForExit`，然后才完成 rollback 或 dispose。
8. Capacity 会一直占用到进程树完全停稳且临时材料清理完成。Cancellation 或 cleanup failure 会保留原 terminal reason，并独立报告 `DISPOSE_FAILED`；任何 success result 都不能隐藏未完成清理。

### 术语与所有权

| 术语 | 含义 | 所有者 |
| --- | --- | --- |
| Runtime Profile | 描述使用哪个可执行文件与策略的持久用户配置 | Settings 提供方；每个会话固定一份不含秘密的有效快照 |
| Runtime Provider | 知道如何启动并使用一种协议，且报告实际能力的代码 | Native、Codex App Server 或 ACP 提供方包 |
| `AgentFactoryRouter` | 选择提供方并负责公共创建、发布、回滚和资源释放的唯一 `ctx.agents` Factory | agent 运行时 Consumer |
| Runtime handle | Router 用来驱动一个已准备原生或外部运行时的提供方结果 | 选定提供方持有到资源释放 |

Router 不只是把请求转发给多个完整的 `AgentFactory` 实现。它负责公共的 `prepare -> create resources -> publish Session and Agent -> rollback on failure -> dispose` 事务。提供方准备协议专用的 Runtime handle，并清理由它创建的资源；它不会独立发布另一种 Harness `Agent` 解释。这样可以让原生与外部运行时共用一套生命周期，避免每个提供方复制 `agent-loop` 中最容易出错的状态机。

Service Definition 负责品牌化运行时、profile、submission 和外部会话标识，提供方注册、能力声明、运行时准备请求、规范化运行时事实以及类型化失败。提供方实现协议。Router 是 Consumer，负责解析固定的 profile 快照、协调公共生命周期工作，并向调用方暴露运行时无关的 `Agent`。

### 跨运行时 Agent 行为

公开 `Agent` 行为分为必选基线和声明式可选能力。必选基线暴露 Harness 会话与上下文、可观察的 `idle` 或 `running` 状态、返回稳定 submission receipt 的 `submit`、取消和 `whenIdle`。该 receipt 让 Host、ACP 和 SDK 代码可以用运行时无关的方式把已接纳输入与轮次完成关联起来。

可选能力包括续接、steering（中途引导）、排队输入查看或修改、图片、模型覆盖、审批、结构化产品活动、Harness 工具桥接和冷恢复。Native inbox 操作改为可选的原生接纳实现，而不是每个 `Agent` 的必选字段。Host 方法在执行边界检查能力，并返回类型化的不支持错误；GUI 隐藏或禁用控件只负责展示，不能代替执行时约束。

可供主 agent profile 选择的提供方必须支持输入接纳、可观察完成、取消或受管进程终止、assistant 输出，以及足以诚实持久化对话的轮次关联。`final-only` 提供方可以服务一次性子 agent，但不能出现在主 agent 选择器中。

Agent Preset 与 Runtime Profile 保持分离。原生执行继续消费 Preset 提供的 Harness 系统提示词和工具。只有外部提供方声明 `harnessComposition`，且能把每项模型可见提示词和工具忠实转换给外部产品时，才能接受 Preset。V1 外部 profile 拒绝非空 Agent Preset，改用显式产品配置和 Harness 工具白名单；CLI 未收到 Harness persona 时，UI 不得暗示它已生效。

### Runtime Profile、固定会话与 fork

Runtime Profile 包含公共字段和类型化提供方选项。公共字段涵盖 Driver、可执行文件和参数数组、工作目录策略、模型、产品 profile、非秘密环境、凭据引用、产品原生策略、Harness 工具白名单、启动和轮次超时以及容量。Driver 校验会保留协议、输出、工作目录、模型和凭据参数。持久化形式绝不包含插值后的 Shell 命令。

```yaml
agentRuntime:
  defaultMainProfile: coding-agent-main
  profiles:
    coding-agent-main:
      driver: codex-app-server
      launch:
        executable: coding-agent-cli
        args: [app-server, --stdio]
        cwdPolicy: session-workspace
        ambientEnv: []
      model:
        default: gpt-5
        allowSessionOverride: true
      cli:
        profile: work
        options:
          model_reasoning_effort: high
      permissions:
        sandbox: workspace-write
        enforcement: required
        approval: unattended-fail-closed
      nativeTools:
        allowed: [filesystem, shell, web]
      harnessTools:
        transport: mcp
        allowed: [subagent.acp-child, todo_write, plan]
      credentials:
        env:
          PROVIDER_API_KEY:
            credentialRef: CODING_AGENT_MAIN_KEY
      process:
        startupTimeoutMs: 15000
        shutdownTimeoutMs: 5000
        turnTimeoutMs: 1800000
        maxConcurrentRuns: 1
    acp-child:
      driver: acp
      launch:
        executable: acp-agent-cli
        args: [acp, serve]
        cwdPolicy: parent-workspace
        ambientEnv: []
      model:
        default: child-model
        allowSessionOverride: false
      permissions:
        sandbox: workspace-write
        enforcement: required
        approval: unattended-fail-closed
      nativeTools:
        allowed: [filesystem, shell]
      harnessTools:
        transport: none
        allowed: []
      credentials:
        env:
          CHILD_PROVIDER_API_KEY:
            credentialRef: CODING_AGENT_CHILD_KEY
      process:
        startupTimeoutMs: 15000
        shutdownTimeoutMs: 5000
        turnTimeoutMs: 900000
        maxConcurrentRuns: 3
subagentRoutes:
  acp-child:
    runtimeProfile: acp-child
    mode: one-shot
    maxDepth: 2
    maxConcurrentRuns: 3
    toolName: delegate_to_acp_child
```

Settings revision 是并发与审计标记，不是 profile 历史。创建会话时，Router 解析默认值，并在不可变会话元数据中存储完整且不含秘密的 `RuntimeProfileSnapshot`，其中包括凭据引用但不包括值。恢复时读取该快照，而不是当前已编辑的 profile。调用方传入冲突覆盖项、缺少提供方或记录的 Driver 不兼容时必须明确失败；系统不得静默启动原生执行或新的外部会话。

协商能力、产品版本、进程状态和安全的外部会话标识等创建后才获知的运行时事实，以会话事件追加。编辑 profile 只影响新会话。每次启动进程时重新解析凭据引用，因此 Key 轮换不需要改写历史数据。

普通 Harness fork 继承父会话固定的 Runtime Profile 快照，但会创建新的 Harness 会话和新的外部产品会话，绝不复用父会话的外部会话标识。显式“从 transcript（文本记录）新建会话”动作可以选择另一 profile，但它拥有新身份，不能展示为恢复。

### 协议与安全启动规则

V1 包含两个外部协议目标：供主 agent 垂直切片使用的 Codex App Server，以及供一次性子 agent 使用的 ACP。每个提供方固定经过测试的兼容范围，并负责握手、codec、流、错误、取消和关闭 fixture（测试前置数据）。名为 `app-server` 的命令或方法不能证明兼容性。系统绝不把终端文案解析成自动化协议。

运行时 Launcher 不经 Shell 解析可执行文件，校验保留参数和环境键，并根据 Driver 必需的操作系统条目、显式允许的非秘密条目、profile 值和刚解析的凭据，构造精确子进程环境。现有宽泛清理后的父环境无法满足该保证。Windows 可执行文件和 `.cmd` 的解析与引用属于这项启动约定，不能留到最后加固。

`CredentialRef` 使用 credentials 服务允许的 POSIX 环境标识符语法。Harness 绝不把已解析值写入参数、profile 快照、事件、API 响应或 Harness 自有诊断字段。持久化或向 API 发送数据前，系统从提供方错误和有界诊断输出中脱敏已知解析值。该保证覆盖 Harness 自有数据路径，但无法撤销可信外部 CLI 执行的任意文件、网络或终端副作用。

Harness permission preset 只约束 Harness 工具，不约束产品原生工具。仅当提供方可以把沙箱或审批策略映射成经过验证的产品策略，或受管进程由强制执行的沙箱包装时，profile 才能声称对应策略。无法满足 `enforcement: required` 时，加载或探测 profile 必须失败。V1 使用无人值守且失败时拒绝的策略禁用产品交互式审批；Harness 网关工具继续使用 Harness approval 服务。

subprocess 所有者观察整棵进程树，并提供有界启动、协议取消、宽限期升级、最终终止和完全停稳。启动回滚会移除进程、临时认证材料、网关注册、会话 Scope 和未发布 Agent。临时文件带有崩溃清理元数据，使下次 Host 启动时能够删除陈旧的自有文件。

### ACP 协议 Spike 基线

V1 ACP 子 agent 的兼容基线是 `@agentclientprotocol/sdk@0.25.1`、ACP 协议版本 `1`，通过 stdio 传输换行分隔的 JSON-RPC 2.0。Client 调用顺序为 `initialize` → `session/new` → 单次 `session/prompt`。assistant 文本通过有序 `session/update` 通知到达，`session/prompt` 响应只提供终止 `stopReason`。提供方必须校验协商得到的 `InitializeResponse.protocolVersion`，因为 SDK 接受任意整数响应，不会强制它与请求版本相等。

取消使用 `session/cancel` 通知。在未完成的 prompt 以 `stopReason: "cancelled"` 结算前，agent 仍可发送 `session/update` 通知，因此适配器会继续读取更新直至 prompt 结算；对于不协作的 agent，本地进程取消仍是权威机制。结构化 agent 失败是使请求 Promise 被拒绝的 JSON-RPC 错误响应，传输 EOF 则会独立拒绝未完成请求。两者都会在保留完整更新帧已经报告的 assistant 文本后成为提供方失败。

ACP 协议版本 1 仅在 agent 声明 `sessionCapabilities.close` 时提供可选的 `session/close` 方法；V1 一次性基线不要求该能力。因此，提供方关闭时会关闭 Client stdin、观察 agent stdout EOF 和连接关闭，再由 subprocess 所有者证明进程树完全停稳。带版本的 [fixture manifest](../../../../packages/subagent/subagent-acp/tests/fixtures/protocol-v1-sdk-0.25.1/manifest.json)和[官方 SDK 回放测试](../../../../packages/subagent/subagent-acp/tests/protocol-fixtures.spec.ts)固定一次性运行、取消、结构化错误和 EOF 关闭帧。

### 会话事实与来源

Session Log 继续作为 Harness 可见对话和活动的真源。运行时适配器只记录观察或协商得到的事实。规范 user、assistant 和 turn 事件表示对话事实；assistant 来源来自协商的协议数据，或者来自 Driver 明确规定为权威字段的固定 profile。无法满足规范 assistant 来源要求的提供方不能用于 V1 主 agent。

产品原生命令、工具、文件编辑和 diff 使用运行时自有活动事件。它们不能伪装成 Harness `tool/call` 或 `tool/result` 事件，也不能进入派生模型历史，因为 Harness 没有执行这些工具，并且可能不知道完整的模型可见输入。只有通过 Harness 网关调用的工具才使用正常 Harness ToolRuntime 事件和 render intent。

只有在关联 Harness turn 仍处于打开状态，且 Driver 能把完整产品决策集合映射为 Harness 决策时，外部审批才能映射到 Harness approval 服务。不完整映射必须在执行前失败。GUI 按声明的完整度渲染，绝不根据文案合成 token 用量、工具参数、diff、终端状态或模型请求。

### Subagent route 与 Harness 工具网关

现有具名 [`ctx.subagents`](../../implemented/feature/2026-06-21-subagent-capability-seam.md)注册表继续作为子 route 的权威。运行时支持的 route 是一个 Consumer：它解析 Runtime Profile，并注册 `SubagentProvider` 及其委派工具，而不是创建第二套路由器。V1 ACP 子 agent 使用现有一次性 `SubagentRun` 结果约定。可续接外部子 agent 必须等待公共接纳和冷恢复行为稳定。

仓库现有 MCP 支持是用于导入外部工具的 Client，因此外部 agent 调用 Harness 工具需要新增每会话 MCP Server 能力。发现和执行阶段都必须强制执行准确工具白名单、父级子集授权、工作区限制、委派深度、容量、取消和会话所有权。只过滤 schema 不能构成授权。

对于示例 profile，主 CLI 会发现 `delegate_to_acp_child`。调用进入 Harness subagent route，以子 agent 自己的快照和凭据引用启动 ACP 子 agent，记录父子关系，并返回一次性结果。两个进程都不会收到对方的凭据值。

Profile 与 route 容量取较小值。等待运行使用可取消的 FIFO 队列。常驻主进程在整个生命周期内占用 profile slot；一次性子 agent 占用一个 slot，直到进程树完全停稳。Route 容量不能提高所选 profile 的上限。

### API 与 GUI

现有三栏 Web Shell 继续作为首个 Client。Runtime Profile 与 Subagent Route 使用专用设置表单和探测诊断。会话创建页增加 Runtime Profile 选择器；现有对话标题栏与 Activity slot 展示进程状态、产品、模型、固定 profile、能力、活动和子 agent 关系。只有声明对应能力时才显示 diff、终端、图片、模型、steering、审批和恢复控件，同时 Host 方法独立执行相同检查。

Host 暴露类型化 profile 与 route CRUD、可执行文件与版本探测、能力诊断、会话运行时状态、取消和凭据状态 API。普通 Client 永远不能获得任意 Settings 访问权或凭据值。由于可执行文件路径、环境继承、产品原生工具和沙箱策略会授权代码执行，它们只能由可信本地或管理员控制平面写入。

Headless、ACP Host 和 SDK 适配器在公共 `submit` receipt 与能力行为冻结后迁移。这些适配器可以并行实现，但都不能通过增加传输层专用例外来恢复 Native inbox 语义。

### 包所有权

agent 运行时 Service Definition 负责提供方注册、品牌化标识、请求、能力和失败。Router Consumer 负责公共 Agent 生命周期事务。Native、Codex App Server 和 ACP 包提供运行时实现。独立的 profile/route、安全启动、会话事件和每会话工具网关能力，使配置、进程安全、持久化和工具执行可以分别测试。

现有 [`AgentRegistry`](../../../../packages/core/agent/src/index.ts)继续作为公开创建入口。现有 [`agent-loop`](../../../../packages/core/agent-loop/src/index.ts)不再安装注册表 Factory，而是贡献已准备的 Native Runtime。现有 [`subagent`](../../../../packages/subagent/subagent/src/types.ts)能力继续作为具名子 Router。改变 Agent 行为和 agent loop 生命周期时，同一实现变更必须更新 [`docs/architecture.md`](../../../../docs/architecture.md)以及所属子系统与包参考文档。

### 交付跟踪

实现状态、硬依赖、并行组、coding agent 等级、工作分支、PR URL 和完成证据记录在持续更新的[交付 roadmap](../../../roadmaps/configurable-cli-agent-runtimes.md)中。工作推进时可以只更新 roadmap，而不改写本设计决策；范围、所有权、持久化、事件或安全决策发生变化时，仍必须更新本 Agent Note。

## Alternatives considered

**让 Router 转发给提供方自有的完整 `AgentFactory` 实现。** 这种方式使初始提取更小，但会在每个提供方复制 Session 发布、回滚、取消和资源释放。Router 改为负责公共事务，提供方返回已准备 Runtime handle。

**把 `ctx.agents` 改成公开的多 Factory API。** 每个调用方都需要实现运行时选择和回退逻辑。保留唯一 Router 可以集中创建入口，而运行时无关 Agent 行为让调用方真正可移植。

**把 Settings revision 当作历史 profile 存储。** Settings 只保留当前文档和单调递增 revision，因此 revision 数字无法重建已编辑 profile。会话改为固定完整且不含秘密的有效快照。

**复用 Agent Preset 保存 CLI 进程配置。** Preset 描述 Harness 组合和模型可见输入。可执行文件、协议、凭据、超时和产品原生策略具有不同所有权；外部提供方只能通过显式的忠实组合能力消费 Preset。

**把产品原生工具记录成普通 Harness 工具事件。** 这些工具不是 Harness 选择或执行的，并且可能只暴露不完整参数或结果。运行时 Activity 事件既保留可观察性，也不会破坏 Harness 派生模型历史。

**在 V1 交付通用 JSONL 提供方。** 仓库没有能够确定其生命周期语义的代表性产品协议或 Consumer。此时增加它会形成缺乏支持的公开选项，因此后续必须先有另一项文档协议和 fixture 作为依据。

**运行任意 Shell 命令字符串或解析交互式终端。** Shell 字符串在不同平台产生引用与注入差异，终端文案也无法可靠表达生命周期事实。提供方使用可执行文件、参数数组和有文档的结构化协议。

**让外部 CLI 在 Harness 之外管理全部凭据和工具。** 产品原生配置仍有价值，但完全由外部管理会阻止每 agent 凭据隔离、Harness 委派、统一状态和可执行的网关策略。

**先构建桌面应用。** 桌面 Shell 不能解决运行时所有权、协议规范化或安全问题。现有 Web Shell 可以先验证 Service 与交互模型，再选择是否打包。

## Acceptance criteria

- 用户可以通过类型化 Settings 或 GUI 配置两个 V1 profile，且普通设置、会话元数据、参数和 API 响应都不存储凭据值。
- Native 与外部会话使用同一 `ctx.agents` 创建入口和 Agent 必选行为；可选操作不受支持时，在 Host 边界返回类型化能力错误。
- 兼容 Codex App Server 的主 profile 可以创建会话、流式输出 assistant 内容、接受有关联的输入、展示受支持活动、取消工作，并固定到完整且不含秘密的快照。
- 主 CLI 可以发现并调用 `delegate_to_acp_child`；ACP 子 agent 使用自己的可执行文件、模型、策略、工作区、容量和凭据引用，并返回一次性结果。
- 产品原生活动与 Harness 工具事件保持可区分，持久化对话来源不包含从终端文案虚构的事实。
- 编辑或删除源 Runtime Profile 不会改变现有会话；普通 fork、从 transcript 新建和恢复遵守声明的身份规则，并且不静默回退。
- 提供方和进程 Launcher 无法执行必需沙箱或审批声称时，校验或探测必须失败。
- 启动失败、握手失败、超时、取消、排队运行取消和 Host 资源释放后，不留下受管进程树、网关、会话 Scope 或临时认证文件。
- Canary 覆盖证明 Harness 自有事件、错误、诊断、工具结果、快照和 GUI 状态不含已知凭据值；每个进程只收到自己精确允许的环境。
- 可运行的无密钥示例和快照证明已配置外部主 agent 通过 MCP 委派给已配置外部一次性子 agent。
- 每个改变相关事实的实现包都同步更新架构、子系统、包 README、JSDoc、配置目录和双语文档。

## Risks

产品协议可能独立于 Harness 变化。明确兼容范围、版本探测、已记录 fixture 和快速失败诊断可以降低漂移风险，但无法承诺支持任意已安装版本。

部分协议只暴露有限的模型和工具活动。诚实展示完整度可能使 GUI 不如产品自有 Client 详细；Harness 不会通过解析文案或虚构规范事件来填补缺口。

外部恢复依赖 Harness Session Log 之外的产品自有状态。即使 Harness transcript 仍可读取，在 V1 后的恢复里程碑中，删除或移动该状态仍会导致恢复失败。

MCP 桥接与进程启动扩展了可信执行路径。远程控制要达到安全要求，必须具备执行器侧授权、父级子集权限、精确环境、可执行沙箱声称、仅本地管理员写入和 Secret canary 测试。

已知值脱敏可以限制意外持久化，但不是完整的数据防泄漏系统。可信外部 CLI 可以转换或传输凭据，也可以产生 Harness 无法撤销的文件系统和网络副作用。

每会话或每次运行一个进程比进程池消耗更多内存和启动时间。V1 为凭据、工作区、权限和故障隔离接受该成本；进程池需要另行决策。

本提案不保证不同 CLI 的功能完全一致，不复现产品隐藏提示词，不让产品原生工具自动服从 Harness permission preset，也不回滚外部 agent 执行的文件和命令副作用。
