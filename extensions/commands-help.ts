import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Row {
	command: string;
	args: string;
	what: string;
}

const SESSION: Row[] = [
	{ command: "/model", args: "<your available models>", what: "pick the model for this session" },
	{ command: "/effort", args: "off | minimal | low | medium | high | xhigh | max", what: "set level of thinking for the model" },
	{ command: "/fast", args: "on | off", what: "set fast or regular model response behaviour" },
	{ command: "/mode", args: "agent | ask | plan", what: "set session mode. /agent, /ask, and /plan can be used too" },
	{ command: "/context", args: "<available context sizes for model>", what: "pick session context window limit" },
	{
		command: "/toggle-animation",
		args: "Hotkey: Ctrl+Shift+H",
		what: "hide or show the ocean for this prompt. Next prompt shows it again",
	},
	{ command: "/footer", args: "on | off", what: "toggle rich footer status bar visibility" },
	{ command: "/header", args: "on | off", what: "toggle visibility of custom header art" },
	{ command: "/silent", args: "on | off | edits only | edits only (+ thinking)", what: "toggle visibility of tool calls and thinking blocks. edits only shows the end result and file creates, edits, deletes, and moves. edits only (+ thinking) also shows thinking blocks" },
];

const COMMAND_WIDTH = 20;
const ARGS_WIDTH = 24;

function wrap(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		const parts = word.length > width ? word.match(new RegExp(`.{1,${width}}`, "g")) ?? [word] : [word];
		for (const part of parts) {
			if (!line) {
				line = part;
				continue;
			}
			if (line.length + 1 + part.length <= width) line = `${line} ${part}`;
			else {
				lines.push(line);
				line = part;
			}
		}
	}
	if (line) lines.push(line);
	return lines;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function rule(left: string, mid: string, right: string, fill: string, whatWidth: number): string {
	return left + fill.repeat(COMMAND_WIDTH + 2) + mid + fill.repeat(ARGS_WIDTH + 2) + mid + fill.repeat(whatWidth + 2) + right;
}

function line(command: string, args: string, what: string, whatWidth: number): string {
	return `│ ${pad(command, COMMAND_WIDTH)} │ ${pad(args, ARGS_WIDTH)} │ ${pad(what, whatWidth)} │`;
}

function table(title: string, rows: Row[], whatWidth: number): string[] {
	const between = rule("├", "┼", "┤", "─", whatWidth);
	const body = rows.flatMap((row, index) => {
		const commands = wrap(row.command, COMMAND_WIDTH);
		const args = wrap(row.args, ARGS_WIDTH);
		const what = wrap(row.what, whatWidth);
		const count = Math.max(commands.length, args.length, what.length);
		const lines: string[] = [];
		for (let i = 0; i < count; i++) lines.push(line(commands[i] ?? "", args[i] ?? "", what[i] ?? "", whatWidth));
		return index === 0 ? lines : [between, ...lines];
	});
	return [
		title,
		rule("┌", "┬", "┐", "─", whatWidth),
		line("Command", "Args / Hotkey", "Description", whatWidth),
		between,
		...body,
		rule("└", "┴", "┘", "─", whatWidth),
	];
}

function helpText(): string {
	const columns = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
	const whatWidth = Math.max(24, Math.min(52, columns - 8 - COMMAND_WIDTH - ARGS_WIDTH - 10));
	return table("Legend of most used commands:", SESSION, whatWidth).join("\n");
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("commands-help", {
		description: "Show the legend of most used commands",
		handler: async (_args, ctx) => {
			ctx.ui.notify(helpText(), "info");
		},
	});
}
