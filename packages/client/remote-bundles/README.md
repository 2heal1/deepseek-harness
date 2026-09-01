---
description: "Web-profile bridge that loads the browser half of selected remote DSH Bundles directly from their published URLs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-bundles

English | [中文](README.zh.md)

## Summary

`dsh-client-remote-bundles` connects Profile-level remote Bundle selection to the browser application. Its Host plugin places resolved browser descriptors in the generated page; its browser plugin loads each immutable remote entry directly from the published URL, supplies the running application's Cordis and client modules, and mounts the exported plugin in Profile order. It is delivery machinery and adds no model-visible content.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web Bundle mounts this bridge automatically. A user adds a remote Bundle to the Web Profile with the ordinary Profile command:

```sh
dsh plugin --profile web add private-map-tools@https://plugins.example.test/maps/dsh-bundle.json
dsh web
```

On startup, app boot resolves the subscription manifest and gives this bridge only the selected immutable browser build. The rendered page then requests that remote entry and its chunks directly from `plugins.example.test`; the DSH Node server does not proxy them.

Remote containers receive only the module identities listed in their validated manifest. Cordis is supplied from the running browser application, so the remote plugin mounts into the same service graph as installed client plugins.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host half injects the Profile remote registry, listens to the Web index injection event, and serializes `ctx.remoteBundles.web()` as `window.__DSH_REMOTE_BUNDLES__`. It remains idle when no remote Bundle is selected. The browser half inserts classic remote-entry scripts, initializes each container once per entry URL, builds a Module Federation share scope from `ctx.modules`, obtains the fixed `./client` export, and mounts it as a Cordis child plugin. Cordis lifecycle disposal therefore tears down the remote plugin with the rest of the Web tree.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host-side projection into the generated page |
| [`src/client/index.ts`](src/client/index.ts) | Direct script loading, Host share scope, and Cordis mount |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion; browser lifecycle tests own the dynamic relationship |

-----

<a id="further-exploration"></a>
## Further Exploration

- [Client module system](../modules/README.md) — supplies Host module identities to remote containers.
- [app-boot](../../boot/app-boot/README.md) — resolves remote manifests and Node halves.
- [Remote Bundle delivery decision](../../../.agents/notes/implemented/architecture/2026-08-28-remote-dsh-bundles.md) — protocol and direct-browser decision.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is browser and Host delivery machinery and only the loaded Bundle plugins can affect model input.

#### KV Cache effect

The bridge contributes no provider request content, so it does not affect cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Direct browser policy applies** — mixed-content policy, Content Security Policy, network routing, and published chunk availability can prevent loading before Cordis activation.
- **One client export per remote Bundle** — the container must expose the protocol's fixed `./client` module.
- **No live replacement** — a running page keeps its selected build; restart the Profile and reload the page to select another stable-manifest generation.

<a id="dev-note"></a>
### Dev Note

None.
