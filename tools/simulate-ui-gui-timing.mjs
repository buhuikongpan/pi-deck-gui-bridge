#!/usr/bin/env node
/**
 * 时序模拟测试：「桥最先可用」+ TUI 守卫（PROMPT-桥最先可用.md 验收 4/6，2026-02-23）。
 *
 * 场景覆盖（全部断言通过即退出码 0）：
 * [1] PiDeck RPC 会话：用户扩展先注册 → 桥后跑 patch ui → 后续事件 ctx.ui.gui 可用
 *     （验收 6 的主时序；包装按 RPC 语义发生）
 * [2] project_trust：桥弃权信任判定（undecided），trust ui 尽力挂 gui（验收 2）
 * [3] 低层：recording transport 验证贡献推送、去重、/reload 幂等（验收 3）
 * [4] 纯终端（PIDECK_BRIDGE_URL 未设）：gui 仍挂，但 **ctx.ui 函数面一个不改**（验收 4）
 * [5] TUI 模式守卫（URL 已设但 mode="tui"）：同样不改函数面（终端渲染不被夺走）
 *
 * 用 jiti 直接加载**真实桥代码**，runner 语义按 pi dist 2026-02 快照复刻：
 * - emit：一次 emit 只建一次 ctx，handler 按注册顺序共享（runner.js emit）；
 * - ctx.ui：活 getter `get ui() { return runner.uiContext }`；
 * - setUIContext(uiContext, mode)：mode 值域 "tui" | "print" | "json" | "rpc"；
 * - project_trust：ctx 由调用方现造（interactive-mode.js:1962，字面量 ui），
 *   handler 返回 `{trusted}`，首个 yes/no 生效，undecided 落空（emitProjectTrustEvent）。
 *
 * 运行：node tools/simulate-ui-gui-timing.mjs
 * （jiti 从同仓 PiDeck-dev 或全局 npm 目录探测；纯 node 环境无构建步骤）
 */

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, ".."); // pi-deck-gui-bridge/

// ── jiti 探测（PiDeck-dev → 全局 npm）────────────────────────────
async function loadJiti() {
	const candidates = [
		process.env.PI_JITI_PATH,
		join(repoRoot, "..", "PiDeck-dev", "node_modules", "jiti", "lib", "jiti.mjs"),
		join(process.env.APPDATA ?? "", "npm", "node_modules", "jiti", "lib", "jiti.mjs"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			const mod = await import(pathToFileURL(candidate).href);
			if (typeof mod.createJiti === "function") return mod.createJiti;
		}
	}
	throw new Error("找不到 jiti（设置 PI_JITI_PATH 指向 jiti/lib/jiti.mjs 可重试）");
}

const createJiti = await loadJiti();
const jiti = createJiti(pathToFileURL(join(here, "import-any.mjs")).href);
const bridge = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge.ts")).href);
const guiSpec = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-gui-spec.ts")).href);
const guiModule = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-gui.ts")).href);
const runtimeModule = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-runtime.ts")).href);

// ── 断言器 ──────────────────────────────────────────────────────
let failures = 0;
function ok(condition, label) {
	if (condition) {
		console.log(`  ✓ ${label}`);
	} else {
		failures++;
		console.error(`  ✗ ${label}`);
	}
}

// ── 迷你 pi runner（按 dist 语义复刻）───────────────────────────
function createMiniPi() {
	const noOpUIContext = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setWidget: () => {},
		setStatus: () => {},
		theme: {},
	};
	/** pi 的 ExtensionAPI.on：注册即按顺序入表（= 扩展加载顺序）。 */
	const handlersByEvent = new Map(); // event -> Array<{ fn }>
	const pi = {
		on(event, handler) {
			const list = handlersByEvent.get(event) ?? [];
			list.push({ fn: handler });
			handlersByEvent.set(event, list);
			return () => {};
		},
	};
	const runner = {
		uiContext: noOpUIContext,
		mode: "print",
		wrapUIPromptContext(ui) {
			// 与 runner.js 相同：spread 出新对象，仅 prompt 系方法换实现（测试不关心）
			return { ...ui };
		},
		setUIContext(ui, mode = "print") {
			// runner 生命周期内只调一次（session 开始前）
			this.uiContext = ui ? this.wrapUIPromptContext(ui) : noOpUIContext;
			this.mode = mode;
		},
		createContext() {
			const r = this;
			return {
				get ui() {
					return r.uiContext;
				},
				get mode() {
					return r.mode;
				},
			};
		},
		async emit(eventType) {
			// 一次 emit 只建一次 ctx，所有 handler 按注册顺序共享执行
			const ctx = this.createContext();
			for (const { fn } of handlersByEvent.get(eventType) ?? []) {
				await fn({ type: eventType }, ctx);
			}
		},
	};
	return { pi, runner, handlersByEvent };
}

function noOpLike() {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		setWidget: () => {},
		setStatus: () => {},
		theme: {},
	};
}

// emitProjectTrustEvent 复刻：ctx 由调用方现造（字面量 ui），undecided 落空
async function emitProjectTrust(handlersByEvent) {
	const projectTrustContext = {
		cwd: process.cwd(),
		mode: "rpc",
		hasUI: true,
		ui: {
			// 与 interactive-mode.js:1962 相同：每次现造的字面量，**不是** session 单例
			...noOpLike(),
		},
	};
	for (const { fn } of handlersByEvent.get("project_trust") ?? []) {
		const result = await fn({ type: "project_trust", cwd: projectTrustContext.cwd }, projectTrustContext);
		if (result?.trusted === "yes" || result?.trusted === "no") return { decided: true, context: projectTrustContext };
	}
	return { decided: false, context: projectTrustContext };
}

// PiDeck RPC 环境变量：指向不可达端点（fail-safe：push 失败被桥吞掉，不影响挂载）
const RPC_ENV = { PIDECK_BRIDGE_URL: "http://127.0.0.1:9/" };

// ── [1] PiDeck RPC：用户扩展先注册，桥后注册 ────────────────────
console.log("\n[1] PiDeck RPC 会话：用户扩展先注册 → 桥后跑 patch ui → 后续事件 ctx.ui.gui 可用");
{
	Object.assign(process.env, RPC_ENV);
	runtimeModule.resetBridgeRuntimeForTests();
	const { pi, runner, handlersByEvent } = createMiniPi();

	// 用户扩展（先加载 ⇒ handler 注册在前）
	const observed = {};
	pi.on("session_start", async (_e, ctx) => {
		observed.uiGuiAtSessionStart = ctx.ui?.gui;
		observed.ctxGuiAtSessionStart = ctx.gui;
	});
	pi.on("agent_start", async (_e, ctx) => {
		observed.uiGuiAtAgentStart = ctx.ui?.gui;
		observed.ctxGuiAtAgentStart = ctx.gui; // 用户 handler 先跑：此刻新 ctx 上桥还没挂 getter
		observed.setterType = typeof ctx.ui?.gui?.setSettingsSection;
		observed.uiIsWrapped = typeof ctx.ui?.setWidget === "function";
	});

	// 桥（-e 注入 ⇒ 后加载 ⇒ handler 注册在后）：直接用真实 default 工厂
	bridge.default(pi);

	// pi 启动序：project_trust（trust 期 ctx.ui 是临时对象）→ setUIContext → session_start
	const trust = await emitProjectTrust(handlersByEvent);
	ok(trust.decided === false, "project_trust：桥弃权信任判定（undecided，pi 信任流程不变）");
	runner.setUIContext({ ...noOpLike() }, "rpc");
	await runner.emit("session_start");

	ok(observed.ctxGuiAtSessionStart === undefined, "session_start 同步段（用户扩展先注册）：ctx.gui 尚未挂上（已知时序缺口，桥 handler 在其后）");
	ok(observed.uiGuiAtSessionStart === undefined, "session_start 同步段：ctx.ui.gui 同样尚未挂上（同上）");

	await runner.emit("agent_start");
	ok(observed.uiGuiAtAgentStart && typeof observed.uiGuiAtAgentStart === "object", "agent_start：ctx.ui.gui 已可用（无需任何 timer 重试）");
	ok(observed.ctxGuiAtAgentStart === undefined, "agent_start 用户 handler 里 ctx.gui 仍 undefined（桥 handler 在后；这恰是 ui.gui 方案的价值）");
	ok(observed.setterType === "function", "ctx.ui.gui.setSettingsSection 可调用");
	ok(observed.uiIsWrapped === true, "ctx.ui 已被桥包装（wrapUI 同机制生效，RPC 语义）");

	// /reload：pi 重新执行扩展模块，runner.uiContext 仍是同一对象 → 再 emit session_start 幂等
	await runner.emit("session_start");
	const guiAfterReload = runner.uiContext.gui;
	ok(guiAfterReload && typeof guiAfterReload.setSettingsSection === "function", "/reload 后 ctx.ui.gui 仍可用（同一单例，不重复挂、不抛错）");

	// session_shutdown：停 ticker、清贡献，/reload 后新 session 重建全新 runtime
	await runner.emit("session_shutdown");
	await runner.emit("session_start");
	ok(typeof runner.uiContext.gui?.setSettingsSection === "function", "shutdown 后新 session：ui.gui 重新挂上（runtime 重建，无「静默死亡」）");
	await runner.emit("session_shutdown");
}

// ── [2] project_trust 铺垫：trust ui 挂 gui ─────────────────────
console.log("\n[2] project_trust：桥弃权信任判定（undecided），trust ui 尽力挂 gui");
{
	Object.assign(process.env, RPC_ENV);
	runtimeModule.resetBridgeRuntimeForTests();
	const { pi, handlersByEvent, runner } = createMiniPi();
	bridge.default(pi);
	const { context } = await emitProjectTrust(handlersByEvent);
	ok(typeof context.ui.gui === "object", "trust ui（临时对象）也被尽力挂上 gui（惠及信任期内取用的扩展）");
	runner.setUIContext({ ...noOpLike() }, "rpc");
	await runner.emit("session_start");
	ok(context.ui.gui === runner.uiContext.gui, "trust ui.gui 与 session ui.gui 是同一 namespace（按 runtime 记忆化）");
	await runner.emit("session_shutdown");
}

// ── [3] 低层：recording transport 验证贡献推送与去重 ────────────
console.log("\n[3] 低层：setSettingsSection 真实推送 settings.section 贡献，重设不重复");
{
	delete process.env.PIDECK_BRIDGE_URL;
	runtimeModule.resetBridgeRuntimeForTests(); // 摆脱 [1]/[2] 建过的模块级单例
	const pushed = [];
	const transport = {
		available: true,
		push(update) {
			pushed.push(update);
		},
		onEvent() {},
		close() {},
	};
	const runtime = runtimeModule.getBridgeRuntime(transport);
	const fakeCtx = { ui: noOpLike(), mode: "rpc", hasUI: true };

	guiModule.installGuiNamespace(fakeCtx, runtime);
	const uiAttached = guiModule.installGuiOnUiSingleton(fakeCtx.ui, runtime);
	ok(uiAttached === true, "installGuiOnUiSingleton 首次挂载返回 true");
	ok(guiModule.installGuiOnUiSingleton(fakeCtx.ui, runtime) === false, "重复挂载返回 false（幂等）");
	ok(fakeCtx.ui.gui === fakeCtx.gui, "ctx.gui === ui.gui（同一 memoized namespace）");

	// factory 返回 GuiNode（合法 kind）→ 直接包一层极简组件
	fakeCtx.ui.gui.setSettingsSection("ext-points", () => ({ kind: "text", text: "hi" }), { title: "扩展点", order: 900 });
	const update = pushed.find((u) => u?.type === "ui-update" && u?.targetId === "gui:settings.section:ext-points");
	ok(Boolean(update), "贡献已推送：targetId=gui:settings.section:ext-points");
	ok(update?.node && typeof update.node === "object", "推送的 node 非空（render 求值成功）");
	ok(guiSpec.guiState(runtime).contributions.size === 1, "贡献表恰 1 条");

	// 重设同 key → 替换不重复；/reload（新 ctx、同 runtime）→ 幂等
	fakeCtx.ui.gui.setSettingsSection("ext-points", () => ({ kind: "text", text: "hi" }), { title: "扩展点", order: 900 });
	ok(guiSpec.guiState(runtime).contributions.size === 1, "同 key 重设：贡献表仍 1 条（替换而非新增）");
	const fakeCtx2 = { ui: noOpLike(), mode: "rpc", hasUI: true };
	guiModule.installGuiNamespace(fakeCtx2, runtime);
	guiModule.installGuiOnUiSingleton(fakeCtx2.ui, runtime);
	fakeCtx2.ui.gui.setSettingsSection("ext-points", () => ({ kind: "text", text: "hi" }), { title: "扩展点", order: 900 });
	ok(guiSpec.guiState(runtime).contributions.size === 1, "/reload 新 ctx 重设同 key：贡献表仍 1 条（幂等，无泄漏）");

	// state.ctx 不被 ui 单例路径污染：仍是 installGuiNamespace 最后一次传入的真 ctx
	ok(guiSpec.guiState(runtime).ctx === fakeCtx2, "state.ctx 只由 installGuiNamespace 写入（project_trust 路径不污染渲染上下文）");

	runtime.shutdown();
}

// ── [4] 纯终端：不改函数面 ──────────────────────────────────────
console.log("\n[4] 纯终端（PIDECK_BRIDGE_URL 未设）：gui 仍挂上，ctx.ui 函数面一个不改");
{
	delete process.env.PIDECK_BRIDGE_URL;
	runtimeModule.resetBridgeRuntimeForTests();
	const { pi, runner, handlersByEvent } = createMiniPi();
	bridge.default(pi);
	await emitProjectTrust(handlersByEvent);
	const uiInstance = noOpLike();
	runner.setUIContext(uiInstance, "print"); // 终端 print 模式
	await runner.emit("session_start");
	ok(typeof runner.uiContext.gui?.setSettingsSection === "function", "无 PIDECK_BRIDGE_URL 时 ui.gui 仍挂（静默但可用，PROMPT §五）");
	ok(runner.uiContext.setWidget === uiInstance.setWidget, "ctx.ui.setWidget 未被替换（原函数引用不变 → pi 行为 100% 不变）");
	ok(runner.uiContext.setStatus === uiInstance.setStatus, "ctx.ui.setStatus 未被替换");
	ok(runner.uiContext.__pideckBridgeWrapped !== true, "无包装标记（wrapUI 未执行）");
	await runner.emit("session_shutdown");
}

// ── [5] TUI 模式守卫：URL 已设但 mode="tui" ─────────────────────
console.log("\n[5] TUI 模式守卫（URL 已设 + mode=tui）：桥不接管 UI，函数面不变");
{
	Object.assign(process.env, RPC_ENV);
	runtimeModule.resetBridgeRuntimeForTests();
	const { pi, runner, handlersByEvent } = createMiniPi();
	bridge.default(pi);
	await emitProjectTrust(handlersByEvent);
	const uiInstance = noOpLike();
	runner.setUIContext(uiInstance, "tui"); // 终端交互模式：pi 原生渲染组件
	await runner.emit("session_start");
	ok(typeof runner.uiContext.gui?.setSettingsSection === "function", "TUI 模式下 ui.gui 仍挂（扩展取用不炸）");
	ok(runner.uiContext.setWidget === uiInstance.setWidget, "ctx.ui.setWidget 未被替换（终端组件渲染不被夺走）");
	ok(runner.uiContext.__pideckBridgeWrapped !== true, "无包装标记（wrapUI 未执行）");
	await runner.emit("session_shutdown");
}

delete process.env.PIDECK_BRIDGE_URL;
console.log(failures === 0 ? "\n全部断言通过 ✓" : `\n${failures} 条断言失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
