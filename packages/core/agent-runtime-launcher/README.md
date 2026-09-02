# @deepseek-ai/dsh-agent-runtime-launcher

English | [中文](README.zh.md)

The shared secure process launcher for external Agent Runtime Providers. `AgentRuntimeLauncher` resolves each executable, constructs one exact child environment, creates launch-scoped private files and credential redaction, and owns deadline-driven process-tree teardown through `ctx.subprocess`.

## Service: `AgentRuntimeLauncher` (ctx key: `agentRuntimeLauncher`)

`launch(request)` accepts an immutable `RuntimeProfileSnapshot`, a Provider-owned Driver declaration, explicit stdio, a working directory, and a caller cancellation signal. It resolves current credential values through `ctx.agentRuntimeProfiles` for that process start, validates the complete launch before spawn, and returns an `AgentRuntimeLaunchHandle`.

The Driver declaration reserves protocol arguments and environment targets, supplies their injected values, identifies credential targets, opts into Windows command scripts when required, and states whether it fully enforces the profile permission policy. Profiles cannot write a reserved argument or environment target. A profile with required enforcement fails with `SECURITY_POLICY_UNSATISFIED` unless the trusted Driver declares full enforcement.

Executable resolution never invokes a shell. An absolute configured path is revalidated immediately before spawn; a bare executable resolves only through the profile's explicit search path and the absolute result is revalidated. On Windows, resolved `.exe` and `.com` files spawn directly. A Driver may opt into `.cmd` and `.bat` only through the shared `ComSpec /d /s /c` encoder, which rejects control characters, expansion markers, and command metacharacters in dynamic arguments.

## Environment and credentials

The child receives `envMode: exact`. Its complete environment contains only launcher-required operating-system entries, explicitly allowlisted non-secret process entries, profile literals, Driver-reserved values, and freshly resolved credentials. Environment names and duplicate writers are rejected; Windows comparisons are case-insensitive. Credential-shaped ambient names cannot be allowlisted.

The handle's `redact(value)` recursively replaces every non-empty resolved credential value in complete diagnostics. `KnownValueStreamRedactor` withholds possible credential prefixes across chunk boundaries. Providers must apply one of these redactors before diagnostics, retained output, events, or API data leave the launch; encoded or transformed credential values are not recognized.

## Temporary material and teardown

Optional authentication and protocol files are created exclusively as owner-only files inside a random owner-only directory under `temporaryRoot`. Non-secret `owner.json` metadata lets initialization remove stale owned directories whose recorded process is gone. Scavenging and cleanup unlink link-shaped run paths without following them.

`waitUntilReady()` applies the startup deadline, and `runTurn()` applies the turn deadline. Timeout or caller cancellation requests the Provider's protocol cancellation and input close hooks, waits through the shutdown deadline, invokes the subprocess Provider's process-tree termination, waits through the termination deadline, and removes temporary material only after the tree is quiescent. `dispose()` is idempotent and concurrent callers join one teardown.

Launch failures use `RUNTIME_UNAVAILABLE` or `SECURITY_POLICY_UNSATISFIED`; deadline failures use `START_TIMEOUT` or `TURN_TIMEOUT`. Incomplete rollback or teardown uses `DISPOSE_FAILED`, retains all observed causes after known-value redaction, and never reports successful cleanup.

## Configuration

`temporaryRoot` is an absolute installation-owned directory. It defaults to `runtime-launches` under the resolved DSH home.

## Invariants

The optional `@deepseek-ai/dsh-agent-runtime-launcher/invariant` companion is intentionally empty. Every process, deadline, redactor, and temporary directory belongs to one launch handle and is verified during its disposal.

## Model Experience

None, as the launcher contributes no model request content.

#### KV Cache effect

No direct invalidation; an external Runtime Provider owns any model request made by the launched process.

## Known Limitations and Deferred Work

- **Providers remain trusted protocol adapters** - the launcher validates a Driver's declarations but cannot prove that external product policy matches a declared `full` enforcement claim.
- **Known-value redaction is literal** - encoded, hashed, partially transformed, or externally emitted credential values remain outside the guarantee.
- **No external Provider ships in this package** - Codex App Server and ACP integrations consume this launcher in their owning Provider work packages.
