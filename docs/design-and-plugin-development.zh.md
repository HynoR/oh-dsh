# Oh-DSH 设计哲学与插件化开发指南

> 本文面向希望理解 Oh-DSH 架构、并为其扩展插件的开发者。阅读前建议先浏览 [`design.zh.md`](./design.zh.md) 与 [`usage.zh.md`](./usage.zh.md)。

---

## 1. 项目定位

**Oh-DSH** 是在一份固定的 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness)（DSH）runtime 之上，打包出的 **Desktop / Web / TUI** 三种交互形态。

- 不是三个独立产品，而是“同一套 runtime + 不同的交互壳”。
- `ohdsh` 统一命令只负责选择界面：
  ```sh
  ohdsh desktop
  ohdsh web
  ohdsh tui
  ```
- 模型服务可运行在云端；Workspace、终端、Git Review、文件、会话、插件状态由本地工作台统一组织。

---

## 2. 设计哲学

### 2.1 单一 runtime，多端 surface

Oh-DSH 的核心信念是：**不要为三端造三套插件系统**。

```text
ohdsh CLI
  ├── desktop  (Electron + Web runtime)
  ├── web      (HTTP + Web runtime)
  └── tui      (dsh-TUI renderer)
        │
        ▼
  Pinned DSH runtime
        │
        ▼
  Profile + Loader ──▶ Oh-DSH / 第三方插件 ──▶ Workspace · PTY · Git · Browser
```

- Desktop 是完整发行版；Web-only / TUI-only 去掉 Electron，按需裁剪。
- 三端共享会话、凭据、皮肤、插件缓存，但各自有独立的 Profile 组合。
- 轻量部署不必强制安装 Electron。

### 2.2 Profile + Loader 的插件治理

`src/profile.ts` 拥有各 surface 的组合边界：

| Profile | Bundle 顺序 | 含义 |
| --- | --- | --- |
| `desktop` | `@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-web-app` → `@oh-dsh/desktop` | 完整桌面 |
| `web` | `@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-web-app` → `@oh-dsh/web` | 浏览器 |
| `tui` | `@deepseek-ai/dsh-base` → `@deepseek-harness-tui/dsh-tui` → `@oh-dsh/tui` | 终端 |

每个 Profile 都是一个可写的 npm 包，位于 `~/.ohdsh/profiles/<name>/`，包含：

- `package.json`：声明依赖的 bundle 与插件。
- `cordis.yml` / `cordis.patch.yml`：DSH Cordis 的图配置与用户补丁层。
- `pnpm-workspace.yaml`：让 Loader 能在 profile 作用域内解析插件。

**插件不是直接“装到 Oh-DSH”，而是装到 active Profile，再由 DSH Loader 在 Cordis 服务图中启动。**

### 2.3 同一种能力只有一个 Host

- Files、PTY、Git、Browser 等本地能力都有且只有一个 Host。
- Host 请求绑定到当前 Session 与 Workspace，防止越界。
- Web 不模拟 Electron 权限；TUI 只在真实 TTY 启动，继续使用 DSH 的 sandbox 与 approval 策略。

### 2.4 人类与 Agent 共享同一条事务

插件安装不是直接改文件，而是走一条统一事务：

```text
Discovered → Prepared → Previewing → Applied
                ↓           ↓
           Discarded    Previous (可恢复)
```

- `installed` 与 `enabled` 分离。
- 安装/更新先固定来源与 commit，再进入隔离预览。
- 只有显式 apply 才会修改当前 Profile。
- Agent 发起的安装也必须经过预览、风险确认和应用，不能绕过 Loader。

### 2.5 上游适配，不覆盖 Oh-DSH UI

`upstream/` 目录保存固定的第三方子模块（如 `DSH-better-sidebar`、`dsh-TUI`、`dsh-context`）。Oh-DSH 的原则是：

- 在上游能力上重新适配到当前 DSH 契约。
- 保留 Oh-DSH 自己的布局、图标、主题、Review 与评论交互。
- 上游代码、Oh-DSH UI、最终权限边界不混为一层。

例如 `@oh-dsh/sidebar` 复用上游 `DSH-better-sidebar` 的 Host，但自己实现侧边栏 UI。

### 2.6 统一数据根

三端默认共同使用 `~/.ohdsh`：

```text
~/.ohdsh
├── profiles/
│   ├── desktop/
│   ├── web/
│   └── tui/
├── sessions/
├── .credentials.yaml
├── settings.yaml
└── skins.json
```

- `OH_DSH_HOME` 统一覆盖三端数据根。
- Web / TUI 的 `--data` 只覆盖当前进程。
- 迁移是非破坏性的、幂等的、可回滚的。

---

## 3. 架构概览

### 3.1 发行边界

| 发行形态 | 包含 | 不包含 |
| --- | --- | --- |
| Full/Desktop | Electron、Web runtime、TUI、Node、内置插件、统一 CLI | 无 |
| Web-only | HTTP/Web runtime、Node、Web 兼容插件、统一 CLI | Electron 和桌面窗口能力 |
| TUI-only | dsh-TUI renderer、Node、TUI 兼容插件、统一 CLI | Electron 和浏览器 UI |

### 3.2 内置插件图谱

| 插件 | 角色 | 说明 |
| --- | --- | --- |
| `@oh-dsh/desktop` | 自研 | 统一入口、窗口、菜单、Electron bridge、内置插件注册 |
| `@oh-dsh/web` | 自研 | Web surface 的 HTTP 入口与 bridge |
| `@oh-dsh/tui` | 自研 | TUI surface 的 Profile 适配 |
| `@oh-dsh/better-sidebar-runtime` | 上游 Host | 编译 `DSH-better-sidebar`，提供 PTY、Files、Git、历史、commit diff |
| `@oh-dsh/sidebar` | 下游 UI | 复用 Host，保留 Oh-DSH 布局与主题 |
| `@oh-dsh/panel-controls` | 下游实现 | 统一 Terminal dock |
| `@oh-dsh/pinned-summary` | 自研 | 会话摘要浮层 |
| `@oh-dsh/plugin-marketplace` | 自研 | 单一 Loader、隔离预览、风险确认、TOFU 来源锁、恢复 |
| `@oh-dsh/skins` | 下游实现 | 三端统一皮肤定义 |
| `@oh-dsh/vision` | 上游适配 | 跨端 `view_image` 工具 |
| `@deepseek-harness-tui/dsh-tui` | 上游固定 | 终端渲染、命令、扩展接口 |
| `dsh-context` | 上游固定 | 上下文洞察面板 |

---

## 4. 插件模型

Oh-DSH 插件基于 DSH/Cordis 的服务图。一个插件通常由两部分组成：

- **Host entry**（`src/index.ts`）：运行在 Node 进程，访问本地能力、文件、PTY、网络、工具注册等。
- **Client entry**（`src/client.ts`）：运行在浏览器/渲染进程，访问 UI slots、theme、locale、React 组件等。

一个插件可以只有 Host，也可以 Host + Client 都有。

### 4.1 最小 Host 插件

```ts
// plugins/hello-host/src/index.ts
export const name = 'hello-host'
export const inject = ['tools'] // 声明依赖的服务

export function apply(ctx: any): void {
  // ctx.get('tools')、ctx.provide('hello', ...)、ctx.effect(...)
}
```

### 4.2 最小 Client 插件

```ts
// plugins/hello-client/src/index.ts
/** Host 侧不需要行为 */
export function apply(): void {}

// plugins/hello-client/src/client.ts
export const inject = ['slots']

export function apply(ctx: any): void {
  ctx.effect(() => {
    // 注册 UI slot、监听主题变化等
    return () => { /* dispose */ }
  }, 'hello-client: mount')
}
```

### 4.3 `package.json` 的 `dsh.client` 字段

Client 插件必须在 `package.json` 中声明注入顺序与平台：

```json
{
  "name": "@oh-dsh/pinned-summary",
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime"],
      "platform": "web",
      "immediately": true
    }
  }
}
```

- `inject`：Client 启动前必须先加载的 DSH 服务。
- `platform`: `"web"` 表示该 client 在 Desktop 与 Web 的浏览器层都生效；TUI 不加载。
- `immediately`: 是否在 profile 启动时立即注入。

### 4.4 核心上下文 API

无论是 Host 还是 Client，`apply(ctx)` 中的 `ctx` 都提供：

| API | 作用 |
| --- | --- |
| `ctx.get(name)` | 获取已注册服务 |
| `ctx.provide(name, value)` | 注册服务 |
| `ctx.inject(names[], cb)` | 延迟依赖，等指定服务可用后回调 |
| `ctx.effect(fn, label?)` | 注册生命周期 effect，返回 dispose 函数 |

Client 额外提供：

| API | 作用 |
| --- | --- |
| `ctx.slots.register(options, Component)` | 注册 UI slot |
| `ctx.theme.getTheme()` / `ctx.on('theme/change')` | 主题 |
| `ctx.reflect.provide(name, value)` | 把服务反射到 Host 侧 |

Host 额外提供：

| API | 作用 |
| --- | --- |
| `ctx.systemPrompt.section(...)` | 向 Agent system prompt 注入段落 |
| `ctx.bashEnv.register(...)` | 注册环境变量 |

### 4.5 真实示例：`@oh-dsh/pinned-summary`

Host 侧（`plugins/pinned-summary/src/index.ts`）几乎为空，因为它不需要本地能力：

```ts
export function apply(): void {}
```

Client 侧（`plugins/pinned-summary/src/client.ts`）做几件事：

1. 通过 `ctx.get('sessions')` 订阅会话列表。
2. 通过 `ctx.get('locale')` 注册多语言字典并响应语言切换。
3. 在 `document.body` 插入浮动 DOM，展示当前会话摘要。
4. 通过 `ctx.reflect.provide('pinnedSummary', service)` 把控制接口暴露出去，供桌面框架调用。

这展示了一个典型模式：**能力在 Client 层实现 UI，Host 层只负责不需要的本地能力时可为空**。

---

## 5. 如何定制插件开发

### 5.1 环境准备

```sh
git submodule update --init --recursive
pnpm install
pnpm run build:dsh   # 构建上游 DSH runtime
pnpm run build       # 构建 Oh-DSH 自身与所有内置插件
pnpm run stage:dsh   # 把 runtime 与插件暂存到 .stage/
export PATH="$PWD/bin:$PATH"

ohdsh desktop        # 或 web / tui
```

开发阶段更推荐用根目录 `Makefile`，它只暂存当前 surface 依赖的包：

```sh
make build
make tui ARGS="--inline --lang zh"
make web ARGS="--port 3080"
make desktop
```

### 5.2 新建插件目录

在 `plugins/` 下创建目录，最小结构如下：

```text
plugins/my-plugin/
├── package.json
├── src/
│   ├── index.ts      # Host entry
│   └── client.ts     # Client entry（可选）
└── tsconfig.json     # 可选，复用仓库顶层配置
```

`package.json` 示例：

```json
{
  "name": "@my-scope/my-plugin",
  "version": "0.1.0",
  "description": "My Oh-DSH plugin",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime"],
      "platform": "web",
      "immediately": true
    }
  },
  "files": [
    "dist/index.js",
    "dist/client.js",
    "dist/client.js.map"
  ]
}
```

### 5.3 编写 Host entry

```ts
// plugins/my-plugin/src/index.ts
export const name = 'my-plugin'
export const inject: string[] = []

export interface MyPluginHost {
  version: string
}

export function apply(ctx: {
  provide(name: string, value: unknown): void
  effect(effect: () => (() => void) | void, label?: string): void
}): void {
  ctx.provide('myPlugin', { version: '0.1.0' } satisfies MyPluginHost)

  ctx.effect(() => {
    console.log('[my-plugin] host mounted')
    return () => {
      console.log('[my-plugin] host disposed')
    }
  }, 'my-plugin: lifecycle')
}
```

如果需要向 Agent system prompt 注入信息：

```ts
ctx.inject(['systemPrompt'], (promptCtx) => {
  promptCtx.systemPrompt.section({
    name: 'app:my-plugin',
    order: -50,
    text: () => '这里是给模型的上下文说明。',
  })
})
```

### 5.4 编写 Client entry

```ts
// plugins/my-plugin/src/client.ts
import type { LocaleService } from '../shared/i18n.ts'

interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): void
  get(name: string): unknown
}

export const inject = ['locale']

export function apply(ctx: ClientContext): void {
  const locale = ctx.get('locale') as LocaleService

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = `[data-my-plugin] { color: red; }`
    document.head.append(style)

    const badge = document.createElement('span')
    badge.dataset.myPlugin = 'true'
    badge.textContent = locale.t('my-plugin.badge') ?? 'My Plugin'
    document.body.append(badge)

    return () => {
      style.remove()
      badge.remove()
    }
  }, 'my-plugin: client mount')
}
```

### 5.5 注册到构建系统

打开 `scripts/build.mjs`，把新插件加入 `pluginPackages` 数组：

```js
const pluginPackages = [
  // ... 已有插件
  { directory: 'my-plugin', id: '@my-scope/my-plugin' },
]
```

- 如果只有 Host：`{ directory: 'my-plugin', hostOnly: true }`。
- 如果 Client 需要额外排除某些包：`{ directory: 'my-plugin', id: '@my-scope/my-plugin', clientExternal: ['@some/pkg'] }`。

### 5.6 注册到 Profile bundle

打开 `src/profile.ts`，把插件加入对应 surface 的 bundle 列表：

```ts
export const BUNDLED_DESKTOP_CLIENT_PLUGINS = [
  // ...
  '@my-scope/my-plugin',
] as const
```

如果是 Host-only 插件，加入 `BUNDLED_DESKTOP_HOST_PLUGINS`。

### 5.7 注册到 stage 脚本

打开 `scripts/stage-dsh.mjs`，找到 `installDesktopPackages` 中的 `packages` 数组，加入：

```js
{
  manifest: join(root, 'plugins', 'my-plugin', 'package.json'),
  files: [
    [join(root, 'dist', 'plugins', 'my-plugin', 'index.js'), 'dist/index.js'],
    [join(root, 'dist', 'plugins', 'my-plugin', 'client.js'), 'dist/client.js'],
    [join(root, 'dist', 'plugins', 'my-plugin', 'client.js.map'), 'dist/client.js.map'],
  ],
},
```

如果该插件还需要出现在 Web / TUI 发行包中，同时更新 `SURFACE_PACKAGE_NAMES` 中的对应集合。

### 5.8 本地测试

```sh
pnpm run build
pnpm run stage:dsh
ohdsh desktop
```

调试技巧：

- Desktop 从终端启动 `bin/ohdsh desktop` 可查看完整 stdout/stderr。
- Web 用 `--port 0 --no-open` 随机端口验证。
- TUI 用 `--inline` 避免 alternate screen 兼容问题。
- 可设置 `OH_DSH_HOME=/tmp/ohdsh-test` 隔离数据目录。

### 5.9 通过插件市场分发

如果想让第三方用户安装，需要：

1. 把插件发布为 GitHub 仓库或 npm 包。
2. 向插件市场目录（默认 `whyihaveyou/dsh-suite/data/plugins.json`）提交条目。
3. 条目需要声明：
   - `id`、`packageName`、`repository`
   - 支持的 surface：`desktop` / `web` / `tui`
   - 构建脚本（如果有）
   - 风险等级与来源信息

市场安装事务会：

- 固定 commit / 版本。
- 在隔离 Profile 中预览。
- 用户确认后 apply。
- 失败可回滚到 previous。

**受保护插件不能被市场替换**，例如 `oh-dsh-desktop`、`plugin-marketplace`、`sidebar` 等（完整列表见 `plugins/plugin-marketplace/src/protocol.ts`）。

---

## 6. 插件开发最佳实践

1. **先决定生效的 surface**：
   - Host-only 插件在三端都能运行。
   - Client 插件的 `platform: "web"` 只在 Desktop/Web 生效，TUI 不会加载。
   - 用 `ctx.get('ohDshSurface')` 读取当前 surface 信息，做显式适配。

2. **不要假设 Electron 存在**：
   - Web-only 发行版没有 Electron。
   - 不要把 `window.electron` 等桌面能力当作全局可用。
   - 需要 native 能力时，应通过 Host plugin 提供 bridge。

3. **生命周期要成对**：
   - `ctx.effect()` 返回的 dispose 函数负责清理 DOM、取消订阅、释放资源。
   - 不要泄漏 `setInterval`、ResizeObserver、事件监听。

4. **服务依赖显式声明**：
   - 用 `inject` 声明依赖，不要直接 `require` 隐式模块。
   - DSH/Cordis 会按依赖图排序启动。

5. **权限与沙箱**：
   - 文件/终端/Git 操作绑定到当前 Session Workspace。
   - 不要绕过 Loader 读取 `~/.ohdsh` 之外的敏感路径。
   - 插件市场安装必须走隔离预览 + 风险确认。

6. **国际化**：
   - 使用 `ctx.get('locale')` 注册字典，用 `locale.bind('my-plugin')` 获取翻译函数。
   - 参考 `plugins/shared/i18n.ts` 与 `plugins/pinned-summary/src/i18n.ts`。

7. **主题一致性**：
   - 优先使用 DSH CSS token（如 `--dsw-alias-bg-base`、`--dsw-alias-label-primary`）。
   - 皮肤由 `@oh-dsh/skins` 统一定义，不要自建第二套主题 loader。

8. **上游适配原则**：
   - 如引入上游项目，放到 `upstream/` 子模块并固定版本。
   - 在 `plugins/` 中写适配层，不要直接修改上游代码。
   - 保留上游 LICENSE 与署名。

---

## 7. 安全边界速查

| 能力 | 边界 |
| --- | --- |
| Web 监听 | 默认 `127.0.0.1`；对局域网开放需 `--trusted-host` |
| Files / PTY / Git | 绑定当前 Session 与 Workspace |
| `view_image` | 本地图片只能读取 Workspace 内文件；远程只发送到用户配置端点 |
| Electron bridge | 仅 Desktop 存在；Web 不模拟 |
| TUI | 只在真实 TTY 启动，沿用 DSH sandbox |
| Marketplace | candidate / current / previous 分离；来源首次使用 TOFU 锁 |

---

## 8. 参考文件

- 架构设计：[`docs/design.zh.md`](./design.zh.md)
- 使用与排错：[`docs/usage.zh.md`](./usage.zh.md)
- Profile 组合：[`src/profile.ts`](../src/profile.ts)
- 构建脚本：[`scripts/build.mjs`](../scripts/build.mjs)、[`scripts/stage-dsh.mjs`](../scripts/stage-dsh.mjs)
- 市场协议：[`plugins/plugin-marketplace/src/protocol.ts`](../plugins/plugin-marketplace/src/protocol.ts)
- Surface 契约：[`plugins/shared/surface.ts`](../plugins/shared/surface.ts)
- 简单 Client 插件示例：[`plugins/pinned-summary/src/client.ts`](../plugins/pinned-summary/src/client.ts)
- 复杂 Client 插件示例：[`plugins/desktop-frame/src/client/plugin.tsx`](../plugins/desktop-frame/src/client/plugin.tsx)
