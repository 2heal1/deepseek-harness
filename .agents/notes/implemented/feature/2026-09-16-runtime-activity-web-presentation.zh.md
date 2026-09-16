# Agent Note: 运行时 Activity Web 展示

Status: implemented

[English](2026-09-16-runtime-activity-web-presentation.md) | 中文

## 问题

运行时事实和提供方原生活动是持久化 Session 事件，但 Chat 视图会有意将它们排除在模型对话之外。否则用户无法检查所选运行时的进程状态、已声明能力、观察到的产品活动或结构化失败。现有 subagent 目录提供关系树，但其 `running` 和 `inactive` 值是驻留状态观察结果，而不是持久化结果。

不同协议报告的细节程度不同。如果展示层解析文案，或补全缺失的命令参数、diff、用量、模型请求或终端结果，就会把未知信息变成虚假事实。当前连接错误也是瞬态信息，不得表示为持久化历史。

## 决策

`@deepseek-ai/dsh-client-ui-subagent` 注册 `activity` 会话 target 和会话作用域的 Activity 标签页。其带 key 的增量 builder 按持久化事件序列排列记录，并且只投影 `agent/runtime/facts`、`agent/runtime/activity`、错误 `turn/end` 和尚未启动即被拒绝的 `agent/submission/settled` 事件。

该标签页从现有 Session 摘要投影读取最新 `runtimeStatus`。它展示进程阶段、Provider 和运行时身份、带 `profile` 或 `protocol` 来源的可选产品与协议事实、可选外部 Session 身份和已声明能力。持久化记录保留每项提供方活动的 `complete` 或 `partial` 完整度，并且只显示其有界 JSON 数据。缺失字段保持缺失。Session 当前的 `lastAgentError` 显示在独立的瞬态区域中，绝不进入持久化记录。

现有递归页头目录继续作为关系视图。它通过携带确切 mode 的地址导航由 Session 支撑的 child，并保留既有驻留状态语义；Activity 不会根据目录状态或计时推断 child 结果。

Client fixture 提供确定性的运行时事实、partial 活动、结构化 submission 拒绝和 one-shot child，使组装 Web 组合无需模型或外部 CLI 即可运行标签页与关系树。

## 考虑过的替代方案

**把运行时行加入 Chat 或 Trajectory。** 未采用，因为 Chat 表示规范对话，而 Trajectory 表示请求和工具执行。提供方原生观察需要独立 target，以免伪装成 Harness 工具事件或模型可见内容。

**增加专用 Activity Host endpoint。** 未采用，因为每条持久化记录已经通过 Session 历史和实时事件传输到达，而当前运行时事实已使用 Session 摘要投影。第二个 endpoint 会重复排序和重连行为。

**根据文本或相邻事件推断更丰富的细节。** 未采用，因为提供方可能只报告 partial 活动，并且不一定公开模型输入、参数、diff、用量或终端状态。UI 改为保留已声明的完整度。

## 测试

包测试覆盖事件选择、非法匹配事件防御、增量排序、稀疏事实、全部进程阶段、完整度标签、持久化与瞬态失败、插件注册和逐文件 100% coverage。无密钥组装 Web 快照会启动已构建的 Client 图，并同时固定 Activity 记录和同一 Session 的 one-shot child 行。

## 结果

用户可以检查持久化运行时观察结果和结构化失败，而不会将它们与规范对话或 Harness 工具执行混淆。该视图仍适用于报告稀疏的提供方，但其细节仅限提供方发出的内容。当前进程事实可能比已加载的记录窗口更新，瞬态连接错误会在 Client 状态清除后消失。
