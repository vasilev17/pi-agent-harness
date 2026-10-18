import {
	AssistantMessageComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	CustomEditor,
	DynamicBorder,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, MouseRegion, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { hookMethod } from "./compact-tools-hook.ts";
import type { DisplayMode } from "./compact-tools-types.ts";
import { captureViewport } from "./compact-tools-viewport.ts";
import { SilentActivityAnimator } from "./compact-tools-activity.ts";

const STATUS_KEY = "compact-tools";
const WIDGET_KEY = "compact-tools-silent";
const COMMAND_ARGUMENTS = ["on", "off", "edits only", "edits only (+ thinking)"] as const;
type SilentLevel = "off" | "on" | "edits" | "edits-thinking";
/** Nerd Font: nf codepoint f478, shown while /silent is on. */
const SILENT_GLYPH = "\u{F478}";
/** Nerd Font: nf codepoint f11e8, shown while /silent is edits only. */
const EDITS_GLYPH = "\u{F11E8}";
/** Nerd Font: nf-oct-light_bulb, codepoint f400. Sits beside the edits glyph while thinking stays visible. */
const THINKING_GLYPH = "\u{F400}";
const EDITS_THINKING_GLYPH = `${EDITS_GLYPH} ${THINKING_GLYPH}`;
export const SILENT_SHORTCUT = "ctrl+'";
// Symbol.for keys resolve to the same symbol in every evaluation of this module.
// /reload re-evaluates the module, but the patched prototypes belong to Pi and
// outlive it, so the flag they read and the patch marker must be shared.
const STATE_KEY = Symbol.for("pi-compact-tools.silent.state");
// Versioned: an instance loaded before thinking was hidden may already have
// wrapped these prototypes in the running process. A new key wraps once more
// rather than silently keeping the older behavior until Pi restarts.
const ORIGINAL_RENDER = Symbol.for("pi-compact-tools.silent.originalRender.v4");
const OVERRIDES_KEY = Symbol.for("pi-compact-tools.silent.overrides.v2");

interface SilentState {
	active: boolean;
	/** Full silent: hide every tool row, thinking block, and notice. */
	enabled: boolean;
	/** End result plus file creates, edits, deletes, and moves. Thinking blocks stay hidden. */
	editsOnly?: boolean;
	/** Mutating tool rows, every turn's text, and thinking blocks. */
	editsThinking?: boolean;
	/** Set by /silent so that a /reload keeps the user's choice over the configured mode. */
	overridden: boolean;
}

type Renderable = { render(width: number): string[] };
type Render = (width: number) => string[];
export type RenderOverride = (component: any, width: number, render: Render) => string[];

type AssistantLike = {
	hasToolCalls?: unknown;
	contentContainer?: { children?: unknown[] };
};

interface RenderOverrides {
	tool: RenderOverride;
	assistant: RenderOverride;
	notice: RenderOverride;
}

function sharedState(): SilentState {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: SilentState };
	holder[STATE_KEY] ??= { active: false, enabled: false, overridden: false };
	return holder[STATE_KEY];
}

/**
 * Pi's own pi-tui classes. Inside Pi an extension imports the same copy Pi uses;
 * an install with a second copy (a development checkout, for one) still builds
 * the same classes, so a matching name identifies them there.
 */
export function isKind(child: unknown, kind: abstract new (...args: any[]) => unknown): boolean {
	return child instanceof kind
		|| (typeof child === "object" && child !== null && child.constructor?.name === kind.name);
}

/** Icon for the current silent mode. Empty when silent mode is off. */
export function silentModeGlyph(): string {
	const state = sharedState();
	if (!state.active) return "";
	if (state.enabled) return SILENT_GLYPH;
	if (state.editsThinking) return EDITS_THINKING_GLYPH;
	if (state.editsOnly) return EDITS_GLYPH;
	return "";
}

/**
 * Mark for the working label in the editor border. Empty when silent mode is off,
 * so the label stays as Pi drew it. One trailing space keeps the icon off the word.
 */
export function silentWorkingPrefix(): string {
	const glyph = silentModeGlyph();
	return glyph ? `${glyph} ` : "";
}

type BorderedEditor = { borderColor(text: string): string };

/**
 * Idle top border: the glyph sits where the working label's first character sits,
 * in the border color, with no sweep. A running prompt replaces this with the
 * shimmering label, which starts with the same glyph.
 */
function renderIdleGlyphBorder(editor: BorderedEditor, width: number, hiddenLineCount: number, glyph: string): string {
	const inner = Math.max(0, width - 2);
	const statusWidth = visibleWidth(glyph);
	const wrap = (body: string) => editor.borderColor("╭") + body + (width >= 2 ? editor.borderColor("╮") : "");
	if (inner < statusWidth + 5) return editor.borderColor("╭" + "─".repeat(inner) + (width >= 2 ? "╮" : ""));
	const status = editor.borderColor(glyph);
	const overflowLabel = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more ` : undefined;
	const overflowLabelWidth = overflowLabel ? visibleWidth(overflowLabel) : 0;
	const overflowStart = Math.floor((inner - overflowLabelWidth) / 2);
	const canFitOverflow = overflowLabel !== undefined
		&& overflowLabelWidth + 2 <= inner
		&& overflowStart - (3 + statusWidth + 1) >= 1;
	if (canFitOverflow && overflowLabel) {
		const leftBlockWidth = 3 + statusWidth + 1;
		return wrap(editor.borderColor("── ")
			+ status
			+ editor.borderColor(` ${"─".repeat(overflowStart - leftBlockWidth)}${overflowLabel}${"─".repeat(inner - overflowStart - overflowLabelWidth)}`));
	}
	return wrap(editor.borderColor("── ") + status + editor.borderColor(` ${"─".repeat(inner - statusWidth - 4)}`));
}

/** Draw the mode glyph on the idle editor border. A running prompt keeps Pi's own label. */
function installIdleGlyph(): void {
	const prototype = CustomEditor?.prototype;
	if (!prototype) return;
	hookMethod(prototype, "renderTopBorder", "silent.idleGlyph", (self, args, original) => {
		const glyph = silentModeGlyph();
		const editor = self as BorderedEditor & { embedWorkingStatus?: boolean; workingStatusIndicator?: unknown };
		if (!glyph || (editor.embedWorkingStatus && editor.workingStatusIndicator) || typeof editor.borderColor !== "function") {
			return original.apply(self, args);
		}
		const width = args[0] as number;
		if (typeof width !== "number" || width <= 2) return original.apply(self, args);
		return renderIdleGlyphBorder(editor, width, typeof args[1] === "number" ? args[1] : 0, glyph);
	});
}

/** Whether silent mode is currently hiding the transcript's tool rows. */
export function isSilent(): boolean {
	const state = sharedState();
	return state.active && state.enabled;
}

/** Full silent or either edits mode: the transcript wrappers must run so rows can be filtered. */
function isHiding(): boolean {
	const state = sharedState();
	return state.active && (state.enabled || state.editsOnly === true || state.editsThinking === true);
}

/** A turn that hands off to tools is progress, not an answer, however it ended. */
export function isIntermediateAssistant(component: AssistantLike): boolean {
	return component.hasToolCalls === true;
}

/**
 * Pi's abort notice has no type of its own: it is a plain Text, matched by its
 * wording with color codes removed. It stays visible so an Esc is never silent.
 */
function isAbortNotice(child: unknown): boolean {
	if (!isKind(child, Text)) return false;
	const text = (child as { text?: unknown }).text;
	if (typeof text !== "string") return false;
	return /\baborted\b/iu.test(text.replace(/\x1b\[[0-9;]*m/gu, ""));
}

/**
 * Render only an assistant turn's answer text. Pi builds a turn from three kinds
 * of children: each thinking run, shown or collapsed to its label, is a
 * MouseRegion followed by a spacer; the answer is Markdown; and an error or
 * truncation notice is a spacer followed by a plain Text. An abort notice is
 * that same Text and stays, in full silent and in edits only. The children are
 * swapped only for this one render, so the component and its message stay
 * untouched and reappear in full once silent mode is off.
 */
export function renderAnswerOnly(component: AssistantLike, width: number, render: Render): string[] {
	const container = component.contentContainer;
	const children = container?.children;
	if (!container || !Array.isArray(children)) return render(width);
	// Most renders have nothing to drop; skip building a filtered copy for them.
	if (!children.some((child) => isKind(child, MouseRegion) || isKind(child, Text))) return render(width);
	const kept: unknown[] = [];
	let afterThinking = false;
	for (const child of children) {
		if (isKind(child, MouseRegion)) {
			afterThinking = true;
			continue;
		}
		if (afterThinking && isKind(child, Spacer)) {
			afterThinking = false;
			continue;
		}
		afterThinking = false;
		if (isKind(child, Text)) {
			if (isAbortNotice(child)) {
				kept.push(child);
				continue;
			}
			if (isKind(kept.at(-1), Spacer)) kept.pop();
			continue;
		}
		kept.push(child);
	}
	if (kept.length === children.length) return render(width);
	// A turn that was only thinking would otherwise leave its leading blank line.
	if (kept.every((child) => isKind(child, Spacer))) return [];
	container.children = kept;
	try {
		return render(width);
	} finally {
		container.children = children;
	}
}

/**
 * A summary Pi writes into the chat of its own accord: the context it compacted
 * away, or the /tree branch it left behind. Both are bookkeeping rather than a
 * prompt or an answer, and compaction arrives mid-turn, where a visible row
 * would come between the animating activity line and the editor below it.
 * Read through `typeof` so an older Pi without the export keeps its own rows.
 */
function isSummary(child: unknown): boolean {
	return (typeof CompactionSummaryMessageComponent === "function" && isKind(child, CompactionSummaryMessageComponent))
		|| (typeof BranchSummaryMessageComponent === "function" && isKind(child, BranchSummaryMessageComponent));
}

/**
 * A row Pi (or this extension) adds to the chat directly rather than as a message:
 * status lines are Text, "What's New" blocks add borders and Markdown too, and
 * compaction and branch summaries come as components of their own.
 */
function isNotice(child: unknown): boolean {
	return isKind(child, Text) || isKind(child, DynamicBorder) || isKind(child, Markdown) || isSummary(child);
}

/**
 * Render a transcript container without Pi's own notices. Pi writes warnings,
 * errors, and status lines ("Reloaded …", "Wait for the current response …")
 * straight into the chat as a spacer followed by a plain Text, while every
 * message has a component of its own. Dropping top-level Text rows and the
 * spacer before each leaves the conversation itself untouched.
 */
export function renderWithoutNotices(container: { children?: unknown[] }, width: number, render: Render): string[] {
	const children = container.children;
	if (!Array.isArray(children) || !children.some(isNotice)) return render(width);
	const kept: unknown[] = [];
	for (const child of children) {
		if (isNotice(child) && !isAbortNotice(child)) {
			if (isKind(kept.at(-1), Spacer)) kept.pop();
			continue;
		}
		kept.push(child);
	}
	if (kept.length === children.length) return render(width);
	container.children = kept;
	try {
		return render(width);
	} finally {
		container.children = children;
	}
}

type TuiLike = { children?: Array<{ children?: unknown[] }> };

/**
 * Pi mounts the transcript document first in both regular and fullscreen mode, and
 * its chat is the document's last child, after the header and resource list.
 */
export function findChat(tui: unknown): { children: unknown[] } | undefined {
	const documentChildren = (tui as TuiLike).children?.[0]?.children;
	const chat = Array.isArray(documentChildren) ? documentChildren.at(-1) : undefined;
	if (typeof chat !== "object" || chat === null || !Array.isArray((chat as { children?: unknown }).children)) return undefined;
	return chat as { children: unknown[] };
}

function hookChatNotices(tui: unknown): void {
	const chat = findChat(tui);
	if (!chat) return;
	hookMethod(chat, "render", "silent.chatNotices", (self, args, original) => {
		const state = sharedState();
		if (!state.active || !state.enabled) return original.apply(self, args);
		return renderWithoutNotices(self, args[0], (width) => original.call(self, width));
	});
}

/**
 * Pi exposes no API to hide another extension's tool rows, so silent mode wraps
 * the shared component prototypes. Returns false when the host no longer has the
 * expected shape, which leaves the transcript untouched.
 */
export function patchRender(
	prototype: Renderable | undefined,
	override: RenderOverride,
	/** When this returns false the original render runs directly, with no override and no allocation. */
	engaged: () => boolean = () => true,
): boolean {
	if (!prototype || typeof prototype.render !== "function") return false;
	// Checked as an own property: a component that inherits render() from a shared
	// base (CustomMessageComponent uses Container's) must still get its own wrapper.
	if (Object.hasOwn(prototype, ORIGINAL_RENDER)) return true;
	const original = prototype.render;
	prototype.render = function (this: unknown, width: number): string[] {
		if (!engaged()) return original.call(this, width);
		return override(this, width, (nextWidth) => original.call(this, nextWidth));
	};
	Object.defineProperty(prototype, ORIGINAL_RENDER, { value: original });
	return true;
}

function sharedOverrides(): RenderOverrides | undefined {
	return (globalThis as typeof globalThis & { [OVERRIDES_KEY]?: RenderOverrides })[OVERRIDES_KEY];
}

const MUTATING_KEYS = new Set(["Create", "Edit", "Delete", "Move"]);
const MUTATING_TOOLS = new Set(["write", "edit"]);

/** A tool row that creates, edits, deletes, or moves a file or folder. */
function isMutatingTool(component: unknown): boolean {
	if (typeof component !== "object" || component === null) return false;
	const row = component as { toolName?: unknown; args?: unknown };
	if (typeof row.toolName === "string" && MUTATING_TOOLS.has(row.toolName)) return true;
	if (!row.args || typeof row.args !== "object") return false;
	for (const [key, value] of Object.entries(row.args as Record<string, unknown>)) {
		if (MUTATING_KEYS.has(key)) return true;
		if (typeof value === "string" && /^(?:Create|Edit|Delete|Move) (?:File|Folder)\b/u.test(value)) return true;
	}
	return false;
}

function publishOverrides(): void {
	const state = sharedState();
	const silent = () => state.active && state.enabled;
	const editsOnly = () => state.active && state.editsOnly === true;
	const editsThinking = () => state.active && state.editsThinking === true;
	(globalThis as typeof globalThis & { [OVERRIDES_KEY]?: RenderOverrides })[OVERRIDES_KEY] = {
		tool: (component, width, render) => {
			if (silent()) return [];
			if ((editsOnly() || editsThinking()) && !isMutatingTool(component)) return [];
			return render(width);
		},
		// Full silent keeps only the end result: intermediate turns go entirely,
		// and the final turn keeps its text but not its thinking.
		// Edits only keeps every turn's answer text and drops only thinking: a turn
		// that calls tools still carries text, which full silent gives up with it.
		// Edits only (+ thinking) keeps every turn, thinking blocks included.
		assistant: (component: AssistantLike, width, render) => {
			if (silent()) return isIntermediateAssistant(component) ? [] : renderAnswerOnly(component, width, render);
			if (editsOnly()) return renderAnswerOnly(component, width, render);
			return render(width);
		},
		// Extension notices such as pi-web-access's "content ready" arrive between
		// tool calls; they are progress, not answers.
		notice: (_component, width, render) => silent() ? [] : render(width),
	};
}

// The patched prototypes look behavior up here on every render, so after a
// /reload they follow the newly loaded module instead of the one that patched them.
function delegate(key: keyof RenderOverrides): RenderOverride {
	return (component, width, render) => {
		const override = sharedOverrides()?.[key];
		return override ? override(component, width, render) : render(width);
	};
}

function currentLevel(state: SilentState): SilentLevel {
	if (state.enabled) return "on";
	if (state.editsThinking) return "edits-thinking";
	if (state.editsOnly) return "edits";
	return "off";
}

export function parseSilentArgument(args: string, current: SilentLevel): SilentLevel | undefined {
	const argument = args.trim().toLowerCase().replace(/\s+/gu, " ");
	if (argument === "") return current === "off" ? "on" : "off";
	if (argument === "on") return "on";
	if (argument === "off") return "off";
	if (argument === "edits only (+ thinking)" || argument === "edits only + thinking" || argument === "edits-only-thinking") return "edits-thinking";
	if (argument === "edits only" || argument === "edits-only") return "edits";
	return undefined;
}

function installPatches(): boolean {
	publishOverrides();
	// Every patch is checked before any is relied on, so a partial host change
	// cannot leave tool rows hidden while their surrounding turns remain visible.
	// Normal mode pays one flag check per render and nothing else.
	const tools = patchRender(ToolExecutionComponent?.prototype, delegate("tool"), isHiding);
	const assistant = patchRender(AssistantMessageComponent?.prototype, delegate("assistant"), isHiding);
	const notices = patchRender(CustomMessageComponent?.prototype, delegate("notice"), isSilent);
	return tools && assistant && notices;
}

/** Hides tool rows, intermediate assistant turns, thinking, and extension notices; the working label carries progress instead. */
export class SilentModeController {
	private context: ExtensionContext | undefined;
	private readonly activity: SilentActivityAnimator;

	constructor(pi: ExtensionAPI, private readonly onVisible?: (ctx: ExtensionContext) => void) {
		this.activity = new SilentActivityAnimator(pi);
		pi.registerCommand("silent", {
			description: `(${SILENT_SHORTCUT}) Show only prompts and final answers`,
			getArgumentCompletions: (prefix) => {
				// Pi applies a shown completion on Enter instead of running the command, so a value
				// already typed in full is not offered again: Enter then runs it the first time.
				const typed = prefix.trim().toLowerCase();
				const items = COMMAND_ARGUMENTS
					.filter((value) => value.startsWith(typed) && value !== typed)
					.map((value) => ({ value, label: value }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const state = sharedState();
				const level = parseSilentArgument(args, currentLevel(state));
				if (level === undefined) {
					ctx.ui.notify("Usage: /silent [on|off|edits only|edits only (+ thinking)]", "warning");
					return;
				}
				this.choose(level);
			},
		});
		pi.registerShortcut(SILENT_SHORTCUT, {
			description: "Toggle silent mode",
			handler: () => {
				const state = sharedState();
				this.choose(state.enabled || state.editsOnly || state.editsThinking ? "off" : "on");
			},
		});
	}

	/** A choice made in the session, which a /reload keeps over the configured mode. */
	private choose(level: SilentLevel): void {
		sharedState().overridden = true;
		// No notification: Pi writes notices into the transcript, which is exactly
		// what silent mode keeps clean.
		this.apply(level);
		if (level === "off" && this.context) this.onVisible?.(this.context);
	}

	isEnabled(): boolean {
		return sharedState().enabled;
	}

	bind(ctx: ExtensionContext, mode: DisplayMode, reload: boolean): void {
		this.context = ctx;
		installIdleGlyph();
		this.activity.bind(ctx);
		// An invisible widget is the extension API's way to reach Pi's TUI, and
		// through it the chat container whose notices silent mode hides.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			hookChatNotices(tui);
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
		const state = sharedState();
		if (!reload) state.overridden = false;
		// A new session starts on edits only, with thinking blocks hidden. Configured full silent still starts on.
		// /silent off or on in this session is kept across /reload.
		this.apply(state.overridden ? currentLevel(state) : mode === "silent" ? "on" : "edits");
	}

	dispose(): void {
		this.activity.dispose();
		// A patched Pi prototype outlives this extension instance. Disable hiding
		// while no instance is bound, but keep the choice for a subsequent /reload.
		sharedState().active = false;
		this.context?.ui.setStatus(STATUS_KEY, undefined);
		this.context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		this.context = undefined;
	}

	private apply(level: SilentLevel): boolean {
		const state = sharedState();
		if (level !== "off" && !installPatches()) {
			state.active = false;
			state.enabled = false;
			state.editsOnly = false;
			state.editsThinking = false;
			this.activity.setEnabled(false);
			this.context?.ui.notify("Silent mode is unavailable in this version of Pi", "warning");
			return false;
		}
		const previous = currentLevel(state);
		// Hiding or revealing rows above the reader would otherwise move the view.
		if (level !== previous) captureViewport();
		state.enabled = level === "on";
		state.editsOnly = level === "edits";
		state.editsThinking = level === "edits-thinking";
		// The working-label glyph is the progress mark. The line under the prompt stays off.
		this.activity.setEnabled(false);
		state.active = this.context !== undefined;
		// Silent mode shows no indicator of its own; the transcript itself is the cue.
		// Clearing the status still requests a render, which is what reveals or hides
		// rows already in the transcript, and removes the label older versions left.
		this.context?.ui.setStatus(STATUS_KEY, undefined);
		return true;
	}
}
