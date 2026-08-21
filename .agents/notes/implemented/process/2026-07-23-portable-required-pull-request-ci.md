# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) selects runner capacity from repository ownership. In `deepseek-ai/deepseek-harness`, the three required primary Node 24 jobs use the repo-restricted enterprise pool; in forks, the same jobs use standard `ubuntu-latest` with one outer gate worker and one inner coverage, snapshot, lint, or publication worker where applicable. Fork coverage runs as one unpartitioned worker because Vitest blob merging can discard coverage when the same source is transformed in multiple projects; canonical Linux and Windows jobs retain their measured process-local partition counts. The stable `all checks passed` aggregate uses standard `ubuntu-latest` unless the canonical repository's explicit self-hosted failover is active. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking checks; the independent native job uses the organization-owned Windows larger runner in the canonical repository and standard `windows-2025` with serial worker budgets in forks, without participating in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard `ubuntu-latest` jobs also retain Node 22.19, Node 26, the Python SDK unit suite, and the [release-shaped Linux x64 Python runtime validation](../testing/2026-08-12-required-python-runtime-pull-request-ci.md), while the serial references remain the complete unsharded cross-platform definitions.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; `windows node 24 / native complete` is deliberately absent. Branch protection continues to require `e2e` and `all checks passed`. Forks do not inherit organization-owned runner groups, so repository identity is the automatic portable fallback. An allocation failure inside the canonical repository still uses the explicit self-hosted switches from the [failover runbook](2026-07-26-ci-failover-runbook.md); repository identity cannot distinguish a temporarily unhealthy enterprise pool from a healthy one.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent completeness check, now provided by the self-hosted `vm-backup`/`dsh-win-ci` standby lanes on `master`; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Use standard capacity for the canonical repository's Linux primary jobs.** This removes its enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. Repository-sensitive selection keeps the canonical critical path on measured enterprise capacity while making the unchanged workflow runnable in forks.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Canonical-repository pull requests spend enterprise capacity on the Linux critical path while the Wine job keeps the required Windows verdict on standard Linux allocation. Fork pull requests trade latency for portability by running the same Linux commands with serial budgets on standard capacity. The independent native job follows the same ownership split for Windows without delaying or changing the aggregate. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Forks remain runnable without organization runner configuration. In the canonical repository, standard compatibility and required Wine jobs remain useful when enterprise allocation is degraded, but they do not make a blocked required Linux job green; responders use the separately proven self-hosted failover instead. Changing a pool definition's status alone is insufficient evidence that it can receive work.
