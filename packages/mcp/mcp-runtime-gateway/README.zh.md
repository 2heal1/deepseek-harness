# @deepseek-ai/dsh-mcp-runtime-gateway

[English](README.md) | 中文

一个 loopback Streamable HTTP MCP Server，将 Runtime Profile 中精确允许的 Harness 工具暴露给单个外部 Agent Runtime。

## 服务

`AgentRuntimeMcpGateway.open()` 将 Agent、runtime id、Provider id 和工具白名单绑定到不可猜测的 URL 与 bearer token。每个 handle 拥有自己的 endpoint；`dispose()` 会撤销 endpoint、取消活动调用并等待调用结束。共享 listener 仅接受 POST 请求，并执行配置的请求与响应字节限制。

工具发现取 profile 白名单与当前 Agent scope 可见工具的交集。执行时会再次检查两者，要求 runtime 存在活动 submission 和 open turn，并携带所属 Agent 与取消信号调用 `ctx.tools.execute()`。因此，现有 approval、workspace、delegation depth、capacity 和工具策略插件继续作为权威执行者。

Token 是 launch-scoped secret。Provider 必须只通过 Launcher 中由 Driver 预留的 secret environment 传递它，不得持久化或记录。

## 审计

接受的调用会追加非 surface 的 `agent/runtime/tool-call` 和 `agent/runtime/tool-result` 事件。事件记录 runtime、Provider、submission、turn 和 call，但不会创建 Native Agent step，也不会把工具输出加入模型历史。

## 配置

`port` 默认为 `0`，由操作系统分配 loopback 端口。`maxRequestBytes` 默认为 1 MiB，`maxResponseBytes` 默认为 4 MiB。

## 模型体验

### 允许的 Harness 工具

#### 模型看到什么

外部 runtime 会发现 Runtime Profile 白名单中当前可见的每个工具，例如 `delegate_to_acp_child`，包括工具描述和 JSON 输入 schema。工具响应包含渲染后的文本或图片内容。

#### Token 影响

外部 runtime 根据其 MCP 实现承担允许工具的 schema 成本。本包不增加 Harness prompt 或 Harness LLM request token。

#### KV Cache 影响

本包不改变 Harness LLM cache 输入。外部 runtime 的 cache 复用取决于该产品处理 MCP 工具定义的方式。

## 已知限制与延期事项

- 网关仅支持 IPv4 loopback 上的 Streamable HTTP。
- Runtime resume 和可续接外部 child session 不属于本包。
