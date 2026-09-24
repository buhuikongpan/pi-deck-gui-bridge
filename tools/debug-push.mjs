#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
async function loadJiti() {
	const candidates = [
		join(repoRoot, "..", "PiDeck-dev", "node_modules", "jiti", "lib", "jiti.mjs"),
		join(process.env.APPDATA ?? "", "npm", "node_modules", "jiti", "lib", "jiti.mjs"),
	].filter(Boolean);
	for (const c of candidates) if (existsSync(c)) return (await import(pathToFileURL(c).href)).createJiti;
	throw new Error("no jiti");
}
const jiti = (await loadJiti())(pathToFileURL(join(here, "import-any.mjs")).href);
const bridge = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge.ts")).href);
const guiSpec = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-gui-spec.ts")).href);
const guiModule = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-gui.ts")).href);
const runtimeModule = await jiti.import(pathToFileURL(join(repoRoot, "pi-deck-gui-bridge-runtime.ts")).href);

// 完全复刻测试 [1] 的端到端段落（模块级 runtime 由 [1] 建立）
delete process.env.PIDECK_BRIDGE_URL;
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
const handlersByEvent = new Map();
const pi = { on(event, handler) { const l = handlersByEvent.get(event) ?? []; l.push({ fn: handler }); handlersByEvent.set(event, l); return () => {}; } };
bridge.default(pi);
const emit = async (t) => { for (const { fn } of handlersByEvent.get(t) ?? []) await fn({ type: t }, { get ui() { return undefined; }, get mode() { return "rpc"; } }); };
await emit("session_shutdown"); // [1] 结束时的 shutdown

// [3] 段落
delete process.env.PIDECK_BRIDGE_URL;
const pushed = [];
const transport = { available: true, push: (u) => pushed.push(u), onEvent() {}, close() {} };
const runtime = runtimeModule.getBridgeRuntime(transport);
const fakeCtx = { ui: noOpLike(), mode: "rpc", hasUI: true };
guiModule.installGuiNamespace(fakeCtx, runtime);
console.log("attached:", guiModule.installGuiOnUiSingleton(fakeCtx.ui, runtime));
console.log("ui.gui type:", typeof fakeCtx.ui.gui?.setSettingsSection, "| ctx.gui type:", typeof fakeCtx.gui?.setSettingsSection);
fakeCtx.ui.gui.setSettingsSection("ext-points", () => ({ kind: "text", text: "hi" }), { title: "扩展点", order: 900 });
console.log("pushed.length:", pushed.length, JSON.stringify(pushed).slice(0, 300));
console.log("contributions:", guiSpec.guiState(runtime).contributions.size);
