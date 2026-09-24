# 扩展点参考（pi 原生 + PiDeck 专属）

> **这份是权威清单。** 写扩展前先在这里查「我要挂的点在 GUI 里会不会有反应」。
>
> - **机器可读版**：`tools/catalog.json`（由 `tools/extract-points.mjs` 从
>   pi 的 `.d.ts` 与桥的源码抽取，**不靠记忆**）
> - **快照**：pi 0.87.1 · 共 **79 个扩展点**（28 个 `ctx.ui` 方法 / 36 个事件 / 14 个 `ctx.gui` 落点 / 6 个 `ctx.gui` 服务）

---

## 0. 三层能力，一张图

```
┌─ 第一层：pi 原生 ─────────────────────────────────────────┐
│  ctx.ui.*        ← 声明式 UI 扩展点（29 条，含 1 组重载）  │
│  pi.on(事件)     ← 36 个扩展事件                          │
│  pi.registerTool / 命令 / …                               │
└───────────────────────────────────────────────────────────┘
              ↓ 桥把 RPC 下被丢弃的点接回来
┌─ 第二层：PiDeck 专属 ─────────────────────────────────────┐
│  ctx.gui.set*    ← 14 个 GUI 专属落点                     │
│  ctx.gui.custom / toast / confirm / overlay / command /   │
│  icon            ← 6 个交互与服务                         │
└───────────────────────────────────────────────────────────┘
              ↓ 画笔（可序列化的视图树）
┌─ 第三层：控件词汇表 ──────────────────────────────────────┐
│  ~30 个 GuiNode kind（布局 / 基础 / 交互 / 数据 / 反馈）  │
└───────────────────────────────────────────────────────────┘
```

**只有一种扩展要写**：一个 `.ts`，与 TUI 扩展同格式、同 manifest、同一个 `ctx`。

---

## 1. `ctx.ui.*` —— pi 原生 UI 扩展点（29 条）

`bridgeStatus` 决定你的调用在 PiDeck 里会不会有反应：

| 状态 | 含义 | 数量 |
|---|---|---|
| ✅ `wired` | 桥接管并落到 GUI | **9 个方法**（10 条，含 `setWidget` 1 组重载） |
| ✅ `passthrough` | PiDeck 本来就有对应能力，桥不动（走原路） | **15** |
| ⛔ `not-bridged` | **刻意不桥接**，调了在 GUI 里没反应 | **4** |
| ⚠️ `unclassified` | 脚本没给分类（pi 新增了方法）→ **应当补进策展表** | **0** |

### 1.1 桥接的（`wired`，9 个方法）

| 方法 | 落到 PiDeck 的 | 语义 |
|---|---|---|
| `setHeader(factory)` | 聊天区顶部 | 传 `undefined` 恢复内置；无 key，**最后设置的胜出** |
| `setFooter(factory)` | 底部状态区 | 同上 |
| `setStatus(key, text)` | 状态栏条目 | **多 key 共存**；`undefined` 清除该 key |
| `setWidget(key, string[] \| factory, opts)` | 输入框上/下方（含 `placement`） | 字符串形式保持原路；**组件形式由桥接**（RPC 下原本被直接丢弃） |
| `setWorkingMessage(msg?)` | 流式状态行文案 | `undefined` 恢复默认 |
| `setWorkingVisible(bool)` | 流式状态行显隐 | — |
| `setWorkingIndicator(opts?)` | 流式状态行指示器 | `frames` 取首帧映射；`frames: []` = 完全隐藏 |
| `setHiddenThinkingLabel(label?)` | 折叠思考块标签 | 有值时**替换**折叠行的耗时小字 |
| `setTitle(title)` | `document.title` | — |

> `setStatus` 仍**转发原实现** —— 否则 PiDeck 的 `pideck:auto-title` 自动标题会失效。
> 这是「只补不拆」的具体体现。

### 1.2 保持原路的（`passthrough`，15 个）

| 方法 | PiDeck 已有的能力 |
|---|---|
| `select` / `confirm` / `input` | 时间线卡片 / 确认卡片 / 输入卡片 |
| `notify` | toast（主进程已清洗 ANSI） |
| `editor` | 多行编辑器弹框 |
| `setEditorText` / `getEditorText` / `pasteToEditor` | 输入框文本控制（含既有去重键，桥不碰） |
| `getEditorComponent` | RPC 下 pi 恒返回 `undefined`（自定义输入框本就不支持），桥保持该语义 |
| `getToolsExpanded` / `setToolsExpanded` | 工具展开态 |
| `theme` / `getAllThemes` / `getTheme` / `setTheme` | 主题（桥另供一份**哨兵 theme** 给扩展用） |

### 1.3 ⛔ 刻意不桥接的（`not-bridged`，4 条）

| 点 | 为什么不桥接 |
|---|---|
| **`ctx.ui.custom()`** | 它画的是 `render(width): string[]`，即**字符行**。观感是终端风，与 GUI 原生风格不合。→ 用 **`ctx.gui.custom()`**（注册方法同形，画笔换成 GUI 控件） |
| **`ctx.ui.onTerminalInput()`** | 语义是「监听原始终端按键」。GUI 里**没有终端**。→ 用 GUI 控件自己的交互（`actionId`） |
| **`ctx.ui.addAutocompleteProvider()`** | GUI 输入框有自己的补全机制。硬接会把 pi-tui 的补全模型塞进 DOM，收益低于成本 |
| **`ctx.ui.setEditorComponent()`** | **拦截但不替换输入框**，见下方专门说明 |

#### 为什么 `setEditorComponent` 不能替换输入框

计划原本把它标为「替换组件」，桥也确实拦截并推了节点树。但实测下来**替换会让输入框变成死控件**：

1. **草稿状态不在 pi 里**。输入内容存在 PiDeck 的 `sessionDraftByIdAtom` /
   `sessionDraftBySessionIdAtomFamily`，由 `useSessionComposerController` 持有。
   扩展的编辑器组件活在 **pi 进程**，两者没有共享状态。
2. **回灌延迟不可接受**。若靠桥把每次按键送回 pi、扩展处理后再推回来，
   走的是 ~100ms 的 HTTP 轮询 —— 逐字符输入延迟 100ms+，实际不可用。
3. **会孤立整条发送链**。发送按钮、附件、斜杠命令、`@` 引用、粘贴文件、
   图片附件全都挂在 `composer` 控制器上，替换输入框后这些全部失联。

> 性质与上面三个**不同**：那三个是**终端专属语义**；这条是**状态所有权不匹配** ——
> 输入框的状态属于宿主，不属于扩展。
>
> **如果将来要做**：唯一可行路径是「扩展只提供**样式/工具栏**，草稿仍由 PiDeck 持有」，
> 即把它降级成附加型语义，而不是真的替换。这需要先对齐语义，不宜擅自改。

---

## 2. `pi.on(...)` —— pi 扩展事件（36 个）

完整名单见 `tools/catalog.json` 的 `events`。常用的几个：

| 事件 | 用途 |
|---|---|
| `session_start` | 桥的挂载时机；扩展初始化 UI 的常规位置 |
| `session_shutdown` | 清理贡献（传 `undefined` 移除） |
| `agent_start` / `agent_end` | 回合生命周期 |
| `tool_call` | 工具调用前拦截（可 `block`） |
| `tool_result` | 工具结果改写 |
| `before_agent_start` | 注入消息 / 改系统提示 |
| `user_bash` | 自定义 bash 执行 |

> 事件在 PiDeck 里**照常工作** —— 桥不碰事件通道，只碰 UI 扩展点。

### 2.1 拿 gui 的正确姿势：不依赖加载顺序（「桥最先可用」）

pi 的扩展加载顺序（项目 → 全局 `~/.pi/agent/extensions` → `-e` 显式）不可更改，
桥（经 PiDeck 以 `-e` 注入）排在全局用户扩展**之后**。为让 gui 能力不依赖
加载顺序，桥把 `GuiNamespace` 同时挂在两处（**同一个对象**，`ctx.gui === ctx.ui.gui`）：

| 取法 | 可用时机 | 适用 |
|---|---|---|
| **`ctx.ui.gui`（推荐）** | 桥的 `session_start` 挂载后的**任何事件** / 命令 handler | 任何扩展，无论加载顺序 |
| `ctx.gui` | 同上（桥挂载后），但仅限当次 emit 的 ctx | 向后兼容 |

```ts
export default function (pi: ExtensionAPI) {
	// 推荐：从共享 ui 单例取，任何时候都可靠
	pi.on("agent_start", async (_e, ctx) => {
		ctx.ui.gui?.setSettingsSection("my-ext", myFactory, { title: "我的扩展", order: 900 });
	});
	// 若必须在 session_start 同步段初始化：先于桥注册时 ctx.ui.gui 可能还没挂上，
	// 此时 ctx.gui 也是 undefined —— 请改到 agent_start，或下一拍重试一次（勿用长 timer 轮询）。
}
```

> 桥还在 `project_trust`（早于一切 `session_start`）里预热 runtime 并对 trust ui
> 尽力挂 `gui`；但 pi 在信任期给的是临时 ui 对象，真正的单例要到 session 才存在。
> 纯终端（`PIDECK_BRIDGE_URL` 未设）时 `ctx.ui.gui` 为 `undefined`，取用前判空。

---

## 3. `ctx.gui.*` —— PiDeck 专属落点（14 个）

**写法与 `ctx.ui` 完全同形**：同样的 `set*` 命名、同样的 `(…, theme) => Component` 工厂、
同样的「传 `undefined` 即恢复默认」、同样的「带 `key` 可多贡献共存」。

```ts
type GuiFactory = (gui: GuiSurface, theme: GuiTheme, ctx: ExtensionContext) => GuiComponent | GuiNode;
type GuiSlotOptions = { title?: string; order?: number; placement?: "above" | "below" };
declare function setXxx(key: string, factory: GuiFactory | undefined, opts?: GuiSlotOptions): void;
```

### 3.1 位置清单

| 方法 | 落点 | 宿主（PiDeck 源码） | key 含义 |
|---|---|---|---|
| `setHeader`（用 `ctx.ui`） | 顶部区 | `session/SessionView.tsx` | — |
| `setFooter`（用 `ctx.ui`） | 底部状态区 | `session/SessionView.tsx` | — |
| `setSidebarPanel` | 侧边栏面板 | `sidebar/SidebarContent.tsx` | 贡献标识 |
| `setSidebarSection` | 侧边栏分区 | `sidebar/SidebarContent.tsx` | 贡献标识 |
| `setContentView` | 主内容区 | `workspace/WorkbenchStage.tsx` | 贡献标识 |
| `setComposerToolbar` | 输入框工具栏 | `session/ComposerArea.tsx` | 贡献标识 |
| `setTitlebarAction` | 窗口/标签栏动作 | `AppHeader.tsx` | 贡献标识 |
| `setBanner` | 顶部横幅 | `session/SessionView.tsx` | 贡献标识 |
| `setToolExtra` | 工具结果卡内部 | `session/ToolCallComponents.tsx` | **`toolName`** |
| `setMessageExtra` | 消息气泡内部下方 | `session/turn/TurnRow.tsx` | **`role`**（TurnRow 按 `assistant` 匹配） |
| `setThinkingExtra` | 折叠思考块内 | `session/TimelineEventCards.tsx` | 贡献标识 |
| `setDialogAction` | 对话框按钮区 | `ui-shadcn/ConfirmDialog.tsx` | 贡献标识 |
| `setDialogBody` | 对话框主体下方 | `ui-shadcn/ConfirmDialog.tsx` | 贡献标识 |
| `setSettingsSection` | 设置弹窗内 | `app/SettingsModal.tsx` | 贡献标识 |
| `setSessionItemExtra` | 会话列表条目 | `sidebar/SessionTree.tsx` | 贡献标识 |
| `setContextMenuItem` | 右键菜单 | `sidebar/SidebarComponents.tsx` | 贡献标识 |

> **行号刻意不列** —— 它必然漂移。要精确定位就用 `tools/extract-points.mjs --check`，
> 它会校验宿主文件里真的用了这个 slot。

### 3.2 排序与 key 语义

- 落点 id 形态 `gui:<slot>:<key>`，宿主按前缀聚合
- **排序在渲染层做**：`order` 升序（缺省 `1000`），同 `order` 按 key 字母序。
  桥是「推一帧是一帧」，无法保证到达顺序 —— **宿主排序才是唯一正确的收敛点**
- `factory` 传 `undefined` → 移除该 key，位置**回到原样（不占位）**
- 同 `key` 重复设置 → **后设覆盖**
- 不同 `key` → **共存**
- 无贡献时组件返回 `null` → **不产生空 div、不加 margin/gap**

### 3.3 ⚠️ 已知覆盖缺口

两个落点的宿主在仓库里**并非处处唯一**，当前只接了覆盖面最广的那处：

| 落点 | 已接 | 未接 |
|---|---|---|
| `session.item` | `SessionTree` 的历史会话行 | `ActiveSessionsTree`、`RecentSessionsSection`、`SessionTabsBar` |
| `context.menu` | `MenuShell`（侧边栏右键菜单共享壳） | 非 `MenuShell` 的右键菜单 |

> 计划本身就注明这两处「无统一宿主」。**不是实现遗漏，是宿主分散**。

### 3.4 权力边界：只追加

- 扩展**只能往上面的位置插入内容**，**不能改动、不能顶掉** PiDeck 原有 UI
- 附加型位置（`toolExtra` / `messageExtra` / `thinkingExtra`）的语义是
  「**在默认内容旁边追加**」，**不是**「顶替默认内容」
- 某位置 PiDeck 尚未实现 → 记为 pending，**不报错**

> **唯一例外**：`ctx.ui.setHeader` / `setFooter` 是 pi 的「整块替换」语义
> （无 `key`，最后设置的胜出）。桥忠实保留 pi 原语义，没改成「只追加」。

---

## 4. `ctx.gui` 的交互与服务（6 个）

| API | 说明 |
|---|---|
| `ctx.gui.custom()` | GUI 作画工厂。**四参数与 `ctx.ui.custom` 一一对应**，只换画框与画笔 |
| `ctx.gui.toast(msg, {tone, actions})` | 带动作按钮的 toast（比 `notify` 强） |
| `ctx.gui.confirm(title, body, opts)` | 富内容确认框（可塞自定义 body 节点） |
| `ctx.gui.overlay(node, opts)` | 开一个独立覆盖层，返回 `GuiHandle` |
| `ctx.gui.command(id, handler)` | 注册命令面板命令 |
| `ctx.gui.icon(name, svgPath)` | 注册图标（内置名或 SVG path） |

### `ctx.gui.custom()` 的四参数对照

| # | TUI | GUI |
|---|---|---|
| 1 | `tui: TUI` | `gui: GuiSurface` |
| 2 | `theme: Theme` | `theme: GuiTheme` |
| 3 | `keybindings: KeybindingsManager` | `keybindings: GuiKeybindings` |
| 4 | `done: (result: T) => void` | 同（原样） |

**组件接口同形，只把「画出来是什么」换掉**：

```ts
// TUI
interface Component { render(width: number): string[];  handleInput?(data: string): void; }
// GUI
interface GuiComponent { render(): GuiNode;  handleAction?(actionId: string, payload?: unknown): void; }
```

`GuiNode` **两种写法都接受**（完全等价）：

```ts
// 写法 A：控件工厂（类型安全，推荐手写）
{ kind: "stack", direction: "column", gap: 8, children: [...] }

// 写法 B：对象字面量（agent 生成最省事）
{ kind: "stack", direction: "column", gap: 8, children: [...] }
```

**回调是 pi 进程里的真闭包，不需要序列化**：桥给每个交互节点分配 `actionId`，
只把这个 id 推给 PiDeck；用户点了 → PiDeck 回传 `actionId` → 桥在进程内调回调。

---

## 5. 控件词汇表（`GuiNode` 的 ~30 个 kind）

| 分类 | kind |
|---|---|
| **布局（6）** | `stack`（column/row + gap/align）、`grid`、`split`、`card`、`spacer`、`scroll` |
| **基础（6）** | `text`、`markdown`、`badge`、`divider`、`icon`、`image` |
| **交互（8）** | `button`、`input`、`textarea`、`select`、`checkbox`、`switch`、`slider`、`list` |
| **数据（7）** | `table`、`tree`、`keyvalue`、`codeblock`、`progress`、`spinner`、`tabs` |
| **反馈（3）** | `modal`、`toast`、`banner` |
| **降级** | `ansi`（认不出的组件渲染成剥了 ANSI 的等宽文本块） |

### 配色铁律

扩展**只能选语义档**，**不能指定颜色值**：

- `tone`：`default` / `muted` / `accent` / `success` / `warning` / `danger`
- `variant`：`solid` / `outline` / `ghost`

真实色值由 PiDeck 主题与亮/暗模式决定 → 天然无样式污染，且自动跟随主题。
**指定颜色值会被忽略。**

---

## 6. 事件回灌契约

GUI 上的一次点击 → PiDeck 回传事件 → 桥在 pi 进程内调**公开方法** →
扩展自己的 `onSelect` / `onSubmit` 回调**原样触发**。

| GUI 操作 | 桥对组件做的 |
|---|---|
| 点选列表第 i 项 | `setSelectedIndex(i)` + `handleInput("\r")` |
| 悬停列表第 i 项 | `handleInput("\u001b[B"/"\u001b[A")`（方向键序列） |
| 输入框改值 | `setValue(v)` |
| 按 Enter | `handleInput("\r")` |
| 点按钮 | 进程内直接调 `onPress`（按 `actionId` 找到） |

> ⚠️ **回灌送的是原始字节，不是 `Key.*` 常量**。
> `handleInput` 匹配的是**全局 keybinding**，而 `Key.enter` 的值是字面量 `"enter"` ——
> 送它会静默不触发回调。这条是实测踩出来的，别改回去。

**只调公开方法**，**绝不直接改私有字段** —— 那会让扩展的回调不触发，行为分叉。

**限制**：回灌只承诺 `select` / `navigate` / `input` / `key` / `filter` / `action` 六类。
部分组件的交互无法用公开方法驱动（如 `Editor` 的光标）→ 该组件降级为只读展示。

---

## 7. 容错承诺（fail-safe）

桥的任何失败都只表现为「**某个点在 GUI 里没出现**」：

- pi 会话照常，PiDeck 照常
- 未知组件 → 降级为**剥了 ANSI 的等宽文本块**，绝不白屏
- 任一适配器取不到私有字段 → 该组件降级，不抛错
- 非法贡献（`key` 为空 / 返回非 `GuiNode` / 节点过深或过多）→ 该贡献隐藏并记日志
- `PIDECK_BRIDGE_URL` 缺失（纯终端跑 pi）→ 桥**静默不工作**，pi 行为不变
- 扩展 `factory` / `render()` 抛错 → 该贡献隐藏，不牵连其他

---

## 8. 相关文档

| 文档 | 内容 |
|---|---|
| [README.md](../README.md) | 作者文档：完整 API、移植指南、示例 |
| `tools/catalog.json` | **机器可读**扩展点清单（供列表 UI 消费） |
| `tools/extract-points.mjs` | 抽取脚本（pi/PiDeck 升级后重跑） |
