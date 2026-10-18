import { generateDiffString, renderDiff, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { hasCursorLogin } from "../src/acp/auth.js";
import { clearModelCache, loadModelCache, saveModelCache } from "../src/acp/model-cache.js";
import { cursorVersion, resolveCursorCommand } from "../src/acp/process.js";
import { planDecision, questionAnswered, questionCancelled } from "../src/acp/cursor-extension.js";
import { CONFIG_PATH, isCursorMode, isPermissionMode, loadConfig, saveConfig, type CursorAcpConfig } from "../src/config.js";
import {
	CURSOR_TOOL_NAME,
	INTERACTION_RESULT_KIND,
	PACKAGE_VERSION,
	PERMISSION_TOOL_NAME,
	PLAN_TOOL_NAME,
	QUESTION_TOOL_NAME,
} from "../src/constants.js";
import { createCursorProvider } from "../src/provider.js";
import { CursorRuntime, type CursorToolView, type InteractionToolResult, type InteractionView } from "../src/runtime.js";

export default function cursorAcpExtension(pi: ExtensionAPI): void {
	let config = loadConfig();
	// Argument completions receive no context, so `/context` completes from this copy of the selected model.
	let activeModelId: string | undefined;

	function rememberModel(model: { provider?: string; id?: string } | undefined): void {
		activeModelId = model?.provider === "cursor-acp" ? model.id : undefined;
	}

	pi.on("model_select", (event) => { rememberModel(event.model); });
	const runtime = new CursorRuntime(config);
	pi.on("session_start", async (_event, ctx) => {
		rememberModel(ctx.model);
		await runtime.syncSessionCursor(ctx.sessionManager.getSessionId(), readSessionCursor(ctx.sessionManager.getBranch()));
	});
	pi.on("session_tree", async (_event, ctx) => {
		await runtime.syncSessionCursor(ctx.sessionManager.getSessionId(), readSessionCursor(ctx.sessionManager.getBranch()));
	});
	let cliVersion: string | undefined;
	try { cliVersion = cursorVersion(); } catch { /* CLI errors remain visible through doctor */ }
	// Registration must be immediate so Pi can select cached Cursor models at
	// startup. Missing/expired catalogs use the default model until /model or
	// /cursor-acp models refresh explicitly requests live discovery.
	const definitions = loadModelCache(cliVersion);
	if (definitions) runtime.setDefinitions(definitions);
	const { provider, setModels } = createCursorProvider(runtime, definitions?.map((item) => item.model));
	pi.registerProvider(provider);

	pi.registerTool({
		name: PERMISSION_TOOL_NAME,
		label: "Cursor ACP Permission",
		description: "Presents a pending Cursor ACP permission request. Only call IDs emitted by the provider are valid.",
		parameters: requestParameters(),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const view = requireView(runtime.getInteraction(params.requestId), "permission");
			const labels = view.options.map((item, index) => `${index + 1}. ${item.label} [${item.kind.replaceAll("_", " ")}]`);
			let selected: string | undefined;
			try { selected = await ctx.ui.select(view.title, labels); } catch { /* headless denies */ }
			const index = selected === undefined ? -1 : labels.indexOf(selected);
			const option = index >= 0 ? view.options[index] : undefined;
			const response = option ? { outcome: { outcome: "selected", optionId: option.id } } : { outcome: { outcome: "cancelled" } };
			return result(params.requestId, response, option ? `Permission decision recorded: ${option.label}` : "Permission denied.");
		},
	});

	pi.registerTool({
		name: QUESTION_TOOL_NAME,
		label: "Cursor ACP Question",
		description: "Answers a pending structured question from Cursor. Only call IDs emitted by the provider are valid.",
		parameters: requestParameters(),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const view = requireView(runtime.getInteraction(params.requestId), "question");
			const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
			try {
				for (const question of view.questions) {
					if (!question.allowMultiple) {
						const labels = question.options.map((item) => item.label);
						const selected = await ctx.ui.select(`${view.title}\n\n${question.prompt}`, labels);
						const index = selected === undefined ? -1 : labels.indexOf(selected);
						if (index < 0) return result(params.requestId, questionCancelled("Question skipped in Pi"), "Question skipped.");
						answers.push({ questionId: question.id, selectedOptionIds: [question.options[index]!.id] });
						continue;
					}
					const remaining = [...question.options];
					const selectedIds: string[] = [];
					while (remaining.length) {
						const done = selectedIds.length ? "Done selecting" : "Skip this question";
						const labels = [...remaining.map((item) => item.label), done];
						const selected = await ctx.ui.select(`${view.title}\n\n${question.prompt} (choose all that apply)`, labels);
						if (!selected || selected === done) break;
						const index = remaining.findIndex((item) => item.label === selected);
						if (index >= 0) selectedIds.push(remaining.splice(index, 1)[0]!.id);
					}
					answers.push({ questionId: question.id, selectedOptionIds: selectedIds });
				}
			} catch { return result(params.requestId, questionCancelled("No interactive UI available"), "Question cancelled."); }
			return result(params.requestId, questionAnswered(answers), "Cursor questions answered.");
		},
	});

	pi.registerTool({
		name: PLAN_TOOL_NAME,
		label: "Cursor ACP Plan Approval",
		description: "Reviews a pending Cursor plan. Plans are never accepted without an explicit selection.",
		parameters: requestParameters(),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const view = requireView(runtime.getInteraction(params.requestId), "plan");
			let selected: string | undefined;
			try { selected = await ctx.ui.select(`${view.title}${view.overview ? `\n\n${view.overview}` : ""}\n\n${view.plan.slice(0, 16_000)}`, ["Accept plan", "Reject plan"]); }
			catch { /* headless cancels */ }
			const response = selected === "Accept plan" ? planDecision(true) : selected === "Reject plan" ? planDecision(false, "Rejected in Pi") : planDecision(false);
			return result(params.requestId, response, selected ?? "Plan cancelled.");
		},
	});

	pi.registerTool({
		name: CURSOR_TOOL_NAME,
		label: "Cursor",
		description: "Shows a tool that Cursor already ran. Only the Cursor ACP provider emits these calls.",
		parameters: Type.Record(Type.String(), Type.String()),
		// Never declared to a model and never callable from codemode: the provider is its only caller.
		exposure: "model-only",
		prepareLoadout: () => ({ hiddenDeclarations: [CURSOR_TOOL_NAME] }),
		async execute(id) { return cursorToolResult(runtime.takeCursorTool(id)); },
		renderResult(result, _options, theme) {
			const details = result.details as CursorToolDetails | undefined;
			// A delete has no diff, and the row title already names the file.
			if (details?.kind === "delete") return new Text("", 0, 0);
			if (details?.files?.length) {
				const body = details.files.map((file) => renderDiff(file.diff, { filePath: file.path })).filter(Boolean).join("\n\n");
				return new Text(body, 0, 0);
			}
			const text = result.content.map((block) => block.type === "text" ? block.text : "").join("\n").trimEnd();
			return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
		},
	});

	pi.registerCommand("fast", {
		description: "Toggle Cursor fast mode, or set it on/off",
		getArgumentCompletions: (prefix) => completeMatch(prefix, ["on", "off"]),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			const saved = readSessionCursor(ctx.sessionManager.getBranch());
			const current = saved && "fast" in saved ? saved.fast === true : config.fast === true;
			const next = value === "" ? !current : value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : undefined;
			if (next === undefined) return usage(ctx, "Usage: /fast [on|off]");
			await applySession(ctx, { fast: next });
			ctx.ui.notify(`Fast ${next ? "on" : "off"}`, "info");
		},
	});

	const cursorModes = ["agent", "ask", "plan"] as const;

	async function setCursorMode(next: (typeof cursorModes)[number], ctx: ExtensionCommandContext): Promise<void> {
		await applySession(ctx, { mode: next });
		ctx.ui.notify(`Cursor mode: ${next}`, "info");
	}

	pi.registerCommand("mode", {
		description: "Cycle Cursor mode (agent, ask, plan), or set one",
		getArgumentCompletions: (prefix) => completeMatch(prefix, cursorModes),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value) {
				const saved = readSessionCursor(ctx.sessionManager.getBranch());
				const index = cursorModes.indexOf(saved?.mode ?? config.mode);
				await setCursorMode(cursorModes[(index + 1) % cursorModes.length]!, ctx);
				return;
			}
			if (!isCursorMode(value)) return usage(ctx, "Usage: /mode [agent|ask|plan]");
			await setCursorMode(value, ctx);
		},
	});

	for (const mode of cursorModes) {
		pi.registerCommand(mode, {
			description: `Set Cursor mode to ${mode}`,
			handler: async (_args, ctx) => { await setCursorMode(mode, ctx); },
		});
	}

	pi.registerCommand("context", {
		description: "Cycle Cursor context size, or set one",
		getArgumentCompletions: (prefix) => {
			if (!activeModelId) return null;
			const needle = prefix.trim().toLowerCase();
			const items = contextChoice(activeModelId).options.filter((item) => item.value.toLowerCase().startsWith(needle) || item.name.toLowerCase().startsWith(needle));
			return items.length ? items.map((item) => ({ label: item.name, value: item.value })) : null;
		},
		handler: async (args, ctx) => {
			if (ctx.model?.provider !== "cursor-acp" || !ctx.model.id) return usage(ctx, "Context applies to a Cursor model.");
			const choice = contextChoice(ctx.model.id);
			if (!choice.options.length) return usage(ctx, "This model has no context sizes.");
			const values = choice.options.map((item) => item.value);
			const value = args.trim().toLowerCase();
			const saved = readSessionCursor(ctx.sessionManager.getBranch());
			const active = values.find((item) => item.toLowerCase() === (saved?.context ?? config.context ?? choice.current ?? "").toLowerCase()) ?? values[0]!;
			const next = !value
				? values[(values.indexOf(active) + 1) % values.length]!
				: values.find((item) => item.toLowerCase() === value);
			if (!next) return usage(ctx, `Usage: /context [${values.join("|")}]`);
			await applySession(ctx, { context: next });
			ctx.ui.notify(`Cursor context: ${next}`, "info");
		},
	});

	pi.registerCommand("cursor-acp", {
		description: "Inspect or configure the Cursor ACP provider",
		getArgumentCompletions: (prefix) => completeCursorAcp(prefix),
		handler: async (args, ctx) => {
			const [command = "doctor", value] = args.trim().split(/\s+/u);
			if (command === "models") {
				if (value === "clear") {
					clearModelCache();
					ctx.ui.notify("Cursor model cache cleared. Restart Pi or run /cursor-acp models refresh.", "info");
					return;
				}
				if (value && value !== "refresh") return usage(ctx, "Usage: /cursor-acp models [refresh|clear]");
				ctx.ui.notify("Refreshing Cursor models…", "info");
				const refreshed = await runtime.discoverModels();
				runtime.setDefinitions(refreshed);
				setModels(refreshed.map((item) => item.model));
				saveModelCache(refreshed, cursorVersion());
				ctx.ui.notify(`Refreshed ${refreshed.length} Cursor models.`, "info");
				return;
			}
			if (command === "mode") {
				if (!isCursorMode(value)) return usage(ctx, "Usage: /cursor-acp mode [agent|plan|ask]");
				config = { ...config, mode: value }; await update(config); ctx.ui.notify(`Cursor mode: ${value}`, "info"); return;
			}
			if (command === "permissions") {
				if (!isPermissionMode(value)) return usage(ctx, "Usage: /cursor-acp permissions [prompt|auto-review|full-access]");
				config = { ...config, permissions: value }; await update(config);
				ctx.ui.notify(`Cursor permissions: ${value}`, value === "full-access" ? "warning" : "info"); return;
			}
			if (command === "fast") {
				if (value !== "on" && value !== "off") return usage(ctx, "Usage: /cursor-acp fast [on|off]");
				config = { ...config, fast: value === "on" }; await update(config); ctx.ui.notify(`Fast ${value}`, "info"); return;
			}
			if (command === "pi-tools") {
				if (value !== "on" && value !== "off") return usage(ctx, "Usage: /cursor-acp pi-tools [on|off]");
				config = { ...config, piTools: value === "on" }; await update(config); ctx.ui.notify(`Cursor Pi MCP tools: ${value}`, "info"); return;
			}
			if (command === "sessions" && value === "clear") { runtime.clearSessions(); ctx.ui.notify("Saved Cursor ACP session bindings cleared.", "info"); return; }
			if (command !== "doctor" && command !== "status" && command !== "doctor-verbose") return usage(ctx, "Usage: /cursor-acp [doctor|status|models|mode|fast|permissions|pi-tools|sessions clear]");
			let binary = "not found"; let version: string | undefined; let authenticated = false;
			try { binary = resolveCursorCommand(); version = cursorVersion(binary); authenticated = await hasCursorLogin(binary); } catch { /* shown below */ }
			const snapshot = await runtime.snapshot(command === "doctor-verbose");
			const session = readSessionCursor(ctx.sessionManager.getBranch());
			const mode = session?.mode ?? snapshot.config.mode;
			const fast = session && "fast" in session ? session.fast : snapshot.config.fast;
			const context = session?.context ?? snapshot.config.context;
			ctx.ui.notify([
				`Cursor ACP provider ${PACKAGE_VERSION}`,
				`CLI: ${binary} (${version ?? "unknown version"})`,
				`CLI login: ${authenticated ? "authenticated" : "not detected"}`,
				`Mode: ${mode}; context: ${context ?? "model current"}; fast: ${fast === undefined ? "default" : fast ? "on" : "off"}; permissions: ${snapshot.config.permissions}; Pi MCP tools: ${snapshot.config.piTools ? "on" : "off"}`,
				`Models: ${snapshot.models}; active bindings: ${snapshot.bindings}`,
				...snapshot.processes.map((item) => `• pid=${item.pid ?? "?"} session=${item.sessionId} model=${item.modelId} alive=${item.alive} restored=${item.restored} waiting=${item.waitingFor ?? "no"} tools=${item.waitingForTools} agent=${item.agentVersion ?? "?"} mcpHttp=${item.mcpHttp}`),
			].join("\n"), authenticated ? "info" : "warning");
		},
	});

	pi.on("session_shutdown", async () => { await runtime.close(); });

	async function update(next: CursorAcpConfig): Promise<void> { saveConfig(next); await runtime.updateConfig(next); }

	async function applySession(ctx: ExtensionCommandContext, patch: SessionCursor): Promise<void> {
		const next = { ...readSessionCursor(ctx.sessionManager.getBranch()), ...patch };
		pi.appendEntry(SESSION_CURSOR, next);
		await runtime.syncSessionCursor(ctx.sessionManager.getSessionId(), next);
	}
}

/**
 * `/fast`, `/mode`, and `/context` are saved as a custom entry on the session branch, not in
 * config.json. `/resume` and `/tree` bring them back, and other sessions keep the file defaults.
 */
const SESSION_CURSOR = "cursor-acp-session";

interface SessionCursor {
	mode?: CursorAcpConfig["mode"];
	fast?: boolean;
	context?: string;
}

function readSessionCursor(branch: readonly { type: string; customType?: string; data?: unknown }[]): SessionCursor | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "custom" || entry.customType !== SESSION_CURSOR) continue;
		if (!entry.data || typeof entry.data !== "object") return undefined;
		const record = entry.data as Record<string, unknown>;
		const cursor: SessionCursor = {};
		if (isCursorMode(record.mode)) cursor.mode = record.mode;
		if (typeof record.fast === "boolean") cursor.fast = record.fast;
		if (typeof record.context === "string" && record.context.length > 0) cursor.context = record.context;
		return cursor;
	}
	return undefined;
}

interface CursorToolDetails {
	kind?: string;
	status?: string;
	files?: Array<{ path: string; diff: string }>;
}

/** A Cursor tool row's result. `terminate` keeps Pi from asking the model again after drawing it. */
function cursorToolResult(view: CursorToolView | undefined) {
	if (view?.kind === "delete") {
		const details: CursorToolDetails = { kind: "delete", ...(view.status ? { status: view.status } : {}) };
		return { content: [{ type: "text" as const, text: "" }], details, isError: view.status === "failed", terminate: view.terminate !== false };
	}
	const files: NonNullable<CursorToolDetails["files"]> = [];
	const output: string[] = [];
	for (const item of view?.content ?? []) {
		const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
		if (record?.type === "diff" && typeof record.newText === "string") {
			const path = typeof record.path === "string" ? record.path : "file";
			const { diff } = generateDiffString(typeof record.oldText === "string" ? record.oldText : "", record.newText);
			if (!diff) continue;
			files.push({ path, diff });
		} else if (record?.type === "content") {
			const block = record.content as Record<string, unknown> | undefined;
			if (block?.type === "text" && typeof block.text === "string") {
				const text = usefulOutput(block.text);
				if (text) output.push(text);
			}
		}
	}
	if (!output.length && typeof view?.rawOutput === "string") {
		const text = usefulOutput(view.rawOutput);
		if (text) output.push(text);
	}
	// Cursor keeps the full output itself. This copy is drawn and saved with the session, so it stays bounded.
	const text = output.join("\n").slice(0, 8_000);
	const details: CursorToolDetails = {
		...(view?.kind ? { kind: view.kind } : {}),
		...(view?.status ? { status: view.status } : {}),
		...(files.length ? { files } : {}),
	};
	return { content: [{ type: "text" as const, text }], details, isError: view?.status === "failed", terminate: view?.terminate !== false };
}

/** "Done" is already on the row. An opened call should not print it again. */
function usefulOutput(value: string): string {
	const text = value.trim();
	return !text || text === "Done" || text === "Failed" ? "" : text;
}

function requestParameters() { return Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }) }); }
function requireView<K extends InteractionView["kind"]>(view: InteractionView | undefined, kind: K): Extract<InteractionView, { kind: K }> {
	if (!view || view.kind !== kind) throw new Error("This Cursor interaction is missing, expired, or already used");
	return view as Extract<InteractionView, { kind: K }>;
}
function result(requestId: string, response: Record<string, unknown>, text: string) {
	const details: InteractionToolResult = { kind: INTERACTION_RESULT_KIND, requestId, response };
	return { content: [{ type: "text" as const, text }], details };
}
function usage(ctx: ExtensionCommandContext, message: string): void { ctx.ui.notify(message, "warning"); }

function completeMatch(prefix: string, choices: readonly string[]): { label: string; value: string }[] | null {
	const needle = prefix.trim().toLowerCase();
	const items = choices.filter((item) => item.toLowerCase().startsWith(needle)).map((item) => ({ label: item, value: item }));
	return items.length ? items : null;
}

const CURSOR_ACP_COMMANDS = ["doctor", "status", "doctor-verbose", "models", "mode", "fast", "permissions", "pi-tools", "sessions"] as const;
const CURSOR_ACP_ARGS: Record<string, readonly string[]> = {
	models: ["refresh", "clear"],
	mode: ["agent", "plan", "ask"],
	fast: ["on", "off"],
	permissions: ["prompt", "auto-review", "full-access"],
	"pi-tools": ["on", "off"],
	sessions: ["clear"],
};

function completeCursorAcp(prefix: string): { label: string; value: string }[] | null {
	const parts = prefix.split(/\s+/);
	if (parts.length <= 1) return completeMatch(parts[0] ?? "", CURSOR_ACP_COMMANDS);
	const command = parts[0] ?? "";
	const options = CURSOR_ACP_ARGS[command];
	if (!options || parts.length > 2) return null;
	const needle = (parts[1] ?? "").toLowerCase();
	const items = options.filter((item) => item.startsWith(needle)).map((item) => ({ label: item, value: `${command} ${item}` }));
	return items.length ? items : null;
}

function contextChoice(modelId: string): { options: Array<{ value: string; name: string }>; current?: string } {
	const model = readModelCatalog().find((item) => item.value === modelId);
	const option = model?.configOptions?.find((item) => item.id === "context");
	const options = flattenOptions(option?.options);
	const current = typeof option?.currentValue === "string" ? option.currentValue : undefined;
	return { options, ...(current ? { current } : {}) };
}

function readModelCatalog(): Array<{ value?: string; configOptions?: Array<{ id?: string; currentValue?: unknown; options?: unknown }> }> {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(CONFIG_PATH), "models.json"), "utf8")) as {
			models?: Array<{ value?: string; configOptions?: Array<{ id?: string; currentValue?: unknown; options?: unknown }> }>;
		};
		return raw.models ?? [];
	} catch { return []; }
}

function flattenOptions(options: unknown): Array<{ value: string; name: string }> {
	if (!Array.isArray(options)) return [];
	const values: Array<{ value: string; name: string }> = [];
	for (const item of options) {
		if (!item || typeof item !== "object") continue;
		const record = item as { value?: unknown; name?: unknown; options?: unknown };
		if (typeof record.value === "string") values.push({ value: record.value, name: typeof record.name === "string" ? record.name : record.value });
		else values.push(...flattenOptions(record.options));
	}
	return values;
}
