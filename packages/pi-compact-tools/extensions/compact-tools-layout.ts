import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	Container,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { diffTintRgb, fillRgb, type Rgb } from "./compact-tools-color.ts";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import { resolveLanguage } from "./compact-tools-language.ts";
import { highlightMarkdown } from "./compact-tools-markdown.ts";
import { paintChrome } from "./compact-tools-palette.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

/**
 * Styles include one outer margin column in their prefixes. Pi 1.1+ can request
 * no outer padding; reclaim that column without changing tree/code indentation.
 * Missing fields and outputPad=1 keep the legacy output byte-for-byte.
 */
export function outputPadLines(lines: string[], width: number, outputPad?: number): string[] {
	if (outputPad !== 0) return lines;
	return lines.map((line) => stripTerminalSequences(line).startsWith(" ")
		? sliceByColumn(line, 1, Math.max(0, width), true)
		: truncateToWidth(line, Math.max(0, width), "…"));
}

class UnpaddedComponent implements Component {
	private source?: string[];
	private width?: number;
	private lines: string[] = [];

	constructor(private readonly inner: Component) {}

	render(width: number): string[] {
		const source = this.inner.render(width + 1);
		if (source !== this.source || width !== this.width) {
			this.source = source;
			this.width = width;
			this.lines = outputPadLines(source, width, 0);
		}
		return this.lines;
	}

	invalidate(): void {
		this.inner.invalidate();
		this.source = undefined;
	}
}

export function withOutputPad(component: Component, outputPad?: number): Component {
	return outputPad === 0 ? new UnpaddedComponent(component) : component;
}

export class CachedComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly renderLines: (width: number) => string[],
		private readonly invalidateSource?: () => void,
	) {}

	render(width: number): string[] {
		if (this.cachedWidth !== width || !this.cachedLines) {
			this.cachedWidth = width;
			this.cachedLines = this.renderLines(width);
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.invalidateSource?.();
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * A Container that does not re-copy all child lines on every fullscreen scroll
 * frame. Its lines are kept for a width, and for whatever else `cacheKey()`
 * says they depend on, until a child is added, removed, or invalidated.
 */
export class CachedContainer extends Container {
	private cachedWidth?: number;
	private cachedKey?: unknown;
	private cachedLines?: string[];

	/** What besides the width the lines depend on, read as each frame is drawn. */
	protected cacheKey(): unknown {
		return undefined;
	}

	private clearRenderCache(): void {
		this.cachedWidth = undefined;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.clearRenderCache();
	}

	override removeChild(component: Component): void {
		super.removeChild(component);
		this.clearRenderCache();
	}

	override clear(): void {
		super.clear();
		this.clearRenderCache();
	}

	override render(width: number): string[] {
		const key = this.cacheKey();
		if (this.cachedWidth !== width || this.cachedKey !== key || !this.cachedLines) {
			this.cachedWidth = width;
			this.cachedKey = key;
			this.cachedLines = super.render(width);
		}
		return this.cachedLines;
	}

	override invalidate(): void {
		super.invalidate();
		this.clearRenderCache();
	}
}

/**
 * A call line whose status dot is painted when the row is drawn rather than when
 * it was built. The dot follows the row's state and the animation frame without
 * Pi rebuilding the row, and a line is laid out once for each dot it has shown.
 */
export class LiveCallContainer extends CachedContainer {
	private readonly titles = new Map<string, Component>();
	private indicator = "";
	private readonly titleLine: Component = {
		render: (width) => this.title().render(width),
		invalidate: () => this.titles.clear(),
	};

	constructor(
		private readonly paintIndicator: () => string,
		private readonly renderTitle: (indicator: string) => Component,
	) {
		super();
		super.addChild(this.titleLine);
	}

	/** Clearing removes what was added beneath the call line; the line itself stays. */
	override clear(): void {
		super.clear();
		super.addChild(this.titleLine);
	}

	/** The dot, painted now; the title drawn beneath it follows. */
	protected override cacheKey(): string {
		this.indicator = this.paintIndicator();
		return this.indicator;
	}

	private title(): Component {
		let title = this.titles.get(this.indicator);
		if (!title) {
			title = this.renderTitle(this.indicator);
			this.titles.set(this.indicator, title);
		}
		return title;
	}
}

export function prefixedText(text: string, firstPrefix: string, continuationPrefix = firstPrefix): Component {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
	const normalized = text.replace(/\t/g, "   ");
	return new CachedComponent((width) => {
		const lines = wrapTextWithAnsi(normalized, Math.max(1, width - prefixWidth));
		return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
	});
}

/**
 * Lines under a tree prefix. With `truncate`, each keeps to one row and ends in an
 * ellipsis, the way Claude Code previews; otherwise each wraps in full. Lines are
 * handled one by one, so the indentation that output starts with survives.
 */
export function prefixedLines(text: string, firstPrefix: string, continuationPrefix: string, truncate: boolean): Component {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
	const lines = text.replace(/\t/g, "   ").split("\n");
	return new CachedComponent((width) => {
		const available = Math.max(1, width - prefixWidth);
		const rows = truncate
			? lines.map((line) => truncateToWidth(line, available, "…"))
			: lines.flatMap((line) => hardWrapTextWithAnsi(line, available));
		return rows.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`);
	});
}

/**
 * A sentence under a tree prefix, wrapped at words as a terminal UI wraps prose:
 * a word moves to the next row whole, and only a word longer than a row is split.
 */
export function prefixedSentence(text: string, firstPrefix: string, continuationPrefix: string, trimWrappedIndent = false): Component {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
	const lines = text.replace(/\t/g, "   ").split("\n");
	return new CachedComponent((width) => {
		const available = Math.max(1, width - prefixWidth);
		return lines.flatMap((line) => wrapTextWithAnsi(line, available).map((row, index) => {
			if (trimWrappedIndent && index > 0) {
				const spaces = stripTerminalSequences(row).match(/^ +/u)?.[0].length ?? 0;
				if (spaces) row = sliceByColumn(row, spaces, visibleWidth(row) - spaces, true);
			}
			return truncateToWidth(row, available, "");
		}))
			.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`);
	});
}

/**
 * Output as Claude Code previews it. Each line is wrapped to the width, and rows
 * rather than lines are counted: collapsed, `maxRows` show, all of them when only
 * one more would be hidden, then an optional completion and `more(hidden)`.
 * Claude Code wraps ten columns short of the terminal, so previews break where
 * its own do. Completion rows never count toward the output-preview limit.
 */
export function claudeRows(
	lines: readonly string[],
	firstPrefix: string,
	continuationPrefix: string,
	maxRows: number | undefined,
	more: (hidden: number) => string,
	completion?: Component,
): Component {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix));
	return new CachedComponent((width) => {
		const available = Math.max(1, width - prefixWidth);
		const wrapWidth = maxRows === undefined ? available : Math.min(available, Math.max(width - 10, 10));
		let rows = lines.flatMap((line) => hardWrapTextWithAnsi(line, wrapWidth).map((row) => row.trimEnd()));
		const hidden = maxRows !== undefined && rows.length > maxRows + 1 ? rows.length - maxRows : 0;
		if (hidden) rows = rows.slice(0, maxRows);
		const rendered = rows.map((row, index) => `${index === 0 ? firstPrefix : continuationPrefix}${row}`);
		if (completion) rendered.push(...completion.render(width));
		if (hidden) rendered.push((rendered.length ? continuationPrefix : firstPrefix) + truncateToWidth(more(hidden), available, "…"));
		return rendered;
	}, () => completion?.invalidate());
}

export function hardWrapTextWithAnsi(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const wrapped: string[] = [];
	for (const logicalLine of text.replace(/\t/g, "   ").split("\n")) {
		const lineWidth = visibleWidth(logicalLine);
		if (lineWidth === 0) {
			wrapped.push("");
			continue;
		}
		let offset = 0;
		while (offset < lineWidth) {
			if (offset > 0) {
				const remainder = sliceByColumn(logicalLine, offset, lineWidth - offset, true);
				const whitespace = stripTerminalSequences(remainder).match(/^\s+/u)?.[0] ?? "";
				offset += visibleWidth(whitespace);
				if (offset >= lineWidth) break;
			}
			wrapped.push(sliceByColumn(logicalLine, offset, safeWidth, true));
			offset += safeWidth;
		}
	}
	return wrapped;
}

export function renderToolCall(
	title: string,
	details: string | undefined,
	theme: Theme,
	continuationPrefix = paintChrome(theme, " │ "),
): Component {
	const text = details ? `${title} ${details}` : title;
	const firstPrefix = " ";
	const prefixWidth = visibleWidth(continuationPrefix);
	return new CachedComponent((width) => {
		const lines = hardWrapTextWithAnsi(text, width - prefixWidth);
		return lines.map((line, index) => `${index === 0 ? firstPrefix : continuationPrefix}${line}`);
	});
}

export function styleMultiline(text: string, style: (line: string) => string): string {
	return normalizeLineEndings(text).split("\n").map(style).join("\n");
}

export function renderOutput(output: string, theme: Theme, isError: boolean, rail = paintChrome(theme, " │ ")): Component | undefined {
	const normalized = normalizeLineEndings(output).trimEnd();
	if (!normalized) return undefined;
	const color = isError ? "error" : "toolOutput";
	const styled = normalized.split("\n").map((line) => theme.fg(color, line)).join("\n");
	return prefixedText(styled, rail);
}

export type CodeDiffLineKind = "context" | "add" | "remove" | "separator";

export type CodeDiffLine = {
	kind: CodeDiffLineKind;
	lineNumber?: number;
	content: string;
	hunk: number;
};

export type CodeDiffOptions = {
	/** Context lines kept around each change; omit to keep every context line the diff carries. */
	contextLines?: number;
	rail?: string;
};

const DIFF_SEPARATOR = "\u22ee";

function parseUnifiedPatch(patch: string, tab: string): CodeDiffLine[] {
	const result: CodeDiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;
	let hunk = -1;
	for (const line of normalizeLineEndings(patch).split("\n")) {
		const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
		if (header) {
			if (hunk >= 0) result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk });
			hunk++;
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			continue;
		}
		if (hunk < 0 || line.startsWith("\\ No newline at end of file")) continue;
		const prefix = line[0];
		const content = line.slice(1).replace(/\t/gu, tab);
		if (prefix === "+") {
			result.push({ kind: "add", lineNumber: newLine++, content, hunk });
		} else if (prefix === "-") {
			result.push({ kind: "remove", lineNumber: oldLine++, content, hunk });
		} else if (prefix === " ") {
			result.push({ kind: "context", lineNumber: newLine++, content, hunk });
			oldLine++;
		}
	}
	return result;
}

function parseDisplayDiff(diff: string, tab: string): CodeDiffLine[] {
	const result: CodeDiffLine[] = [];
	let hunk = 0;
	for (const line of normalizeLineEndings(diff).split("\n")) {
		if (/^\s*\.\.\.\s*$/u.test(line)) {
			result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk: hunk++ });
			continue;
		}
		const match = line.match(/^([ +\-])(\s*\d+)\s(.*)$/u);
		if (!match) continue;
		result.push({
			kind: match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context",
			lineNumber: Number(match[2]),
			content: match[3]!.replace(/\t/gu, tab),
			hunk,
		});
	}
	return result;
}

/**
 * Parse a standard patch, falling back to Pi's display-oriented numbered diff. A tab
 * becomes `tab`: three columns as Pi draws code, four as Codex does.
 */
export function parseCodeDiff(patch: string, displayDiff = "", tab = "   "): CodeDiffLine[] {
	const parsedPatch = patch ? parseUnifiedPatch(patch, tab) : [];
	return parsedPatch.length > 0 ? parsedPatch : parseDisplayDiff(displayDiff, tab);
}

/** Drop context that sits far from any change so a collapsed preview still reaches the edit. */
export function trimDiffContext(lines: CodeDiffLine[], contextLines: number): CodeDiffLine[] {
	const kept = lines.map((line) => line.kind !== "context");
	lines.forEach((line, index) => {
		if (line.kind !== "add" && line.kind !== "remove") return;
		for (let offset = 1; offset <= contextLines; offset++) {
			if (lines[index - offset]?.kind === "context") kept[index - offset] = true;
			if (lines[index + offset]?.kind === "context") kept[index + offset] = true;
		}
	});
	const result: CodeDiffLine[] = [];
	lines.forEach((line, index) => {
		const previous = result[result.length - 1];
		// One mark per gap: context dropped next to a hunk break the diff already marks
		// would otherwise draw two.
		if (previous?.kind === "separator" && (!kept[index] || line.kind === "separator")) return;
		if (kept[index]) result.push(line);
		else if (previous) result.push({ kind: "separator", content: DIFF_SEPARATOR, hunk: line.hunk });
	});
	while (result.length > 0 && result[result.length - 1]!.kind === "separator") result.pop();
	return result;
}

/** Past these sizes syntax highlighting costs more than it helps; mirrors Codex's diff renderer. */
const HIGHLIGHT_MAX_CHARS = 512 * 1024;
const HIGHLIGHT_MAX_LINES = 10_000;
const HIGHLIGHT_MAX_LINE_CHARS = 4 * 1024;

function canHighlight(lines: readonly CodeDiffLine[]): boolean {
	if (lines.length > HIGHLIGHT_MAX_LINES) return false;
	let total = 0;
	for (const line of lines) {
		if (line.content.length > HIGHLIGHT_MAX_LINE_CHARS) return false;
		total += line.content.length + 1;
		if (total > HIGHLIGHT_MAX_CHARS) return false;
	}
	return true;
}

/** Highlight each hunk as one block so multi-line strings and comments keep their state. */
function highlightCodeLines(lines: CodeDiffLine[], language: string | undefined, theme: Theme): string[] {
	if (!language || !canHighlight(lines)) {
		return lines.map((line) => line.kind === "separator" ? line.content : theme.fg("toolOutput", line.content));
	}
	const rendered = new Array<string>(lines.length);
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind === "separator") {
			rendered[index] = lines[index]!.content;
			index++;
			continue;
		}
		let end = index;
		while (end < lines.length && lines[end]!.kind !== "separator") end++;
		const contents = lines.slice(index, end).map((line) => line.content);
		const highlighted = language === "markdown"
			? highlightMarkdown(contents, theme)
			: highlightCode(contents.join("\n"), language);
		for (let offset = 0; offset < contents.length; offset++) rendered[index + offset] = highlighted[offset] ?? contents[offset]!;
		index = end;
	}
	return rendered;
}

function hardSliceAnsi(text: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const lineWidth = visibleWidth(text);
	if (lineWidth === 0) return [""];
	const slices: string[] = [];
	for (let offset = 0; offset < lineWidth; offset += safeWidth) {
		slices.push(sliceByColumn(text, offset, safeWidth, true));
	}
	return slices;
}

function codeGutter(
	kind: CodeDiffLineKind,
	lineNumber: number | undefined,
	numberWidth: number,
	signs: boolean,
	theme: Theme,
): string {
	const number = (lineNumber === undefined ? "" : String(lineNumber)).padStart(numberWidth);
	if (!signs) return theme.fg("toolDiffContext", ` ${number} `);
	const sign = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
	const color = kind === "add" ? "toolDiffAdded" : kind === "remove" ? "toolDiffRemoved" : "toolDiffContext";
	return theme.fg(color, ` ${number} ${sign}`);
}

type CharRange = [start: number, end: number];

/** Most token pairs a word diff compares; a longer pair of lines is left untinted instead of taking quadratic time. */
const WORD_DIFF_MAX_CELLS = 40_000;
/** How alike two lines must be, by shared characters, before their changed words are marked. */
const WORD_DIFF_MIN_SIMILARITY = 0.6;
/** How much of the theme color a changed word is tinted with, against the row's own tint. */
const WORD_TINT = 0.32;

/**
 * The changed words of a removed row and the added row that replaces it, as Claude
 * Code marks them: a brighter tint behind each word the pair does not share. Two
 * rows with little in common are rewrites rather than edits and mark nothing.
 */
function wordDiffRanges(removed: string, added: string): { removed: CharRange[]; added: CharRange[] } | undefined {
	const split = (text: string) => text.match(/[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu) ?? [];
	const before = split(removed);
	const after = split(added);
	if (before.length * after.length > WORD_DIFF_MAX_CELLS) return undefined;
	const width = after.length + 1;
	const lengths = new Uint16Array((before.length + 1) * width);
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			lengths[i * width + j] = before[i] === after[j]
				? lengths[(i + 1) * width + j + 1]! + 1
				: Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
		}
	}
	const removedChanged = new Array<boolean>(before.length).fill(true);
	const addedChanged = new Array<boolean>(after.length).fill(true);
	let shared = 0;
	for (let i = 0, j = 0; i < before.length && j < after.length;) {
		if (before[i] === after[j]) {
			removedChanged[i] = addedChanged[j] = false;
			shared += before[i]!.length;
			i++;
			j++;
		} else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
		else j++;
	}
	if (shared === 0 || (2 * shared) / (removed.length + added.length) < WORD_DIFF_MIN_SIMILARITY) return undefined;
	const ranges = (text: string, tokens: string[], changed: boolean[]): CharRange[] => {
		const output: CharRange[] = [];
		let offset = 0;
		tokens.forEach((token, index) => {
			const last = output.at(-1);
			if (changed[index]) {
				if (last && last[1] === offset) last[1] = offset + token.length;
				else output.push([offset, offset + token.length]);
			}
			offset += token.length;
		});
		// A range starts and ends on a word, not on the blanks beside it.
		return output
			.map(([start, end]): CharRange => [
				end - text.slice(start, end).trimStart().length,
				start + text.slice(start, end).trimEnd().length,
			])
			.filter(([start, end]) => end > start);
	};
	const markedRemoved = ranges(removed, before, removedChanged);
	const markedAdded = ranges(added, after, addedChanged);
	return markedRemoved.length || markedAdded.length ? { removed: markedRemoved, added: markedAdded } : undefined;
}

/** Changed-word ranges for every removed row paired, in order, with the added row beside it. */
function pairWordRanges(lines: readonly CodeDiffLine[]): Map<number, CharRange[]> {
	const marked = new Map<number, CharRange[]>();
	let index = 0;
	while (index < lines.length) {
		if (lines[index]!.kind !== "remove") {
			index++;
			continue;
		}
		const removedStart = index;
		while (index < lines.length && lines[index]!.kind === "remove") index++;
		const addedStart = index;
		while (index < lines.length && lines[index]!.kind === "add") index++;
		for (let offset = 0; offset < Math.min(addedStart - removedStart, index - addedStart); offset++) {
			const pair = wordDiffRanges(lines[removedStart + offset]!.content, lines[addedStart + offset]!.content);
			if (!pair) continue;
			if (pair.removed.length) marked.set(removedStart + offset, pair.removed);
			if (pair.added.length) marked.set(addedStart + offset, pair.added);
		}
	}
	return marked;
}

/** A row's text with a brighter fill behind the given character ranges and `base` behind the rest. */
function fillWithWords(
	theme: Theme,
	base: Rgb,
	word: Rgb,
	content: string,
	ranges: readonly CharRange[],
	chunk: string,
	chunkStart: number,
	padding: number,
): string {
	const chunkWidth = visibleWidth(chunk);
	let output = "";
	let cursor = 0;
	for (const [start, end] of ranges) {
		const from = Math.max(cursor, visibleWidth(content.slice(0, start)) - chunkStart);
		const to = Math.min(chunkWidth, visibleWidth(content.slice(0, end)) - chunkStart);
		if (to <= from) continue;
		if (from > cursor) output += fillRgb(theme, base, sliceByColumn(chunk, cursor, from - cursor, true));
		output += fillRgb(theme, word, sliceByColumn(chunk, from, to - from, true));
		cursor = to;
	}
	return output + fillRgb(theme, base, sliceByColumn(chunk, cursor, chunkWidth - cursor, true) + " ".repeat(padding));
}

type CodeRowsOptions = {
	/** Show the `+`/`-` sign column and tint changed rows. */
	signs: boolean;
	/** Dim note rendered below the code, such as a read truncation notice. */
	footer?: string;
	/** What each row starts with; the result rail unless a mode draws its own. */
	rail?: string;
};

/** Render numbered, syntax-highlighted code rows shared by edit diffs and read/write file views. */
function renderCodeRows(lines: CodeDiffLine[], path: string, theme: Theme, options: CodeRowsOptions): Component {
	// A shebang only speaks for the file when the first row really is line 1, so a
	// read at an offset or a diff hunk never reads one out of a comment.
	const first = lines[0];
	const shebangLine = first?.lineNumber === 1 && first.kind !== "separator" ? first.content : undefined;
	// ToolExecutionComponent builds result components even when silent mode hides
	// the row. Defer syntax work until the code is actually drawn, and keep it
	// across width changes so resize does not highlight the same source again.
	let highlighted: string[] | undefined;
	const numberWidth = lines.reduce((maximum, line) => Math.max(maximum, String(line.lineNumber ?? "").length), 1);
	const prefix = options.rail ?? paintChrome(theme, " \u2502 ");
	const prefixWidth = visibleWidth(prefix);
	const gutterWidth = numberWidth + (options.signs ? 3 : 2);
	const addedTint = options.signs ? diffTintRgb(theme, "toolDiffAdded") : undefined;
	const removedTint = options.signs ? diffTintRgb(theme, "toolDiffRemoved") : undefined;
	const addedWordTint = options.signs ? diffTintRgb(theme, "toolDiffAdded", WORD_TINT) : undefined;
	const removedWordTint = options.signs ? diffTintRgb(theme, "toolDiffRemoved", WORD_TINT) : undefined;
	let words: Map<number, CharRange[]> | undefined;
	return new CachedComponent((width) => {
		highlighted ??= highlightCodeLines(lines, resolveLanguage(path, shebangLine), theme);
		if (options.signs) words ??= pairWordRanges(lines);
		const bodyWidth = Math.max(1, width - prefixWidth);
		const codeWidth = Math.max(1, bodyWidth - gutterWidth);
		const output: string[] = [];
		lines.forEach((line, index) => {
			if (line.kind === "separator") {
				output.push(prefix + " ".repeat(numberWidth + 1) + theme.fg("toolDiffContext", line.content));
				return;
			}
			const tint = line.kind === "add" ? addedTint : line.kind === "remove" ? removedTint : undefined;
			const wordRanges = words?.get(index);
			const wordTint = line.kind === "add" ? addedWordTint : removedWordTint;
			for (const [chunkIndex, chunk] of hardSliceAnsi(highlighted![index] ?? line.content, codeWidth).entries()) {
				const gutter = codeGutter(
					line.kind,
					chunkIndex === 0 ? line.lineNumber : undefined,
					numberWidth,
					options.signs,
					theme,
				);
				const body = gutter + chunk;
				if (!tint) {
					output.push(prefix + body);
					continue;
				}
				const padding = Math.max(0, bodyWidth - visibleWidth(body));
				if (wordRanges && wordTint) {
					output.push(
						prefix + fillRgb(theme, tint, gutter)
							+ fillWithWords(theme, tint, wordTint, line.content, wordRanges, chunk, chunkIndex * codeWidth, padding),
					);
					continue;
				}
				output.push(prefix + fillRgb(theme, tint, body + " ".repeat(padding)));
			}
		});
		if (options.footer) {
			for (const line of wrapTextWithAnsi(options.footer, bodyWidth)) output.push(prefix + theme.fg("dim", line));
		}
		return output;
	});
}

/** Render an edit as a syntax-highlighted diff with a line-number gutter and tinted change rows. */
export function renderCodeDiff(
	patch: string,
	displayDiff: string,
	path: string,
	theme: Theme,
	options: CodeDiffOptions = {},
): Component | undefined {
	const diff = parseCodeDiff(patch, displayDiff);
	const lines = options.contextLines === undefined ? diff : trimDiffContext(diff, options.contextLines);
	if (lines.length === 0) return undefined;
	return renderCodeRows(lines, path, theme, { signs: true, rail: options.rail });
}

export type CodeViewOptions = {
	/** File line number of the first code line, e.g. a read's `offset`. */
	startLine?: number;
	footer?: string;
	rail?: string;
};

/** Render file contents with line numbers and syntax highlighting, matching the edit diff layout. */
export function renderCodeView(code: string, path: string, theme: Theme, options: CodeViewOptions = {}): Component | undefined {
	const normalized = normalizeLineEndings(code).replace(/\n+$/u, "");
	if (!normalized) return undefined;
	const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
	const lines = normalized.split("\n").map((content, index): CodeDiffLine => ({
		kind: "context",
		lineNumber: startLine + index,
		content: content.replace(/\t/gu, "   "),
		hunk: 0,
	}));
	return renderCodeRows(lines, path, theme, { signs: false, footer: options.footer, rail: options.rail });
}

/**
 * Diff rows the way Codex draws them: `{line} {sign}{code}` after `indent`, the
 * number dim and the sign in its change color, and an added or removed row tinted
 * across the whole width. A wrapped row continues under the code; `⋮` marks a gap
 * between hunks. `maxRows` keeps the first rows, as Codex's collapsed preview does.
 */
export function renderCodexDiff(
	lines: readonly CodeDiffLine[],
	path: string,
	theme: Theme,
	indent: string,
	maxRows?: number,
): Component | undefined {
	if (lines.length === 0) return undefined;
	const first = lines[0];
	const shebangLine = first?.lineNumber === 1 && first.kind !== "separator" ? first.content : undefined;
	let highlighted: string[] | undefined;
	const numberWidth = lines.reduce((maximum, line) => Math.max(maximum, String(line.lineNumber ?? "").length), 1);
	const indentWidth = visibleWidth(indent);
	const addedTint = diffTintRgb(theme, "toolDiffAdded");
	const removedTint = diffTintRgb(theme, "toolDiffRemoved");
	return new CachedComponent((width) => {
		highlighted ??= highlightCodeLines([...lines], resolveLanguage(path, shebangLine), theme);
		const codeWidth = Math.max(1, width - indentWidth - numberWidth - 2);
		const output: string[] = [];
		for (const [index, line] of lines.entries()) {
			if (maxRows !== undefined && output.length >= maxRows) break;
			if (line.kind === "separator") {
				output.push(indent + " ".repeat(numberWidth + 1) + theme.fg("dim", line.content));
				continue;
			}
			const tint = line.kind === "add" ? addedTint : line.kind === "remove" ? removedTint : undefined;
			const sign = line.kind === "add" ? theme.fg("toolDiffAdded", "+") : line.kind === "remove" ? theme.fg("toolDiffRemoved", "-") : " ";
			for (const [chunkIndex, chunk] of hardSliceAnsi(highlighted[index] ?? line.content, codeWidth).entries()) {
				const gutter = chunkIndex === 0
					? theme.fg("dim", `${String(line.lineNumber ?? "").padStart(numberWidth)} `) + sign
					: " ".repeat(numberWidth + 2);
				// Narrower than the gutter itself, a row is cut rather than drawn past the edge.
				const row = truncateToWidth(indent + gutter + chunk, Math.max(1, width), "");
				output.push(tint ? fillRgb(theme, tint, row + " ".repeat(Math.max(0, width - visibleWidth(row)))) : row);
			}
		}
		return maxRows === undefined ? output : output.slice(0, maxRows);
	});
}

/**
 * A row that never draws past the pane's edge. Chrome has a width of its own, so in
 * a pane narrower than a prefix the lines are cut to it. Lines are checked again only
 * when the component draws new ones.
 */
export class WithinWidth implements Component {
	private source: string[] | undefined;
	private width: number | undefined;
	private lines: string[] = [];

	constructor(private readonly inner: Component) {}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (lines !== this.source || width !== this.width) {
			this.source = lines;
			this.width = width;
			this.lines = lines.some((line) => visibleWidth(line) > width)
				? lines.map((line) => visibleWidth(line) > width ? truncateToWidth(line, Math.max(1, width), "") : line)
				: lines;
		}
		return this.lines;
	}

	invalidate(): void {
		this.inner.invalidate?.();
		this.source = undefined;
	}
}

/** Limit a result preview by rendered rows while preserving the full source component for expansion. */
export function limitComponentLines(
	component: Component,
	maximumLines: number,
	theme: Theme,
	footer: (omitted: number) => string = (omitted) => paintChrome(theme, " │ ")
		+ theme.fg("toolOutput", `… ${omitted} more ${omitted === 1 ? "line" : "lines"}`),
): Component {
	return new CachedComponent((width) => {
		const lines = component.render(width);
		if (lines.length <= maximumLines) return lines;
		return [...lines.slice(0, maximumLines), truncateToWidth(footer(lines.length - maximumLines), Math.max(1, width), "…")];
	}, () => component.invalidate?.());
}

/** Indent another renderer's component under the result rail so it reads as part of the row. */
export function railComponent(component: Component, theme: Theme, rail = paintChrome(theme, " │ ")): Component {
	const railWidth = visibleWidth(rail);
	return new CachedComponent(
		(width) => component.render(Math.max(1, width - railWidth)).map((line) => rail + line),
		() => component.invalidate?.(),
	);
}

export function renderArguments(args: ToolArgs, theme: Theme, rail = paintChrome(theme, " │ ")): Component {
	const json = JSON.stringify(args, null, 2) ?? "{}";
	const styled = styleMultiline(json, (line) => theme.fg("toolOutput", line));
	return prefixedText(styled, rail);
}
