---
description: "Web profile 桥接器，从已发布 URL 直接加载选中远程 DSH 组合包的浏览器部分。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-bundles

[English](README.md) | 中文

## 概述

`dsh-client-remote-bundles` 把 profile 级的远程组合包选择连接到浏览器应用。Host 插件把已解析的浏览器描述写入生成页面；浏览器插件从发布 URL 直接加载每个不可变 remote entry，提供运行中应用的 Cordis 和客户端模块，并按照 profile 顺序挂载导出的插件。它只是交付设施，不添加模型可见内容。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用这个包

内置 Web 组合包会自动挂载这个桥接器。用户使用普通 profile 命令把远程组合包加入 Web profile：

```sh
dsh plugin --profile web add private-map-tools@https://plugins.example.test/maps/dsh-bundle.json
dsh web
```

启动时，app boot 解析订阅 manifest，并且只把选中的不可变浏览器构建交给这个桥接器。生成的页面随后直接向 `plugins.example.test` 请求 remote entry 和其 chunks；DSH Node 服务不会代理这些文件。

远程容器只能获得已校验 manifest 中列出的模块实例。Cordis 由运行中的浏览器应用提供，因此远程插件会挂载到与已安装客户端插件相同的 service graph。

-----

<a id="understand-the-implementation"></a>
## 理解实现

Host 端注入 Profile remote registry，监听 Web index injection 事件，并把 `ctx.remoteBundles.web()` 序列化成 `window.__DSH_REMOTE_BUNDLES__`。没有选中远程组合包时它保持空闲。浏览器端插入经典 remote-entry 脚本，每个入口 URL 只初始化一次容器，从 `ctx.modules` 构建 Module Federation share scope，获取固定的 `./client` 导出，并把它挂载为 Cordis 子插件。因此，Cordis 生命周期会与 Web 树的其他部分一起卸载远程插件。

### 源码索引

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 端向生成页面投影描述 |
| [`src/client/index.ts`](src/client/index.ts) | 直接加载脚本、提供 Host share scope 和 Cordis 挂载 |
| [`src/invariant.ts`](src/invariant.ts) | invariant companion；动态关系由浏览器生命周期测试负责 |

-----

<a id="further-exploration"></a>
## 进一步探索

- [客户端模块系统](../modules/README.zh.md) — 向远程容器提供 Host 模块实例。
- [app-boot](../../boot/app-boot/README.zh.md) — 解析远程 manifest 和 Node 部分。
- [远程组合包交付决策](../../../.agents/notes/implemented/architecture/2026-08-28-remote-dsh-bundles.zh.md) — 协议和浏览器直连决策。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是浏览器和 Host 的交付设施，只有加载的组合包插件能够影响模型输入。

#### KV Cache 影响

该桥接器不会贡献服务商请求内容，因此不会影响缓存复用。

## 已知限制和暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **浏览器直接访问策略生效** — 混合内容策略、Content Security Policy、网络路由和已发布 chunk 的可用性都可能在 Cordis 激活前阻止加载。
- **每个远程组合包只有一个客户端导出** — 容器必须暴露协议固定的 `./client` 模块。
- **没有运行时替换** — 正在运行的页面会继续使用已经选择的构建；需要重启 profile 并刷新页面才能选择稳定 manifest 的另一个版本。

<a id="dev-note"></a>
### 开发备注

无。
