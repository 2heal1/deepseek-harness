# @deepseek-ai/dsh-agent-runtime-profile

[English](README.md) | 中文

由 Settings 支持的 Runtime Profile 解析服务，由 Agent Router 与运行时支持的 subagent route 共享。该服务校验一份完整的非秘密设置文档，并把每次新运行解析为不可变的 `RuntimeProfileSnapshot`。

## 服务：`AgentRuntimeProfiles`（ctx key：`agentRuntimeProfiles`）

插件配置是 `agent-runtime` Settings 命名空间的基础值。存在 `ctx.settings` 时，已保存的设置会替换该基础值，每份快照记录解析时观察到的命名空间 revision。没有 Settings 提供方时，基础值仍可使用，快照的 revision 为 `0`。

- `resolve(id?, overrides?)` 选择具名或默认 profile，应用允许的每会话值，并返回分离且深度冻结的快照。
- `resolveRoute(id)` 返回一条已配置的一次性 route，以及该次调用时解析出的 profile 快照。
- `listRoutes()` 按设置顺序返回当前 route id。
- `acquire(profile, signal, upperLimit?)` 按可取消 FIFO 顺序等待共享 profile 容量。route 限制可以降低但不能提高 profile 限制。
- `acquireSync(profile)` 服务于 Native 同步兼容入口，在没有立即可用的 slot 时以 `AGENT_BUSY` 失败，而不进入队列。
- `resolveCredentials(profile)` 在每次进程启动前立即解析各项凭据引用，并返回目标到值的映射，但不保留这些值。

编辑设置只影响后续解析。已经返回的快照不会观察到后续编辑或凭据值。快照保存的是引用而不是值，因此凭据轮换会影响下一次 `resolveCredentials()` 调用。

## 配置

`defaultMainProfile` 必须指向 `profiles` 中的一项。每个 profile 记录：

- Provider id、快照 schema version 和带版本的 Provider 自有 JSON 选项。
- 可执行文件、参数数组、解析策略、工作目录策略、环境继承名称和非秘密环境字面量。
- 默认模型以及是否允许 Session 覆盖。
- 产品配置、权限策略与执行要求、Native 和 Harness 工具白名单，以及凭据引用。
- 启动、轮次、关闭和终止 deadline，以及正数共享容量。

标识符以字母开头，并只使用小写字母、数字和连字符。环境目标使用 POSIX 环境变量名。JSON 自有字段必须无损往返；白名单只能包含互不重复的非空值；凭据环境目标与字面量环境目标不能重叠。运行时支持的 route 条目另外包含 profile id、工具名、深度限制和正数 route 容量。完整 schema 见生成的[配置目录](../../../docs/config-catalog.md#deepseek-aidsh-agent-runtime-profile)。

本包负责校验配置并解析策略输入；它不执行命令、不构造子进程环境、不执行沙箱，也不把快照持久化到 Session Header。这些职责分别属于[安全 Launcher](../agent-runtime-launcher/README.md)、Provider 和 Session 集成。

## 失败与所有权

缺失 profile 使用 `PROFILE_NOT_FOUND`。不允许的覆盖以及缺失的凭据服务或凭据值使用 `PROFILE_INVALID`。容量等待取消时会保留作为 signal reason 提供的 `Error`；Native 同步路径在没有立即可用的 slot 时使用 `AGENT_BUSY`。

容量租约归调用方所有，且释放操作幂等。调用方必须持有租约，直到运行时关闭与清理完全停稳，再调用 `release()`。Router 与运行时支持的 route Consumer 分别为各自运行执行该生命周期。

## 不变量

可选的 `@deepseek-ai/dsh-agent-runtime-profile/invariant` companion 有意为空。完整设置文档会在发布前校验，而快照与容量都是请求作用域值，没有可供扫描的权威全局关系。

## 模型体验

### 运行时选择

#### 模型看到的内容

本服务不直接增加文本。它解析出的 `RuntimeProfileSnapshot` 决定后续运行时与工具 Consumer 可以向模型请求加入哪些 Provider、模型、产品策略和工具白名单。

#### Token 影响

直接增加零 token。选择其他 profile 可能改变下游 Provider、模型上下文或可用工具。

#### KV Cache 影响

本服务不构造请求。不同快照可能让下游选择具有不同前缀的请求内容；已解析的快照保持不变。

## 已知限制和延后工作

- **快照尚未成为持久 Session 身份** - F5 会把完整的非秘密快照持久化到 Session Header，并定义 resume 与 fork 行为。
- **启动策略仅是数据** - 安全 Launcher 负责解析可执行文件、构造精确环境、保护 reserved control、管理进程树 teardown 并提供 known-value 脱敏；选定的 Provider 提供协议行为和它所声明的 sandbox 机制。
- **凭据值有意保持临时性** - 调用方取得供一次进程启动使用的解析值；本服务在返回后不会缓存、持久化或脱敏这些值。
