import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

function pathFrom(args: ToolArgs): string {
	const value = args.path ?? args.file_path;
	return typeof value === "string" ? normalizeLineEndings(value) : "";
}

const INLINE_ARGUMENT_TOOLS = new Set(["grep", "find", "ls"]);

function omitArgument(name: string, key: string): boolean {
	if (key === "path" || key === "file_path") return true;
	if (name === "read" && (key === "offset" || key === "limit")) return true;
	if (name === "write" && key === "content") return true;
	return (name === "grep" || name === "find") && key === "pattern";
}

function collectArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	const details: ToolArgs = {};
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined && !omitArgument(name, key)) details[key] = value;
	}
	return details;
}

export function getCallDetails(name: string, args: ToolArgs): string {
	const path = pathFrom(args) || (INLINE_ARGUMENT_TOOLS.has(name) ? "." : "");
	if (name === "read") return path;
	if (name !== "grep" && name !== "find") return path;
	const pattern = typeof args.pattern === "string" ? normalizeLineEndings(args.pattern) : "…";
	return name === "grep" ? `/${pattern}/ in ${path}` : `${pattern} in ${path}`;
}

/** Argument names that usually identify what a tool call is about, most specific first. */
const CUSTOM_SUMMARY_KEYS = [
	"command", "query", "queries", "q", "url", "urls", "path", "file_path", "paths",
	"pattern", "prompt", "question", "claim", "name", "id", "tool",
];
const CUSTOM_SUMMARY_MAX_LENGTH = 160;

function summaryValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts = value.filter((item) => typeof item === "string" || typeof item === "number").map(String);
		return parts.length > 0 ? parts.join(", ") : undefined;
	}
	return undefined;
}

/** One line describing a custom tool call; the full arguments stay available when expanded. */
export function summarizeCustomArguments(args: ToolArgs): string {
	const keys = [...CUSTOM_SUMMARY_KEYS.filter((key) => key in args), ...Object.keys(args)];
	for (const key of keys) {
		const value = summaryValue(args[key]);
		if (!value?.trim()) continue;
		const line = stripTerminalSequences(normalizeLineEndings(value))
			.replace(/[\x00-\x1f\x7f]/gu, " ")
			.replace(/\s+/gu, " ")
			.trim();
		return line.length > CUSTOM_SUMMARY_MAX_LENGTH
			? `${line.slice(0, CUSTOM_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
			: line;
	}
	return "";
}

export function getArgumentDetails(name: string, args: ToolArgs): ToolArgs {
	if (name === "edit" || INLINE_ARGUMENT_TOOLS.has(name)) return {};
	return collectArgumentDetails(name, args);
}

export function shellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			current += character;
			continue;
		}
		const pair = command.slice(index, index + 2);
		if (character === "\n" || character === ";" || pair === "&&" || pair === "||") {
			if (current.trim()) segments.push(current.trim());
			current = "";
			if (pair === "&&" || pair === "||") index++;
			continue;
		}
		current += character;
	}
	if (current.trim()) segments.push(current.trim());
	return segments;
}

function shellWords(command: string, powershell = false): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	const input = command.trim();
	for (let index = 0; index < input.length; index++) {
		const character = input[index]!;
		if (powershell && character === "`" && quote !== "'") {
			const next = input[index + 1];
			if (next !== undefined) {
				current += next;
				index++;
			}
			continue;
		}
		if (!powershell && character === "\\" && quote !== "'") {
			const next = input[index + 1];
			if (next === undefined) {
				current += "\\";
				continue;
			}
			// In double quotes, Bash preserves backslashes before ordinary characters.
			if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) {
				current += "\\";
				continue;
			}
			current += next;
			index++;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (current) words.push(current);
			current = "";
			continue;
		}
		current += character;
	}
	if (current) words.push(current);
	return words;
}

const SEARCH_OPTIONS_WITH_VALUES = new Set([
	"-a", "--after-context", "-b", "--before-context", "-c", "--context", "--context-separator",
	"-d", "--max-depth", "--dfa-size-limit", "-f", "--file", "-g", "--glob", "--iglob",
	"-m", "--max-count", "--max-columns", "--path-separator", "--pre", "--pre-glob",
	"--regex-size-limit", "--replace", "--sort", "--sortr", "-t", "--type", "--type-not",
	"--encoding", "--engine", "--field-context-separator", "--field-match-separator", "--hostname-bin",
	"--binary-files", "--exclude", "--exclude-from", "--exclude-dir", "--include", "--label",
]);

function searchPattern(executable: string, words: string[]): string | undefined {
	const args = words.slice(1);
	for (let index = 0; index < args.length; index++) {
		const argument = args[index] ?? "";
		const lower = argument.toLowerCase();
		if (executable === "select-string") {
			if (lower === "-pattern") return args[index + 1];
			if (lower.startsWith("-pattern:")) return argument.slice(argument.indexOf(":") + 1);
			if (!argument.startsWith("-")) return argument;
			continue;
		}
		if (lower === "-e" || lower === "--regexp") return args[index + 1];
		if (lower.startsWith("--regexp=")) return argument.slice(argument.indexOf("=") + 1);
		if (/^-e.+/u.test(argument)) return argument.slice(2);
		if (argument === "--") return args[index + 1];
		const optionName = lower.split("=", 1)[0] ?? lower;
		if (SEARCH_OPTIONS_WITH_VALUES.has(optionName) && !argument.includes("=")) {
			index++;
			continue;
		}
		if (argument.startsWith("-")) continue;
		return argument;
	}
	return undefined;
}

function summarizeTextSearch(executable: string, words: string[]): string {
	const pattern = searchPattern(executable, words);
	return pattern === undefined ? "Search text" : `Search text ${JSON.stringify(pattern)}`;
}

function formatTargets(targets: string[]): string {
	const visible = targets.slice(0, 2).map((target) => JSON.stringify(target)).join(", ");
	const remaining = targets.length - 2;
	return remaining > 0 ? `${visible} + ${remaining} more` : visible;
}

function plainOperands(words: string[]): string[] {
	const separator = words.indexOf("--");
	if (separator >= 0) return words.slice(separator + 1);
	return words.slice(1).filter((word) => !word.startsWith("-"));
}

function optionValue(words: string[], names: string[]): string | undefined {
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		const lower = word.toLowerCase();
		if (names.includes(lower)) return words[index + 1];
		const prefix = names.find((name) => lower.startsWith(`${name}=`) || lower.startsWith(`${name}:`));
		if (prefix) return word.slice(prefix.length + 1);
	}
	return undefined;
}

const FD_OPTIONS_WITH_VALUES = new Set([
	"-d", "--max-depth", "-e", "--extension", "-E", "--exclude", "-t", "--type",
	"-x", "--exec", "-X", "--exec-batch", "-j", "--threads", "--base-directory",
	"--changed-before", "--changed-within", "--format", "--glob", "--path-separator",
	"--search-path", "--size", "--strip-cwd-prefix",
].map((option) => option.toLowerCase()));

function fdOperands(words: string[]): string[] {
	const operands: string[] = [];
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") return [...operands, ...words.slice(index + 1)];
		const optionName = word.toLowerCase().split("=", 1)[0] ?? word.toLowerCase();
		if (FD_OPTIONS_WITH_VALUES.has(optionName) && !word.includes("=")) {
			index++;
			continue;
		}
		if (!word.startsWith("-")) operands.push(word);
	}
	return operands;
}

function summarizeFileDiscovery(executable: string, words: string[]): string {
	if (executable === "find") {
		const paths: string[] = [];
		for (let index = 1; index < words.length; index++) {
			const word = words[index] ?? "";
			if (word.startsWith("-") || word === "!" || word === "(") break;
			paths.push(word);
		}
		const pattern = optionValue(words, ["-name", "-iname", "-path", "-ipath", "-regex"]);
		const location = formatTargets(paths.length > 0 ? paths : ["."]);
		return pattern ? `Find files ${JSON.stringify(pattern)} in ${location}` : `Find files in ${location}`;
	}
	if (executable === "fd") {
		const operands = fdOperands(words);
		const pattern = operands[0];
		const locations = operands.slice(1);
		if (!pattern) return "Find files";
		return locations.length > 0
			? `Find files ${JSON.stringify(pattern)} in ${formatTargets(locations)}`
			: `Find files ${JSON.stringify(pattern)}`;
	}
	const explicitPath = optionValue(words, ["-path", "-literalpath"]);
	const targets = explicitPath ? [explicitPath] : plainOperands(words);
	return targets.length > 0 ? `List files ${formatTargets(targets)}` : "List files";
}

function summarizeFileOperation(executable: string, words: string[]): string | undefined {
	const targets = plainOperands(words);
	if (targets.length === 0) return undefined;
	if (["rm", "del", "erase", "remove-item"].includes(executable)) return `Run ${executable} ${formatTargets(targets)}`;
	if (["cat", "type", "get-content"].includes(executable)) return `Read file ${formatTargets(targets)}`;
	if (["mkdir", "md", "new-item"].includes(executable)) return `Create ${formatTargets(targets)}`;
	if (["rmdir", "rd"].includes(executable)) return `Remove directory ${formatTargets(targets)}`;
	if (["touch"].includes(executable)) return `Touch ${formatTargets(targets)}`;
	if (["cp", "copy", "copy-item"].includes(executable) && targets.length >= 2) {
		return `Copy ${JSON.stringify(targets[0])} to ${JSON.stringify(targets.at(-1))}`;
	}
	if (["mv", "move", "move-item", "ren", "rename-item"].includes(executable) && targets.length >= 2) {
		return `Move ${JSON.stringify(targets[0])} to ${JSON.stringify(targets.at(-1))}`;
	}
	return undefined;
}

/** One step split at its unquoted pipes: `cat a | tee b` is two commands, the second writing a file. */
function pipelineStages(segment: string): string[] {
	const stages: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let index = 0; index < segment.length; index++) {
		const character = segment[index]!;
		if (quote) {
			if (character === "\\" && quote === '"' && index + 1 < segment.length) {
				current += character + segment[++index];
				continue;
			}
			if (character === quote) quote = undefined;
		} else if (character === "'" || character === '"' || character === "`") {
			quote = character;
		} else if (character === "\\" && index + 1 < segment.length) {
			current += character + segment[++index];
			continue;
		} else if (character === "|") {
			if (current.trim()) stages.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}
	if (current.trim()) stages.push(current.trim());
	return stages;
}

/** A calm collapsed label that describes intent while retaining primary command targets. */
export function summarizeShellCommand(name: string, command: string): string {
	const allSegments = shellSegments(normalizeLineEndings(command)).flatMap(pipelineStages);
	const segments = allSegments.filter((segment) => !/^\s*(?:cd|pushd|popd)\b/iu.test(segment));
	const primary = segments[0] ?? allSegments[0] ?? "";
	if (!primary) return name === "powershell" ? "Prepare PowerShell command" : "Prepare shell command";

	const words = shellWords(primary, name === "powershell");
	while (words.length > 0) {
		if (/^[A-Za-z_][A-Za-z\d_]*=.*/u.test(words[0] ?? "")
			|| ["command", "env", "sudo", "time"].includes((words[0] ?? "").toLowerCase())) {
			words.shift();
			continue;
		}
		break;
	}
	const executable = (words[0] ?? "").replace(/^.*[\\/]/u, "").replace(/\.(?:cmd|exe|ps1)$/iu, "").toLowerCase();
	const action = (words[1] ?? "").toLowerCase();
	const subject = words[2] ?? "";

	let summary: string;
	if (["npm", "pnpm", "yarn", "bun"].includes(executable) && action === "run" && subject) {
		summary = `Run ${subject} task`;
	} else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && ["test", "check"].includes(action)) {
		summary = action === "test" ? "Run tests" : "Run project checks";
	} else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && ["install", "i", "ci"].includes(action)) {
		summary = "Install dependencies";
	} else if (executable === "git" && action === "status") {
		summary = "Check repository status";
	} else if (executable === "git" && action === "diff") {
		summary = "Review repository changes";
	} else if (executable === "git" && action === "log") {
		summary = "Review commit history";
	} else if (executable === "git" && ["fetch", "pull", "push", "clone"].includes(action)) {
		summary = `${action[0]!.toUpperCase()}${action.slice(1)} repository`;
	} else if (["rg", "grep", "select-string"].includes(executable)) {
		summary = summarizeTextSearch(executable, words);
	} else if (["find", "fd", "get-childitem", "ls", "dir"].includes(executable)) {
		summary = summarizeFileDiscovery(executable, words);
	} else if (summarizeFileOperation(executable, words)) {
		summary = summarizeFileOperation(executable, words)!;
	} else if (["tsc", "mypy", "pyright"].includes(executable)) {
		summary = "Check types";
	} else if (["jest", "vitest", "pytest", "invoke-pester"].includes(executable)) {
		summary = "Run tests";
	} else if (executable) {
		const display = executable.replace(/[-_]+/gu, " ");
		summary = `Run ${display}`;
	} else {
		summary = name === "powershell" ? "Run PowerShell command" : "Run shell command";
	}

	const remainingSteps = Math.max(0, segments.length - 1);
	return remainingSteps > 0 ? `${summary} + ${remainingSteps} more ${remainingSteps === 1 ? "step" : "steps"}` : summary;
}

export function getTextResult(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "text") parts.push(item.text);
	}
	return normalizeLineEndings(parts.join("\n")).trimEnd();
}

const FAILURE_REASON_MAX_LENGTH = 140;

/** Pull a useful diagnostic into a collapsed failed row without exposing raw control sequences. */
export function summarizeFailure(name: string, output: string): string | undefined {
	const lines = normalizeLineEndings(stripTerminalSequences(output))
		.split("\n")
		.map((line) => line.replace(/[\x00-\x1f\x7f]/gu, " ").trim())
		.filter(Boolean);
	if (lines.length === 0) return undefined;
	const last = lines[lines.length - 1]!;
	const shellStatus = (name === "bash" || name === "powershell")
		&& /^Command (?:exited with code \d+|timed out.*|aborted|terminated.*)$/iu.test(last)
		? last
		: undefined;
	const diagnostic = shellStatus
		? lines.slice(0, -1).reverse().find((line) =>
			/\b(?:error|failed|failure|fatal|exception|denied|not found|no such file)\b|ENOENT/iu.test(line))
		: undefined;
	const reason = diagnostic ? `${diagnostic} (${shellStatus})` : shellStatus ?? lines[0]!;
	return reason.length > FAILURE_REASON_MAX_LENGTH
		? `${reason.slice(0, FAILURE_REASON_MAX_LENGTH - 1).trimEnd()}…`
		: reason;
}

type ResultDetails = {
	diff?: unknown;
	patch?: unknown;
	truncation?: {
		firstLineExceedsLimit?: boolean;
		outputLines?: number;
	};
	matchLimitReached?: unknown;
	resultLimitReached?: unknown;
	entryLimitReached?: unknown;
	linesTruncated?: unknown;
};

function countTextLines(text: string): number {
	const normalized = normalizeLineEndings(text).trimEnd();
	if (!normalized) return 0;
	let count = 1;
	for (let index = 0; index < normalized.length; index++) {
		if (normalized.charCodeAt(index) === 10) count++;
	}
	return count;
}

export function getEditDiff(result: AgentToolResult<unknown>): string {
	const diff = (result.details as ResultDetails | undefined)?.diff;
	return typeof diff === "string" ? normalizeLineEndings(diff).trimEnd() : "";
}

export function getEditPatch(result: AgentToolResult<unknown>): string {
	const patch = (result.details as ResultDetails | undefined)?.patch;
	return typeof patch === "string" ? normalizeLineEndings(patch).trimEnd() : "";
}

/** Keep only the lines that the edit actually removed or added; discard context and ellipses. */
export function getEditChanges(result: AgentToolResult<unknown>): string {
	return getEditDiff(result)
		.split("\n")
		.filter((line) => line.startsWith("-") || line.startsWith("+"))
		.join("\n")
		.trimEnd();
}

/** How many lines an edit added and removed, counted from the diff Pi attaches to its result. */
export function countEditChanges(result: AgentToolResult<unknown>): { added: number; removed: number } | undefined {
	const diff = getEditDiff(result);
	if (!diff) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

const READ_FOOTER = /\n\n(\[(?:Showing lines |\d+ more lines in file\.)[^\n]*\])$/u;

/** Separate a read's file contents from the continuation notice Pi appends to them. */
export function splitReadFooter(text: string): { body: string; footer?: string } {
	const match = text.match(READ_FOOTER);
	return match ? { body: text.slice(0, match.index), footer: match[1] } : { body: text };
}

/** Whether a read result is plain file text that can be shown as numbered code. */
export function isReadTextResult(result: AgentToolResult<unknown>): boolean {
	const details = result.details as ResultDetails | undefined;
	return !details?.truncation?.firstLineExceedsLimit
		&& !result.content.some((item) => item.type === "image");
}

function stripGeneratedFooter(name: string, text: string, details: ResultDetails | undefined): string {
	if (name === "read") return splitReadFooter(text).body;
	const hasGeneratedFooter = details?.truncation?.outputLines !== undefined
		|| details?.matchLimitReached !== undefined
		|| details?.resultLimitReached !== undefined
		|| details?.entryLimitReached !== undefined
		|| details?.linesTruncated !== undefined;
	return hasGeneratedFooter ? text.replace(/\n\n\[[^\n]*\]$/u, "") : text;
}

export function formatResultLineSummary(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output?: string,
): string | undefined {
	const details = result.details as ResultDetails | undefined;
	const text = name === "edit"
		? getEditChanges(result)
		: output ?? (name === "write"
			? String(args.content ?? "")
			: result.content.some((item) => item.type === "text")
				? getTextResult(result)
				: undefined);
	if (text === undefined) return undefined;
	const truncationLines = details?.truncation?.outputLines;
	const lineCount = !details?.truncation?.firstLineExceedsLimit
		&& typeof truncationLines === "number"
		&& Number.isInteger(truncationLines)
		&& truncationLines >= 0
		? truncationLines
		: countTextLines(stripGeneratedFooter(name, text, details));
	return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
}

export function getFileOutput(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	isError: boolean,
): string {
	if (isError || name === "read" || name === "grep" || name === "find" || name === "ls") {
		return getTextResult(result);
	}
	return name === "write" ? String(args.content ?? "") : "";
}
