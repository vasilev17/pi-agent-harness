import { UserMessageComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { onTick } from "./compact-tools-clock.ts";
import { colorizeRgb, interpolateRgb } from "./compact-tools-color.ts";
import { hookMethod } from "./compact-tools-hook.ts";
import { activityGlow, perPalette, type ThinkingLevel } from "./compact-tools-palette.ts";

const WIDGET_KEY = "compact-tools-silent-activity-render";
const ACTIVITY_STATE = Symbol.for("pi-compact-tools.silent.activity.state");
// Markers under which earlier versions kept the unwrapped methods; hookMethod
// replaces those wrappers so a /reload never leaves the old drawing in place.
const LEGACY_USER_RENDER = Symbol.for("pi-compact-tools.silent.activity.originalUserRender");
const LEGACY_TRANSCRIPT_RENDER = Symbol.for("pi-compact-tools.silent.activity.originalTranscriptRender");
const LEGACY_GAP_RENDER = Symbol.for("pi-compact-tools.silent.activity.originalGapRender");
/**
 * Pi mounts the same components in regular and fullscreen mode, in this order:
 * transcript, pending messages, status, widgets above, editor, widgets below, footer.
 */
const MOUNTED_CHILDREN = 7;
const WIDGETS_ABOVE_CHILD = 3;
/**
 * Frames per run to the end of the line and back, on the shared 80 ms clock: about
 * two seconds. The light crosses the middle fast, a cell or more per frame, so
 * few frames are needed; the tail fills in every cell it swept past between them.
 */
const BREATH_FRAMES = 26;
const DOT_COUNT = 9;
/**
 * Pi draws the working label into the editor's top border after a "── " prefix,
 * so the label's first letter sits in column 3. The line starts there too, lining
 * up with "Thinking…" just below it.
 */
const LABEL_COLUMN = 3;
/** A heavy line segment: consecutive cells join into one unbroken line, like the editor border below. */
const DOT = "━";
/** Brightness a passed cell keeps from one 80 ms frame to the next: the tail fades within about a third of a second. */
const AFTERGLOW = 0.6;
/** Frames of history the tail is traced over; beyond this it is fully dark. */
const AFTERGLOW_FRAMES = 8;
/** Samples between frames, so a light crossing two cells in one frame still leaves both in its tail. */
const SUBSTEPS = 8;
/** Brightness levels: coarse enough that unchanged frames compare equal and skip a repaint. */
const TONE_LEVELS = 32;
/** Perceptual easing for color: faint tail steps would otherwise read as bands. */
const TONE_GAMMA = 0.75;

/**
 * Where the light is at a (possibly fractional) frame. It runs to the last cell and
 * back, and each run follows a quintic S-curve (smootherstep): it lingers at each
 * end, is fastest through the middle, and settles into the far end.
 */
function lightPosition(time: number): number {
	const step = ((time % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
	const half = BREATH_FRAMES / 2;
	const run = step < half ? step / half : (BREATH_FRAMES - step) / half;
	return run * run * run * (run * (run * 6 - 15) + 10) * (DOT_COUNT - 1);
}

function cellAt(time: number): number {
	return Math.round(lightPosition(time));
}

/**
 * Brightness of every cell for one frame. The head is the cell the light is on, at
 * full brightness. A cell it has passed, even between two frames, keeps a fading
 * afterimage, so the light trails an unbroken tail. Nothing ahead of the head is
 * ever lit: the direction turns only when the head actually steps off an end cell,
 * and cells ahead of it in the new direction are dark.
 */
function computeFrame(frame: number): number[] {
	const head = cellAt(frame);
	let direction: 1 | -1 = 1;
	for (let sample = 1; sample <= BREATH_FRAMES * SUBSTEPS; sample++) {
		const previous = cellAt(frame - sample / SUBSTEPS);
		if (previous !== head) {
			direction = head > previous ? 1 : -1;
			break;
		}
	}
	return Array.from({ length: DOT_COUNT }, (_, index) => {
		if ((index - head) * direction > 0) return 0;
		for (let sample = 0; sample <= AFTERGLOW_FRAMES * SUBSTEPS; sample++) {
			if (cellAt(frame - sample / SUBSTEPS) === index) {
				return Math.round(AFTERGLOW ** (sample / SUBSTEPS) * TONE_LEVELS) / TONE_LEVELS;
			}
		}
		return 0;
	});
}

// One run is computed once when the module loads; every frame after is a lookup.
const FRAMES: readonly (readonly number[])[] = Array.from({ length: BREATH_FRAMES }, (_, frame) => computeFrame(frame));
const FRAME_CHANGED: readonly boolean[] = FRAMES.map((cells, frame) => {
	const previous = FRAMES[(frame + BREATH_FRAMES - 1) % BREATH_FRAMES]!;
	return cells.some((value, index) => value !== previous[index]);
});

function frameIndex(frame: number): number {
	return ((Math.floor(frame) % BREATH_FRAMES) + BREATH_FRAMES) % BREATH_FRAMES;
}

/** Brightness of each cell, 0 to 1, at a frame. */
export function dotIntensities(frame: number): number[] {
	return [...FRAMES[frameIndex(frame)]!];
}

/** Whether a frame looks different from the one before it; an identical frame needs no repaint. */
export function frameChanges(frame: number): boolean {
	return FRAME_CHANGED[frameIndex(frame)]!;
}

type PaintedBreath = readonly (readonly string[])[];

/**
 * Every dot of every frame of a breath at a level, painted once per palette. A breath
 * has a fixed number of frames, so each frame the line draws after that is a lookup.
 */
function paintedBreath(theme: Theme, level: ThinkingLevel): PaintedBreath {
	const byLevel = perPalette(theme, "activity-breath", () => new Map<ThinkingLevel, PaintedBreath>());
	let breath = byLevel.get(level);
	if (!breath) {
		const glow = activityGlow(theme, level);
		const paint = (intensity: number) => glow
			? colorizeRgb(theme, interpolateRgb(glow.from, glow.to, intensity ** TONE_GAMMA), DOT)
			// Reached only when the theme's colors did not resolve.
			: theme.fg(intensity > 0.5 ? "text" : "dim", DOT);
		breath = FRAMES.map((cells) => cells.map(paint));
		byLevel.set(level, breath);
	}
	return breath;
}

/** A line the light runs along with a fading afterimage, in the thinking level's color, fitted to the width. */
export function renderActivityDots(
	frame: number,
	width: number,
	theme: Theme,
	level: ThinkingLevel = "medium",
	column = LABEL_COLUMN,
): string[] {
	if (width <= 0) return [];
	const indent = Math.max(0, Math.min(column, width - 1));
	const fitting = Math.min(DOT_COUNT, width - indent);
	return [" ".repeat(indent) + paintedBreath(theme, level)[frameIndex(frame)]!.slice(0, fitting).join("")];
}

/** Add the activity row directly beneath the prompt, keeping Pi's padding inside its box. */
export function attachActivityToUserMessage(lines: string[], activity: string): string[] {
	return [...lines, activity];
}

interface ActivityState {
	active: boolean;
	frame: number;
	level?: ThinkingLevel;
	theme?: Theme;
	tui?: TUI;
	target?: UserMessageComponent;
	candidate?: UserMessageComponent;
	selectionPending?: boolean;
}

function sharedActivityState(): ActivityState {
	const holder = globalThis as typeof globalThis & { [ACTIVITY_STATE]?: ActivityState };
	holder[ACTIVITY_STATE] ??= { active: false, frame: 0 };
	return holder[ACTIVITY_STATE];
}

/** Fill unused transcript rows above the content while silent mode is active. */
export function bottomAlignTranscript(lines: string[], viewportHeight: number): string[] {
	const gap = Math.max(0, Math.floor(viewportHeight) - lines.length);
	return gap > 0 ? [...Array<string>(gap).fill(""), ...lines] : lines;
}

function patchTranscriptAlignment(tui: TUI): void {
	const getPrimaryScrollView = (tui as TUI & { getPrimaryScrollView?: () => unknown }).getPrimaryScrollView;
	const scroll = getPrimaryScrollView?.call(tui) as { child?: { render(width: number): string[] }; viewportHeight?: number } | undefined;
	const document = scroll?.child;
	if (!document) return;
	hookMethod(document, "render", "activity.transcriptRender", (self, args, original) => {
		const lines: string[] = original.apply(self, args);
		if (!sharedActivityState().active) return lines;
		const height = scroll?.viewportHeight;
		return typeof height === "number" ? bottomAlignTranscript(lines, height) : lines;
	}, [LEGACY_TRANSCRIPT_RENDER]);
}

type ContainerLike = { children?: unknown[]; render(width: number): string[] };

function isSpacer(component: unknown): boolean {
	return typeof component === "object" && component !== null && component.constructor?.name === "Spacer";
}

/**
 * Pi keeps one blank row between the transcript and the editor: the widgets-above
 * area renders a lone spacer when no extension placed a widget there. While the
 * line animates it already separates the prompt from the editor, so that row
 * would only push them apart. It is found by its fixed place among the TUI's
 * children, the same in regular and fullscreen mode, and left
 * alone whenever the layout differs or a real widget occupies it.
 */
function patchEditorGap(tui: TUI): void {
	const children = (tui as TUI & { children?: unknown[] }).children;
	if (!Array.isArray(children) || children.length !== MOUNTED_CHILDREN) return;
	const gap = children[WIDGETS_ABOVE_CHILD] as ContainerLike | undefined;
	if (!gap || !Array.isArray(gap.children)) return;
	hookMethod(gap, "render", "activity.editorGap", (self: ContainerLike, args, original) => {
		if (!sharedActivityState().active) return original.apply(self, args);
		return (self.children ?? []).every(isSpacer) ? [] : original.apply(self, args);
	}, [LEGACY_GAP_RENDER]);
}

/** Draw the activity row as part of the latest submitted user message. */
function patchUserMessage(): boolean {
	const prototype = UserMessageComponent?.prototype;
	if (!prototype) return false;
	return hookMethod(prototype, "render", "activity.userRender", (self: UserMessageComponent, args, original) => {
		const state = sharedActivityState();
		if (!state.active) return original.apply(self, args);
		const lines: string[] = original.apply(self, args);
		if (lines.length === 0) return lines;
		// The transcript renders user messages in order. Commit the last one after
		// the current render pass, then repaint only if the target changed.
		state.candidate = self;
		if (!state.selectionPending) {
			state.selectionPending = true;
			queueMicrotask(() => {
				state.selectionPending = false;
				if (!state.active || state.target === state.candidate) return;
				state.target = state.candidate;
				state.tui?.requestRender();
			});
		}
		if (state.target !== self || !state.theme) return lines;
		const width = args[0] as number;
		return attachActivityToUserMessage(lines, renderActivityDots(state.frame, width, state.theme, state.level)[0] ?? "");
	}, [LEGACY_USER_RENDER]);
}

/** Animates beneath the latest submitted prompt during a silent turn. */
export class SilentActivityAnimator {
	private context: ExtensionContext | undefined;
	private running = false;
	/** The final answer is streaming; the dots step aside rather than sit under it. */
	private answering = false;
	private enabled = false;
	private mounted = false;
	private frame = 0;
	/** Stops this animation's share of the shared clock. */
	private stopTicking: (() => void) | undefined;

	constructor(private readonly pi: ExtensionAPI) {
		pi.on("agent_start", () => {
			if (!this.context) return;
			this.running = true;
			this.answering = false;
			this.refresh();
		});
		// Text means the assistant is answering. Thinking, a tool call, or a new turn
		// means it went back to work, so the dots return.
		pi.on("message_update", (event) => {
			const type = event.assistantMessageEvent?.type;
			if (type === "text_start" || type === "text_delta") this.setAnswering(true);
			else if (type === "thinking_start" || type === "toolcall_start") this.setAnswering(false);
		});
		pi.on("tool_execution_start", () => this.setAnswering(false));
		pi.on("turn_start", () => {
			if (!this.context) return;
			this.running = true;
			this.answering = false;
			this.refresh();
		});
		// agent_end closes a low-level run, not retries/compaction/continuations.
		// Keep the shared clock alive until Pi declares final settlement, as the
		// working-label controller already does.
		pi.on("agent_settled", () => {
			if (!this.context) return;
			this.running = false;
			this.refresh();
		});
	}

	bind(ctx: ExtensionContext): void {
		this.hide();
		this.context = ctx;
		this.running = ctx.isIdle?.() === false;
		this.answering = false;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.refresh();
	}

	dispose(): void {
		this.hide();
		this.context = undefined;
		this.running = false;
		this.enabled = false;
	}

	/** Guarded like the progress label: a host with a partial API keeps the default color. */
	private readLevel(): ThinkingLevel {
		return typeof this.pi.getThinkingLevel === "function" ? this.pi.getThinkingLevel() : "medium";
	}

	private setAnswering(answering: boolean): void {
		if (!this.context || this.answering === answering) return;
		this.answering = answering;
		this.refresh();
	}

	private refresh(): void {
		if (this.context && this.enabled && this.running && !this.answering) this.show();
		else this.hide();
	}

	private show(): void {
		if (!this.context || this.mounted || !patchUserMessage()) return;
		this.frame = 0;
		this.mounted = true;
		Object.assign(sharedActivityState(), {
			active: true, frame: 0, level: this.readLevel(), theme: this.context.ui.theme,
			target: undefined, candidate: undefined,
		});
		// This invisible widget provides Pi's TUI for animation repaints.
		this.context.ui.setWidget(WIDGET_KEY, (tui) => {
			sharedActivityState().tui = tui;
			patchTranscriptAlignment(tui);
			patchEditorGap(tui);
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
		// Ticks with the working label, so the two share one repaint per frame, and
		// frames that look the same as the last one ask for no repaint at all.
		this.stopTicking = onTick(() => {
			this.frame++;
			const state = sharedActivityState();
			const level = this.readLevel();
			const changed = frameChanges(this.frame) || level !== state.level;
			state.frame = this.frame;
			state.level = level;
			if (changed) state.tui?.requestRender();
		});
	}

	private hide(): void {
		const state = sharedActivityState();
		state.active = false;
		state.tui = undefined;
		state.target = undefined;
		state.candidate = undefined;
		this.stopTicking?.();
		this.stopTicking = undefined;
		if (!this.mounted) return;
		this.mounted = false;
		this.context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
	}
}
