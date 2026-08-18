# 可配置 CLI agent 运行时工作包执行说明

本文件定义可配置 CLI agent 运行时 roadmap 中单个工作包的执行流程。派工时只需指定工作包 ID，例如：

> 阅读 `.agents/roadmaps/configurable-cli-agent-runtimes-task.md`，完成 ID `P0a` 任务。

任务消息必须指定且只指定一个 roadmap ID。ID 不存在、重复领取或范围不明确时，停止并报告，不自行选择或合并工作包。

## 必读资料

执行前完整阅读以下文件：

1. 仓库根目录的 [AGENTS.md](../../AGENTS.md)。
2. [交付 roadmap](configurable-cli-agent-runtimes.md)。
3. roadmap 链接的中文 Agent Note；需要核对英文术语或配对内容时同时阅读英文 Agent Note。
4. 工作包涉及目录下的 `AGENTS.md`。
5. 修改 `packages/` 前阅读[架构说明](../../docs/architecture.md)；涉及生命周期、并发、subprocess 或 teardown 时同时阅读[防御性模式](../../docs/defensive-patterns.md)。

## 开始条件

从 roadmap 中找到指定 ID，并以该行作为工作范围和完成判据。开始实现前必须确认：

- 所有硬依赖均已在最新的 `fork/feat/configurable-cli` 中标记为 `done`，对应 PR 已实际合入；依赖未满足时停止并报告。
- 当前 agent 符合该行的 Agent 等级；要求高级 agent 的工作包不能降级执行，要求高级评审的工作包不能省略该评审。
- 指定工作分支从最新的 `feat/configurable-cli` 创建或更新，且没有承载其他工作包。
- 该 ID 没有被其他 agent 领取；并行组相同不代表可以在依赖合入前开始。

开始工作时，将对应行改为 `in-progress`，保留完成判据，在更新记录中登记工作分支和开始状态。只用本机 `git` 处理分支、提交与推送，不使用 `gh`。

## 实现范围

只实现指定 ID，不顺带实现后继工作包，也不复制尚未合入的依赖代码。需要修改 `core/agent`、`agent-loop`、`core/session` 或 Host 关联语义时，由 roadmap 指定的高级主干所有者统一处理跨包设计与集成。

Agent Note 是架构决策的权威来源。实现若要求改变运行时所有权、Agent 行为、事件来源、持久化、安全保证或其他已记录决定，先停止并报告；获得明确决定后，在同一 PR 中更新中英文 Agent Note 及配对记录，不能只修改 roadmap 或代码。

智能度较低的 agent 只能承担已经给出精确输入、fixture 和预期输出的机械子任务，不能独立改变状态机、生命周期、权限、安全、事件或持久化语义。工作包负责人对这些子任务的范围、复核和完成证据负责。

## 验证与交付

实现、文档和测试必须共同满足 roadmap 的完成证据，并遵守适用的仓库门禁。推送前使用 [dsh-pre-push-checks](../skills/dsh-pre-push-checks/SKILL.md) 选择最小充分检查，并运行 `git diff --check`；只报告实际运行的命令和结果。

推送 roadmap 指定的工作分支，并创建以 `feat/configurable-cli` 为 base 的 Draft PR。优先使用可用的 GitHub 集成；如果当前任务没有 PR 创建能力，输出完整 compare URL，等待用户创建，不能把尚未存在的 PR 记录为 `in-review`。

PR 创建后，将对应行改为 `in-review`，填写完整 PR URL，并在更新记录中追加状态变化。PR 合入 `feat/configurable-cli` 且实际完成证据已经记录后，负责集成的 agent 将状态改为 `done`。未经用户明确要求，不自行合并 PR。

## 完成报告

最终报告必须包含：

- 工作包 ID、分支和当前 roadmap 状态；
- 实现范围及明确未包含的后继范围；
- commit 和完整 PR 或 compare URL；
- 实际运行的检查及结果；
- 未解决风险、阻塞和需要的高级评审。
