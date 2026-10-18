import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	CODEX_BULLET,
	CODEX_COMMAND_INDENT,
	CODEX_INDENT,
	CODEX_MARGIN,
	CODEX_PREVIEW_ROWS,
	CODEX_RESULT_PREFIX,
	CODEX_TAB,
	codexDisclosure,
	codexPath,
	formatCodexDuration,
	isEmptyOutput,
	openExplorations,
	paintSegments,
	shellOutcome,
	tailLines,
	textLines,
	wrapSegments,
	type Segment,
	type ThemeColor,
} from "./compact-tools-codex.ts";
import { normalizeLineEndings, type RowStatus } from "./compact-tools-core.ts";
import { countEditChanges, getEditDiff, getEditPatch, splitReadFooter } from "./compact-tools-invocation.ts";
import { parseCodeDiff, renderCodexDiff, type CodeDiffLine } from "./compact-tools-layout.ts";
import type { RowState, ToolArgs } from "./compact-tools-types.ts";

/** How a row is drawn: a file tool's result is code, a shell's is output, a custom tool's is its author's. */
export type CodexRowKind = "file" | "shell" | "custom";

/** Lines drawn from state read as they are drawn, laid out again only when that state or the width changes. */
class LiveLines implements Component {
	private cache: { key: string; width: number; lines: string[] } | undefined;

	constructor(private readonly key: (width: number) => string, private readonly draw: (width: number) => string[]) {}

	render(width: number): string[] {
		const key = this.key(width);
		if (!this.cache || this.cache.key !== key || this.cache.width !== width) this.cache = { key, width, lines: withinWidth(this.draw(width), width) };
		return this.cache.lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** One row cut to the width with "…", in the style of what it cuts when that is given. */
const clip = (line: string, width: number, ellipsis = "…") => truncateToWidth(line, Math.max(1, width), ellipsis);

/** Whatever a row lays out, a pane too narrow for its chrome still never draws past its edge. */
function withinWidth(lines: string[], width: number): string[] {
	return lines.map((line) => visibleWidth(line) > width ? clip(line, width) : line);
}

function commandOf(args: ToolArgs): string {
	return typeof args.command === "string" ? normalizeLineEndings(stripTerminalSequences(args.command)).trim() : "";
}

const SHELL_OPERATORS = ["&&", "||", ">>", ">&", "&>", "|", ";", "&", ">", "<", "(", ")"];
/** Operators that send a command's output somewhere rather than start another command. */
const REDIRECTIONS = new Set([">", ">>", ">&", "&>", "<", ")"]);

/**
 * A command's lines with the shell's colors, as Codex highlights what it ran: the
 * program each command runs, its flags, strings, variables, and the operators
 * between them, in the theme's syntax colors. It is tokenized here rather than by
 * the host's highlighter, whose grammar changes between Pi versions.
 */
export function highlightCommand(command: string, theme: Theme): string[] {
	return commandSegments(command).map((line) => paintSegments(line, theme));
}

/** The pieces of a command, line by line, each with the syntax color it is painted in. */
function commandSegments(command: string): Segment[][] {
	const lines: Segment[][] = [[]];
	const add = (color: ThemeColor | undefined, token: string) => {
		token.split("\n").forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part) lines[lines.length - 1]!.push({ text: part, color });
		});
	};
	let commandStart = true;
	let index = 0;
	while (index < command.length) {
		const rest = command.slice(index);
		const space = rest.match(/^[ \t]+/u)?.[0];
		if (space) {
			add(undefined, space);
			index += space.length;
			continue;
		}
		if (rest[0] === "\n") {
			add(undefined, "\n");
			commandStart = true;
			index++;
			continue;
		}
		if (rest[0] === "#") {
			const comment = rest.match(/^#[^\n]*/u)![0];
			add("syntaxComment", comment);
			index += comment.length;
			continue;
		}
		const operator = SHELL_OPERATORS.find((candidate) => rest.startsWith(candidate));
		if (operator) {
			add("syntaxOperator", operator);
			if (!REDIRECTIONS.has(operator)) commandStart = true;
			index += operator.length;
			continue;
		}
		if (rest[0] === "'" || rest[0] === "\"") {
			const quote = rest[0];
			let end = 1;
			while (end < rest.length && rest[end] !== quote) end += quote === "\"" && rest[end] === "\\" ? 2 : 1;
			const string = rest.slice(0, Math.min(end + 1, rest.length));
			add("syntaxString", string);
			commandStart = false;
			index += string.length;
			continue;
		}
		if (rest[0] === "$") {
			const variable = rest.match(/^\$(?:\{[^}]*\}?|[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])?/u)![0];
			add("syntaxVariable", variable);
			commandStart = false;
			index += variable.length;
			continue;
		}
		const word = rest.match(/^[^\s'"$#&|;<>()]+/u)?.[0] ?? rest[0]!;
		const assignment = commandStart && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
		add(commandStart && !assignment ? "syntaxFunction" : word.startsWith("-") ? "syntaxKeyword"
			: /^\d+$/u.test(word) ? "syntaxNumber" : undefined, word);
		if (!assignment) commandStart = false;
		index += word.length;
	}
	return lines;
}

/** Lines wrapped under a prefix, the first row after `first` and every later one after `rest`. */
function prefixedRows(lines: readonly Segment[][], first: string, rest: string, width: number, theme: Theme): string[] {
	const available = Math.max(1, width - Math.max(visibleWidth(first), visibleWidth(rest)));
	return lines.flatMap((line) => wrapSegments(line, available, available))
		.map((row, index) => (index === 0 ? first : rest) + paintSegments(row, theme));
}

function durationOf(state: RowState): string | undefined {
	if (state.durationMs !== undefined) return formatCodexDuration(state.durationMs);
	return state.startedAt !== undefined && state.endedAt !== undefined ? formatCodexDuration(state.endedAt - state.startedAt) : undefined;
}

/** What each status reads as at the head of a row. */
const VERBS: Record<"shell" | "custom" | "edit" | "write", Record<"running" | "success" | "error", string>> = {
	shell: { running: "Running", success: "Ran", error: "Failed" },
	custom: { running: "Calling", success: "Called", error: "Failed" },
	edit: { running: "Editing", success: "Edited", error: "Failed to edit" },
	write: { running: "Writing", success: "Wrote", error: "Failed to write" },
};

const settled = (status: RowStatus) => status === "success" || status === "error" ? status : "running";

/** An exploration tool's verb and what it looked at, as a lone row names them. */
function lookTitle(name: string, args: ToolArgs, theme: Theme): { verb: string; target: string } {
	const path = codexPath(args);
	if (name === "read") return { verb: "Read", target: path };
	if (name === "ls") return { verb: "List", target: path || "." };
	const pattern = typeof args.pattern === "string" ? normalizeLineEndings(args.pattern).split("\n")[0]!.trim() : "";
	return { verb: "Search", target: path ? `${pattern}${theme.fg("dim", " in ")}${path}` : pattern };
}

function changeCount(theme: Theme, added: number, removed: number): string {
	return `(${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)})`;
}

function writeLineCount(args: ToolArgs): number {
	const content = typeof args.content === "string" ? normalizeLineEndings(args.content) : "";
	return content ? content.replace(/\n$/u, "").split("\n").length : 0;
}

/** A custom tool's call as Codex writes an MCP call it opened: `name({"query":"x"})`. */
function invocation(name: string, args: ToolArgs): Segment[] {
	let json = "";
	try {
		json = JSON.stringify(args) ?? "";
	} catch {
		json = "";
	}
	return [{ text: name, color: "accent" }, { text: "(" }, { text: json === "{}" ? "" : json, color: "dim" }, { text: ")" }];
}

/** Where a custom tool's opened header starts its invocation: beside the verb when it fits, else beneath it. */
function invocationInline(verb: string, call: readonly Segment[], width: number): boolean {
	return visibleWidth(call.map((segment) => segment.text).join("")) <= width - visibleWidth(`${CODEX_MARGIN}${CODEX_BULLET} ${verb} `);
}

/**
 * The head of a Codex row, drawn from the row's state each time it is painted: the
 * verb follows the call from running to its outcome, and an edit's counts and a
 * command's exit code arrive with the result.
 */
export function renderCodexCall(
	name: string,
	kind: CodexRowKind,
	args: ToolArgs,
	theme: Theme,
	state: RowState,
	status: () => RowStatus,
	indicator: () => string,
	toolCallId: string,
): Component {
	const expanded = state.expanded === true;
	const command = kind === "shell" ? commandOf(args) : "";
	const segments = kind === "shell" ? commandSegments(command) : [];
	let current: RowStatus = "pending";
	let dot = "";
	// Opened, a command reads as its transcript; one with nothing left out keeps its preview, as in Codex.
	const opened = (width: number) => expanded && kind === "shell" && (openExplorations.has(toolCallId)
		|| (state.codex?.opens?.(width) ?? headerCut(command, VERBS.shell.running, width)));
	return new LiveLines((width) => {
		dot = indicator();
		current = status();
		const outcome = state.codex;
		return `${dot}|${current}|${outcome?.exitCode ?? ""}|${outcome?.changes?.added ?? ""}/${outcome?.changes?.removed ?? ""}|${opened(width)}`;
	}, (width) => {
		const phase = settled(current);
		const bullet = phase === "success" ? theme.bold(theme.fg("success", CODEX_BULLET))
			: phase === "error" ? theme.bold(theme.fg("error", CODEX_BULLET)) : dot;
		const head = (verb: string, rest: string) => `${CODEX_MARGIN}${bullet} ${theme.bold(verb)}${rest ? ` ${rest}` : ""}`;
		if (kind === "shell") {
			if (opened(width)) {
				const prompt = theme.fg("bashMode", "$ ");
				const first = width - visibleWidth(CODEX_MARGIN + "$ ");
				const rest = Math.max(1, width - visibleWidth(CODEX_COMMAND_INDENT));
				return segments.flatMap((line, index) => wrapSegments(line, index === 0 ? first : rest, rest)
					.map((row, position) => index === 0 && position === 0 ? `${CODEX_MARGIN}${prompt}${paintSegments(row, theme)}` : `${CODEX_COMMAND_INDENT}${paintSegments(row, theme)}`));
			}
			const exitCode = state.codex?.exitCode;
			const verb = phase === "error" && exitCode !== undefined ? `Failed (exit ${exitCode})` : VERBS.shell[phase];
			// Painted as it is drawn, so a theme switched since the row was made colors it too.
			return [clip(head(verb, paintSegments(segments[0] ?? [], theme) + (segments.length > 1 ? " …" : "")), width)];
		}
		if (kind === "custom") {
			const verb = VERBS.custom[phase];
			if (!expanded) return [clip(head(verb, theme.fg("accent", name)), width)];
			const call = invocation(name, args);
			if (invocationInline(verb, call, width)) return [head(verb, paintSegments(call, theme))];
			return [head(verb, ""), ...prefixedRows([call], theme.fg("dim", CODEX_RESULT_PREFIX), CODEX_INDENT, width, theme)];
		}
		const path = codexPath(args);
		if (name === "edit" || name === "write") {
			const verbs = VERBS[name];
			if (phase === "error") return [clip(`${CODEX_MARGIN}${theme.fg("error", theme.bold(`✘ ${verbs.error}${path ? ` ${path}` : ""}`))}`, width)];
			if (phase === "running") return [clip(head(verbs.running, path), width)];
			const changes = name === "write" ? { added: writeLineCount(args), removed: 0 } : state.codex?.changes ?? { added: 0, removed: 0 };
			return [clip(`${CODEX_MARGIN}${theme.fg("dim", CODEX_BULLET)} ${theme.bold(verbs.success)} ${path} ${changeCount(theme, changes.added, changes.removed)}`, width)];
		}
		const { verb, target } = lookTitle(name, args, theme);
		return [clip(head(verb, target), width)];
	});
}

type ResultInput = {
	name: string;
	kind: CodexRowKind;
	args: ToolArgs;
	result: AgentToolResult<unknown>;
	output: string;
	theme: Theme;
	state: RowState;
	isError: boolean;
	isPartial: boolean;
	expanded: boolean;
	toolCallId: string;
	author?: (expanded: boolean) => Component | undefined;
	/** A codemode completion summary, in this style's native indentation. */
	completion?: Component;
};

/**
 * `✓ • 1.23s`, or `✗ (2) • 1.23s`: how an opened call ended, and how long it took.
 * A row restored from the session was never timed here, so it shows only how it ended.
 */
function outcomeLine(theme: Theme, isError: boolean, exitCode: number | undefined, duration: string | undefined): string {
	const mark = isError
		? theme.bold(theme.fg("error", "✗")) + (exitCode !== undefined ? ` (${exitCode})` : "")
		: theme.bold(theme.fg("success", "✓"));
	return `${CODEX_MARGIN}${mark}${duration ? theme.fg("dim", ` • ${duration}`) : ""}`;
}

/** The last rows of output under `└`, each cut to the row, dim as Codex previews them. */
function previewRows(lines: readonly string[], theme: Theme, width: number): string[] {
	return lines.map((line, index) => clip(theme.fg("dim", (index === 0 ? CODEX_RESULT_PREFIX : CODEX_INDENT) + line), width, theme.fg("dim", "…")));
}

/**
 * How many lines a collapsed preview leaves out: every line before the last three,
 * and any of those three too wide to show whole.
 */
function hiddenLines(lines: readonly string[], width: number): number {
	const shown = lines.slice(Math.max(0, lines.length - CODEX_PREVIEW_ROWS));
	return Math.max(0, lines.length - CODEX_PREVIEW_ROWS)
		+ shown.filter((line) => visibleWidth(line) + visibleWidth(CODEX_INDENT) > width).length;
}

function outputLines(text: string): string[] {
	return normalizeLineEndings(stripTerminalSequences(text)).replace(/\n+$/u, "").split("\n").map((line) => line.replace(/\t/gu, CODEX_TAB));
}

/** An opened call's output: whole, undimmed, wrapped from the margin. */
function fullOutput(text: string, theme: Theme, width: number): string[] {
	if (isEmptyOutput(text)) return [];
	return prefixedRows(outputLines(text).map((line) => line ? [{ text: line, color: "toolOutput" as const }] : []), CODEX_MARGIN, CODEX_MARGIN, width, theme);
}

function dimDisclosure(theme: Theme, width: number, expanded: boolean, hidden?: number): string {
	return clip(theme.fg("dim", codexDisclosure(width, expanded, hidden)), width, theme.fg("dim", "…"));
}

/** A command, or a lone read, search, or listing: the tail of its output, or all of it opened. */
/** The verb a command's collapsed head reads with. */
function shellVerb(isPartial: boolean, isError: boolean, exitCode: number | undefined): string {
	if (isPartial) return VERBS.shell.running;
	if (!isError) return VERBS.shell.success;
	return exitCode !== undefined ? `Failed (exit ${exitCode})` : VERBS.shell.error;
}

/** Whether a command's collapsed head hides part of it: a second line, or a first line too wide for the row. */
function headerCut(command: string, verb: string, width: number): boolean {
	const lines = command.split("\n");
	return lines.length > 1 || visibleWidth(`${CODEX_MARGIN}${CODEX_BULLET} ${verb} ${lines[0] ?? ""}`) > width;
}

/** What a call's output and the text it shows come to: a command's exit code apart, a read's notice apart. */
function outputOf(input: ResultInput) {
	const { name, kind, isError } = input;
	const outcome = kind === "shell" && isError ? shellOutcome(input.output) : { output: input.output, exitCode: undefined };
	const read = name === "read" && !isError ? splitReadFooter(outcome.output) : undefined;
	return { exitCode: outcome.exitCode, text: read?.body ?? outcome.output, footer: read?.footer };
}

/**
 * What a collapsed command or lone read leaves out at a width: the lines it hides,
 * "generic" when only its head is cut, and undefined when it shows everything, in
 * which case Codex offers no control and does not open it.
 */
function collapsedDetails(input: ResultInput, width: number): number | "generic" | undefined {
	const { exitCode, text, footer } = outputOf(input);
	const hidden = isEmptyOutput(text) ? 0 : hiddenLines(outputLines(text), width);
	if (hidden > 0) return hidden;
	// A read cut short says so only once opened.
	if (footer) return "generic";
	const command = input.kind === "shell" ? commandOf(input.args) : "";
	return input.kind === "shell" && headerCut(command, shellVerb(input.isPartial, input.isError, exitCode), width) ? "generic" : undefined;
}

function outputResult(input: ResultInput, width: number): string[] {
	const { theme, state, isError, isPartial } = input;
	const { exitCode, text, footer } = outputOf(input);
	const empty = isEmptyOutput(text);
	const details = collapsedDetails(input, width);
	if (opens(input, width)) {
		// Codex has no file view: what a read returned shows as a command's output does, notice and all.
		const rows = fullOutput(footer ? `${text}\n\n${footer}` : text, theme, width);
		const ended = isPartial ? [] : [outcomeLine(theme, isError, exitCode, durationOf(state))];
		return [...rows, ...ended, dimDisclosure(theme, width, true)];
	}
	const rows = empty ? (isPartial ? [] : previewRows(["(no output)"], theme, width))
		: previewRows(tailLines(outputLines(text).join("\n")), theme, width);
	if (details === undefined) return rows;
	return [...rows, dimDisclosure(theme, width, false, details === "generic" ? undefined : details)];
}

/** Whether a command or lone read draws opened: always within an opened exploration, else only when it has more to show. */
function opens(input: ResultInput, width: number): boolean {
	return input.expanded && (openExplorations.has(input.toolCallId) || collapsedDetails(input, width) !== undefined);
}

/** A failed edit or write: why, under `└`, three rows of it until opened. */
function failureResult(input: ResultInput, width: number): string[] {
	const { theme, expanded } = input;
	const reason = input.output.trim() || "(error details unavailable)";
	const rows = prefixedRows(textLines(reason, "dim"), theme.fg("dim", CODEX_RESULT_PREFIX), CODEX_INDENT, width, theme);
	if (expanded) return [...rows, dimDisclosure(theme, width, true)];
	return [...rows.slice(0, CODEX_PREVIEW_ROWS).map((row) => clip(row, width, theme.fg("dim", "…"))), dimDisclosure(theme, width, false)];
}

/** Changed lines only, as Codex previews a patch: context dropped, one `⋮` between hunks. */
function changesOnly(lines: readonly CodeDiffLine[]): CodeDiffLine[] {
	const kept: CodeDiffLine[] = [];
	for (const line of lines) {
		if (line.kind === "context") continue;
		if (line.kind === "separator" && (kept.length === 0 || kept.at(-1)!.kind === "separator")) continue;
		kept.push(line);
	}
	while (kept.at(-1)?.kind === "separator") kept.pop();
	return kept;
}

/** An edit's diff or a write's new lines, the first changed rows until opened, every hunk once opened. */
function patchResult(input: ResultInput, width: number, lines: readonly CodeDiffLine[]): string[] {
	const { theme, expanded, args } = input;
	const shown = expanded ? lines : changesOnly(lines);
	const rows = renderCodexDiff(shown, codexPath(args), theme, CODEX_INDENT, expanded ? undefined : CODEX_PREVIEW_ROWS)?.render(width) ?? [];
	return [...rows, dimDisclosure(theme, width, expanded)];
}

/** A custom tool's result as Codex shows an MCP call's: the last lines, then all of it, or its author's view. */
function customResult(input: ResultInput, width: number): string[] {
	const { name, args, theme, isError, isPartial, expanded, author } = input;
	const text = isEmptyOutput(input.output) ? "" : input.output.trimEnd();
	if (isPartial) return text ? previewRows(tailLines(text), theme, width) : [];
	if (expanded) {
		const inline = invocationInline(VERBS.custom[isError ? "error" : "success"], invocation(name, args), width);
		const first = inline ? theme.fg("dim", CODEX_RESULT_PREFIX) : CODEX_INDENT;
		let rows: string[] = [];
		let component: Component | undefined;
		if (author && !isError) {
			try {
				component = author(true);
			} catch {
				// A failing third-party renderer degrades to the plain text result.
			}
		}
		if (component) {
			// The author's view hangs from "└" like any result, without the blank lines it may open with.
			const lines = component.render(Math.max(1, width - visibleWidth(CODEX_INDENT)));
			const start = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
			rows = (start < 0 ? [] : lines.slice(start)).map((line, index) => (index === 0 ? first : CODEX_INDENT) + line);
		} else if (text || isError) rows = prefixedRows(textLines(outputLines(isError ? `Error: ${text}` : text).join("\n"), "dim"), first, CODEX_INDENT, width, theme);
		return [...rows, ...(input.completion?.render(width) ?? []), dimDisclosure(theme, width, true)];
	}
	let lines = text ? tailLines(text) : [];
	if (isError && outputLines(text).length <= CODEX_PREVIEW_ROWS) lines = lines.length ? [`Error: ${lines[0]}`, ...lines.slice(1)] : ["Error: "];
	return [...previewRows(lines, theme, width), ...(input.completion?.render(width) ?? []), dimDisclosure(theme, width, false)];
}

/** Everything a Codex row draws beneath its head. */
export function renderCodexResult(input: ResultInput): Component {
	const { name, kind, result, state, isError, isPartial, args } = input;
	if (kind === "shell" && isError && !isPartial) state.codex = { ...state.codex, exitCode: shellOutcome(input.output).exitCode };
	let draw: (width: number) => string[];
	if (kind === "custom") {
		draw = (width) => customResult(input, width);
	} else if (name === "edit" || name === "write") {
		if (isPartial) return new LiveLines(() => "", () => []);
		if (isError) {
			draw = (width) => failureResult(input, width);
		} else if (name === "edit") {
			state.codex = { ...state.codex, changes: countEditChanges(result) ?? { added: 0, removed: 0 } };
			const lines = parseCodeDiff(getEditPatch(result), getEditDiff(result), CODEX_TAB);
			draw = (width) => patchResult(input, width, lines);
		} else {
			const content = typeof args.content === "string" ? normalizeLineEndings(args.content).replace(/\n$/u, "") : "";
			const lines = content ? content.split("\n").map((line, index): CodeDiffLine => ({ kind: "add", lineNumber: index + 1, content: line.replace(/\t/gu, CODEX_TAB), hunk: 0 })) : [];
			draw = (width) => patchResult(input, width, lines);
		}
	} else {
		draw = (width) => outputResult(input, width);
		state.codex = { ...state.codex, opens: (width) => opens(input, width) };
	}
	// In an opened exploration the group's one "− Show less" closes it, so the call leaves out its own.
	const grouped = () => openExplorations.has(input.toolCallId);
	return new LiveLines(() => (grouped() ? "grouped" : ""), (width) => {
		const lines = draw(width);
		if (grouped() && lines.at(-1) === dimDisclosure(input.theme, width, true)) lines.pop();
		return lines;
	});
}
