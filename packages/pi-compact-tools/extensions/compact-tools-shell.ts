/**
 * Shell commands as both summary styles read them: split into words the way the
 * shell would, and checked for anything that writes or runs something else. A row
 * that folds into a "looked around" group hides its command, so a command that
 * changes the disk must never pass for one that only reads it.
 */

/** A redirection and where it points: `>`, `2>`, `&>`, `>&` with `1`, `<`. */
export type Redirect = { operator: string; target: string };

/** One command between connectors: its words, and the redirections written into it. */
export type ShellCommand = { words: string[]; redirects: Redirect[] };

export type ParsedShell = {
	commands: ShellCommand[];
	/** `$(…)`, backticks, `<(…)`, a subshell, or a background job: what runs there cannot be read off the words. */
	opaque: boolean;
};

const CONNECTORS = ["&&", "||", "|&", "|", ";"];
const REDIRECTS = ["&>>", "&>", ">>", ">&", ">|", "<>", "<&", ">", "<"];

/**
 * Split a command the way the shell does: quotes removed, a quoted `;` or newline
 * kept as text, and connectors, newlines outside quotes, and redirections kept
 * apart from words. Undefined when it cannot be split: an unterminated quote, or a
 * here-document whose body would read as commands.
 */
export function parseShell(source: string): ParsedShell | undefined {
	const commands: ShellCommand[] = [{ words: [], redirects: [] }];
	let opaque = false;
	let word = "";
	let started = false;
	let redirect: string | undefined;
	const current = () => commands[commands.length - 1]!;
	const flush = () => {
		if (!started) return;
		if (redirect !== undefined) {
			current().redirects.push({ operator: redirect, target: word });
			redirect = undefined;
		} else {
			current().words.push(word);
		}
		word = "";
		started = false;
	};
	const connect = () => {
		flush();
		if (redirect !== undefined) return false;
		if (current().words.length > 0 || current().redirects.length > 0) commands.push({ words: [], redirects: [] });
		return true;
	};
	for (let index = 0; index < source.length; index++) {
		const character = source[index]!;
		if (character === "'") {
			const end = source.indexOf("'", index + 1);
			if (end < 0) return undefined;
			word += source.slice(index + 1, end);
			started = true;
			index = end;
			continue;
		}
		if (character === "\"") {
			let end = index + 1;
			for (; end < source.length && source[end] !== "\""; end++) {
				const inner = source[end]!;
				if (inner === "\\" && end + 1 < source.length && "\"\\$`\n".includes(source[end + 1]!)) {
					if (source[end + 1] !== "\n") word += source[end + 1];
					end++;
				} else {
					if (inner === "`" || (inner === "$" && source[end + 1] === "(")) opaque = true;
					word += inner;
				}
			}
			if (end >= source.length) return undefined;
			started = true;
			index = end;
			continue;
		}
		if (character === "\\") {
			// A backslash before a newline joins the lines; before anything else it quotes it.
			if (source[index + 1] !== "\n" && index + 1 < source.length) {
				word += source[index + 1];
				started = true;
			}
			index++;
			continue;
		}
		if (character === " " || character === "\t") {
			flush();
			continue;
		}
		if (character === "\n") {
			if (!connect()) return undefined;
			continue;
		}
		if (character === "#" && !started) {
			const end = source.indexOf("\n", index);
			index = end < 0 ? source.length : end - 1;
			continue;
		}
		if (character === "`" || (character === "$" && source[index + 1] === "(")) {
			opaque = true;
			word += character;
			started = true;
			continue;
		}
		const rest = source.slice(index);
		if (rest.startsWith("<<")) return undefined;
		if ((character === "<" || character === ">") && source[index + 1] === "(") {
			opaque = true;
			word += character;
			started = true;
			continue;
		}
		const redirection = REDIRECTS.find((operator) => rest.startsWith(operator));
		if (redirection) {
			// A word of digits right before it names the descriptor: `2>`.
			const descriptor = started && /^\d+$/u.test(word) ? word : "";
			if (descriptor) {
				word = "";
				started = false;
			}
			flush();
			if (redirect !== undefined) return undefined;
			redirect = descriptor + redirection;
			index += redirection.length - 1;
			continue;
		}
		const connector = CONNECTORS.find((operator) => rest.startsWith(operator));
		if (connector) {
			if (!connect()) return undefined;
			index += connector.length - 1;
			continue;
		}
		if (character === "&" || character === "(" || character === ")") {
			opaque = true;
			if (!connect()) return undefined;
			continue;
		}
		word += character;
		started = true;
	}
	flush();
	if (redirect !== undefined) return undefined;
	return { commands: commands.filter((command) => command.words.length > 0 || command.redirects.length > 0), opaque };
}

/** Whether a redirection only discards output or joins two streams, rather than reading or writing a file. */
export function isHarmlessRedirect({ operator, target }: Redirect): boolean {
	if (/[>&]&$/u.test(operator) || operator.endsWith("<&")) return /^(?:\d+|-)$/u.test(target);
	return operator.includes(">") && target === "/dev/null";
}

const FIND_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);

function shortFlag(arg: string, letter: string): boolean {
	return /^-[^-]/u.test(arg) && arg.slice(1).includes(letter);
}

function operandCount(args: readonly string[]): number {
	return args.filter((arg) => !arg.startsWith("-") || arg === "-").length;
}

/**
 * sed scripts given with -e, or the first operand when there is none. A short option
 * takes its value from the rest of its word or the next one: `-e'w out'`, `-ne 'w out'`.
 */
function sedScripts(args: readonly string[]): string[] | undefined {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--expression") scripts.push(args[++index] ?? "");
		else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
		// A script read from a file cannot be checked.
		else if (arg === "--file" || arg.startsWith("--file=")) return undefined;
		else if (/^-[^-]/u.test(arg)) {
			// A cluster of single-letter options; e and f take what follows them.
			for (let position = 1; position < arg.length; position++) {
				const letter = arg[position];
				if (letter === "f") return undefined;
				if (letter !== "e") continue;
				scripts.push(position + 1 < arg.length ? arg.slice(position + 1) : args[++index] ?? "");
				break;
			}
		} else if (!arg.startsWith("-")) operands.push(arg);
	}
	if (scripts.length === 0 && operands[0] !== undefined) scripts.push(operands[0]);
	return scripts;
}

/** Whether one sed command writes a file or runs one: `w`, `W`, `e`, or an `s` with the w or e flag. */
function sedCommandWrites(command: string): boolean {
	// Past the address: line numbers, `$`, `/regex/` ranges, and `!`.
	const body = command.replace(/^\s*(?:(?:\d+|\$|\/(?:\\.|[^/])*\/)\s*(?:[,~]\s*(?:\d+|\$|\/(?:\\.|[^/])*\/))?\s*!?\s*)?/u, "");
	const verb = body[0];
	if (verb === "w" || verb === "W" || verb === "e") return true;
	if (verb !== "s" || body.length < 2) return false;
	const delimiter = body[1]!;
	let seen = 0;
	let index = 2;
	for (; index < body.length && seen < 2; index++) {
		if (body[index] === "\\") index++;
		else if (body[index] === delimiter) seen++;
	}
	return /^[^;}\s]*[we]/u.test(body.slice(index));
}

function sedWrites(args: readonly string[]): boolean {
	// An i before any e or f in a cluster is the in-place flag; after one it belongs to the script.
	const inPlace = (arg: string) => /^-[^-ef]*i/u.test(arg);
	if (args.some((arg) => arg === "--in-place" || arg.startsWith("--in-place=") || inPlace(arg))) return true;
	const scripts = sedScripts(args);
	if (!scripts) return true;
	return scripts.some((script) => script.split(/[;\n]/u).some(sedCommandWrites));
}

/** awk can print into files and pipes and run commands; a program it reads from a file cannot be checked. */
function awkWrites(args: readonly string[]): boolean {
	let program: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "-f" || arg.startsWith("--file")) return true;
		if (arg === "-v" || arg === "-F") index++;
		else if (!arg.startsWith("-")) {
			program = arg;
			break;
		}
	}
	return program === undefined || /system\s*\(|[|>]/u.test(program);
}

/** An option given alone or with its value attached: `--pager`, `--pager=less`. */
function hasOption(args: readonly string[], ...names: string[]): boolean {
	return args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
}

/**
 * Whether a command can change files or run another program, though the program it
 * names usually only reads: `find -delete`, `fd -x`, `rg --pre`, a pager it is told
 * to run, `sort -o`, an in-place or writing `sed`, an `awk` that prints to a file,
 * and `xargs` and `tee`, which exist to run and to write.
 */
export function writesOrRuns(words: readonly string[]): boolean {
	const [program, ...args] = words;
	switch (program) {
		case "git": {
			// `git grep -O` opens its matches in a pager it runs; an option before the subcommand can set one.
			const [sub, ...rest] = args;
			if (sub !== "grep") return sub?.startsWith("-") === true;
			return rest.some((arg) => /^-[^-]*O/u.test(arg)) || hasOption(rest, "--open-files-in-pager");
		}
		case "ag": case "ack": case "pt": case "bat": case "batcat":
			return hasOption(args, "--pager");
		case "xargs": case "tee":
			return true;
		case "find":
			return args.some((arg) => FIND_ACTIONS.has(arg));
		case "fd": case "fdfind":
			return args.some((arg) => arg === "-x" || arg === "-X" || /^--exec(?:-batch)?(?:=|$)/u.test(arg));
		case "rg":
			return hasOption(args, "--pre", "--hostname-bin");
		case "sort":
			return args.some((arg) => arg.startsWith("--output") || arg.startsWith("--compress-program") || shortFlag(arg, "o"));
		case "uniq":
			return operandCount(args) >= 2;
		case "tree":
			return args.some((arg) => arg === "-o" || arg.startsWith("--output"));
		case "sed":
			return sedWrites(args);
		case "awk": case "gawk": case "mawk": case "nawk":
			return awkWrites(args);
		default:
			return false;
	}
}
