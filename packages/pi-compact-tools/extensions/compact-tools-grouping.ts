import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type AgentToolResult,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CLAUDE_RESULT_PREFIX, claudeFailure, lookHint, lookKind, pathOf, type LookKind } from "./compact-tools-claude.ts";
import {
	CODEX_BULLET,
	CODEX_INDENT,
	CODEX_MARGIN,
	CODEX_PREVIEW_ROWS,
	CODEX_RESULT_PREFIX,
	codexDisclosure,
	exploreActions,
	exploreFailure,
	exploreLines,
	openExplorations,
	paintSegments,
	wrapSegments,
	type ExploreAction,
	type Segment,
} from "./compact-tools-codex.ts";
import { formatDurationMs, type RowStatus } from "./compact-tools-core.ts";
import { hookMethod } from "./compact-tools-hook.ts";
import { getTextResult } from "./compact-tools-invocation.ts";
import { outputPadLines } from "./compact-tools-layout.ts";
import { chromePainter, paintIndicator } from "./compact-tools-palette.ts";
import type { ToolRuntime } from "./compact-tools-runtime.ts";
import { findChat, isKind, isSilent } from "./compact-tools-silent.ts";
import { captureViewport } from "./compact-tools-viewport.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

const WIDGET_KEY = "compact-tools-groups";

/** Claude Code's words for each way of looking around, in the order it lists them. */
const PHRASES: ReadonlyArray<{ kind: LookKind; running: string; done: string; singular: string; plural: string }> = [
	{ kind: "search", running: "searching for", done: "searched for", singular: "pattern", plural: "patterns" },
	{ kind: "read", running: "reading", done: "read", singular: "file", plural: "files" },
	{ kind: "list", running: "listing", done: "listed", singular: "directory", plural: "directories" },
];

/** A click opens one group; Ctrl+O opens every row and its output, which is rarely what a reader wants here. */
export const EXPAND_HINT = "(click to expand)";

/** The fields of Pi's tool row a group summary reads. */
export interface ToolRowLike {
	toolName: string;
	toolCallId: string;
	args: unknown;
	result?: AgentToolResult<unknown> & { isError?: boolean };
	isPartial: boolean;
	expanded: boolean;
	/** Present on Pi 1.1+ tool components, absent on legacy hosts. */
	outputPad?: number;
	render(width: number): string[];
	handleMouse?(event: unknown): unknown;
	invalidate(): void;
	setExpanded?(expanded: boolean): void;
}

/** Whether a call without its result can still get one; the row itself answers the same way. */
export type CanRun = (row: ToolRowLike) => boolean;

const ALWAYS_RUNS: CanRun = () => true;

/**
 * A call with no result yet runs, unless it can no longer get one: restored from
 * the session without it, or left without it when its run ended. Then it waits,
 * as its row shows.
 */
export function memberStatus(row: ToolRowLike, canRun: CanRun = ALWAYS_RUNS): RowStatus {
	if (!row.result || row.isPartial) return canRun(row) ? "running" : "pending";
	return row.result.isError ? "error" : "success";
}

function argsOf(row: ToolRowLike): ToolArgs {
	return typeof row.args === "object" && row.args !== null ? row.args as ToolArgs : {};
}

// Keyed by the row and checked against its arguments, which stream in: a command is
// parsed once rather than on every frame the whole transcript repaints.
const kinds = new WeakMap<object, { args: unknown; kind: LookKind | undefined }>();

function kindOf(row: ToolRowLike): LookKind | undefined {
	const cached = kinds.get(row);
	if (cached && cached.args === row.args) return cached.kind;
	const kind = lookKind(row.toolName, argsOf(row));
	kinds.set(row, { args: row.args, kind });
	return kind;
}

// Codex parses a command into what it does, once for each set of arguments as they stream in.
const explorations = new WeakMap<object, { args: unknown; actions: ExploreAction[] | undefined }>();

function exploreOf(row: ToolRowLike): ExploreAction[] | undefined {
	const cached = explorations.get(row);
	if (cached && cached.args === row.args) return cached.actions;
	const actions = exploreActions(row.toolName, argsOf(row));
	explorations.set(row, { args: row.args, actions });
	return actions;
}

function lastRunning(rows: readonly ToolRowLike[], canRun: CanRun): ToolRowLike | undefined {
	for (let index = rows.length - 1; index >= 0; index--) {
		if (memberStatus(rows[index]!, canRun) === "running") return rows[index];
	}
	return undefined;
}

/**
 * How many patterns, files, and directories a group covers, counted as Claude Code
 * counts them: files by distinct path, and reads by command only when no file was read.
 */
export function countGroup(rows: readonly ToolRowLike[]): Record<LookKind, number> {
	const counts: Record<LookKind, number> = { search: 0, read: 0, list: 0 };
	const paths = new Set<string>();
	let readCommands = 0;
	for (const row of rows) {
		const kind = kindOf(row);
		if (kind === "read" && row.toolName === "read") paths.add(pathOf(argsOf(row)));
		else if (kind === "read") readCommands++;
		else if (kind) counts[kind]++;
	}
	counts.read = paths.size > 0 ? paths.size : readCommands;
	return counts;
}

/**
 * "Searched for 2 patterns, read 3 files". While any call in the group still runs,
 * every verb reads in progress. `bold` marks the counts, as Claude Code does.
 */
export function summarizeGroup(
	rows: readonly ToolRowLike[],
	bold: (text: string) => string = (text) => text,
	canRun: CanRun = ALWAYS_RUNS,
): string {
	const counts = countGroup(rows);
	const running = lastRunning(rows, canRun) !== undefined;
	const text = PHRASES.filter((phrase) => counts[phrase.kind] > 0)
		.map((phrase) => {
			const count = counts[phrase.kind];
			return `${running ? phrase.running : phrase.done} ${bold(String(count))} ${count === 1 ? phrase.singular : phrase.plural}`;
		})
		.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** While a call runs, the line under its group names what it looks at. */
export function groupHint(rows: readonly ToolRowLike[], canRun: CanRun = ALWAYS_RUNS): string | undefined {
	const running = lastRunning(rows, canRun);
	if (!running) return undefined;
	return lookHint(running.toolName, argsOf(running)) || undefined;
}

/** Claude Code keeps a failure in view beneath the folded group. */
export function groupFailures(rows: readonly ToolRowLike[]): string[] {
	return rows.filter((row) => memberStatus(row) === "error")
		.map((row) => claudeFailure(row.toolName, getTextResult(row.result!)).headline);
}

/**
 * A finished group's lines, and everything they were drawn from. Only a group with
 * no running row is kept, so every row in it has its final result.
 */
type HeaderCache = {
	paint: string;
	width: number;
	expanded: boolean;
	rows: readonly ToolRowLike[];
	args: unknown[];
	results: unknown[];
	lines: string[];
};

type GroupState = { expanded: boolean; lastHostExpanded: boolean; header?: HeaderCache };

/** The colors a group line is drawn in, resolved once per frame rather than once per group. */
type Paint = { theme: Theme; chrome: (text: string) => string; key: string };

/** Theme colors a group line uses; a theme that changes any of them draws the lines anew. */
const PAINT_COLORS = ["toolTitle", "error", "success", "muted", "dim", "text", "borderMuted", "accent"] as const;

function headerStill(cache: HeaderCache, rows: readonly ToolRowLike[], paint: string, width: number, expanded: boolean): boolean {
	if (cache.paint !== paint || cache.width !== width || cache.expanded !== expanded || cache.rows.length !== rows.length) return false;
	return rows.every((row, index) => row === cache.rows[index] && row.args === cache.args[index]
		&& row.result === cache.results[index]);
}

/** A run of tool rows drawn as one summary line, which a click or Ctrl+O opens into the rows themselves. */
export class ToolGroupComponent extends Container {
	constructor(
		readonly rows: readonly ToolRowLike[],
		/** Every child the group folded, in order: its tool rows and the thinking between them. */
		members: readonly unknown[],
		private readonly state: GroupState,
		private readonly draw: (rows: readonly ToolRowLike[], width: number, expanded: boolean) => string[],
		private readonly onToggle: (expanded: boolean) => void,
		/** Lines beneath an opened group's members, which a click closes too. */
		footer?: (width: number) => string[],
	) {
		super();
		// Ctrl+O expands every tool row in Pi; the group follows it both ways.
		const hostExpanded = rows[0]!.expanded;
		if (state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
		}
		const handleMouse = (event: { type?: string; button?: string }) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			captureViewport();
			this.state.expanded = !this.state.expanded;
			this.onToggle(this.state.expanded);
			return { handled: true };
		};
		this.addChild({ render: (width) => this.draw(this.rows, width, this.state.expanded), invalidate() {}, handleMouse } as Component);
		if (!state.expanded) return;
		for (const member of members) this.addChild(member as Component);
		if (footer) this.addChild({ render: footer, invalidate() {}, handleMouse } as Component);
	}
}

/** Which rows fold into a group: what Claude Code counts as looking around, or what Codex parses as exploring. */
export type GroupStyle = "claude" | "codex";

function isGroupable(child: unknown, style: GroupStyle = "claude"): child is ToolRowLike {
	if (!isKind(child, ToolExecutionComponent)) return false;
	return style === "codex" ? exploreOf(child as ToolRowLike) !== undefined : kindOf(child as ToolRowLike) !== undefined;
}

type AssistantLike = { lastMessage?: { content?: Array<{ type: string; text?: string }> } };

/** A turn with no text for the reader: it only thought, then handed off to tools. */
function isThinkingOnly(child: unknown): boolean {
	if (!isKind(child, AssistantMessageComponent)) return false;
	const content = (child as AssistantLike).lastMessage?.content ?? [];
	return !content.some((block) => block.type === "text" && block.text?.trim());
}

/**
 * What may sit between two calls of one group: a turn that only thought, and the
 * status lines Pi writes into the chat itself, such as "Tool output: collapsed".
 */
function isFoldable(child: unknown): boolean {
	return isThinkingOnly(child) || isKind(child, Text) || isKind(child, Spacer);
}

/**
 * Replace each run of reads, searches, and listings with one group. What sits
 * between two of them folds into the group, as Claude Code keeps thinking out
 * of the way; anything else, text, a command, an edit, ends the run.
 */
export function groupChildren(
	children: readonly unknown[],
	makeGroup: (rows: ToolRowLike[], members: unknown[]) => Component,
	style: GroupStyle = "claude",
): unknown[] {
	const grouped: unknown[] = [];
	let rows: ToolRowLike[] = [];
	let members: unknown[] = [];
	let pending: unknown[] = [];
	const flush = () => {
		if (rows.length > 0) grouped.push(makeGroup(rows, members));
		rows = [];
		members = [];
	};
	for (const child of children) {
		if (isGroupable(child, style)) {
			rows.push(child);
			members.push(...pending, child);
			pending = [];
			continue;
		}
		if (rows.length > 0 && isFoldable(child)) {
			pending.push(child);
			continue;
		}
		flush();
		grouped.push(...pending, child);
		pending = [];
	}
	flush();
	grouped.push(...pending);
	return grouped;
}

/** Claude and Codex styles: runs of reads, searches, and listings fold into one group each. */
export class ToolGroupController {
	private context: ExtensionContext | undefined;
	private readonly states = new WeakMap<object, GroupState>();
	/** This frame's colors, set as the chat starts drawing. */
	private paint: Paint | undefined;
	/** Asks the runtime, which knows which run each call belongs to, as the call's own row does. */
	private readonly canRun: CanRun = (row) => this.runtime.canRun(row.toolCallId);

	constructor(private readonly runtime: ToolRuntime) {}

	bind(ctx: ExtensionContext): void {
		this.dispose();
		this.context = ctx;
		// An invisible widget is the extension API's way to reach Pi's TUI and its chat.
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const chat = findChat(tui);
			if (chat) {
				hookMethod(chat, "render", "claude.groups", (self, args, original) => {
					const style = this.runtime.config.style;
					if (!this.context || isSilent() || (style !== "claude" && style !== "codex")) return original.apply(self, args);
					const children = self.children as unknown[];
					this.paint = this.resolvePaint();
					openExplorations.clear();
					self.children = groupChildren(children, (rows, members) => this.makeGroup(rows, members, tui), style);
					try {
						return original.apply(self, args);
					} finally {
						self.children = children;
						this.paint = undefined;
					}
				});
			}
			return { render: () => [], invalidate() {} };
		}, { placement: "belowEditor" });
	}

	dispose(): void {
		this.context?.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		this.context = undefined;
	}

	private makeGroup(rows: ToolRowLike[], members: unknown[], tui: { requestRender(): void }): Component {
		const key = rows[0]!;
		let state = this.states.get(key);
		if (!state) {
			state = { expanded: key.expanded, lastHostExpanded: key.expanded };
			this.states.set(key, state);
		}
		const groupState = state;
		const draw = (group: readonly ToolRowLike[], width: number, expanded: boolean) => {
			const pad = group[0]?.outputPad;
			return outputPadLines(this.drawCached(group, width + (pad === 0 ? 1 : 0), expanded, groupState), width, pad);
		};
		if (this.runtime.config.style !== "codex") return new ToolGroupComponent(rows, members, state, draw, () => tui.requestRender());
		// Codex opens a group to the whole of each call, and closes it from one "− Show less" beneath them.
		const toggle = (expanded: boolean) => {
			for (const row of rows) row.setExpanded?.(expanded);
			tui.requestRender();
		};
		const footer = (width: number) => {
			const theme = this.paint?.theme ?? this.context?.ui.theme;
			const pad = rows[0]?.outputPad;
			const available = width + (pad === 0 ? 1 : 0);
			return theme ? outputPadLines([truncateToWidth(theme.fg("dim", codexDisclosure(available, true)), Math.max(1, available), "…")], width, pad) : [];
		};
		const group = new ToolGroupComponent(rows, members, state, draw, toggle, footer);
		// Read once the group has followed Ctrl+O, which it does as it is made. A call that joins an
		// opened group opens with it, as every call in an opened Codex group shows whole.
		if (state.expanded) {
			for (const row of rows) {
				openExplorations.add(row.toolCallId);
				if (!row.expanded) row.setExpanded?.(true);
			}
		}
		return group;
	}

	private resolvePaint(): Paint | undefined {
		const theme = this.context?.ui.theme;
		if (!theme) return undefined;
		const chrome = chromePainter(theme);
		// The style is part of the key: a group drawn in one style is never reused in another.
		const key = this.runtime.config.style + PAINT_COLORS.map((color) => theme.fg(color, "x")).join("") + theme.bold("x") + chrome("x");
		return { theme, chrome, key };
	}

	/**
	 * A finished group draws the same lines until one of its rows, the width, the
	 * expansion, or the theme changes, so those lines are kept. A running group's
	 * line pulses and counts time, so it is drawn every frame.
	 */
	private drawCached(rows: readonly ToolRowLike[], width: number, expanded: boolean, state: GroupState): string[] {
		const paint = this.paint ?? this.resolvePaint();
		if (!paint) return [];
		if (lastRunning(rows, this.canRun)) return this.draw(rows, width, expanded, paint);
		if (state.header && headerStill(state.header, rows, paint.key, width, expanded)) return state.header.lines;
		const lines = this.draw(rows, width, expanded, paint);
		state.header = {
			paint: paint.key,
			width,
			expanded,
			rows: [...rows],
			args: rows.map((row) => row.args),
			results: rows.map((row) => row.result),
			lines,
		};
		return lines;
	}

	/**
	 * A group's line reads like any other row: its status dot, then what it did in
	 * the title style. While it runs the dot pulses and the line below names what it
	 * looks at.
	 */
	private draw(rows: readonly ToolRowLike[], width: number, expanded: boolean, paint: Paint): string[] {
		if (this.runtime.config.style === "codex") return this.drawCodex(rows, width, expanded, paint);
		const { theme, chrome } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		// A call that waits for a result it will never get leaves the group waiting too.
		const status: RowStatus = running ? "running" : statuses.includes("error") ? "error"
			: statuses.includes("pending") ? "pending" : "success";
		const summary = summarizeGroup(rows, undefined, this.canRun);
		let title = ` ${paintIndicator(theme, status, this.runtime.frame)} ${theme.fg("toolTitle", theme.bold(summary))}`;
		if (running) {
			// The folded row is not drawn, so the line that pulses for it keeps the clock going.
			this.runtime.keepAnimating(running.toolCallId);
			const started = this.runtime.timing(running.toolCallId)?.startedAt;
			const elapsed = started === undefined ? 0 : Date.now() - started;
			title += `${elapsed >= 2000 ? chrome(` · ${formatDurationMs(elapsed)}`) : ""}…`;
		}
		if (!expanded) title += chrome(` ${EXPAND_HINT}`);
		const lines = ["", fit(title)];
		const hintText = groupHint(rows, this.canRun);
		if (hintText) lines.push(fit(chrome(`${CLAUDE_RESULT_PREFIX}${hintText}`)));
		if (!expanded) for (const failure of groupFailures(rows)) lines.push(fit(chrome(CLAUDE_RESULT_PREFIX) + theme.fg("error", failure)));
		return lines;
	}

	/**
	 * Codex's exploration: `• Exploring` while a call runs and `• Explored` after,
	 * then a line for what each call did, three rows of them until the group opens.
	 * A failed call says so at the end of its line and in the head's count.
	 */
	private drawCodex(rows: readonly ToolRowLike[], width: number, expanded: boolean, paint: Paint): string[] {
		const { theme } = paint;
		const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
		const running = lastRunning(rows, this.canRun);
		const statuses = rows.map((row) => memberStatus(row, this.canRun));
		if (running) this.runtime.keepAnimating(running.toolCallId);
		const bullet = running ? paintIndicator(theme, "running", this.runtime.frame, CODEX_BULLET)
			: statuses.includes("pending") ? paintIndicator(theme, "pending", 0, CODEX_BULLET) : theme.fg("dim", CODEX_BULLET);
		const failed = statuses.filter((status) => status === "error").length;
		let head = `${CODEX_MARGIN}${bullet} ${theme.bold(running ? "Exploring" : "Explored")}`;
		if (failed > 0) head += theme.bold(theme.fg("error", ` · ${failed} failed`));
		// Opened, Codex lists the calls themselves in place of the summary; each brings its own blank line.
		if (expanded) return [];
		const lines = ["", fit(head)];
		const calls = rows.map((row) => {
			const actions = exploreOf(row) ?? [];
			const failure = row.result && !row.isPartial
				? exploreFailure(row.toolName, getTextResult(row.result), row.result.isError === true, actions) : undefined;
			return { actions, failure };
		});
		const details: string[] = [];
		for (const line of exploreLines(calls)) {
			const verb = `${line.verb} `;
			const segments: Segment[] = line.parts.map((part) => ({ text: part.text, color: part.dim ? "dim" : undefined }));
			if (line.failure) segments.push({ text: line.failure.text, color: line.failure.quiet ? "dim" : "error" });
			const available = Math.max(1, width - visibleWidth(CODEX_INDENT) - verb.length);
			wrapSegments(segments, available, available).forEach((row, index) => {
				details.push((index === 0 ? theme.fg("accent", verb) : " ".repeat(verb.length)) + paintSegments(row, theme));
			});
		}
		details.slice(0, CODEX_PREVIEW_ROWS).forEach((row, index) => {
			lines.push(fit(theme.fg("dim", index === 0 ? CODEX_RESULT_PREFIX : CODEX_INDENT) + row));
		});
		lines.push(fit(theme.fg("dim", codexDisclosure(width, false))));
		return lines;
	}
}
