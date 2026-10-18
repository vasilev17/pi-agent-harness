import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DISPLAY_STYLES, type CompactToolsConfig, type DisplayStyle } from "./compact-tools-types.ts";
import { loadConfig } from "./compact-tools-config.ts";

type Scope = "global" | "project";
const SCOPES: readonly Scope[] = ["global", "project"];
const HELP = "Usage: /compact-tools [compact|claude|codex|off] [global|project]\nWithout a scope the style is saved globally, or to this project when its settings choose the style.\n/compact-tools status · /compact-tools help\nCtrl+O expands rows; /silent toggles quiet mode. Styles switch at once, even while tools run; off reloads Pi.";
const BUSY = "Wait for the current response to finish before changing tool styles.";
const CHOICES: Record<DisplayStyle, string> = {
	compact: "Compact — one expandable row per tool call",
	claude: "Claude — group reads and searches",
	codex: "Codex — explored groups and output tails, like Codex CLI",
	off: "Off — restore Pi's default tool rows",
};

export function configPath(cwd: string, scope: Scope): string {
	return scope === "global" ? join(getAgentDir(), "compact-tools.json")
		: join(cwd, CONFIG_DIR_NAME, "compact-tools.json");
}

/** Preserve unrelated and future settings. Never overwrite a malformed file. */
export function saveStyle(path: string, style: DisplayStyle): void {
	let linked = false;
	try {
		linked = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Update dotfiles-managed targets without replacing the link. A dangling link
	// is an error, not permission to silently disconnect it.
	if (linked) path = realpathSync(path);
	let data: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		data = parsed as Record<string, unknown>;
		mode = statSync(path).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	// Beside the target so the rename stays atomic, and short so a long target name still fits.
	const temporary = join(dirname(path), `.compact-tools-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...data, style }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		// The creation mode passes through the umask; set the original mode exactly.
		chmodSync(temporary, mode);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Whether a trusted project's own settings choose the style, which then outranks the global one. */
function projectSetsStyle(cwd: string, trusted: boolean): boolean {
	if (!trusted) return false;
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath(cwd, "project"), "utf8"));
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && "style" in parsed;
	} catch {
		return false;
	}
}

function describePath(path: string): string {
	return `${path} (${existsSync(path) ? "exists" : "not created"})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Draw the saved style in place, without a reload, and say whether it could: a switch
 * between the compact, Claude, and Codex styles keeps every tool's registration, so
 * it applies at once, even while a response runs. Turning rows off or back on cannot.
 */
export type ApplyStyle = (cwd: string, trusted: boolean) => boolean;

/** Whether a switch needs Pi to reload: only off hands tools to or takes them from Pi's own renderers. */
function needsReload(from: DisplayStyle, to: DisplayStyle): boolean {
	return from === "off" || to === "off";
}

export function registerCompactToolsCommand(pi: ExtensionAPI, getConfig: () => CompactToolsConfig, applyStyle?: ApplyStyle): void {
	pi.registerCommand("compact-tools", {
		description: "Choose compact/Claude/Codex/default tool rows, or show settings and controls",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trimStart().toLowerCase();
			const parts = typed.split(/\s+/);
			const scoped = parts.length === 2 && DISPLAY_STYLES.includes(parts[0] as DisplayStyle);
			const values = scoped ? SCOPES.map((scope) => `${parts[0]} ${scope}`) : [...DISPLAY_STYLES, "status", "help"];
			// Pi applies a shown completion on Enter instead of running the command, so a value already
			// typed in full is not offered again: Enter then runs it the first time.
			const items = values.filter((value) => value.startsWith(typed) && value !== typed.trimEnd()).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim() ? args.trim().toLowerCase().split(/\s+/) : [];
			if (parts.length === 1 && parts[0] === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			if (parts.length === 1 && parts[0] === "status") {
				const config = getConfig();
				ctx.ui.notify([
					`Style: ${config.style} · configured mode: ${config.mode} · preview: ${config.previewLines} lines`,
					`Global: ${describePath(configPath(ctx.cwd, "global"))}`,
					`Project: ${describePath(configPath(ctx.cwd, "project"))} (${ctx.isProjectTrusted() ? "trusted; overrides global" : "untrusted; ignored"})`,
					"/silent is a session toggle; Ctrl+O expands rows.",
				].join("\n"), "info");
				return;
			}
			if (parts.length > 2 || (parts.length > 0 && !DISPLAY_STYLES.includes(parts[0] as DisplayStyle))
				|| (parts[1] !== undefined && !SCOPES.includes(parts[1] as Scope))) {
				ctx.ui.notify(HELP, "warning");
				return;
			}
			// A switch between drawn styles applies in place, so only one that reloads waits for the response.
			const named = parts[0] as DisplayStyle | undefined;
			if (named && !ctx.isIdle() && (needsReload(getConfig().style, named) || !applyStyle)) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			let style = named;
			// Unnamed, the style is saved where it is decided: a trusted project that sets one would
			// otherwise outrank a global save, and the switch would seem to do nothing.
			let scope: Scope = (parts[1] as Scope | undefined) ?? (projectSetsStyle(ctx.cwd, ctx.isProjectTrusted()) ? "project" : "global");
			if (!style) {
				if (ctx.mode !== "tui") {
					ctx.ui.notify(HELP, "info");
					return;
				}
				const selected = await ctx.ui.select(`Tool style (current: ${getConfig().style})`, Object.values(CHOICES));
				style = DISPLAY_STYLES.find((value) => CHOICES[value] === selected);
				if (!style) return;
				// A project that sets its own style outranks a global save, so it is offered first and the global
				// choice says it will not show here.
				const projectDecides = projectSetsStyle(ctx.cwd, ctx.isProjectTrusted());
				const scopes = projectDecides
					? ["Project — this trusted project only", "Global — all projects (this project keeps its own style)"]
					: ["Global — all projects", ...(ctx.isProjectTrusted() ? ["Project — this trusted project only"] : [])];
				const selectedScope = await ctx.ui.select("Save style where?", scopes);
				if (!selectedScope) return;
				scope = selectedScope.startsWith("Project") ? "project" : "global";
			}
			if (scope === "project" && !ctx.isProjectTrusted()) {
				ctx.ui.notify("Project settings require a trusted project. No file was changed.", "warning");
				return;
			}
			// The agent may have started while the user was choosing in a dialog.
			const reloads = needsReload(getConfig().style, style) || !applyStyle;
			if (reloads && !ctx.isIdle()) {
				ctx.ui.notify(BUSY, "warning");
				return;
			}
			const path = configPath(ctx.cwd, scope);
			try {
				saveStyle(path, style);
			} catch (error) {
				ctx.ui.notify(`Could not save ${path}: ${errorMessage(error)}. No settings were replaced.`, "error");
				return;
			}
			const effective = loadConfig(ctx.cwd, ctx.isProjectTrusted()).style;
			const where = scope === "project" ? "this project" : "global settings";
			// Paths stay out of these lines, which Pi keeps in the chat; /compact-tools status shows them.
			if (scope === "global" && effective !== style) {
				// Saved, but this project's own style still decides what is drawn here: nothing switches.
				ctx.ui.notify(`Saved ${style} to global settings, but this project keeps its own ${effective} style. Run /compact-tools ${style} to switch it here.`, "warning");
				return;
			}
			if (!reloads && applyStyle!(ctx.cwd, ctx.isProjectTrusted())) {
				ctx.ui.notify(`Switched to ${style} style (saved to ${where}).`, "info");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(`Saved ${style} style to ${where}. It applies once the response finishes; run /reload then.`, "warning");
				return;
			}
			ctx.ui.notify(`Switching to ${style} style (saved to ${where}). Reloading…`, "info");
			// Reloading makes this ctx stale, so a failure is reported through the UI held from before.
			const ui = ctx.ui;
			try {
				await ctx.reload();
			} catch (error) {
				ui.notify(`Style was saved, but reload failed: ${errorMessage(error)}. Run /reload to apply it.`, "error");
			}
		},
	});
}
