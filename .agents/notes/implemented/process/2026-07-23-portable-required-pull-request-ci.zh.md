# Agent Note: 拉取请求 CI 的可移植恢复边界

Status: implemented

[English](2026-07-23-portable-required-pull-request-ci.md) | 中文

## 问题

分配到组织自有运行器标签的拉取请求必需作业，在 GitHub 无法为这些池分配运行器时会持续排队。工作流本身有效，GitHub 标准托管作业仍能通过，但 `all checks passed` 始终无法启动，原本健康的拉取请求因此无法满足分支保护要求。

账单状态正常、运行器定义处于 `Ready` 状态以及较高的自动扩缩容上限，都不能证明指定的运行器池可以接收作业。必需的正确性检查需要预先明确一条可移植恢复路径，即使日常低延迟路径依赖仓库外部的运行器预配也不例外。

## 决策

[CI](../../../../.github/workflows/ci.yml) 根据仓库归属选择运行器容量。在 `deepseek-ai/deepseek-harness` 中，三项必需的主 Node 24 作业使用仅限本仓库的企业级运行器池；在 fork 中，同一批作业使用标准 `ubuntu-latest`，并在适用位置把外层门禁，以及内层覆盖率、快照、lint 或发布工作线程各限制为一个。稳定的 `all checks passed` 聚合流程使用标准 `ubuntu-latest`，除非规范仓库显式启用了自托管故障切换。必需的 Windows 作业在标准 `ubuntu-latest` 上通过 Wine 运行 Windows Node，覆盖阻断性检查；独立原生作业在规范仓库使用组织自有的 Windows 大型运行器，在 fork 中使用标准 `windows-2025` 和串行工作线程预算，且不参与聚合流程（[双 Windows 决策](2026-08-08-native-windows-pull-request-ci.md)）。标准 `ubuntu-latest` 作业还保留 Node 22.19、Node 26、Python SDK 单元测试套件与[发布形态的 Linux x64 Python 运行时验证](../testing/2026-08-12-required-python-runtime-pull-request-ci.md)，串行参考流程仍是完整且未分片的跨平台定义。

三项 Linux 主作业、Node 兼容性、Python SDK 单元测试套件、Python 运行时验证和 `windows node 24 / wine blocking` 继续作为 `all checks passed` 的依赖项；`windows node 24 / native complete` 被刻意排除。分支保护继续要求 `e2e` 和 `all checks passed`。fork 不会继承组织自有的运行器组，因此仓库身份就是自动可移植后备条件。规范仓库内部发生分配故障时，仍使用[故障切换手册](2026-07-26-ci-failover-runbook.md)中的显式自托管开关；仓库身份无法区分暂时不健康与健康的企业级运行器池。

当前主拓扑及其测量结果以[大型运行器决策](2026-07-22-evidence-based-larger-hosted-runners.md)为准。[跨平台串行参考流程](2026-07-21-serial-cross-platform-ci-reference.md)继续作为独立的标准托管完整性检查，手动大型运行器套件则保留规格比较，同时不扩大普通必需矩阵。

## 曾考虑的替代方案

**让规范仓库的 Linux 主作业使用标准容量。** 此方案消除了其企业级运行器分配依赖，但标准运行器上的完整作业反馈明显更慢，仍会遇到共享容量排队。按仓库选择运行器既让规范仓库的关键路径继续使用实测企业级容量，也让 fork 可以原样运行同一工作流。

**根据标称核心数选择企业规格。** 基准测试表明扩展效果不呈单调变化，设置耗时也存在波动，因此必需运行器池改由完整作业的精确测量结果选定。

**在容量不可用时跳过检查或降低其级别。** 这种方式通过丢弃证据而非执行仓库的必需约定来使状态变绿。

**在每台主机上使用同一工作线程策略。** 外层门禁并发与内层工具工作线程在 Linux、Windows 和标准运行器上的争用方式不同；按主机实测的上限可以避免新增核心反而拖慢执行。

## 后果

规范仓库的拉取请求会将企业级运行器容量用于 Linux 关键路径，而 Wine 作业让必需的 Windows 判定继续使用标准 Linux 运行器容量。fork 拉取请求以延迟换取可移植性，在标准容量上以串行预算运行相同的 Linux 命令。独立原生作业在 Windows 上遵循同一仓库归属拆分，不会延迟或改变聚合流程。一次针对确切分支头的实际运行会区分分支保护采用的命令与单独的诊断约定；排队延迟与每个作业从 `startedAt` 到 `completedAt` 的执行区间分开报告。

fork 无需组织运行器配置即可运行。在规范仓库中，企业级运行器分配能力下降时，标准兼容性作业与必需的 Wine 作业仍能提供有用证据，但无法让受阻的必需 Linux 作业变绿；响应者改用已经单独验证的自托管故障切换。仅改变运行器池定义的状态，不足以证明它可以接收作业。
