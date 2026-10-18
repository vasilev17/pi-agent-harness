import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { onTick } from "./compact-tools-clock.ts";
import { colorizeRgb, interpolateRgb, paletteOf } from "./compact-tools-color.ts";
import { progressGlow, type ColorRamp, type ThinkingLevel } from "./compact-tools-palette.ts";
import { silentWorkingPrefix } from "./compact-tools-silent.ts";
import type { ToolArgs } from "./compact-tools-types.ts";


const TOOL_PROGRESS_MESSAGES: Readonly<Record<string, string>> = {
	read: "Reading file…",
	write: "Writing file…",
	edit: "Editing file…",
	bash: "Running command…",
	powershell: "Running command…",
	grep: "Searching text…",
	find: "Finding files…",
	ls: "Listing files…",
};

function humanizeToolName(toolName: string, args: ToolArgs): string {
	const routedName = (toolName === "mcp" || toolName.startsWith("mcp__")) && typeof args.tool === "string"
		? args.tool
		: toolName;
	const readableName = stripTerminalSequences(routedName)
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/^mcp__/iu, "")
		.replace(/[_-]mcp$/iu, "")
		.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
		.replace(/([a-z\d])([A-Z])/gu, "$1 $2")
		.replace(/[_-]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return truncateToWidth(readableName, 40, "…");
}

/** Keep the working row calm and private; invocation details remain in the tool card. */
export function formatToolProgress(toolName: string, args: ToolArgs): string {
	const builtInMessage = TOOL_PROGRESS_MESSAGES[toolName];
	if (builtInMessage) return builtInMessage;
	const displayName = humanizeToolName(toolName, args);
	return displayName ? `Using ${displayName}…` : "Running tool…";
}

function glowRadius(length: number): number {
	return Math.max(2, Math.min(8, Math.ceil(length / 4)));
}

/** Render the working label with a proportional highlight sweeping left to right. */
export function glowProgressMessage(
	message: string,
	frame: number,
	theme: Theme,
	level: ThinkingLevel,
): string {
	return paintGlowFrame(message, frame, theme, progressGlow(theme, level));
}

function paintGlowFrame(message: string, frame: number, theme: Theme, glow: ColorRamp | undefined): string {
	const characters = [...message];
	if (characters.length === 0) return "";
	const radius = glowRadius(characters.length);
	const center = frame % (characters.length + radius * 2) - radius;
	// Reached only when the level's color did not resolve, so the sweep falls back to names
	// every theme carries rather than to the one that just failed.
	if (!glow) {
		return characters.map((character, index) =>
			theme.fg(Math.abs(index - center) < radius ? "text" : "muted", character)).join("");
	}
	return characters.map((character, index) => {
		const distance = Math.abs(index - center);
		const strength = Math.max(0, 1 - distance / radius);
		return colorizeRgb(theme, interpolateRgb(glow.from, glow.to, strength), character);
	}).join("");
}

function createGlowFrames(message: string, theme: Theme, level: ThinkingLevel): string[] {
	const length = [...message].length;
	if (length === 0) return [""];
	// One ramp for the whole cycle; only the sweep position changes between frames.
	const glow = progressGlow(theme, level);
	return Array.from({ length: length + glowRadius(length) * 2 }, (_, frame) =>
		paintGlowFrame(message, frame, theme, glow));
}

/** Owns Pi's single working row so animation remains continuous across thinking and tool execution. */
export class ProgressController {
	private context: ExtensionContext | undefined;
	private readonly activeTools = new Map<string, string>();
	private message: string | undefined;
	private frames: string[] = [];
	/** The palette `frames` were painted with. */
	private paintedFor: object | undefined;
	/** The label `frames` were painted from, including the silent glyph. */
	private paintedLabel: string | undefined;
	private frame = 0;
	/** Stops this label's share of the animation clock. */
	private stopTicking: (() => void) | undefined;
	private level: ThinkingLevel = "medium";

	constructor(private readonly pi: ExtensionAPI) {
		// Every handler leaves early while unbound. Pi keeps dispatching to this
		// extension in non-TUI modes, and guarding at the top keeps that work — and
		// any future handler added here — out of the detached path.
		pi.on("agent_start", () => {
			if (!this.context) return;
			this.setMessage("Thinking…");
		});
		pi.on("message_update", (event) => {
			if (!this.context) return;
			const type = event.assistantMessageEvent.type;
			if (type === "thinking_start" || type === "thinking_delta") this.setMessage("Thinking…");
			else if (type === "text_start" || type === "text_delta") this.setMessage("Responding…");
			else if (type === "toolcall_start" || type === "toolcall_delta") this.setMessage("Preparing tools…");
		});
		pi.on("tool_execution_start", (event) => {
			if (!this.context) return;
			const message = formatToolProgress(event.toolName, event.args ?? {});
			this.activeTools.set(event.toolCallId, message);
			this.setMessage(message);
		});
		pi.on("tool_execution_end", (event) => {
			if (!this.context) return;
			this.activeTools.delete(event.toolCallId);
			const remaining = [...this.activeTools.values()].at(-1);
			this.setMessage(remaining ?? "Processing results…");
		});
		// agent_end closes one low-level run, after which Pi may still retry, compact,
		// or continue from a settlement boundary. Pi hides its own working row at that
		// point and rebuilds it at the next turn_start from the message last set here,
		// so releasing the label at agent_end makes a retried turn reappear under Pi's
		// default label. Release it at the final settlement instead.
		pi.on("agent_settled", () => {
			if (!this.context) return;
			this.activeTools.clear();
			this.clearMessage();
		});
		pi.on("thinking_level_select", (event) => {
			if (!this.context || event.level === this.level) return;
			this.level = event.level;
			// Recolor in place: the label and its animation phase are unchanged.
			this.frames = [];
			this.renderMessage();
		});
	}

	/** Guarded, like the Theme accessors, so a host supplying a partial API cannot break binding. */
	private readLevel(): void {
		if (typeof this.pi.getThinkingLevel === "function") this.level = this.pi.getThinkingLevel();
	}

	bind(ctx: ExtensionContext): void {
		this.stopAnimation();
		this.context = ctx;
		this.readLevel();
		this.activeTools.clear();
		this.message = undefined;
		this.frames = [];
		this.frame = 0;
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator({ frames: [] });
	}

	dispose(): void {
		this.stopAnimation();
		this.activeTools.clear();
		this.context?.ui.setWorkingMessage();
		this.context?.ui.setWorkingIndicator();
		this.message = undefined;
		this.frames = [];
		this.context = undefined;
	}

	private setMessage(message: string): void {
		if (!this.context || (this.message === message && this.stopTicking)) return;
		this.message = message;
		this.frames = [];
		this.frame = 0;
		this.renderMessage();
		if (this.stopTicking) return;
		this.stopTicking = onTick(() => {
			this.frame++;
			this.renderMessage();
		});
	}

	private renderMessage(): void {
		if (!this.message || !this.context) return;
		// The glyph is a character of the same string, so the sweep colors it with the word.
		const label = `${silentWorkingPrefix()}${this.message}`;
		// Painted once per label, level, and palette: a theme switch, a silent-mode change,
		// or the system theme following the terminal from dark to light, repaints on the next frame.
		const theme = this.context.ui.theme;
		const palette = paletteOf(theme);
		if (this.frames.length === 0 || this.paintedFor !== palette || this.paintedLabel !== label) {
			this.frames = createGlowFrames(label, theme, this.level);
			this.paintedFor = palette;
			this.paintedLabel = label;
		}
		this.context.ui.setWorkingMessage(this.frames[this.frame % this.frames.length]);
	}

	private clearMessage(): void {
		this.stopAnimation();
		this.message = undefined;
		this.frames = [];
		this.paintedLabel = undefined;
		this.frame = 0;
		this.context?.ui.setWorkingMessage();
	}

	private stopAnimation(): void {
		this.stopTicking?.();
		this.stopTicking = undefined;
	}
}
