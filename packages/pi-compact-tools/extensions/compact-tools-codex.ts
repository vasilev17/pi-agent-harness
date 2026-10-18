import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeLineEndings } from "./compact-tools-core.ts";
import { parseShell, writesOrRuns } from "./compact-tools-shell.ts";
import type { ToolArgs } from "./compact-tools-types.ts";

/** Rows Codex shows of a call's output, its last ones, before offering the rest. */
export const CODEX_PREVIEW_ROWS = 3;
/**
 * Codex 0.160.0's chrome: `• Ran …`, then `  └ ` under the bullet with the output two
 * columns after it, and every later row four columns in. Pi draws every row one column
 * in, so each prefix keeps that geometry one column further right.
 */
export const CODEX_RESULT_PREFIX = "   └ ";
export const CODEX_INDENT = "     ";
/** Where an opened command's wrapped lines continue, four columns past the `$`. */
export const CODEX_COMMAND_INDENT = "     ";
/** The left margin every Codex row starts after. */
export const CODEX_MARGIN = " ";
export const CODEX_BULLET = "•";
/** Codex draws a tab as four columns. */
export const CODEX_TAB = "    ";
/**
 * Codex's key is ctrl+t; in Pi the key that opens a row is ctrl+o. Codex 0.161 spells
 * a modifier by platform (`⌃t` on macOS, `^t` on Linux, `ctrl+t` elsewhere) and so does
 * this. PI_COMPACT_TOOLS_PLATFORM stands in for the platform, so the suite draws the
 * same rows wherever it runs.
 */
export function codexExpandKey(platform: string = process.env.PI_COMPACT_TOOLS_PLATFORM ?? process.platform): string {
	return platform === "darwin" ? "⌃o" : platform === "linux" ? "^o" : "ctrl+o";
}

/** How Codex prints how long a call took: `250ms`, `1.50s`, `1m 15s`. */
export function formatCodexDuration(milliseconds: number): string {
	const millis = Math.max(0, Math.floor(milliseconds));
	if (millis < 1000) return `${millis}ms`;
	if (millis < 60_000) return `${(millis / 1000).toFixed(2)}s`;
	const seconds = Math.floor((millis % 60_000) / 1000);
	return `${Math.floor(millis / 60_000)}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * The control under a collapsed or opened call. Codex starts it at a quarter of the
 * width, at most four columns in, and drops the key hint when the row cannot fit it.
 */
export function codexDisclosure(width: number, expanded: boolean, hiddenLines?: number): string {
	const indent = CODEX_MARGIN + " ".repeat(Math.min(Math.floor(width / 4), 4));
	if (expanded) return `${indent}− Show less`;
	if (hiddenLines === undefined) return `${indent}+ Show details`;
	const label = `+ ${hiddenLines} ${hiddenLines === 1 ? "line" : "lines"}`;
	const hint = ` (${codexExpandKey()} to expand)`;
	return visibleWidth(indent + label + hint) <= width ? indent + label + hint : indent + label;
}

/**
 * The last path segment, as Codex names files in its exploration lines; `src`, `dist`,
 * `build`, and `node_modules` say nothing about the file and are skipped.
 */
export function shortDisplayPath(path: string): string {
	const trimmed = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
	const parts = trimmed.split("/").reverse()
		.filter((part) => part && part !== "build" && part !== "dist" && part !== "node_modules" && part !== "src");
	return parts[0] ?? trimmed;
}

/** One thing an exploration call does, the way Codex parses it out of the command. */
export type ExploreAction =
	| { kind: "read"; name: string }
	| { kind: "search"; query?: string; path?: string; command: string }
	| { kind: "list"; path?: string; command: string };

/** Operands, skipping flags and the values the given flags take. */
function operands(args: readonly string[], flagsWithValues: readonly string[] = []): string[] {
	const out: string[] = [];
	let afterDashes = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (afterDashes) {
			out.push(arg);
		} else if (arg === "--") {
			afterDashes = true;
		} else if (arg.startsWith("--") && arg.includes("=")) {
			continue;
		} else if (flagsWithValues.includes(arg)) {
			index++;
		} else if (!arg.startsWith("-")) {
			out.push(arg);
		}
	}
	return out;
}

const digits = (value: string | undefined) => value !== undefined && /^\d+$/u.test(value);
const signedDigits = (value: string | undefined) => value !== undefined && /^\+?\d+$/u.test(value);

function isSedRange(value: string | undefined): boolean {
	return value !== undefined && /^\d+(?:,\d+)?p$/u.test(value);
}

function sedReadPath(args: readonly string[]): string | undefined {
	if (args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place") || !args.includes("-n")) return undefined;
	let range = false;
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "-e" || args[index] === "--expression") {
			if (isSedRange(args[index + 1])) range = true;
			index++;
		}
	}
	if (!range) range = args.some((arg) => !arg.startsWith("-") && isSedRange(arg));
	if (!range) return undefined;
	const rest = operands(args, ["-e", "-f", "--expression", "--file"]);
	if (rest.length === 0) return undefined;
	return isSedRange(rest[0]) ? rest[1] : rest[0];
}

/** Commands that only reshape another's output, which Codex leaves out of a pipeline's summary. */
function isFormatting(words: readonly string[]): boolean {
	const [program, ...args] = words;
	switch (program) {
		// Codex counts xargs and tee as formatting too; they run and write, so here they are never left out.
		case "wc": case "tr": case "cut": case "sort": case "uniq": case "column": case "yes": case "printf":
			return true;
		case "head":
			return args.length === 0 || (args.length === 1 && args[0]!.startsWith("-"))
				|| (args.length === 2 && (args[0] === "-n" || args[0] === "-c") && digits(args[1]));
		case "tail":
			return args.length === 0 || (args.length === 1 && args[0]!.startsWith("-"))
				|| (args.length === 2 && (args[0] === "-n" || args[0] === "-c") && signedDigits(args[1]));
		case "sed":
			return !args.some((arg) => arg.startsWith("-i")) && sedReadPath(args) === undefined;
		default:
			return false;
	}
}

/** A head or tail of a file: `-n N file`, `-nN file`, or the file alone. */
function headTailPath(args: readonly string[], signed: boolean): string | undefined {
	const count = signed ? signedDigits : digits;
	const first = args[0];
	const counted = (first === "-n" && count(args[1])) || (first?.startsWith("-n") === true && first.length > 2 && count(first.slice(2)));
	if (counted) {
		const rest = first === "-n" ? args.slice(2) : args.slice(1);
		const path = rest.find((arg) => !arg.startsWith("-"));
		if (path !== undefined) return path;
	}
	return args.length === 1 && !args[0]!.startsWith("-") ? args[0] : undefined;
}

function single(values: readonly string[]): string | undefined {
	return values.length === 1 ? values[0] : undefined;
}

const read = (path: string | undefined): ExploreAction | undefined =>
	path === undefined ? undefined : { kind: "read", name: shortDisplayPath(path) };

/** What one command does, or undefined when it does anything but look around. */
function summarize(words: readonly string[]): ExploreAction | undefined {
	const [program, ...args] = words;
	const command = words.join(" ");
	const short = (path: string | undefined) => path === undefined ? undefined : shortDisplayPath(path);
	switch (program) {
		case "ls": case "eza": case "exa":
			return { kind: "list", path: short(operands(args, ["-I", "-w", "--block-size", "--format", "--time-style", "--color", "--quoting-style", "--ignore-glob", "--sort", "--time"])[0]), command };
		case "tree":
			return { kind: "list", path: short(operands(args, ["-L", "-P", "-I", "--charset", "--filelimit", "--sort"])[0]), command };
		case "du":
			return { kind: "list", path: short(operands(args, ["-d", "--max-depth", "-B", "--block-size", "--exclude", "--time-style"])[0]), command };
		case "rg": case "rga": case "ripgrep-all": {
			const rest = operands(args, ["-g", "--glob", "--iglob", "-t", "--type", "--type-add", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--max-depth"]);
			if (args.includes("--files")) return { kind: "list", path: short(rest[0]), command };
			return { kind: "search", query: rest[0], path: short(rest[1]), command };
		}
		case "grep": case "egrep": case "fgrep": {
			let pattern: string | undefined;
			const rest: string[] = [];
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!;
				if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file") pattern ??= args[++index];
				else if (["-m", "--max-count", "-C", "--context", "-A", "--after-context", "-B", "--before-context"].includes(arg)) index++;
				else if (!arg.startsWith("-")) rest.push(arg);
			}
			if (pattern === undefined) pattern = rest.shift();
			return { kind: "search", query: pattern, path: short(rest[0]), command };
		}
		case "ag": case "ack": case "pt": {
			const rest = operands(args, ["-G", "-g", "--file-search-regex", "--ignore-dir", "--ignore-file", "--path-to-ignore"]);
			return { kind: "search", query: rest[0], path: short(rest[1]), command };
		}
		case "fd": {
			const rest = operands(args, ["-t", "--type", "-e", "--extension", "-E", "--exclude", "--search-path"]);
			if (rest.length === 1) {
				return /[/\\]|^\.\.?$/u.test(rest[0]!) ? { kind: "list", path: short(rest[0]), command } : { kind: "search", query: rest[0], command };
			}
			return rest.length === 0 ? { kind: "list", command } : { kind: "search", query: rest[0], path: short(rest[1]), command };
		}
		case "find": {
			const root = args.find((arg) => !arg.startsWith("-") && arg !== "!" && arg !== "(" && arg !== ")");
			const flag = args.findIndex((arg) => arg === "-name" || arg === "-iname" || arg === "-path" || arg === "-regex");
			const query = flag >= 0 ? args[flag + 1] : undefined;
			return query === undefined ? { kind: "list", path: short(root), command } : { kind: "search", query, path: short(root), command };
		}
		case "git": {
			const [sub, ...rest] = args;
			if (sub === "grep") {
				const search = summarize(["grep", ...rest]);
				return search && { ...search, command } as ExploreAction;
			}
			if (sub === "ls-files") return { kind: "list", path: short(operands(rest, ["--exclude", "--exclude-from", "--pathspec-from-file"])[0]), command };
			return undefined;
		}
		case "cat": case "more":
			return read(single(operands(args)));
		case "bat": case "batcat":
			return read(single(operands(args, ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"])));
		case "less":
			return read(single(operands(args, ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"])));
		case "head":
			return read(headTailPath(args, false));
		case "tail":
			return read(headTailPath(args, true));
		case "nl":
			return read(operands(args, ["-s", "-w", "-v", "-i", "-b"])[0]);
		case "sed":
			return read(sedReadPath(args));
		default:
			return undefined;
	}
}

/**
 * What a shell command does, call by call, if all it does is read, search, and list;
 * otherwise undefined, and Codex shows it as a command it ran. Formatting stages,
 * a `cd`, a leading `echo`, and a `true` say nothing and are left out. Like Codex,
 * only plain words are read: a redirection or a substitution is a command it ran.
 * Unlike Codex, a command that can write or run something else, `xargs rm`, `tee`,
 * `find -delete`, never passes for exploring, since the group would hide it.
 */
export function parseExploreCommand(command: string): ExploreAction[] | undefined {
	const parsed = parseShell(normalizeLineEndings(command));
	if (!parsed || parsed.opaque || parsed.commands.some((each) => each.redirects.length > 0)) return undefined;
	let commands = parsed.commands.map((each) => each.words);
	if (commands.some(writesOrRuns)) return undefined;
	if (commands.length > 1) commands = commands.filter((each) => !isFormatting(each));
	commands = commands.filter((each, index) => each[0] !== "cd" && !(each.length === 1 && each[0] === "true")
		&& !(each[0] === "echo" && index === 0 && commands.length > 1));
	if (commands.length === 0) return undefined;
	const actions: ExploreAction[] = [];
	for (const each of commands) {
		const action = summarize(each);
		if (!action) return undefined;
		actions.push(action);
	}
	return actions;
}

function argument(args: ToolArgs, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? normalizeLineEndings(value) : undefined;
}

/** A Pi tool's path argument, whichever name it uses. */
export function codexPath(args: ToolArgs): string {
	return argument(args, "path") ?? argument(args, "file_path") ?? "";
}

/**
 * What a call does, as Codex's exploration lines name it. Pi's dedicated tools map to
 * the verb Codex would give the command they stand for; a shell command is parsed.
 */
export function exploreActions(name: string, args: ToolArgs): ExploreAction[] | undefined {
	const path = codexPath(args);
	const short = path ? shortDisplayPath(path) : undefined;
	switch (name) {
		case "read": return path ? [{ kind: "read", name: shortDisplayPath(path) }] : undefined;
		case "grep": case "find": {
			const pattern = argument(args, "pattern");
			return pattern ? [{ kind: "search", query: firstLine(pattern), path: short, command: name }] : undefined;
		}
		case "ls": return [{ kind: "list", path: short, command: "ls" }];
		case "bash": case "powershell": {
			const command = argument(args, "command");
			return command ? parseExploreCommand(command) : undefined;
		}
		default: return undefined;
	}
}

function firstLine(text: string): string {
	return normalizeLineEndings(stripTerminalSequences(text)).split("\n").find((line) => line.trim())?.trim() ?? "";
}

/** One exploration line: its verb and the parts after it, each marked plain or dim. */
export type ExploreLine = { verb: "Read" | "Search" | "List"; parts: Array<{ text: string; dim?: boolean }>; failure?: { text: string; quiet: boolean } };

export type ExploreCall = { actions: ExploreAction[]; failure?: { text: string; quiet: boolean } };

/**
 * Codex's exploration lines for a run of calls: consecutive reads that succeeded
 * merge into one line of distinct names; every other action is a line of its own, and
 * a failed call's last line ends with why.
 */
export function exploreLines(calls: readonly ExploreCall[]): ExploreLine[] {
	const lines: ExploreLine[] = [];
	for (let index = 0; index < calls.length;) {
		const call = calls[index]!;
		const readsOnly = call.actions.every((action) => action.kind === "read");
		if (readsOnly && !call.failure) {
			const names: string[] = [];
			while (index < calls.length && !calls[index]!.failure && calls[index]!.actions.every((action) => action.kind === "read")) {
				for (const action of calls[index]!.actions) {
					const name = (action as { name: string }).name;
					if (!names.includes(name)) names.push(name);
				}
				index++;
			}
			const parts = names.flatMap((name, position) => position === 0 ? [{ text: name }] : [{ text: ", ", dim: true }, { text: name }]);
			lines.push({ verb: "Read", parts });
			continue;
		}
		call.actions.forEach((action, position) => {
			const line = actionLine(action);
			if (call.failure && position === call.actions.length - 1) line.failure = call.failure;
			lines.push(line);
		});
		index++;
	}
	return lines;
}

/** Text that spans lines, such as a quoted multi-line pattern, shows its first line and that more follows. */
function oneLine(text: string): string {
	const lines = text.split("\n");
	return lines.length > 1 ? `${lines[0]} …` : text;
}

function actionLine(action: ExploreAction): ExploreLine {
	if (action.kind === "read") return { verb: "Read", parts: [{ text: oneLine(action.name) }] };
	if (action.kind === "list") return { verb: "List", parts: [{ text: oneLine(action.path ?? action.command) }] };
	if (action.query === undefined) return { verb: "Search", parts: [{ text: oneLine(action.command) }] };
	const query = oneLine(action.query);
	return { verb: "Search", parts: action.path ? [{ text: query }, { text: " in ", dim: true }, { text: oneLine(action.path) }] : [{ text: query }] };
}

const SHELL_STATUS = /^Command (?:exited with code (\d+)|(timed out.*|aborted|terminated.*))$/iu;

/**
 * A command's outcome as Pi reports it: the exit code from the line Pi ends a failed
 * run with, and the output without that line. A run that timed out or was aborted
 * keeps its line, the only place that says why.
 */
export function shellOutcome(output: string): { exitCode?: number; output: string } {
	const lines = normalizeLineEndings(output).trimEnd().split("\n");
	const status = lines.at(-1)?.trim().match(SHELL_STATUS);
	if (status?.[1] === undefined) return { output: lines.join("\n") };
	return { exitCode: Number(status[1]), output: lines.slice(0, -1).join("\n").trimEnd() };
}

/** Pi's bash reports a run that printed nothing as "(no output)"; Codex has its own words for it. */
export function isEmptyOutput(output: string): boolean {
	const trimmed = normalizeLineEndings(output).trim();
	return !trimmed || trimmed === "(no output)";
}

/**
 * A failed exploration call's note: the exit code a command gave, or that a tool
 * failed. A compound command has one exit code for all it did, so Codex says so.
 */
export function exploreFailure(name: string, output: string, isError: boolean, actions: readonly ExploreAction[]): ExploreCall["failure"] {
	if (!isError) return undefined;
	if (name !== "bash" && name !== "powershell") return { text: " (failed)", quiet: false };
	const { exitCode } = shellOutcome(output);
	if (exitCode === undefined) return { text: " (failed)", quiet: false };
	// A search's exit 1 can mean it found nothing; Codex reports the code without calling it a failure.
	const quiet = exitCode === 1 && actions.some((action) => action.kind === "search");
	return { text: actions.length > 1 ? ` (command exit ${exitCode})` : ` (exit ${exitCode})`, quiet };
}

/**
 * The calls of every exploration opened this frame. Codex lists an opened group's
 * calls with one "− Show less" beneath them all, so a call listed there leaves out
 * its own. Refilled as the chat is drawn, before any row in it is.
 */
export const openExplorations = new Set<string>();

/** The last lines of output, the way Codex previews a call. */
export function tailLines(text: string, count = CODEX_PREVIEW_ROWS): string[] {
	const lines = normalizeLineEndings(text).replace(/\n+$/u, "").split("\n");
	return lines.slice(Math.max(0, lines.length - count));
}

export type ThemeColor = Parameters<Theme["fg"]>[0];
/** A run of text and the color it is painted in. Text is wrapped as text and painted after. */
export type Segment = { text: string; color?: ThemeColor };

export function paintSegments(segments: readonly Segment[], theme: Theme): string {
	return segments.map((segment) => segment.color ? theme.fg(segment.color, segment.text) : segment.text).join("");
}

/** Plain text as lines of one color each. */
export function textLines(text: string, color?: ThemeColor): Segment[][] {
	return normalizeLineEndings(text).split("\n").map((line) => line ? [{ text: line, color }] : []);
}

/**
 * Where each row of word-wrapped text starts and ends, in graphemes: a row breaks
 * at its last space when it can and mid-word when it cannot, and the spaces it
 * breaks at begin no row. The first row has `first` columns and every later one `rest`.
 */
function wrapRanges(characters: readonly string[], first: number, rest: number): Array<[number, number]> {
	const rows: Array<[number, number]> = [];
	let start = 0;
	while (start < characters.length) {
		if (rows.length > 0) while (characters[start] === " ") start++;
		if (start >= characters.length) break;
		const limit = Math.max(1, rows.length === 0 ? first : rest);
		let end = start;
		let used = 0;
		while (end < characters.length) {
			const columns = visibleWidth(characters[end]!);
			if (used + columns > limit && end > start) break;
			used += columns;
			end++;
		}
		if (end < characters.length && characters[end] !== " ") {
			const space = characters.lastIndexOf(" ", end - 1);
			if (space > start) end = space;
		}
		let trimmed = end;
		while (trimmed > start && characters[trimmed - 1] === " ") trimmed--;
		rows.push([start, trimmed > start ? trimmed : end]);
		start = end;
	}
	return rows;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Segments word-wrapped into rows, each piece keeping its color. */
export function wrapSegments(segments: readonly Segment[], first: number, rest: number): Segment[][] {
	const owners: number[] = [];
	const characters: string[] = [];
	segments.forEach((segment, index) => {
		// A grapheme, not a code point: an emoji joined from several stays whole on one row.
		for (const { segment: character } of graphemes.segment(segment.text)) {
			characters.push(character);
			owners.push(index);
		}
	});
	if (characters.length === 0) return [[]];
	return wrapRanges(characters, first, rest).map(([start, end]) => {
		const row: Segment[] = [];
		for (let position = start; position < end; position++) {
			const color = segments[owners[position]!]!.color;
			const last = row.at(-1);
			if (last && owners[position] === owners[position - 1] && position > start) last.text += characters[position];
			else row.push({ text: characters[position]!, color });
		}
		return row;
	});
}
