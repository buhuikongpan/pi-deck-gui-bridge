#!/usr/bin/env node
/**
 * 抽取 pi 与 PiDeck 的扩展点，产出机器可读的 `catalog.json`。
 *
 * 用途：给「扩展点面板」类扩展（辅助用户开发 pi/PiDeck 扩展）提供数据源。
 * 参照 `dsh-ext-points` 的做法：**数据在构建时抽取**，产物随包分发。
 *
 * ## 数据来源（全部是权威来源，不靠记忆）
 *
 * | 类别 | 来源 |
 * |---|---|
 * | pi 原生 UI 扩展点 | `<pi>/dist/core/extensions/types.d.ts` 的 `ExtensionUIContext` |
 * | pi 扩展事件 | 同文件的 `ExtensionEvent` 联合 + 各 `XxxEvent` 的 `type` 字面量 |
 * | PiDeck 专属扩展点 | 桥的 `pi-deck-gui-bridge-gui-spec.ts` 的 `GUI_SLOT_METHODS` |
 * | 落点宿主 | 本脚本内的**策展表** + 对 PiDeck 源码做存在性校验 |
 *
 * ## 为什么宿主落点要策展
 *
 * 「这个扩展点挂在哪个文件的哪一行」是**实现事实**，无法从类型定义推出。
 * 因此本脚本内维护一张策展表，并**逐个校验宿主文件存在**（`verifyHosts`），
 * 避免表漂移成谎话。行号刻意不记 —— 它必然漂移，记了反而误导。
 *
 * 用法：
 *   node scripts/extract.mjs                 # 写 catalog.json
 *   node scripts/extract.mjs --check         # 只校验策展表，不写盘
 *   node scripts/extract.mjs --pi <pi路径>   # 指定 pi 安装目录
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

/** PiDeck 仓库根（相对本包）。可用 --pideck 覆盖。 */
const DEFAULT_PIDECK_ROOT = resolve(PKG_ROOT, "..", "pideck");

// ── pi 安装目录定位（与桥的加载器同一套策略）────────────────────

function resolvePiPackageDir(explicit) {
	const require_ = createRequire(import.meta.url);
	const { homedir } = require_("node:os");
	const candidates = [];
	if (explicit) candidates.push(explicit);
	if (process.env.PIDECK_BRIDGE_PI_PATH) candidates.push(process.env.PIDECK_BRIDGE_PI_PATH);
	const execDir = dirname(process.execPath);
	const globalRoots = [
		process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
		join(execDir, "..", "lib", "node_modules"),
		join(execDir, "node_modules"),
		join(homedir(), ".npm-global", "lib", "node_modules"),
	].filter(Boolean);

	const probe = (dir) => {
		if (!dir) return null;
		const pkgDir = join(dir, "@earendil-works", "pi-coding-agent");
		return existsSync(join(pkgDir, "package.json")) ? pkgDir : null;
	};
	for (const candidate of candidates) {
		const fromExplicit = candidate.replace(/[\\/]dist[\\/].*$/, "");
		const hit = probe(dirname(fromExplicit)) ?? probe(fromExplicit);
		if (hit) return hit;
	}
	for (const root of globalRoots) {
		const hit = probe(root);
		if (hit) return hit;
	}
	return null;
}

// ── 从 pi 的 .d.ts 抽 UI 扩展点 ─────────────────────────────────

/** 抽 `ExtensionUIContext` 的成员（方法签名 + 只读属性）。 */
function extractUiContextMembers(typesDts) {
	const match = typesDts.match(/export interface ExtensionUIContext \{([\s\S]*?)\n\}/);
	if (!match) return [];
	const body = match[1];
	const members = [];
	// 方法：`name(args): Return;` 或泛型 `name<T>(args): Return;`（可能跨行）
	// 泛型参数必须容忍 —— `custom<T>` 就是这种，早期版本漏了它会误报「pi 版本变了」。
	for (const m of body.matchAll(/^\s{4}(\w+)\s*(<[^>]*>)?\s*\(([\s\S]*?)\)\s*:\s*([^;]+);/gm)) {
		const generics = m[2] ?? "";
		const params = m[3].replace(/\s+/g, " ").trim();
		members.push({ name: m[1], signature: `${m[1]}${generics}(${params}): ${m[4].replace(/\s+/g, " ").trim()}`, kind: "method" });
	}
	// 只读属性：`readonly name: Type;`
	for (const m of body.matchAll(/^\s{4}readonly\s+(\w+)\s*:\s*([^;]+);/gm)) {
		members.push({ name: m[1], signature: `readonly ${m[1]}: ${m[2].trim()}`, kind: "property" });
	}
	return members;
}

/** 抽 pi 的扩展事件名（各 `XxxEvent` 接口的 `type` 字面量）。 */
function extractEventNames(typesDts) {
	const names = new Set();
	for (const m of typesDts.matchAll(/interface (\w+Event)\b[^{]*\{([\s\S]*?)\n\}/g)) {
		const literal = m[2].match(/type:\s*"([^"]+)"/);
		if (literal) names.add(literal[1]);
	}
	return [...names].sort();
}

// ── 从桥抽 PiDeck 专属扩展点 ───────────────────────────────────

/** 抽桥的 `GUI_SLOT_METHODS`（方法名 → 落点名）。 */
function extractGuiSlots(bridgeRoot) {
	const file = join(bridgeRoot, "pi-deck-gui-bridge-gui-spec.ts");
	if (!existsSync(file)) throw new Error(`找不到桥的 spec 文件: ${file}`);
	const source = readFileSync(file, "utf8");
	const block = source.match(/export const GUI_SLOT_METHODS = \{([\s\S]*?)\} as const;/);
	if (!block) throw new Error("找不到 GUI_SLOT_METHODS 定义");
	const slots = [];
	for (const m of block[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
		slots.push({ method: m[1], slot: m[2] });
	}
	return slots;
}

// ── 策展表：宿主落点与状态 ─────────────────────────────────────

/**
 * pi 原生 UI 扩展点在 PiDeck 里的处理方式。
 *
 * `bridge: "wired"` = 桥接管并落到 GUI；`"passthrough"` = 保持原路不动；
 * `"not-bridged"` = 刻意不桥接（附原因）。
 */
const UI_POINT_HANDLING = {
	select: { bridge: "passthrough", note: "PiDeck 已有时间线卡片，桥不动" },
	confirm: { bridge: "passthrough", note: "PiDeck 已有确认卡片，桥不动" },
	input: { bridge: "passthrough", note: "PiDeck 已有输入卡片，桥不动" },
	notify: { bridge: "passthrough", note: "PiDeck 已有 toast（主进程已清洗 ANSI）" },
	editor: { bridge: "passthrough", note: "PiDeck 已有多行编辑器弹框" },
	pasteToEditor: { bridge: "passthrough", note: "走 setEditorText 原路" },
	setEditorText: { bridge: "passthrough", note: "已有落点（含既有去重键，桥不碰）" },
	getEditorText: { bridge: "passthrough", note: "同步读，RPC 下 pi 返回空串，桥不接管" },
	getToolsExpanded: { bridge: "passthrough", note: "已有落点" },
	setToolsExpanded: { bridge: "passthrough", note: "已有落点" },
	theme: { bridge: "passthrough", note: "桥另供一份哨兵 theme 给扩展用" },
	getAllThemes: { bridge: "passthrough", note: "RPC 下 pi 返回空数组" },
	getTheme: { bridge: "passthrough", note: "RPC 下 pi 返回 undefined" },
	setTheme: { bridge: "passthrough", note: "RPC 下 pi 返回失败" },
	setStatus: { bridge: "wired", note: "全量接管为状态栏条目（多 key 共存）；同时仍转发原实现，保住 pideck:auto-title" },
	setWidget: { bridge: "wired", note: "字符串形式保持原路；组件形式被桥接（RPC 下原本被直接丢弃）" },
	setFooter: { bridge: "wired", note: "调 factory 求值后翻译成 UINode" },
	setHeader: { bridge: "wired", note: "同上" },
	setWorkingMessage: { bridge: "wired", note: "流式状态行文案" },
	setWorkingVisible: { bridge: "wired", note: "流式状态行显隐" },
	setWorkingIndicator: { bridge: "wired", note: "取 frames 映射成 GUI 指示器" },
	setHiddenThinkingLabel: { bridge: "wired", note: "替换折叠思考块标签" },
	setTitle: { bridge: "wired", note: "落到 document.title" },
	setEditorComponent: {
		bridge: "not-bridged",
		note: "拦截但不替换输入框：草稿状态在 PiDeck 的 atoms 里、不在 pi 进程；靠桥回灌每次按键要走 ~100ms 轮询；替换后发送/附件/斜杠命令全部失联",
	},
	// 与 setEditorComponent 配对：RPC 下 pi 恒返回 undefined（自定义输入框本就不支持）。
	// 桥不改这个语义 —— 若扩展读它来判断「我的输入框是否生效」，读到 undefined 是正确的。
	getEditorComponent: { bridge: "passthrough", note: "RPC 下 pi 恒返回 undefined（自定义输入框本就不支持），桥保持该语义" },
	custom: { bridge: "not-bridged", note: "画的是字符行，观感是终端风。GUI 对应物是 ctx.gui.custom()" },
	onTerminalInput: { bridge: "not-bridged", note: "GUI 里没有终端" },
	addAutocompleteProvider: { bridge: "not-bridged", note: "GUI 输入框有自己的补全机制" },
};

/**
 * 14 个 PiDeck 专属落点的宿主（**策展**，由 verifyHosts 校验文件存在）。
 *
 * 行号刻意不记 —— 必然漂移。
 */
const GUI_SLOT_HOSTS = {
	"sidebar.panel": { host: "src/renderer/src/components/sidebar/SidebarContent.tsx", where: "conversation-list 内 ProjectTree 之后", keyMeaning: "贡献标识，可多 key 共存", order: true },
	"sidebar.section": { host: "src/renderer/src/components/sidebar/SidebarContent.tsx", where: "同上", keyMeaning: "贡献标识", order: true },
	"content.view": { host: "src/renderer/src/components/workspace/WorkbenchStage.tsx", where: "workbench-content-frame 内", keyMeaning: "贡献标识", order: true },
	"composer.toolbar": { host: "src/renderer/src/components/session/ComposerArea.tsx", where: "底栏之后、输入卡之内", keyMeaning: "贡献标识", order: true },
	"titlebar.action": { host: "src/renderer/src/components/AppHeader.tsx", where: "与 window-controls 同级（显式 no-drag）", keyMeaning: "贡献标识", order: true },
	banner: { host: "src/renderer/src/components/session/SessionView.tsx", where: "标题栏之下、SessionBranchBar 之前", keyMeaning: "贡献标识", order: true },
	"tool.extra": { host: "src/renderer/src/components/session/ToolCallComponents.tsx", where: "ToolCard 默认内容之下", keyMeaning: "**toolName**（只在该工具的工具卡内显示）", order: true },
	"message.extra": { host: "src/renderer/src/components/session/turn/TurnRow.tsx", where: "助手回合 </article> 之前", keyMeaning: "**role**（TurnRow 按 assistant 匹配）", order: true },
	"thinking.extra": { host: "src/renderer/src/components/session/TimelineEventCards.tsx", where: "ThinkingBlock 展开区内", keyMeaning: "贡献标识", order: true },
	"dialog.action": { host: "src/renderer/src/components/ui-shadcn/ConfirmDialog.tsx", where: "AlertDialogFooter 内、既有按钮之前", keyMeaning: "贡献标识", order: true },
	"dialog.body": { host: "src/renderer/src/components/ui-shadcn/ConfirmDialog.tsx", where: "AlertDialogHeader 之后", keyMeaning: "贡献标识", order: true },
	"settings.section": { host: "src/renderer/src/components/app/SettingsModal.tsx", where: "全部设置 tab 之下", keyMeaning: "贡献标识", order: true },
	"config.page": { host: "src/renderer/src/ConfigModal.tsx", where: "「Pi 管理」侧栏「Agent 能力」组内（一项一个二级 TabTrigger + 对应 TabContent）", keyMeaning: "贡献标识，`slot.title` 即导航项文字，可多页共存", order: true },
	"session.item": { host: "src/renderer/src/components/sidebar/SessionTree.tsx", where: "历史会话行之后", keyMeaning: "贡献标识", order: true },
	"context.menu": { host: "src/renderer/src/components/sidebar/SidebarComponents.tsx", where: "MenuShell（侧边栏右键菜单共享壳）内、原有条目之后", keyMeaning: "贡献标识", order: true },
};

/** 覆盖缺口：宿主并非处处唯一，已接的只是主宿主。 */
const KNOWN_COVERAGE_GAPS = {
	"session.item": ["ActiveSessionsTree", "RecentSessionsSection", "SessionTabsBar"],
	"context.menu": ["非 MenuShell 的右键菜单"],
};

// ── 校验 ───────────────────────────────────────────────────────

function verifyHosts(pideckRoot) {
	// 宿主校验需要 PiDeck 源码。**独立仓库里通常没有** —— 那种情况下跳过而不是失败：
	// 「落点挂在哪个文件」是 PiDeck 侧的实现事实，开源仓库的读者拿不到它也不影响用桥。
	if (!pideckRoot || !existsSync(pideckRoot)) return [];
	const problems = [];
	for (const [slot, meta] of Object.entries(GUI_SLOT_HOSTS)) {
		const absolute = join(pideckRoot, meta.host);
		if (!existsSync(absolute)) {
			problems.push(`落点 "${slot}" 的宿主不存在: ${meta.host}`);
			continue;
		}
		// 宿主文件里必须真的用了这个 slot（防止策展表与代码漂移）
		const source = readFileSync(absolute, "utf8");
		if (!source.includes(`slot="${slot}"`)) {
			problems.push(`落点 "${slot}" 的宿主 ${meta.host} 里找不到 slot="${slot}" 的使用`);
		}
	}
	return problems;
}

// ── 主流程 ─────────────────────────────────────────────────────

function main() {
	const argv = process.argv.slice(2);
	const checkOnly = argv.includes("--check");
	const piArg = argv.includes("--pi") ? argv[argv.indexOf("--pi") + 1] : null;
	const pideckArg = argv.includes("--pideck") ? argv[argv.indexOf("--pideck") + 1] : null;
	const pideckRoot = pideckArg ? resolve(pideckArg) : DEFAULT_PIDECK_ROOT;

	const piDir = resolvePiPackageDir(piArg);
	if (!piDir) {
		console.error("[extract] 找不到 pi 安装目录；用 --pi <路径> 显式指定");
		process.exitCode = 1;
		return;
	}
	const piVersion = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version;
	const typesDts = readFileSync(join(piDir, "dist/core/extensions/types.d.ts"), "utf8");

	// 桥的目录：本包同级，或 pideck 的 resources/extensions
	const bridgeRoot = existsSync(join(PKG_ROOT, "pi-deck-gui-bridge.ts")) ? PKG_ROOT : join(pideckRoot, "resources", "extensions");
	if (!existsSync(join(bridgeRoot, "pi-deck-gui-bridge-gui-spec.ts"))) {
		console.error(`[extract] 找不到桥的源码目录（试过 ${PKG_ROOT} 与 ${join(pideckRoot, "resources", "extensions")}）`);
		process.exitCode = 1;
		return;
	}

	const uiMembers = extractUiContextMembers(typesDts);
	const events = extractEventNames(typesDts);
	const guiSlots = extractGuiSlots(bridgeRoot);

	// ── 校验 ──
	const problems = [];
	if (uiMembers.length === 0) problems.push("没抽到 ExtensionUIContext 成员（pi 版本变了？）");
	if (events.length === 0) problems.push("没抽到扩展事件名");
	if (guiSlots.length !== 15) problems.push(`PiDeck 落点数应为 15，实际 ${guiSlots.length}`);
	for (const { slot } of guiSlots) {
		if (!GUI_SLOT_HOSTS[slot]) problems.push(`落点 "${slot}" 在策展表里没有宿主记录`);
	}
	for (const name of Object.keys(UI_POINT_HANDLING)) {
		if (!uiMembers.some((m) => m.name === name)) problems.push(`处理表里的 "${name}" 不在 pi 的 ExtensionUIContext 里（pi 版本变了？）`);
	}
	problems.push(...verifyHosts(pideckRoot));

	if (problems.length > 0) {
		console.error("[extract] 校验失败：");
		for (const p of problems) console.error(`  - ${p}`);
		process.exitCode = 1;
		if (!checkOnly) return;
	}

	// ── 组装 catalog ──
	// 同名方法可能是**重载**（如 setWidget 的 string[] / factory 两种签名）。
	// 两条都保留（签名不同、用法不同），但标出重载序号，让列表 UI 能合并成一条展示。
	const nameCount = new Map();
	for (const member of uiMembers) nameCount.set(member.name, (nameCount.get(member.name) ?? 0) + 1);
	const nameSeen = new Map();

	const uiPoints = uiMembers.map((member) => {
		const handling = UI_POINT_HANDLING[member.name];
		const total = nameCount.get(member.name) ?? 1;
		const index = (nameSeen.get(member.name) ?? 0) + 1;
		nameSeen.set(member.name, index);
		return {
			key: member.name,
			group: "pi-ui",
			kind: "method",
			signature: member.signature,
			bridgeStatus: handling?.bridge ?? "unclassified",
			note: handling?.note ?? "",
			// 重载信息：total > 1 时列表 UI 可合并展示，展开看全部签名
			overload: total > 1 ? { index, total } : undefined,
		};
	});

	const guiPoints = guiSlots.map(({ method, slot }) => {
		const meta = GUI_SLOT_HOSTS[slot];
		return {
			key: slot,
			group: "pideck-gui",
			kind: "keyed",
			method: `ctx.gui.${method}`,
			keyMeaning: meta?.keyMeaning ?? "贡献标识",
			host: meta?.host ?? "",
			where: meta?.where ?? "",
			order: meta?.order ?? false,
			coverageGaps: KNOWN_COVERAGE_GAPS[slot] ?? [],
			example: `ctx.gui.${method}("my-ext", (gui, theme) => ({ kind: "text", id: "t", text: "hello", tone: "accent" }), { order: 100 });`,
		};
	});

	const catalog = {
		schemaVersion: 1,
		piVersion,
		counts: {
			uiPoints: uiPoints.length,
			uiPointsBridged: uiPoints.filter((p) => p.bridgeStatus === "wired").length,
			events: events.length,
			guiPoints: guiPoints.length,
			total: uiPoints.length + events.length + guiPoints.length,
		},
		uiPoints,
		events: events.map((name) => ({ key: name, group: "pi-event", kind: "event" })),
		guiPoints,
		guiServices: [
			{ key: "custom", method: "ctx.gui.custom", summary: "GUI 作画工厂：四参数与 ctx.ui.custom 同形，画笔换成 GUI 控件" },
			{ key: "toast", method: "ctx.gui.toast", summary: "带动作按钮的 toast（比 notify 强）" },
			{ key: "confirm", method: "ctx.gui.confirm", summary: "富内容确认框（可塞自定义 body 节点）" },
			{ key: "overlay", method: "ctx.gui.overlay", summary: "开一个独立覆盖层，返回 handle" },
			{ key: "command", method: "ctx.gui.command", summary: "注册命令面板命令" },
			{ key: "icon", method: "ctx.gui.icon", summary: "注册图标（内置名或 SVG path）" },
		],
	};

	if (checkOnly) {
		console.log(`[extract] 校验通过：${catalog.counts.total} 个扩展点（pi ${piVersion}）`);
		return;
	}

	// 产物写在脚本旁边（tools/catalog.json）—— 开源仓库的约定
	const outPath = join(__dirname, "catalog.json");
	writeFileSync(outPath, `${JSON.stringify(catalog, null, "\t")}\n`, "utf8");
	console.log(`[extract] 已写出 ${outPath}`);
	console.log(`  pi ${piVersion}`);
	console.log(`  ctx.ui 扩展点 ${catalog.counts.uiPoints}（桥接 ${catalog.counts.uiPointsBridged}）`);
	console.log(`  扩展事件     ${catalog.counts.events}`);
	console.log(`  ctx.gui 落点 ${catalog.counts.guiPoints}`);
}

main();
