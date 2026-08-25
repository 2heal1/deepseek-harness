# 可配置 CLI agent 运行时交付 Roadmap

状态：active

最近更新：2026-08-25

设计方案：[中文](../notes/proposed/feature/2026-08-17-configurable-cli-agent-runtimes-and-gui.zh.md) | [English](../notes/proposed/feature/2026-08-17-configurable-cli-agent-runtimes-and-gui.md)

集成分支：`feat/configurable-cli`

远端状态：P0a、P0b、P0c 已合入 `fork/feat/configurable-cli`

## 使用规则

本文件是该功能的交付状态真源。工作包开始、PR 创建、评审状态变化、阻塞解除或合并后，负责该工作包的 agent 必须在同一分支更新对应行。`done` 表示所列完成判据已经随 PR 合入 `feat/configurable-cli`，而不是本地代码完成或 PR 已打开。

`PR` 列填写完整 GitHub URL；尚未创建 PR 时填写 `—`。`完成证据` 列在工作开始前记录必需判据，在完成后补充实际运行的检查、快照或集成证据。状态发生变化时，在文末更新记录中追加一行。

本文件只记录交付状态、依赖、分支、PR 和证据。架构范围、所有权、安全保证与取舍由设计方案负责；改变这些决策时必须同时更新 Agent Note，不能只修改 roadmap。

派发工作包时，让负责的 agent 阅读[工作包执行说明](configurable-cli-agent-runtimes-task.md)并指定一个 ID。执行说明负责通用的预检、分支、状态、验证和交付步骤；本文件负责该 ID 的范围、依赖、Agent 等级和完成判据。

## 分支与 PR 规则

`feat/configurable-cli` 以 `master` 的 `99f6f02fec` 为当前基线，是所有工作包的集成分支。每个工作包在其硬依赖合入该集成分支后，从最新的 `feat/configurable-cli` 创建独立工作分支，并把 PR base 设置为 `feat/configurable-cli`。V1 通过 I1 后，再从 `feat/configurable-cli` 向 `master` 创建最终 PR。

工作分支使用 `feat/configurable-cli-<id>-<slug>`，例如 `feat/configurable-cli-p0a-codex-spike`。不能使用 `feat/configurable-cli/<id>`：Git 已用 `feat/configurable-cli` 占据同名 ref，无法再在该 ref 下创建子路径。

一个工作分支只承载一个工作包。并行 agent 不共享工作分支；需要修改 `core/agent`、`agent-loop`、`core/session` 或 Host 关联语义的提交由主干所有者统一集成。依赖工作未合入集成分支前，后继工作不得用复制未合并代码的方式绕过依赖。

## 状态定义

| 状态 | 使用条件 |
| --- | --- |
| `not-started` | 硬依赖尚未满足，或尚无人开始实现 |
| `in-progress` | 已有 agent 在指定工作分支上实现，但尚未进入评审 |
| `in-review` | PR 已创建并进入评审；PR 列必须有完整 URL |
| `blocked` | 工作已开始，但存在无法在该工作包内解除的外部阻塞；更新记录必须写明原因 |
| `done` | PR 已合入 `feat/configurable-cli`，且完成证据已经记录 |
| `deferred` | 明确不属于当前 V1 集成范围 |

## 工作包状态

并行组相同只表示在共同依赖合入后可以并行，不表示可以提前开始。Agent 等级中的“高级”负责跨包生命周期、事件或安全决策；“中等”根据已冻结接口实现范围明确的 Provider 或产品切片；“较低”只承担已有精确输入、fixture 和预期输出的机械任务。

| ID | 工作包 | 硬依赖 | 并行组 | Agent 等级 | 状态 | 工作分支 | PR | 完成证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D0 | 设计方案与交付跟踪基线 | 无 | D0 | 高级 | `done` | `feat/configurable-cli-d0-design-roadmap` | [PR #1](https://github.com/2heal1/deepseek-harness/pull/1) | Agent Note 与 roadmap 通过 `doc-sync`、lint、提交钩子和增量 typecheck；PR 已合入集成分支 |
| P0a | Codex App Server 协议 Spike | D0 | P0 | 中等，高级评审 | `done` | `feat/configurable-cli-p0a-codex-spike` | [PR #3](https://github.com/2heal1/deepseek-harness/pull/3) | 0.147.0 握手、流、取消、错误与关闭 fixture；Codex 定向测试、`doc-sync`、lint、翻译配对与 `git diff --check` 通过；PR 已合入集成分支 |
| P0b | ACP 协议 Spike | D0 | P0 | 中等，高级评审 | `done` | `feat/configurable-cli-p0b-acp-spike` | [PR #2](https://github.com/2heal1/deepseek-harness/pull/2) | SDK 0.25.1／协议 v1 的一次性运行、取消、结构化错误和 EOF 关闭 fixture；官方 SDK 回放 5 项、ACP 单测 52 项、包级类型构建、lint、doc-sync 通过；PR 已合入集成分支 |
| P0c | Host、SDK、事件与威胁模型审计 | D0 | P0 | 高级 | `done` | `feat/configurable-cli-p0c-runtime-audit` | [PR #4](https://github.com/2heal1/deepseek-harness/pull/4) | [审计报告](configurable-cli-agent-runtimes-p0c-audit.md)：调用方行为矩阵、事件表、启动威胁模型与 P1 冻结输入；`doc-sync` 28 项、lint、`git diff --check` 通过；PR 已合入集成分支 |
| P1 | 架构冻结 | P0a、P0b、P0c | P1 | 高级主干所有者 | `in-progress` | `feat/configurable-cli-p1-architecture` | — | [P1 冻结约定](../notes/proposed/feature/2026-08-17-configurable-cli-agent-runtimes-and-gui.zh.md#p1-冻结约定)：Agent／submission、Router 生命周期、事件来源、snapshot／fork、错误迁移与安全启动；双语配对、`doc-sync` 28 项、lint 与 `git diff --check` 通过 |
| F1 | agent 运行时 Service Definition | P1 | F1 | 高级 | `not-started` | `feat/configurable-cli-f1-runtime-service` | — | 类型、Fake Provider、能力与失败测试、不变量配套工具 |
| F2 | Router 与 Native 提取 | F1 | F | 高级 | `not-started` | `feat/configurable-cli-f2-router-native` | — | Native 行为一致性、事务回滚、取消、资源释放与完全停稳测试 |
| F3 | Runtime Profile 与 subagent route | F1 | F | 中等，高级评审 | `not-started` | `feat/configurable-cli-f3-profiles-routes` | — | 校验、快照解析、凭据引用与容量测试 |
| F4 | 安全启动基础能力 | F1、P0c | F | 高级 | `not-started` | `feat/configurable-cli-f4-secure-launch` | — | 精确环境、保留参数、进程树、临时文件与 Windows Launcher 测试 |
| F5 | 会话事件与 Host API | F1、P0c | F | 高级 | `not-started` | `feat/configurable-cli-f5-events-host-api` | — | Projection、fork、来源、不支持能力与 API schema 测试 |
| D1 | Codex App Server Provider | P0a、F1、F4 | D | 中等，高级状态机评审 | `not-started` | `feat/configurable-cli-d1-codex-provider` | — | Fixture 一致性、背压、取消与失败清理 |
| D2 | ACP 一次性 Provider | P0b、F1、F4 | D | 中等，高级状态机评审 | `not-started` | `feat/configurable-cli-d2-acp-provider` | — | Fixture 一致性、一次性结果、取消与失败清理 |
| U1 | Profile、route 与能力 UI | F3、F5 | D | 中等；固定表单可交给较低 agent | `not-started` | `feat/configurable-cli-u1-runtime-ui` | — | 表单、探测、可信写入、禁用状态与 Client schema 测试 |
| M1 | 外部主 agent 垂直切片 | F2、F3、F5、D1 | M | 高级 | `not-started` | `feat/configurable-cli-m1-main-agent` | — | 创建、流、submit receipt、取消、活动与固定会话集成 |
| S1 | 运行时支持的一次性子 agent | F3、F4、D2 | M | 中等，高级评审 | `not-started` | `feat/configurable-cli-s1-child-agent` | — | Route 解析、容量、工作区、凭据隔离与一次性集成 |
| G1 | 每会话 MCP 网关 | M1、S1 | G | 高级安全所有者 | `not-started` | `feat/configurable-cli-g1-mcp-gateway` | — | 发现与执行器授权、审批、取消与审计测试 |
| G2 | Activity 与子 agent 树展示 | M1、S1、F5 | G | 中等；固定渲染 fixture 可交给较低 agent | `not-started` | `feat/configurable-cli-g2-activity-ui` | — | 按完整度展示活动、错误、进程与关系 |
| I1 | V1 组装发布 | G1、G2、U1 | I1 | 高级集成者 | `not-started` | `feat/configurable-cli-i1-integration` | — | 无密钥主 agent 到网关再到子 agent 的示例与快照、构建冒烟、Secret canary 测试 |
| R1 | Follow-up 与 interrupt | I1 | R | 高级 | `deferred` | `feat/configurable-cli-r1-followup` | — | 多轮接纳与取消竞态测试 |
| R2 | 冷恢复与可续接子 agent | R1 | R | 高级 | `deferred` | `feat/configurable-cli-r2-cold-resume` | — | 双 Host 重启、精确 profile 恢复、状态缺失失败与续接集成 |

## Agent 分配规则

P1、F1、F2、F4、F5、M1、G1、I1、R1 和 R2 必须由高级 coding agent 负责。高级 agent 还必须评审 Provider 的取消与背压状态机、产品审批映射、事件来源、沙箱声称、profile 固定、fork 行为和跨前端兼容性。

接口冻结后，中等 coding agent 可以负责 P0a、P0b、F3、D1、D2、S1、U1 和 G2。智能度较低的 coding agent 只适合包脚手架、codec golden fixture、schema 与类型再导出、固定 API Handler 接线、专用表单字段、禁用状态、快照更新、生成目录、机械 import、README 配对和错误矩阵扩充。

每个 agent 开始工作前必须在对应行把状态改为 `in-progress`，确认工作分支从最新集成分支创建，并在更新记录中登记。创建 PR 时改为 `in-review` 并填写 URL；PR 合入并补齐完成证据后改为 `done`。

## 更新记录

| 日期 | 工作包 | 变更 |
| --- | --- | --- |
| 2026-08-18 | D0 | 创建集成分支 `feat/configurable-cli`，fast-forward 到 `master` 的 `99f6f02fec` 并推送到 fork；创建 D0 工作分支；拆分交付 roadmap；设计与跟踪基线进入 `in-progress` |
| 2026-08-18 | D0 | [PR #1](https://github.com/2heal1/deepseek-harness/pull/1) 合入 `feat/configurable-cli`；记录文档、lint、提交钩子和增量 typecheck 证据；状态更新为 `done` |
| 2026-08-18 | P0a | 从最新 `feat/configurable-cli` 创建 `feat/configurable-cli-p0a-codex-spike`；Codex App Server 协议 Spike 进入 `in-progress` |
| 2026-08-18 | P0a | 固定 Codex App Server 0.147.0 的握手、assistant 流、interrupt、远端错误和 stdio 关闭 fixture，并通过定向测试与文档门禁；等待高级评审 |
| 2026-08-18 | P0a | [PR #3](https://github.com/2heal1/deepseek-harness/pull/3) 已创建；状态更新为 `in-review`，等待高级协议评审 |
| 2026-08-18 | P0b | 从最新 `fork/feat/configurable-cli` 创建 `feat/configurable-cli-p0b-acp-spike`；确认 D0 已合入且远端不存在同名工作分支；状态更新为 `in-progress` |
| 2026-08-18 | P0b | 完成 SDK 0.25.1／协议 v1 的四类 fixture、官方 SDK 回放测试与双语设计基线；最小充分测试、lint 和 doc-sync 通过，等待创建 Draft PR |
| 2026-08-18 | P0b | [PR #2](https://github.com/2heal1/deepseek-harness/pull/2) 已创建；状态更新为 `in-review`，等待高级协议评审 |
| 2026-08-20 | P0b | [PR #2](https://github.com/2heal1/deepseek-harness/pull/2) 合入 `feat/configurable-cli`；状态更新为 `done` |
| 2026-08-24 | P0c | 从最新 `fork/feat/configurable-cli` 创建 `feat/configurable-cli-p0c-runtime-audit`；确认 D0 已合入且远端不存在同名工作分支；状态更新为 `in-progress` |
| 2026-08-24 | P0c | 完成 Host／SDK 调用方行为矩阵、Session 与 live event 来源表、启动威胁模型及 P1 冻结输入；`doc-sync` 28 项、lint 与 `git diff --check` 通过，等待 Draft PR |
| 2026-08-24 | P0c | [PR #4](https://github.com/2heal1/deepseek-harness/pull/4) 已创建；状态更新为 `in-review`，等待高级架构评审 |
| 2026-08-25 | P0a | [PR #3](https://github.com/2heal1/deepseek-harness/pull/3) 已合入 `feat/configurable-cli`；状态更新为 `done` |
| 2026-08-25 | P0c | [PR #4](https://github.com/2heal1/deepseek-harness/pull/4) 已合入 `feat/configurable-cli`；状态更新为 `done` |
| 2026-08-25 | P1 | 从 `fork/feat/configurable-cli` 的 `41733d5d24` 创建 `feat/configurable-cli-p1-architecture`；确认 P0a、P0b、P0c 均已合入且远端不存在同名工作分支；状态更新为 `in-progress` |
| 2026-08-25 | P1 | 冻结 Agent 与 submission 行为、Router 事务、事件生产权、Runtime Profile snapshot、resume／fork identity、错误与调用方迁移以及 secure-launch 输入；等待文档门禁与 Draft PR |
| 2026-08-25 | P1 | 双语配对、`doc-sync` 28 项、lint 与 `git diff --check` 通过；等待创建 Draft PR 和高级架构评审 |
