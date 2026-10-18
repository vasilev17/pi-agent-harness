import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { languageFromPath } from "./compact-tools-language.ts";

type Fence = { char: string; length: number; language: string | undefined; start: number };

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/u;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/u;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/u;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const QUOTE = /^(\s{0,3}(?:>\s?)+)(.*)$/u;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+(?:\[[ xX]\]\s+)?)(.*)$/u;
const INLINE = /(`+)(.+?)\1|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(?=\S)(.+?)\*\*|__(?=\S)(.+?)__|\*(?=[^\s*])(.+?)\*|(?<!\w)_(?=[^\s_])(.+?)_(?!\w)/gu;

/** Resolve a fence info string such as `ts` or `typescript` to a highlighter language. */
function fenceLanguage(info: string): string | undefined {
	const name = info.toLowerCase();
	if (!name) return undefined;
	return languageFromPath(`fence.${name}`) ?? name;
}

function highlightInline(text: string, theme: Theme): string {
	const plain = (value: string) => value ? theme.fg("toolOutput", value) : "";
	const marker = (value: string) => theme.fg("dim", value);
	let output = "";
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		output += plain(text.slice(last, match.index));
		const [whole, ticks, code, label, url, strong, strongAlt, emphasis, emphasisAlt] = match;
		if (ticks !== undefined) {
			output += marker(ticks) + theme.fg("mdCode", code!) + marker(ticks);
		} else if (label !== undefined) {
			output += marker("[") + theme.fg("mdLink", label) + marker("](") + theme.fg("mdLinkUrl", url!) + marker(")");
		} else if (strong !== undefined || strongAlt !== undefined) {
			const delimiter = whole.slice(0, 2);
			output += marker(delimiter) + theme.bold(plain(strong ?? strongAlt!)) + marker(delimiter);
		} else {
			const delimiter = whole[0]!;
			output += marker(delimiter) + theme.italic(plain(emphasis ?? emphasisAlt!)) + marker(delimiter);
		}
		last = match.index + whole.length;
	}
	return output + plain(text.slice(last));
}

function highlightProse(line: string, theme: Theme): string {
	if (HEADING.test(line)) return theme.bold(theme.fg("mdHeading", line));
	if (RULE.test(line)) return theme.fg("mdHr", line);
	const quote = line.match(QUOTE);
	if (quote) return theme.fg("mdQuoteBorder", quote[1]!) + theme.italic(theme.fg("mdQuote", quote[2]!));
	const item = line.match(LIST_ITEM);
	if (item) return item[1]! + theme.fg("mdListBullet", item[2]! + item[3]!) + highlightInline(item[4]!, theme);
	return highlightInline(line, theme);
}

function highlightFenceBody(lines: string[], language: string | undefined, theme: Theme): string[] {
	if (lines.length === 0) return [];
	if (!language) return lines.map((line) => theme.fg("mdCodeBlock", line));
	return highlightCode(lines.join("\n"), language);
}

/**
 * Highlight Markdown source line by line: prose gets Markdown styling, fenced code is
 * highlighted as its declared language, and every character of the source stays visible.
 */
export function highlightMarkdown(lines: string[], theme: Theme): string[] {
	const output = new Array<string>(lines.length);
	let fence: Fence | undefined;
	const flush = (end: number) => {
		if (!fence) return;
		const body = highlightFenceBody(lines.slice(fence.start, end), fence.language, theme);
		body.forEach((line, offset) => {
			output[fence!.start + offset] = line;
		});
	};
	lines.forEach((line, index) => {
		if (fence) {
			const close = line.match(FENCE_CLOSE);
			if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
				flush(index);
				output[index] = theme.fg("mdCodeBlockBorder", line);
				fence = undefined;
			}
			return;
		}
		const open = line.match(FENCE_OPEN);
		if (open) {
			fence = { char: open[1]![0]!, length: open[1]!.length, language: fenceLanguage(open[2]!), start: index + 1 };
			output[index] = theme.fg("mdCodeBlockBorder", line);
			return;
		}
		output[index] = highlightProse(line, theme);
	});
	flush(lines.length);
	return output.map((line, index) => line ?? lines[index]!);
}
