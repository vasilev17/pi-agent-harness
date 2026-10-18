import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, isKeyRelease, isKeyRepeat, matchesKey, stripTerminalSequences, TuiAltScreen, type TUI } from "@earendil-works/pi-tui";
import { hookMethod } from "./compact-tools-hook.ts";

const WIDGET_KEY = "compact-tools-viewport";
// Shared through globalThis: the TUI outlives a /reload of this module, so the
// render wrapper installed on it must reach whichever instance is loaded now.
const STATE_KEY = Symbol.for("pi-compact-tools.viewport.state");
/** Consecutive lines matched together, so a lone repeated line cannot anchor the view. */
const ANCHOR_LINES = 2;
/** How far past the anchor to compare when a short window matches in several places. */
const TIE_BREAK_LINES = 200;
/** Pi keybindings that change the height of rows throughout the transcript, with Pi's defaults. */
const RELAYOUT_BINDINGS = { "app.tools.expand": "ctrl+o", "app.thinking.toggle": "ctrl+t" } as const;

interface ScrollViewLike {
	readonly scrollTop: number;
	readonly isFollowingEnd: boolean;
	readonly viewportHeight: number;
	child?: { render(width: number): string[] };
	getContentWidth?(width: number): number;
	updateLayout?(contentHeight: number, viewportHeight: number, requestRender?: () => void): void;
	requestRenderCallback?: () => void;
	scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
}

interface LayoutBox {
	scrollView?: unknown;
	scrollContentLines?: string[];
	rect?: { width: number };
	children?: LayoutBox[];
}

interface TuiLike {
	currentLayout?: { root?: LayoutBox };
	terminal?: { columns?: number };
	getPrimaryScrollView?(): ScrollViewLike | undefined;
	doRender?(...args: unknown[]): unknown;
}

interface Snapshot {
	scrollView: ScrollViewLike;
	columns: number | undefined;
	width: number;
	lines: string[];
	top: number;
	height: number;
}

interface ViewportState {
	tui?: TuiLike;
	pending?: Snapshot;
	restore?: (tui: TuiLike) => void;
}

function sharedState(): ViewportState {
	const holder = globalThis as typeof globalThis & { [STATE_KEY]?: ViewportState };
	holder[STATE_KEY] ??= {};
	return holder[STATE_KEY];
}

function hasText(line: string | undefined): boolean {
	return line !== undefined && stripTerminalSequences(line).trim().length > 0;
}

/** How many lines from `row` in `before` continue unchanged from `start` in `after`. */
function matchingRun(before: readonly string[], row: number, after: readonly string[], start: number, limit: number): number {
	let length = 0;
	while (length < limit && row + length < before.length && before[row + length] === after[start + length]) length++;
	return length;
}

/**
 * Where to scroll so the text the reader was looking at stays on the same screen
 * row after rows above it grew or shrank. Lines on screen are tried top first,
 * then lines above the viewport, so a row that disappeared hands over to the
 * nearest text that survived. Returns undefined when nothing survived.
 */
export function findAnchorTop(
	before: readonly string[],
	top: number,
	height: number,
	after: readonly string[],
): number | undefined {
	const starts = new Map<string, number[]>();
	after.forEach((line, index) => {
		const list = starts.get(line);
		if (list) list.push(index);
		else starts.set(line, [index]);
	});
	const bottom = Math.min(before.length, top + Math.max(1, height));
	// Visit the viewport first, then preceding rows, without copying candidate windows.
	for (let candidate = 0; candidate < bottom; candidate++) {
		const row = candidate < bottom - top ? top + candidate : bottom - candidate - 1;
		if (row + ANCHOR_LINES > before.length || (!hasText(before[row]) && !hasText(before[row + 1]))) continue;
		// Several places can match a short window; the one that keeps matching for
		// longest is the same text, and distance only breaks a remaining tie.
		let best: number | undefined;
		let bestRun = 0;
		for (const start of starts.get(before[row]!) ?? []) {
			const run = matchingRun(before, row, after, start, TIE_BREAK_LINES);
			if (run < ANCHOR_LINES) continue;
			if (best === undefined || run > bestRun
				|| (run === bestRun && Math.abs(start - row) < Math.abs(best - row))) {
				best = start;
				bestRun = run;
			}
		}
		if (best !== undefined) return Math.max(0, best - (row - top));
	}
	return undefined;
}

function findScrollBox(box: LayoutBox | undefined, scrollView: ScrollViewLike): LayoutBox | undefined {
	if (!box) return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const match = findScrollBox(child, scrollView);
		if (match) return match;
	}
	return undefined;
}

/**
 * Remember what the transcript shows right now, before a change that resizes rows
 * throughout it. The next frame scrolls so the same text stays in place. Pi's
 * fullscreen viewport keeps its offset from the top, so without this, expanding
 * rows above the reader pushes what they were reading out of view.
 */
export function captureViewport(): void {
	const state = sharedState();
	state.pending = undefined;
	const tui = state.tui;
	const scrollView = tui?.getPrimaryScrollView?.();
	// Following the end already keeps the newest output in view.
	if (!tui || !scrollView || scrollView.isFollowingEnd) return;
	const box = findScrollBox(tui.currentLayout?.root, scrollView);
	if (!box?.scrollContentLines || !box.rect) return;
	state.pending = {
		scrollView,
		columns: tui.terminal?.columns,
		width: scrollView.getContentWidth?.(box.rect.width) ?? box.rect.width,
		lines: box.scrollContentLines.slice(),
		top: scrollView.scrollTop,
		height: scrollView.viewportHeight,
	};
}

function restoreViewport(tui: TuiLike): void {
	const state = sharedState();
	const pending = state.pending;
	state.pending = undefined;
	if (!pending || pending.columns !== tui.terminal?.columns) return;
	const scrollView = pending.scrollView;
	if (scrollView !== tui.getPrimaryScrollView?.() || scrollView.isFollowingEnd || !scrollView.child) return;
	// A relayout leaves scrollTop alone. If it moved, the reader scrolled since the
	// snapshot, and restoring would undo that.
	if (scrollView.scrollTop !== pending.top) return;
	const after = scrollView.child.render(pending.width);
	const top = findAnchorTop(pending.lines, pending.top, pending.height, after);
	if (top === undefined || top === scrollView.scrollTop) return;
	// scrollTo clamps against the previous frame's height; publish the new height first.
	scrollView.updateLayout?.(after.length, scrollView.viewportHeight, scrollView.requestRenderCallback);
	scrollView.scrollTo(top, { disableFollow: true });
}

/**
 * Run the pending restore just before Pi lays out a fullscreen frame, so no frame
 * shows the jump. The hook sits on the fullscreen renderer's class rather than on
 * an instance: extensions only ever see a proxy to the current renderer, and a
 * switch to fullscreen in /settings creates a new one.
 */
function hookFullscreenRender(): void {
	const prototype = (TuiAltScreen as unknown as { prototype?: object } | undefined)?.prototype;
	if (!prototype) return;
	hookMethod(prototype, "doRender", "viewport.doRender", (self: TuiLike, args, original) => {
		if (sharedState().pending) {
			try {
				restoreViewport(self);
			} catch {
				// Keeping the position is a nicety; never let it block a frame.
			}
		}
		return original.apply(self, args);
	});
}

function isRelayoutKey(data: string): boolean {
	// Kitty terminals also report releases and repeats; only the press relays out.
	if (isKeyRelease(data) || isKeyRepeat(data)) return false;
	const keybindings = getKeybindings();
	return Object.entries(RELAYOUT_BINDINGS).some(([binding, fallback]) =>
		// A host that never registered Pi's app bindings still uses the defaults.
		keybindings.getKeys(binding as never).length > 0
			? keybindings.matches(data, binding as never)
			: matchesKey(data, fallback));
}

/** Keeps the reader's place when expand, collapse, thinking, or silent mode resize the transcript. */
export class ViewportKeeper {
	private context: ExtensionContext | undefined;
	private unsubscribe: (() => void) | undefined;

	bind(ctx: ExtensionContext): void {
		this.dispose();
		this.context = ctx;
		hookFullscreenRender();
		// Earlier versions wrapped a renderer instance directly and call this slot;
		// pointing it at the current restore keeps those in step until Pi restarts.
		sharedState().restore = restoreViewport;
		// An invisible widget is the extension API's way to reach Pi's TUI.
		ctx.ui.setWidget(WIDGET_KEY, (tui: TUI) => {
			sharedState().tui = tui as unknown as TuiLike;
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
		this.unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (isRelayoutKey(data)) captureViewport();
			// Observe only: Pi and the thinking controller still handle the key.
			return undefined;
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		const state = sharedState();
		state.pending = undefined;
		state.tui = undefined;
		this.context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		this.context = undefined;
	}
}
