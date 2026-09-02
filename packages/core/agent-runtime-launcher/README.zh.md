# @deepseek-ai/dsh-agent-runtime-launcher

[English](README.md) | 中文

供外部 Agent Runtime Provider 共用的安全进程 Launcher。`AgentRuntimeLauncher` 解析每个可执行文件、构造精确子进程环境、创建启动作用域的私有文件与凭据脱敏，并通过 `ctx.subprocess` 负责由 deadline 驱动的进程树 teardown。

## 服务：`AgentRuntimeLauncher`（ctx key：`agentRuntimeLauncher`）

`launch(request)` 接受不可变的 `RuntimeProfileSnapshot`、Provider 自有的 Driver 声明、显式 stdio、工作目录和调用方取消 signal。它通过 `ctx.agentRuntimeProfiles` 为本次进程启动解析当前凭据值，在 spawn 前校验完整启动配置，并返回 `AgentRuntimeLaunchHandle`。

Driver 声明会保留协议参数与环境目标、提供相应注入值、标识凭据目标、按需选择 Windows command script，并声明是否完整执行 profile 权限策略。Profile 不能写入 reserved argument 或 environment target。要求强制执行的 profile 只有在可信 Driver 声明完整执行时才能启动，否则以 `SECURITY_POLICY_UNSATISFIED` 失败。

可执行文件解析绝不调用 Shell。配置的绝对路径会在 spawn 前立即重新校验；裸可执行文件只通过 profile 的显式 search path 解析，并重新校验解析所得的绝对路径。在 Windows 上，解析后的 `.exe` 和 `.com` 文件直接 spawn。Driver 只能通过共享的 `ComSpec /d /s /c` encoder 选择 `.cmd` 和 `.bat`；该 encoder 拒绝动态参数中的控制字符、展开标记与命令元字符。

## 环境与凭据

子进程接收 `envMode: exact`。其完整环境仅包含 Launcher 必需的操作系统条目、显式 allowlist 中的非秘密 process 条目、profile literal、Driver reserved value 和刚解析的 credential。环境名称与重复写入者会被拒绝；Windows 比较不区分大小写。Credential-shaped ambient name 不能加入 allowlist。

句柄的 `redact(value)` 会在完整诊断中递归替换每个非空的已解析凭据值。`KnownValueStreamRedactor` 会跨 chunk 边界保留可能的凭据前缀。Provider 必须在诊断、retained output、事件或 API 数据离开本次启动前应用其中一种 redactor；编码或转换后的凭据值无法识别。

## 临时材料与 teardown

可选的认证和协议文件以 exclusive owner-only file 形式创建在 `temporaryRoot` 下的随机 owner-only 目录中。不含秘密的 `owner.json` metadata 让初始化过程能够删除所记录进程已经消失的陈旧自有目录。Scavenging 与 cleanup 会 unlink link-shaped run path，而不跟随链接。

`waitUntilReady()` 应用 startup deadline，`runTurn()` 应用 turn deadline。超时或调用方取消会请求 Provider 的协议取消与输入关闭 hook，等待 shutdown deadline，再调用 subprocess Provider 的进程树终止能力，等待 termination deadline，并仅在进程树完全停稳后删除临时材料。`dispose()` 保持幂等，并让并发调用方等待同一次 teardown。

启动失败使用 `RUNTIME_UNAVAILABLE` 或 `SECURITY_POLICY_UNSATISFIED`；deadline 失败使用 `START_TIMEOUT` 或 `TURN_TIMEOUT`。未完成的回滚或 teardown 使用 `DISPOSE_FAILED`，在 known-value 脱敏后保留所有已观察到的 cause，且绝不报告清理成功。

## 配置

`temporaryRoot` 是安装实例拥有的绝对目录，默认位于解析后的 DSH home 下的 `runtime-launches`。

## 不变量

可选的 `@deepseek-ai/dsh-agent-runtime-launcher/invariant` companion 有意为空。每个进程、deadline、redactor 与临时目录只属于一个 launch handle，并在其 disposal 期间完成验证。

## 模型体验

无，因为 Launcher 不会增加模型请求内容。

#### KV Cache 影响

不会直接失效；由外部 Runtime Provider 负责已启动进程发出的任何模型请求。

## 已知限制和延后工作

- **Provider 仍是可信协议适配器** - Launcher 校验 Driver 声明，但无法证明外部产品策略与声明的 `full` enforcement 一致。
- **Known-value 脱敏只匹配字面值** - 编码、哈希、部分转换或由外部系统发出的凭据值不在保证范围内。
- **本包不提供外部 Provider** - Codex App Server 与 ACP 集成会在各自的 Provider 工作包中消费该 Launcher。
