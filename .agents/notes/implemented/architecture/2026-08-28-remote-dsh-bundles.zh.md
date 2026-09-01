# Agent Note：远程 DSH 组合包使用稳定订阅和不可变构建

Status: implemented

[English](2026-08-28-remote-dsh-bundles.md) | 中文

## Problem

profile 组合包交付要求通过 pnpm 从 npm、Git、tarball 或文件系统路径安装。这对公开包可行，但当部署专用代码必须运行在云端机器时比较繁琐：发布 npm 包、配置 Git 访问或复制 tarball，会把一个可部署配置层变成安装流程。运行时也没有 URL 形式，无法在下一次进程启动时选择当前发布的构建版本。支持浏览器的组合包还有一项要求：Node 和浏览器代码必须消费运行中应用的 Cordis 与平台模块，而不能创建不兼容的副本。

## Decision

`dsh.profile.bundles` 条目可以是已安装包名，也可以是 `{ "type": "remote", "name": string, "url": string }`。URL 是稳定 HTTP(S) 订阅 manifest。`dsh plugin --profile <name> add name@https://…/dsh-bundle.json` 校验 manifest 名称一致后，把 remote 条目写入同一个有序层列表；`remove <name>` 将其移除。package 参数保留既有 pnpm 行为。一条命令同时包含两种形式时，只有 pnpm 成功后才会提交 remote 条目。

版本一 manifest 使用 `buildId` 标识一个不可变构建，并包含相对的 patch、Node 入口和可选 Web 入口路径。app boot 在每次进程启动时获取一次稳定 manifest，再获取其 patch，从 DSH 安装或当前 profile 解析声明的共享 peer，然后加载 Node 容器。容器返回 patch 所引用的每个模块命名空间。app boot 把这些名称改写成进程本地 Loader builtin，此后由普通 Loader 负责配置、依赖等待、激活和卸载。Cordis 是 `import: false` 的必需共享 peer，因此每个远程插件都使用 Host 的单例。运行中的进程不会轮询或替换已选择的构建。

当选中构建包含 Web 入口时，Web profile 的 remote 桥接器只把不可变描述序列化到页面。浏览器直接从发布方加载 remote entry 和 chunks，使用运行中客户端模块系统里的 Cordis 与其他声明模块初始化容器，再把固定的 `./client` 导出挂载为普通子插件。

协议不要求特定的产物生成器。生成器输出上述稳定 manifest、不可变 Node 入口、可选 Web 入口和 patch。Module Federation 是实现细节，不贡献面向用户的标识或配置。

## Alternatives considered

- **执行任意远程 JavaScript URL**：裸 import 没有纯数据 patch、共享 peer 声明、不可变构建标识或浏览器部分，还会迫使每个发布方发明自己的 bootstrap API。小型 DSH manifest 让远程交付与既有组合包层模型保持一致。
- **把包下载并安装进 profile**：这种做法会把远程使用与包管理器状态、生命周期脚本、lockfile 以及 registry 或 Git 凭据耦合。URL 订阅在配置树挂载前解析，并且不改动 profile 的包安装状态。
- **通过 DSH Node 服务代理浏览器资源**：代理会增加路由、缓存、Content Security Policy 和流式传输职责，同时无法消除浏览器对发布方代码的信任。直接访问能让部署要求保持可见，也避免让 DSH 中转资源字节。
- **在 DSH 配置中暴露 Module Federation 名称**：容器名和 exposed module key 都由协议派生并固定。暴露它们只会把内部传输方式变成产品词汇，并不能新增 DSH 用例。
- **从运行时 URL 交付声明**：TypeScript 在运行时 profile 启动前就会消费声明，无法从之后的 HTTP 获取得知 module augmentation。dual 的 package 产物就是编译期分发形式。

## Consequences

- package 和 remote 组合包是同一个有序 profile 层的两种交付形式，不会引入新的运行时组合概念。
- 稳定 URL 可以在后续进程启动时选择新的不可变构建，无需修改 profile 配置。运行中的进程和页面继续使用已选择的构建。
- 远程 Node 代码包含非 peer 运行时依赖，Cordis 和声明的 peer 来自 Host。浏览器代码消费运行中的客户端模块实例。
- 远程发布要求普通 HTTP(S) 资源可访问。HTTPS 页面不能消费 HTTP 入口，每个浏览器 chunk 都必须持续存在于其不可变 URL。
- 首版浏览器构建支持组合包自己的 `src/client/index.ts`。remote 构建会拒绝声明了 `dsh.client` 的依赖包，因为遗漏这些客户端部分会形成不完整应用；多客户端聚合仍是独立设计问题。
- 本决策只取代 [Profile 插件组合包笔记](2026-08-05-profile-plugin-bundles.zh.md)中“`dsh plugin` 仅是 pnpm 薄转发器”的表述。其 profile/组合包区分、有序层和 package 解析仍然有效。
