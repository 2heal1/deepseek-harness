# 打包与安装插件

[English](publish.md) | 中文

前几篇教程通过 `--patch` overlay 加载本地插件。本教程把它打包成可安装的**组合包**（bundle），用 `dsh plugin add` 安装进一个 **profile**，并解释决定组合后配置的层顺序。本文假设 `dsh` CLI 已安装。请先完成[插件配置](./config.zh.md)。

如果改用全新的源码 checkout，请先按照[从源码运行章节](../../../../README.zh.md#run-from-source)完成准备，将本教程的 `hello-plugin` 目录放在仓库根目录，并从该目录把下文的 `dsh ...` 命令改为 `pnpm dsh ...`。构建与启动器行为见[源码执行](../../../../apps/cli/reference/README.zh.md#source-execution)。

## 两个概念，两种 manifest

安装机制建立在两个概念之上。二者都由一份 `package.json` 描述，但它们在 `dsh` 键下携带的 manifest（元数据清单）种类不同，回答的问题也不同：

- **组合包**是附带一个配置层的 npm 包。它的 manifest 声明 `dsh.bundle`，回答的是"这个包贡献什么？"：一个插入或覆盖插件行的 patch 文件。
- **profile** 是位于 `$DSH_HOME/profiles/<name>` 下、描述一份可启动组合的目录。它的 manifest 声明 `dsh.profile`，回答的是"这套配置由哪些组合包按什么顺序组成？"。

组合包是你编写并分发的东西；profile 是用户用 `dsh --profile <name>` 启动的东西。没有东西同时是两者。

### 组合包 manifest

创建包目录：

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

创建 `hello-plugin/package.json`：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

创建 `hello-plugin/index.js`，写入插件入口：

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

创建 `hello-plugin/cordis.patch.yml`。这个 patch 与你写过的 `--patch` overlay 一样，是一个 patch 条目的 YAML 数组；区别是插件行按包名而不是相对源码路径引用这个包，这样 Node 的模块解析才能找到已安装的代码：

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

没有 `dsh.bundle` 声明的包仍然可以安装，但只作为普通依赖：`dsh plugin` 会打印警告，且不激活任何层。如果一个库供插件包 import，而不是供用户启用，就使用这种包格式。

### 从一份源码构建 package 和 remote 两种形式

上面的手写 JavaScript 包足以用于本地和 registry 交付。对于 TypeScript 组合包或远程交付，独立的 [dsh-bundle-builder](https://github.com/2heal1/dsh-bundle-builder) 项目可以从同一份源码生成两种形式。它的标准目录使用 `package.json`、`cordis.patch.yml`、`src/index.ts` 和可选的 `src/client/index.ts`；`@deepseek-ai/cordis` 必须是 peer dependency，使每个运行时提供自己的单例。

```sh
pnpm add -D dsh-bundle-builder typescript
pnpm exec dsh-bundle lint
pnpm exec dsh-bundle build
```

默认的 `dual` target 会把普通可安装组合包及其类型声明直接写入 `dist/`，并在其下写入 `dist/remote/dsh-bundle.json` 和不可变的 `dist/remote/builds/<buildId>/` 运行时资源。只需要一种形式时使用 `--target package` 或 `--target remote`。标准路径不需要任何构建器配置；只有需要修改路径、显式映射 patch 模块或选择 target 时，才使用 `package.json#dsh.bundleBuilder`。独立项目的 README 说明了配置字段和当前浏览器构建限制。

### profile manifest

profile 目录包含两个文件：

- `package.json` — profile 的树外插件依赖（由 pnpm 管理），加上 `dsh.profile` manifest 及其有序的 `bundles` 列表。
- `cordis.patch.yml` — 用户自己的 patch 层，在每个组合包层之后应用。

profile manifest 从不需要手写：`dsh plugin` 负责创建和维护它。下一节展示其结果。

## 安装进 profile

`dsh plugin --profile <name> <args...>` 在 profile 目录内转发给 pnpm，因此所有 pnpm 子命令都可用。在包含 `hello-plugin` 的目录中安装该包的 checkout：

```sh
dsh plugin --profile demo add ./hello-plugin
```

首次使用会初始化 profile（`@deepseek-ai/dsh-base` 作为它的第一个组合包），pnpm 链接该 checkout，而 `dsh` 因为这个包声明了 `dsh.bundle`，把它追加进 `dsh.profile.bundles`：

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

先不启动、只验证该层，再启动：

```sh
dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer
dsh --profile demo
```

`dsh plugin --profile demo remove dsh-hello-plugin` 会同时移除依赖和对应的层。

## 订阅远程组合包

使用普通 HTTP(S) URL 发布 `dist/remote/` 的全部内容，保持 `dsh-bundle.json` 地址稳定，并保证每个 `builds/<buildId>/` 路径不可变。然后以 manifest 声明的名称添加其 URL：

```sh
dsh plugin --profile demo add private-map-tools@https://plugins.example.test/maps/dsh-bundle.json
dsh --profile demo
```

`dsh plugin add` 添加的是组合包来源，只是该命令保留了历史名称 `plugin`。add 会校验一次 manifest，并把 `{ type: "remote", name, url }` 写入和 package 组合包相同的有序 profile 列表。此后每次进程启动会获取一次稳定 manifest 并选择其当前不可变构建；系统不会运行后台更新器或实时替换。发布新构建时改指稳定 manifest，再由用户或进程管理器决定何时重启 DSH 以应用更新。

Node 进程会下载并执行不可变 Node 入口；Web 页面会从发布源加载可选的浏览器入口及其 chunks。运行时 URL 不携带 TypeScript 声明：如果消费方需要针对组合包 service 类型进行编译，请发布或以其他方式分发 `dist/` 作为开发依赖。

按名称移除订阅：

```sh
dsh plugin --profile demo remove private-map-tools
```

## 加载顺序

生效配置在空根之上按以下顺序逐层组合：

1. profile 的 `dsh.profile.bundles` 列表所列的各个组合包 patch，按列表顺序——先是 `@deepseek-ai/dsh-base`，然后是每个已安装组合包，按其加入顺序。
2. profile 自己的 `cordis.patch.yml`。
3. home 级的 `$DSH_HOME/cordis.patch.yml`——各 profile 共享的机器本地偏好。
4. 每个 `--patch <path>` overlay，按 argv 顺序。

应用参数不是另一层 patch。表层组合包可以通过下文所述的普通应用自有服务解析它们。

后应用的层按行胜出，且 patch 会替换目标行的整个 `config` 值，而不是深度合并各键。这给组合包作者带来两个推论：

- 你的 patch 可以按 `id` 覆盖前面各层的行——就像 [`dsh-web-app` 组合包](../../../../packages/bundle/web-app/cordis.patch.yml)覆盖 `dsh-base` 的行那样——但必须重述该行需要的每一个键，而不是只写改动的那个。
- 用户可以在自己 profile 的 `cordis.patch.yml` 中覆盖你的行，无需改动你的包，所以优先给出用户大概率会保留的配置默认值，其余交给 schema 承担。

内置组合包名称始终从 dsh 安装目录本身解析；pnpm 只管理树外的包，所以你的组合包可以放心依赖 `@deepseek-ai/dsh-base` 存在且与安装保持一致。

## 让表层组合包持有自己的命令行

定义了可运行应用的组合包挂载一个普通提供方插件：

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

该插件导出 `inject = ['cmdlineArgs']`，使用自己的 commander program 调用 [`@deepseek-ai/dsh-cmdline`](../../../../packages/boot/cmdline/README.zh.md) 中的 `parseCmdline`，再在 program 自己的 action 中把应用自有服务提供出去。启动器把自身 flag 之后的同一份不可变参数交给每个插件，因此添加应用专属 flag 无需修改启动器，多个插件也可以解析该快照。Loader 行不需要启动器标记或特殊类型。

受这些参数配置的行会注入提供方服务，并在自己的 `!!js` 选项中读取它，同时把部署取值写在旁边作为回退：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

遇到 `--help` 时，提供方不会发布该服务，所以这些行不会激活。Loader 只挂载一次组合，等待每一行的普通注入，再基于其已注入的上下文求值该行的 `!!js` 配置。

## 从 GitHub 安装：构建脚本这道坎

发布到注册表不是必须的——用户可以直接从 git 托管安装：

```sh
dsh plugin --profile demo add github:you/hello-plugin
```

但 git 安装拉取的是**源码，不是构建产物**：没有任何环节运行你的 `build` 脚本，因此 TypeScript 包到手时没有 `lib/` 输出，加载会失败。必须两边各做一件事：

- **作者**提供一个 `prepare` 脚本——pnpm 在 git 安装后运行它——从源码构建出发布入口，且必须自包含：不能假设仅开发环境才有的上下文，例如旁边有一份 monorepo checkout。[turtle-ui](https://github.com/deepseek-harness/turtle-ui) 是一个可用的例子：它的 `prepare` 运行一份专用的 tsdown 配置，直接转译 `src/`，不用项目引用，也不做类型检查。
- **用户**为构建授权。pnpm ≥10 在得到显式允许之前拒绝运行 git 依赖的 `prepare` 脚本，所以第一次 `add` 会失败；`dsh` 会指出修法——把 pnpm 打印的确切包键复制进该 profile 的 `pnpm-workspace.yaml`：

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  然后重新执行 `add`。

请把这项授权视为**允许该包的代码在安装时于你的机器上执行**，且不在 agent 运行的任何沙箱之内。只对源码可信的包授权，并锁定 commit（`github:you/hello-plugin#<sha>`），让后续推送无法悄悄改变实际运行的内容。

如果不想让用户做这项授权，就改为分发构建产物——以下两种形式都不需要任何构建权限：

- **发布到 npm**，在 `pnpm publish` 时构建好 `lib/`；`dsh plugin add your-package` 安装的就是预构建代码。
- **交付 tarball**：用 `pnpm pack` 打包；用户执行 `dsh plugin add ./hello-plugin-0.1.0.tgz`。

## 下一步

- [插件与生命周期](../framework/index.zh.md) — 插件的完整生命周期
- [CLI（命令行界面）行为参考](../../../../apps/cli/reference/README.zh.md) — 确切的层优先级、flag 与 profile 机制
