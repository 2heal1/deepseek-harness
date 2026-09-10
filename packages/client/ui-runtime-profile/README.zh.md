# @deepseek-ai/dsh-client-ui-runtime-profile

[English](README.md) | 中文

基于 Host 分层读取约定的浏览器 Runtime Profile 界面。每个 Client 都能读取安全的 `runtimeProfile.catalog` 投影，用于新建会话选择和固定 profile 标签。只有 loopback Client 会注册 Settings 分节，用于读取完整的非秘密文档、编辑 profile 与一次性 subagent route，以及探测 Provider。

## 会话选择

对话 hero 选择器列出每个 profile 的 id、Provider、可选模型、可用性和快照 schema 兼容性。不可用或不兼容的条目仍会显示，但不可选择。选择条目会携带显式 `runtimeProfile` 创建并打开新 Session；它绝不会改变已有 Session 的运行时。对话标题栏读取固定在该 Session Header 中的 profile id，因此后续 profile 编辑不会改写历史会话的标签。

## 可信编辑器

仅限 loopback 的 Settings 分节可编辑可执行文件解析、参数、工作目录策略、模型策略、权限、工具 allowlist、环境字面量、凭据引用、Provider 自有 JSON、进程 deadline、容量和一次性 route。凭据值绝不进入 Client 状态；编辑器只会收到每个引用的已配置、缺失或凭据服务不可用状态。

每次写入都携带最后加载的 Settings revision。冲突或完整文档校验失败时，草稿会保留并显示 Host 错误。Remove 操作会删除用户层条目：由组合基础层提供的条目会重新出现，而用户创建的条目会消失。Settings 提供方只读时，所有修改操作都会禁用。

Provider 探测独立于 Session 创建，报告产品／协议版本、能力、权限执行情况和安全的 Provider details。Provider 缺失和快照 schema 不兼容会在探测前禁用选择；Host 仍是每个创建与探测请求的权威。

`/client` 导出包括 `apply`、`RuntimeProfileController`、三个 slot 组件、对应注入面以及共享的 `RuntimeProfileState`。

## 模型体验

通过传给 `session.create` 的显式 `runtimeProfile` 间接影响模型；固定的 Runtime Profile 会选择下游 Provider、模型策略和工具策略，而本浏览器包不会贡献任何模型请求文本。

#### KV Cache 影响

选择其他 profile 会创建不同的 Session，并可能选择不同的下游请求前缀或 Provider cache；浏览器 UI 本身不组装请求。

## 已知限制与暂缓事项

- **不能原地切换运行时**——选择 profile 始终创建新 Session，因为已发布 Session 已经拥有不可变的 Runtime Profile 快照。
- **没有远程编辑器**——非 loopback Client 只能收到安全 catalog 字段；完整配置、凭据引用状态、写入与探测需要未来具备认证的管理控制平面。
- **不标识基础层所有权**——移除前，编辑器无法区分组合基础层条目与用户创建条目；移除后，Host 的有效文档会表明基础条目是否仍然存在。
