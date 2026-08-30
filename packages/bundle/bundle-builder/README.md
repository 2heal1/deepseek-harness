---
description: "Convention-first DSH Bundle builder for installable package artifacts and URL-loadable Node and browser artifacts."
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-builder

English | [中文](README.zh.md)

## Summary

`dsh-bundle-builder` turns one Bundle source directory into an ordinary installable package, a URL-loadable remote artifact, or both. The default `dual` target writes both forms from the same `package.json`, `cordis.patch.yml`, and conventional source entries. Users see DSH Bundle concepts and stable HTTP URLs; Module Federation is an internal transport used to preserve the Host's Cordis identity while loading remote code.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the outputs](#understand-the-outputs)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Start with these files; no Builder configuration is required:

```text
my-bundle/
├── package.json
├── cordis.patch.yml
└── src/
    ├── index.ts
    └── client/index.ts   # optional browser plugin
```

The package must name itself, declare a version, and list `@deepseek-ai/cordis` as a peer dependency. The patch inserts the Node plugins that form the Bundle layer. When the patch inserts the Bundle package's own name, `src/index.ts` is its conventional implementation. Other package module names resolve from the project. Relative module names are rejected because their local file URL cannot identify the same module after remote publication; expose that code through the Bundle package or a dependency package instead.

### Build and validate

```sh
dsh-bundle lint
dsh-bundle build
dsh-bundle build --target package
dsh-bundle build --target remote
```

The default target is `dual`. Command-line `--target`, `--out-dir`, and `--build-id` values override `package.json` configuration. A remote build id defaults to a new UUID and may contain ASCII letters, digits, dots, underscores, and hyphens.

### Optional configuration

Use `dsh.bundleBuilder` only when the conventional paths do not fit:

```json
{
  "name": "private-map-tools",
  "version": "1.0.0",
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.0"
  },
  "dsh": {
    "bundleBuilder": {
      "target": "dual",
      "outDir": "dist",
      "patch": "cordis.patch.yml",
      "nodeEntry": "src/index.ts",
      "clientEntry": "src/client/index.ts",
      "modules": {
        "private-map-tools": "src/index.ts"
      }
    },
    "client": {
      "platform": "web",
      "inject": [],
      "external": []
    }
  }
}
```

`modules` maps patch module specifiers to project source files. It is unnecessary for the Bundle's own conventional entry and resolvable package dependencies.

### Serve a remote artifact locally

```sh
dsh-bundle serve --port 4173
```

The command builds the remote target, serves it with permissive CORS, prints the subscription URL, and marks the stable manifest as non-cacheable while marking build-id paths immutable. It is a development server, not a production publisher.

-----

<a id="understand-the-outputs"></a>
## Understand the outputs

The package artifact is written directly to `dist/`. It contains a normal `dsh.bundle` manifest, patch file, Node entry, declarations, and optional browser entry. Install or publish `dist/`, or use it from Git through the ordinary `dsh plugin add` path. It is an installable package rather than a single-file executable: package dependencies remain package-manager dependencies, while workspace peer ranges are converted to publishable version ranges. Rebuilding the package form replaces its files while preserving `dist/remote/`.

The remote artifact is written under `dist/remote/`:

```text
dist/remote/
├── dsh-bundle.json
└── builds/<buildId>/
    ├── cordis.patch.yml
    ├── node/remoteEntry.js
    └── web/remoteEntry.js   # only when a browser entry exists
```

`dsh-bundle.json` is the stable subscription document. Every path below `builds/<buildId>/` is immutable, and rebuilding an existing id fails. The Node artifact contains the patch modules and their runtime dependencies except declared peers; the Host supplies peers, including the single Cordis instance. The browser artifact exposes the Bundle's own `src/client/index.ts` and consumes React, Cordis, and declared browser externals from the running Web application.

Type declarations belong to `dist/`, not the runtime URL. A TypeScript consumer that imports the Bundle's service augmentation installs the package artifact as a development dependency even when deployment uses the remote artifact.

### Source map

| File | Role |
|---|---|
| [`src/project.ts`](src/project.ts) | Convention and `package.json` resolution |
| [`src/package-build.ts`](src/package-build.ts) | Installable package and declarations |
| [`src/remote-build.ts`](src/remote-build.ts) | Immutable remote Node/browser artifacts and stable manifest |
| [`src/webpack.ts`](src/webpack.ts) | Shared TypeScript, CSS, asset, and federation build rules |
| [`src/bin.ts`](src/bin.ts) | `lint`, `build`, and local `serve` commands |

-----

<a id="further-exploration"></a>
## Further Exploration

- [Bundle group](../README.md) — what a Bundle contributes to a Profile.
- [Publishing tutorial](../../../docs/user/develop/basic/publish.md) — author, build, install, and remotely serve a Bundle.
- [app-boot](../../boot/app-boot/README.md) — Profile composition and remote resolution.
- [Remote Bundle delivery decision](../../../.agents/notes/implemented/architecture/2026-08-28-remote-dsh-bundles.md) — protocol and lifecycle rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is build-time artifact tooling and emitted Bundle plugins own every model-facing effect.

#### KV Cache effect

The Builder never assembles or sends a model request, so it cannot affect provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current remote delivery surface.

- **Remote types are not runtime assets** — install the package artifact for TypeScript declarations and module augmentation.
- **One authored browser plugin per remote Bundle** — the remote target emits only the Bundle's own `src/client/index.ts`. It rejects a patch that inserts a dependency package declaring `dsh.client`, because silently omitting that dependency's browser half would produce an incomplete application.
- **The local server is not hardened for public exposure** — it has no TLS, access control, upload, retention, or concurrent-publisher coordination.

<a id="dev-note"></a>
### Dev Note

None.
