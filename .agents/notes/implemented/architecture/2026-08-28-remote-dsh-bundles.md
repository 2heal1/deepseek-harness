# Agent Note: Remote DSH Bundles use stable subscriptions and immutable builds

Status: implemented

English | [中文](2026-08-28-remote-dsh-bundles.zh.md)

## Problem

Profile Bundle delivery required pnpm installation from npm, Git, a tarball, or a filesystem path. That is workable for public packages but cumbersome when deployment-specific code must run on a cloud machine: publishing an npm package, configuring Git access, or copying a tarball turns one deployable configuration layer into an installation workflow. The runtime also had no URL form that could select the current published generation on the next process start. Browser-capable Bundles add another requirement: Node and browser code must consume the running application's Cordis and platform modules instead of creating incompatible copies.

## Decision

A `dsh.profile.bundles` item is either an installed package name or `{ "type": "remote", "name": string, "url": string }`. The URL is a stable HTTP(S) subscription manifest. `dsh plugin --profile <name> add name@https://…/dsh-bundle.json` validates that the manifest name matches and writes the remote item into the same ordered layer list; `remove <name>` removes it. Package arguments retain the existing pnpm behavior. A command containing both forms commits the remote items only after pnpm succeeds.

The version-one manifest identifies one immutable generation with `buildId` and relative patch, Node entry, and optional Web entry paths. App boot fetches the stable manifest once per process start, fetches its patch, resolves the declared shared peers from the DSH installation or active Profile, and loads the Node container. The container returns every module namespace named by the patch. App boot rewrites those names to process-local Loader builtins, after which the ordinary Loader owns configuration, dependency waiting, activation, and disposal. Cordis is a required shared peer with `import: false`, so every remote plugin uses the Host's singleton. A running process never polls or replaces the selected generation.

When the selected generation has a Web entry, the Web Profile's remote bridge serializes only its immutable descriptor into the page. The browser loads the remote entry and chunks directly from the publisher, initializes it with Cordis and other declared modules from the running client module system, and mounts the fixed `./client` export as an ordinary child plugin.

The protocol does not require a particular producer. A producer emits the stable manifest, immutable Node entry, optional Web entry, and patch described above. Module Federation is an implementation detail and contributes no user-facing identifier or configuration.

## Alternatives considered

- **Evaluate an arbitrary remote JavaScript URL**: a raw import has no data-only patch, shared-peer declaration, immutable generation identity, or browser half. It also makes every publisher invent its own bootstrap API. The small DSH manifest keeps remote delivery aligned with the existing Bundle layer model.
- **Download and install a package into the Profile**: this couples remote use to package-manager state, lifecycle scripts, lockfiles, and registry or Git credentials. A URL subscription is resolved before the tree mounts and leaves the Profile's package installation untouched.
- **Proxy browser assets through the DSH Node server**: proxying would add routing, cache, Content Security Policy, and streaming ownership without removing the browser's trust in publisher code. Direct access keeps deployment requirements visible and avoids moving bytes through DSH.
- **Expose Module Federation names in DSH configuration**: container names and exposed module keys are derived and fixed by the protocol. Exposing them would make an internal transport part of the product vocabulary without enabling a DSH use case.
- **Ship declarations from the runtime URL**: TypeScript consumes declarations before the runtime Profile starts and cannot learn module augmentation from a later HTTP fetch. The dual package artifact is the compile-time distribution.

## Consequences

- Package and remote Bundles are two delivery forms of the same ordered Profile layer; neither introduces a new runtime composition concept.
- A stable URL can select a new immutable build on a later process start without changing Profile configuration. Running processes and pages keep their selected build.
- Remote Node code contains non-peer runtime dependencies, while Cordis and declared peers come from the Host. Browser code consumes the running client module identities.
- Remote publication requires reachable ordinary HTTP(S) assets. HTTPS pages cannot consume HTTP entries, and every browser chunk must remain available at its immutable URL.
- The first browser build supports the Bundle's own `src/client/index.ts`. Remote builds reject dependency packages that declare `dsh.client`, because omitting those client halves would create an incomplete application; multi-client aggregation remains a separate design problem.
- This decision supersedes only the claim in the [Profile plugin Bundles note](2026-08-05-profile-plugin-bundles.md) that `dsh plugin` is solely a thin pnpm forwarder. Its Profile/Bundle distinction, ordered layers, and package resolution remain authoritative.
