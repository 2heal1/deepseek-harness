---
description: "约定优先的 DSH 组合包构建器，可生成可安装的包产物以及能够通过 URL 加载的 Node 和浏览器产物。"
kind: "package-reference"
---

# @deepseek-ai/dsh-bundle-builder

[English](README.md) | 中文

## 概述

`dsh-bundle-builder` 把一个组合包源码目录构建成普通的可安装包、能够通过 URL 加载的远程产物，或者同时生成两者。默认的 `dual` target 使用同一份 `package.json`、`cordis.patch.yml` 和约定源码入口生成两种形式。用户只需要理解 DSH 组合包和稳定 HTTP URL；Module Federation 是内部传输实现，用于在远程加载代码时保持 Host 的 Cordis 实例一致。

## 目录

- [使用这个包](#use-this-package)
- [理解输出](#understand-the-outputs)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用这个包

从下面这些文件开始，无需配置构建器：

```text
my-bundle/
├── package.json
├── cordis.patch.yml
└── src/
    ├── index.ts
    └── client/index.ts   # optional browser plugin
```

包必须声明名称和版本，并把 `@deepseek-ai/cordis` 列为 peer dependency。patch 插入组成该组合包配置层的 Node 插件。当 patch 插入组合包自己的包名时，`src/index.ts` 是它的约定实现。其他包模块名从项目解析。Builder 会拒绝相对模块名，因为本地文件 URL 无法在远程发布后继续标识同一模块；这类代码应通过组合包或依赖包暴露。

### 构建和校验

```sh
dsh-bundle lint
dsh-bundle build
dsh-bundle build --target package
dsh-bundle build --target remote
```

默认 target 是 `dual`。命令行中的 `--target`、`--out-dir` 和 `--build-id` 会覆盖 `package.json` 配置。远程 build id 默认是新 UUID，只能包含 ASCII 字母、数字、点、下划线和连字符。

### 可选配置

只有约定路径不适用时才需要 `dsh.bundleBuilder`：

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

`modules` 把 patch 模块名映射到项目源码文件。组合包自己的约定入口和可解析的包依赖不需要配置它。

### 在本地提供远程产物

```sh
dsh-bundle serve --port 4173
```

该命令会构建 remote target，以允许跨域访问的方式提供文件，并输出订阅 URL。稳定 manifest 不缓存，build-id 路径则标记为不可变。它是开发服务器，不是生产发布服务。

-----

<a id="understand-the-outputs"></a>
## 理解输出

包产物直接写入 `dist/`，其中包含普通的 `dsh.bundle` manifest、patch 文件、Node 入口、类型声明和可选的浏览器入口。可以安装或发布 `dist/`，也可以通过 Git 使用普通的 `dsh plugin add` 路径。它是可安装的包而不是单文件可执行程序：包依赖仍由包管理器安装，workspace peer 范围会转换成可发布的版本范围。重新构建包形式时会替换其文件并保留 `dist/remote/`。

远程产物写入 `dist/remote/`：

```text
dist/remote/
├── dsh-bundle.json
└── builds/<buildId>/
    ├── cordis.patch.yml
    ├── node/remoteEntry.js
    └── web/remoteEntry.js   # only when a browser entry exists
```

`dsh-bundle.json` 是稳定订阅文档。`builds/<buildId>/` 下的每个路径都不可变，重复构建同一个 id 会失败。Node 产物包含 patch 模块及其运行时依赖，但不包含声明为 peer 的依赖；Host 会提供这些 peer，包括唯一的 Cordis 实例。浏览器产物暴露组合包自己的 `src/client/index.ts`，并从运行中的 Web 应用消费 React、Cordis 和声明的浏览器 external。

类型声明属于 `dist/`，不属于运行时 URL。即使部署时使用远程产物，需要导入组合包 service 类型扩展的 TypeScript 消费方仍应把包产物安装为开发依赖。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/project.ts`](src/project.ts) | 约定和 `package.json` 解析 |
| [`src/package-build.ts`](src/package-build.ts) | 可安装包和类型声明 |
| [`src/remote-build.ts`](src/remote-build.ts) | 不可变远程 Node/浏览器产物和稳定 manifest |
| [`src/webpack.ts`](src/webpack.ts) | 共享的 TypeScript、CSS、资源和 federation 构建规则 |
| [`src/bin.ts`](src/bin.ts) | `lint`、`build` 和本地 `serve` 命令 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [组合包分组](../README.zh.md) — 组合包为 profile 贡献什么。
- [发布教程](../../../docs/user/develop/basic/publish.zh.md) — 编写、构建、安装和远程提供组合包。
- [app-boot](../../boot/app-boot/README.zh.md) — profile 组合与远程解析。
- [远程组合包交付决策](../../../.agents/notes/implemented/architecture/2026-08-28-remote-dsh-bundles.zh.md) — 协议和生命周期依据。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是构建期产物工具，所有面向模型的影响都由输出的组合包插件拥有。

#### KV Cache 影响

构建器不会组装或发送模型请求，因此不会影响服务商缓存复用。

## 已知限制和暂缓工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定当前远程交付能力。

- **远程类型不是运行时资源** — 请安装包产物以获取 TypeScript 声明和 module augmentation。
- **每个远程组合包只支持一个自有浏览器插件** — remote target 只输出组合包自己的 `src/client/index.ts`。如果 patch 插入了声明 `dsh.client` 的依赖包，构建会拒绝，因为静默遗漏该依赖的浏览器部分会产生不完整的应用。
- **本地服务器不适合公开暴露** — 它不提供 TLS、访问控制、上传、保留策略或多发布者协调。

<a id="dev-note"></a>
### 开发备注

无。
