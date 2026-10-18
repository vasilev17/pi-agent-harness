import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import {
	countEditChanges,
	formatResultLineSummary,
	summarizeCustomArguments,
	summarizeFailure,
} from "./compact-tools-invocation.ts";
import { isHarmlessRedirect, parseShell, writesOrRuns } from "./compact-tools-shell.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

/**
 * Rows Claude Code shows of a command's output before "… +N lines". Output is
 * wrapped to the width first, so a long line counts as the rows it takes.
 */
export const CLAUDE_OUTPUT_ROWS = 3;
/** Rows Claude Code shows of what a write put in the file. */
export const CLAUDE_WRITE_ROWS = 10;
/** Lines of context Claude Code keeps around each change in an edit's diff. */
export const CLAUDE_DIFF_CONTEXT_LINES = 3;

/**
 * Claude Code 2.1.288's chrome: `⏺ Bash(…)`, then `  ⎿  ` with the "⎿" under the
 * tool's name and the result two columns after it. Pi draws every row one column
 * in, with its own smaller "⦁" dot, so each prefix keeps that geometry one column
 * further right.
 */
export const CLAUDE_RESULT_PREFIX = "   ⎿  ";
/** Lines after the first under "⎿", and everything drawn beneath the result. */
export const CLAUDE_INDENT = "      ";
/** Where a wrapped call line continues: under the tool's name. */
export const CLAUDE_TITLE_INDENT = "   ";

/** Claude Code's names for the tools Pi shares with it. */
const LABELS: Readonly<Record<string, string>> = {
	read: "Read",
	grep: "Search",
	find: "Search",
	ls: "List",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Update",
	write: "Write",
};

export function claudeLabel(name: string): string {
	return LABELS[name] ?? name;
}

export function pathOf(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? normalizeLineEndings(value) : "";
}

function oneLine(text: string): string {
	const lines = normalizeLineEndings(stripTerminalSequences(text)).split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return "";
	return lines.length > 1 ? `${lines[0]} …` : lines[0]!;
}

function commandOf(args: ToolArgs): string {
	return typeof args.command === "string" ? args.command : "";
}

/** Claude Code shortens a collapsed command only past two lines or 160 characters. */
export const CLAUDE_COMMAND_LINES = 2;
export const CLAUDE_COMMAND_CHARS = 160;

/**
 * A command as Claude Code titles it: whole when opened, and collapsed cut only
 * past its line and character limits, with an ellipsis. Within them it is never
 * cut to fit the row; the title wraps instead.
 */
export function claudeCommand(command: string, expanded: boolean): string {
	const text = normalizeLineEndings(stripTerminalSequences(command)).trim();
	if (expanded) return text;
	const lines = text.split("\n");
	let shown = lines.length > CLAUDE_COMMAND_LINES ? lines.slice(0, CLAUDE_COMMAND_LINES).join("\n") : text;
	if (shown.length > CLAUDE_COMMAND_CHARS) shown = shown.slice(0, CLAUDE_COMMAND_CHARS);
	return shown === text ? text : `${shown.trim()}…`;
}

/** What goes between the parentheses: `Bash(npm test)`, `Search(pattern: "x", path: "src")`. */
export function claudeArgument(name: string, args: ToolArgs, expanded = false): string {
	const path = pathOf(args);
	if (name === "bash" || name === "powershell") return claudeCommand(commandOf(args), expanded);
	if (name === "grep" || name === "find") {
		const pattern = typeof args.pattern === "string" ? oneLine(args.pattern) : "";
		// Arguments stream in; until the pattern arrives there is nothing to name.
		if (!pattern) return "";
		return path ? `pattern: "${pattern}", path: "${path}"` : `pattern: "${pattern}"`;
	}
	if (name === "ls") return path || ".";
	if (name === "read" || name === "edit" || name === "write") return path;
	return formatArguments(args);
}

function formatValue(value: unknown): string | undefined {
	if (typeof value === "string") return JSON.stringify(oneLine(value));
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.every((item) => typeof item !== "object" || item === null)) {
		return `[${value.map((item) => formatValue(item) ?? "null").join(", ")}]`;
	}
	return undefined;
}

/** A custom tool's arguments as Claude Code lists them: `query: "pi tui", limit: 5`. */
export function formatArguments(args: ToolArgs): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		const formatted = formatValue(value);
		if (formatted !== undefined) parts.push(`${key}: ${formatted}`);
	}
	return parts.length > 0 ? parts.join(", ") : summarizeCustomArguments(args);
}

export function claudeTitle(name: string, args: ToolArgs, expanded = false): { label: string; argument: string } {
	return { label: claudeLabel(name), argument: claudeArgument(name, args, expanded) };
}

// Claude Code's own lists: a command made only of these only looks around, so it
// folds into a group with reads and searches.
const SEARCH_COMMANDS = new Set(["find", "grep", "rg", "ag", "ack", "locate", "which", "whereis"]);
const READ_COMMANDS = new Set([
	"cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq", "tr",
]);
const LIST_COMMANDS = new Set(["ls", "tree", "du"]);
const NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

export type LookKind = "search" | "read" | "list";

/**
 * How a shell command looks around, if that is all it does: `rg x | head` searches,
 * `cat a.ts` reads, `ls src` lists. Anything that runs something else, writes a
 * file, or redirects anywhere but /dev/null is undefined, so a group never hides it.
 */
export function classifyShellCommand(command: string): LookKind | undefined {
	const parsed = parseShell(normalizeLineEndings(command));
	if (!parsed || parsed.opaque) return undefined;
	let search = false;
	let read = false;
	let list = false;
	for (const { words, redirects } of parsed.commands) {
		if (!redirects.every(isHarmlessRedirect) || writesOrRuns(words)) return undefined;
		const program = words[0];
		if (!program || NEUTRAL_COMMANDS.has(program)) continue;
		if (SEARCH_COMMANDS.has(program)) search = true;
		else if (READ_COMMANDS.has(program)) read = true;
		else if (LIST_COMMANDS.has(program)) list = true;
		else return undefined;
	}
	// Claude Code counts a call once: as a listing first, then a search, then a read.
	return list ? "list" : search ? "search" : read ? "read" : undefined;
}

/** Whether a call only looks around, and how; such calls fold into one group. */
export function lookKind(name: string, args: ToolArgs): LookKind | undefined {
	if (name === "read") return "read";
	if (name === "grep" || name === "find") return "search";
	if (name === "ls") return "list";
	if (name === "bash" || name === "powershell") return classifyShellCommand(commandOf(args));
	return undefined;
}

/** What a group's second line names while a call runs: a path, a pattern, a command. */
export function lookHint(name: string, args: ToolArgs): string {
	if (name === "grep" || name === "find") {
		const pattern = typeof args.pattern === "string" ? oneLine(args.pattern) : "";
		return pattern ? `"${pattern}"` : "";
	}
	if (name === "bash" || name === "powershell") {
		const command = oneLine(commandOf(args));
		return command ? `$ ${command}` : "";
	}
	return name === "ls" ? pathOf(args) || "." : pathOf(args);
}

function plural(count: number, singular: string): string {
	return count === 1 ? singular : `${singular}s`;
}

function countOf(summary: string | undefined): number {
	return Number.parseInt(summary ?? "0", 10) || 0;
}

/**
 * The result line for tools whose outcome is a sentence rather than output, worded
 * as Claude Code words it: "Read 42 lines", "Added 3 lines, removed 1 line". `bold`
 * marks the counts and paths Claude Code sets in bold. Tools whose output is the
 * result, commands and custom tools, return undefined and show it instead.
 */
export function claudeOutcome(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	bold: (text: string) => string = (text) => text,
): string | undefined {
	const lines = countOf(formatResultLineSummary(name, args, result, output));
	const count = (value: number, singular: string) => `${bold(String(value))} ${plural(value, singular)}`;
	switch (name) {
		case "read": return `Read ${count(lines, "line")}`;
		case "grep": return `Found ${count(lines, "line")}`;
		case "find": return `Found ${count(lines, "file")}`;
		case "ls": return `Listed ${count(lines, "path")}`;
		case "write": return `Wrote ${count(lines, "line")} to ${bold(pathOf(args))}`;
		case "edit": {
			const { added, removed } = countEditChanges(result) ?? { added: 0, removed: 0 };
			if (added > 0 && removed > 0) return `Added ${count(added, "line")}, removed ${count(removed, "line")}`;
			if (added > 0) return `Added ${count(added, "line")}`;
			if (removed > 0) return `Removed ${count(removed, "line")}`;
			return undefined;
		}
		default: return undefined;
	}
}

const SHELL_STATUS = /^Command (?:exited with code (\d+)|(timed out.*|aborted|terminated.*))$/iu;

/**
 * A failure as Claude Code reports it. A command leads with its exit code and
 * then shows what it printed; another tool leads with its reason alone.
 */
export function claudeFailure(name: string, output: string): { headline: string; detail: string } {
	if (name === "bash" || name === "powershell" || !TOOL_NAMES.has(name)) {
		const lines = normalizeLineEndings(output).trimEnd().split("\n");
		const status = lines.at(-1)?.trim().match(SHELL_STATUS);
		if (status) {
			const headline = status[1] !== undefined ? `Error: Exit code ${status[1]}` : `Error: ${status[2]}`;
			return { headline, detail: lines.slice(0, -1).join("\n").trimEnd() };
		}
		if (name === "bash" || name === "powershell") return { headline: "Error", detail: output.trimEnd() };
	}
	const reason = summarizeFailure(name, output);
	return { headline: reason ? `Error: ${reason}` : "Error", detail: "" };
}

const TOOL_NAMES = new Set(Object.keys(LABELS));
