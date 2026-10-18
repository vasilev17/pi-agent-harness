/**
 * Dropped files and `@` paths render as tags inside the prompt.
 *
 * The tag is real text (round caps + icon + path), so cursor width stays honest.
 * Submit expands each tag back to `@path`. A path inside the session folder
 * shows from that folder. Anything else keeps the full path.
 * A sent `@path` stays a tag in the transcript, shaded off the user bubble.
 * An image or video tag opens in the OS viewer.
 * An http(s) URL in the prompt uses the output link color, underlines while the pointer is on it, and opens on click.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	colorToRgb,
	Editor,
	foregroundAnsi,
	Markdown,
	mixColors,
	rgbColor,
	SelectList,
	TuiAltScreen,
	visibleWidth,
	type AutocompleteProvider,
	type Color,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";

const MARK = Symbol.for("val.pi.path-tags");
const LIST_ORIG = Symbol.for("val.pi.path-tags.list");
const MD_MARK = Symbol.for("val.pi.path-tags.md");

/** Sentinel row. Keeps the `@` menu open when the search matches nothing. */
export const AT_NO_MATCH = "\u0000@no-match";
const NO_MATCH_TEXT = "Search: No Matches";
const NO_MATCH_RED = `\x1b[38;5;196m${NO_MATCH_TEXT}\x1b[39m`;

/** nf-pl-left-hard-divider / nf-pl-right-hard-divider. Round ends of the tag. */
const LEFT = "\uE0B6";
const RIGHT = "\uE0B4";
/** nf-oct-file / nf-fa-folder. */
const FILE_ICON = "\uf15b";
const FOLDER_ICON = "\uf07b";
/** Blank between icon and path. A normal space is a wrap point, so a narrow prompt would leave the icon alone. */
const GAP = "\u2800";

const CAP = "\x1b[38;5;67m";
const FILL = "\x1b[48;5;67m\x1b[38;5;231m";
const OFF = "\x1b[39;49m";
/** Closes an OSC 8 hyperlink so the terminal does not keep a link open across the tag. */
const CLOSE_LINK = "\x1b]8;;\x07";
/** Word joiner. Width 0. Stops the terminal treating the path as a URL. */
const WJ = "\u2060";
const PASTE_MARKER = /^\[paste #\d+( (\+\d+ lines|\d+ chars))?\]$/;
const PUNCT = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
const ORIG = Symbol.for("val.pi.path-tags.orig");

const PILL = /\uE0B6([^\uE0B4]*)\uE0B4/g;
const TOKEN = /@"[^"]+"|@[^\s\uE0B6\uE0B4]+/g;

type Kind = "file" | "dir";

type EditorHost = Editor & {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	setCursorCol(col: number): void;
	onChange?: (text: string) => void;
	getText(): string;
};

let cwd = process.cwd();
let ctxRef: ExtensionContext | undefined;

const BLACK = rgbColor(0, 0, 0);
const WHITE = rgbColor(255, 255, 255);
/** How far a sent tag shifts off the user-message bubble. Dark themes go darker, light themes lighter. */
const TAG_SHADE = 0.45;
const SENTINEL = /\uE000([0-9a-f]+)\uE001/g;
const BOUNDARY = /[\s"'=({[<`]/;
const MEDIA = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic", "heif", "svg",
	"mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ogv", "m2ts",
]);

type ThemeLike = {
	appearance: "dark" | "light";
	colors: { userMessageBg: Color; userMessageText: Color };
	getBgAnsi(color: "userMessageBg"): string;
	getFgAnsi(color: "userMessageText"): string;
	getColorMode(): TerminalColorMode;
};

function kindOf(abs: string): Kind | null {
	try {
		return statSync(abs).isDirectory() ? "dir" : "file";
	} catch {
		return null;
	}
}

/** Path text inside the tag. Session-relative when the file lives in this session. */
export function displayOf(abs: string, root: string): string {
	const file = resolve(abs);
	const base = resolve(root);
	const rel = relative(base, file);
	if (rel === "") return basename(file);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.replace(/\\/g, "/");
	const fileKey = file.toLowerCase();
	const baseKey = base.toLowerCase();
	if (fileKey === baseKey) return basename(file);
	if (fileKey.startsWith(baseKey + "\\") || fileKey.startsWith(baseKey + "/")) {
		return file.slice(base.length + 1).replace(/\\/g, "/");
	}
	return file.replace(/\\/g, "/");
}

export function fileUrlToPath(input: string): string | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}
	if (url.protocol !== "file:") return null;
	let path = decodeURIComponent(url.pathname);
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	if (process.platform === "win32") path = path.replace(/\//g, "\\");
	return path;
}

function stripQuotes(text: string): string {
	if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
	if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
	return text;
}

/**
 * Absolute path spelling for Windows (`C:\`, `C:/`, `\\server`), Linux and macOS
 * (`/home`, `/Users`), or `~/`. Null for a relative string such as `asd/qwe`.
 * No stat. The caller checks that the file is really there.
 */
export function absolutePastePath(text: string): string | null {
	const bare = stripQuotes(text.trim());
	if (!bare) return null;
	if (/^[A-Za-z]:[\\/]/.test(bare) || bare.startsWith("\\\\") || (bare.startsWith("//") && bare.length > 2)) return bare;
	if (bare.startsWith("~/") || bare.startsWith("~\\")) return join(homedir(), bare.slice(2));
	if (bare.startsWith("/") && bare.length > 1) return bare;
	return null;
}

/** Absolute path that exists. A typed or relative string is not one. */
function existingAbs(text: string): string | null {
	const abs = absolutePastePath(text);
	if (!abs) return null;
	const root = abs === "/" || /^[A-Za-z]:[\\/]$/.test(abs);
	const trimmed = root ? abs : abs.replace(/[\\/]+$/, "");
	return kindOf(trimmed) ? trimmed : null;
}

function oneDrop(line: string): string[] | null {
	const text = line.trim();
	if (!text) return null;
	const ps = text.match(/^&\s+(['"])([\s\S]*)\1$/);
	if (ps) {
		const abs = existingAbs(ps[2]);
		return abs ? [abs] : null;
	}
	if (/^file:/i.test(text)) {
		const path = fileUrlToPath(stripQuotes(text));
		if (!path) return null;
		const abs = existingAbs(path);
		return abs ? [abs] : null;
	}
	if (text.includes('"') && text.includes(" ")) {
		const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		const rest = text.replace(/"[^"]*"/g, "").trim();
		if (quoted.length > 0 && !rest) {
			const abs = quoted.map((item) => existingAbs(item));
			if (abs.every((item) => item !== null)) return abs as string[];
		}
	}
	const abs = existingAbs(text);
	return abs ? [abs] : null;
}

/** A paste that is only dropped paths. Null when the paste is ordinary text. */
export function droppedPaths(text: string): string[] | null {
	const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (lines.length === 0) return null;
	const paths: string[] = [];
	for (const line of lines) {
		const found = oneDrop(line);
		if (!found) return null;
		paths.push(...found);
	}
	return paths;
}

export function pillForAbsolute(abs: string, root: string): string | null {
	const kind = kindOf(abs);
	if (!kind) return null;
	const icon = kind === "dir" ? FOLDER_ICON : FILE_ICON;
	return `${LEFT}${icon}${GAP}${displayOf(abs, root)}${RIGHT}`;
}

function resolveToken(token: string, root: string): { abs: string; folder: boolean } | null {
	let raw = token.startsWith("@") ? token.slice(1) : token;
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
	const folder = /[\\/]$/.test(raw);
	raw = raw.replace(/[\\/]+$/, "");
	if (!raw || raw === "." || raw === "..") return null;
	const abs = isAbsolute(raw) ? raw : resolve(root, raw);
	if (!kindOf(abs)) return null;
	return { abs, folder };
}

function tokenToPill(token: string, root: string): string | null {
	const found = resolveToken(token, root);
	if (!found) return null;
	const icon = kindOf(found.abs) === "dir" || found.folder ? FOLDER_ICON : FILE_ICON;
	return `${LEFT}${icon}${GAP}${displayOf(found.abs, root)}${RIGHT}`;
}

/** `@path` tokens that name a real file, in order. `@` inside a word is not one. */
export function tagPaths(markdown: string, root: string): string[] {
	const paths: string[] = [];
	if (!root || !markdown.includes("@")) return paths;
	markdown.replace(TOKEN, (token, offset) => {
		if (offset > 0 && !BOUNDARY.test(markdown[offset - 1] ?? "")) return token;
		const found = resolveToken(token, root);
		if (found) paths.push(found.abs);
		return token;
	});
	return paths;
}

/** Swap real `@path` tokens for a hex sentinel so markdown cannot eat `_` in the path. */
export function tagSentinels(markdown: string, root: string): string {
	if (!root || !markdown.includes("@")) return markdown;
	return markdown.replace(TOKEN, (token, offset) => {
		if (offset > 0 && !BOUNDARY.test(markdown[offset - 1] ?? "")) return token;
		const found = resolveToken(token, root);
		if (!found) return token;
		return `\uE000${Buffer.from(found.abs, "utf8").toString("hex")}\uE001`;
	});
}

function luma(color: Color): number {
	const rgb = colorToRgb(color);
	return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

/** Dark theme: darker than the bubble. Light theme: lighter. Already-extreme bubbles shift the other way so the tag still reads. */
export function tagFill(theme: ThemeLike): Color {
	const bg = theme.colors.userMessageBg;
	const light = theme.appearance === "light";
	const fill = mixColors(bg, light ? WHITE : BLACK, TAG_SHADE);
	if (Math.abs(luma(fill) - luma(bg)) >= 8) return fill;
	return mixColors(bg, light ? BLACK : WHITE, 0.16);
}

function transcriptPill(abs: string, theme: ThemeLike): string {
	const icon = kindOf(abs) === "dir" ? FOLDER_ICON : FILE_ICON;
	const label = displayOf(abs, cwd);
	const mode = theme.getColorMode();
	const fill = tagFill(theme);
	const cap = foregroundAnsi(fill, mode);
	const body = backgroundAnsi(fill, mode) + foregroundAnsi(theme.colors.userMessageText, mode);
	const restore = theme.getBgAnsi("userMessageBg") + theme.getFgAnsi("userMessageText");
	return `${cap}${LEFT}${body}${breakLink(icon + GAP + label)}${restore}${cap}${RIGHT}${restore}`;
}

function paintSentinels(text: string): string {
	if (!text.includes("\uE000")) return text;
	const theme = ctxRef?.ui.theme as ThemeLike | undefined;
	return text.replace(SENTINEL, (_match, hex: string) => {
		const abs = Buffer.from(hex, "hex").toString("utf8");
		if (!theme) return `@${displayOf(abs, cwd)}`;
		return transcriptPill(abs, theme);
	});
}

export function isMediaPath(file: string): boolean {
	const base = basename(file).toLowerCase();
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false;
	return MEDIA.has(base.slice(dot + 1));
}

/** OS default app. `start`'s first quoted arg is the window title, so it stays empty. */
export function openCommand(file: string, platform = process.platform): { command: string; args: string[] } {
	if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "start", "", file] };
	if (platform === "darwin") return { command: "open", args: [file] };
	return { command: "xdg-open", args: [file] };
}

function launchMedia(file: string): void {
	const spec = openCommand(file);
	try {
		const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no opener
	}
}

let launchMediaImpl = launchMedia;

export function setMediaLauncher(fn: ((file: string) => void) | null): void {
	launchMediaImpl = fn ?? launchMedia;
}

function openIfMedia(abs: string): boolean {
	if (kindOf(abs) !== "file" || !isMediaPath(abs)) return false;
	launchMediaImpl(abs);
	return true;
}

/** Same launcher as pi's link click. No shell, so the URL is not re-parsed. */
function openLink(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no opener
	}
}

/** Turn finished `@path` tokens into tags. An open `@dir/` stays text so typing can continue. */
export function chipifyFinished(text: string, root: string): string {
	if (!root || !text.includes("@")) return text;
	return text.replace(TOKEN, (token, offset) => {
		const next = text[offset + token.length] ?? "";
		if (/[\\/]$/.test(token) && !/\s/.test(next)) return token;
		return tokenToPill(token, root) ?? token;
	});
}

export function expandPills(text: string): string {
	return text.replace(PILL, (pill, body: string) => {
		const gap = body[1];
		const path = (body.startsWith(FILE_ICON) || body.startsWith(FOLDER_ICON)) && (gap === GAP || gap === " ") ? body.slice(2) : body;
		if (!path) return pill;
		return /\s/.test(path) ? `@"${path}"` : `@${path}`;
	});
}

function ansiLength(text: string, i: number): number {
	if (text[i] !== "\x1b") return 0;
	const next = text[i + 1];
	if (next === "[") {
		let j = i + 2;
		while (j < text.length && text.charCodeAt(j) < 0x40) j += 1;
		return j < text.length ? j - i + 1 : 0;
	}
	if (next === "]" || next === "_" || next === "P" || next === "X" || next === "^") {
		const bel = text.indexOf("\x07", i + 2);
		const st = text.indexOf("\x1b\\", i + 2);
		const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
		if (end === -1) return 0;
		return (text.startsWith("\x1b\\", end) ? end + 2 : end + 1) - i;
	}
	return 0;
}

/** Break the path into non-link text without changing how it looks. */
function breakLink(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\x1b") {
			const len = ansiLength(text, i);
			if (len > 0) {
				out += text.slice(i, i + len);
				i += len - 1;
				continue;
			}
		}
		out += text[i] + WJ;
	}
	return out;
}

function paintClosed(pill: string): string {
	const mid = pill.slice(LEFT.length, pill.length - RIGHT.length);
	return `${CLOSE_LINK}${CAP}${LEFT}${OFF}${FILL}${breakLink(mid)}${OFF}${CAP}${RIGHT}${OFF}${CLOSE_LINK}`;
}

export function paintTags(line: string): string {
	if (!line.includes(LEFT)) return line;
	return line.replace(PILL, paintClosed);
}

function paintOpen(slice: string): string {
	const mid = slice.slice(LEFT.length);
	return `${CLOSE_LINK}${CAP}${LEFT}${OFF}${FILL}${breakLink(mid)}${OFF}${CLOSE_LINK}`;
}

function paintMiddle(slice: string): string {
	return `${CLOSE_LINK}${FILL}${breakLink(slice)}${OFF}${CLOSE_LINK}`;
}

function paintClose(slice: string): string {
	const mid = slice.slice(0, slice.length - RIGHT.length);
	return `${CLOSE_LINK}${FILL}${breakLink(mid)}${OFF}${CAP}${RIGHT}${OFF}${CLOSE_LINK}`;
}

function enclosingPill(line: string, index: number): { start: number; end: number } | null {
	let from = 0;
	while (from < line.length) {
		const left = line.indexOf(LEFT, from);
		if (left < 0 || left > index) return null;
		const right = line.indexOf(RIGHT, left + LEFT.length);
		if (right < 0) return null;
		const end = right + RIGHT.length;
		if (index >= left && index < end) return { start: left, end };
		from = end;
	}
	return null;
}

function splitEdgeAnsi(text: string): { lead: string; body: string; trail: string } {
	let leadEnd = 0;
	while (leadEnd < text.length && text[leadEnd] === "\x1b") {
		const len = ansiLength(text, leadEnd);
		if (len <= 0) break;
		leadEnd += len;
	}
	let cut = leadEnd;
	for (let i = leadEnd; i < text.length; i += 1) {
		if (text[i] === "\x1b") {
			const len = ansiLength(text, i);
			if (len > 0) {
				i += len - 1;
				continue;
			}
		}
		cut = i + 1;
	}
	const trail = cut < text.length && text[cut] === "\x1b" ? text.slice(cut) : "";
	return { lead: text.slice(0, leadEnd), body: text.slice(leadEnd, text.length - trail.length), trail };
}

function paintBody(body: string, startsInside: boolean): string {
	let out = "";
	let i = 0;
	let inside = startsInside;
	while (i < body.length) {
		if (!inside) {
			const left = body.indexOf(LEFT, i);
			if (left < 0) {
				out += body.slice(i);
				break;
			}
			out += body.slice(i, left);
			const right = body.indexOf(RIGHT, left + LEFT.length);
			if (right < 0) {
				out += paintOpen(body.slice(left));
				break;
			}
			out += paintClosed(body.slice(left, right + RIGHT.length));
			i = right + RIGHT.length;
			continue;
		}
		const right = body.indexOf(RIGHT, i);
		if (right < 0) {
			out += paintMiddle(body.slice(i));
			break;
		}
		out += paintClose(body.slice(i, right + RIGHT.length));
		i = right + RIGHT.length;
		inside = false;
	}
	return out;
}

/**
 * A tag wider than the prompt is split across visual lines. Each piece keeps
 * the fill. The first piece keeps the left cap. The last piece keeps the right cap.
 * No extra cap is added, so the line stays the same width.
 */
export function paintChunkLine(line: string, logical: string, chunkStart: number, paddingX: number): string {
	const pill = enclosingPill(logical, chunkStart);
	const startsInside = pill !== null && pill.start < chunkStart && chunkStart < pill.end;
	const first = line.indexOf("│");
	const last = line.lastIndexOf("│");
	const framed = first !== -1 && last > first;
	const content = framed ? line.slice(first + 1, last) : line;
	const { lead, body, trail } = splitEdgeAnsi(content);
	let pad = 0;
	while (pad < paddingX && pad < body.length && body[pad] === " ") pad += 1;
	const painted = lead + body.slice(0, pad) + paintBody(body.slice(pad), startsInside) + trail;
	if (!framed) return painted;
	return line.slice(0, first + 1) + painted + line.slice(last);
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gu;
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

type UrlSpan = { start: number; end: number; url: string };
type LinkHover = { editor: EditorHost; line: number; start: number; end: number; url: string };

let linkHover: LinkHover | null = null;
let linkHoverClaimed = false;

function trimUrlTail(raw: string): string {
	let end = raw.length;
	while (end > "https://".length) {
		const ch = raw[end - 1] ?? "";
		if (".,;:!?".includes(ch)) {
			end -= 1;
			continue;
		}
		if (ch === ")" && countChar(raw, ")", end) > countChar(raw, "(", end)) {
			end -= 1;
			continue;
		}
		break;
	}
	return raw.slice(0, end);
}

function countChar(text: string, ch: string, end: number): number {
	let n = 0;
	for (let i = 0; i < end; i += 1) if (text[i] === ch) n += 1;
	return n;
}

/** Raw http(s) URLs in prompt text. Trailing punctuation stays outside the link. */
export function urlSpans(text: string): UrlSpan[] {
	const spans: UrlSpan[] = [];
	for (const match of text.matchAll(URL_RE)) {
		const raw = match[0];
		const index = match.index ?? 0;
		const url = trimUrlTail(raw);
		if (!/^https?:\/\/./.test(url)) continue;
		spans.push({ start: index, end: index + url.length, url });
	}
	return spans;
}

function spanAt(spans: UrlSpan[], index: number): UrlSpan | null {
	for (const span of spans) {
		if (index >= span.start && index < span.end) return span;
	}
	return null;
}

/** Opening and closing sequences for `mdLink`, the same color output links use. */
function linkStyle(): { open: string; close: string } {
	try {
		const marked = getMarkdownTheme().link("\u0001");
		const at = marked.indexOf("\u0001");
		if (at < 0) return { open: "", close: "" };
		return { open: marked.slice(0, at), close: marked.slice(at + 1) };
	} catch {
		return { open: "", close: "" };
	}
}

/**
 * Color a URL in one visual row and underline it while hovered.
 * The stored prompt text stays the raw URL. Click handling opens it.
 */
export function paintPromptLinks(
	line: string,
	logical: string,
	chunkStart: number,
	chunkLen: number,
	paddingX: number,
	logicalLine: number,
	hover: { line: number; start: number; end: number } | null,
): string {
	const chunkEnd = chunkStart + chunkLen;
	const spans = urlSpans(logical).filter(
		(span) => span.end > chunkStart && span.start < chunkEnd && enclosingPill(logical, span.start) === null,
	);
	if (spans.length === 0) return line;
	const first = line.indexOf("│");
	const last = line.lastIndexOf("│");
	const framed = first !== -1 && last > first;
	const content = framed ? line.slice(first + 1, last) : line;
	const { lead, body, trail } = splitEdgeAnsi(content);
	let pad = 0;
	while (pad < paddingX && pad < body.length && body[pad] === " ") pad += 1;
	const painted =
		lead +
		body.slice(0, pad) +
		paintLinkedBody(body.slice(pad), logical.slice(chunkStart, chunkEnd), chunkStart, spans, logicalLine, hover) +
		trail;
	if (!framed) return painted;
	return line.slice(0, first + 1) + painted + line.slice(last);
}

function paintLinkedBody(
	body: string,
	expected: string,
	base: number,
	spans: UrlSpan[],
	logicalLine: number,
	hover: { line: number; start: number; end: number } | null,
): string {
	const style = linkStyle();
	let out = "";
	let i = 0;
	let exp = 0;
	let active: UrlSpan | null = null;
	const hovered = (span: UrlSpan) => hover?.line === logicalLine && hover.start === span.start && hover.end === span.end;
	const close = () => {
		if (!active) return;
		if (hovered(active)) out += UNDERLINE_OFF;
		out += style.close;
		active = null;
	};
	const open = (span: UrlSpan) => {
		active = span;
		out += style.open;
		if (hovered(span)) out += UNDERLINE_ON;
	};
	while (i < body.length && exp < expected.length) {
		if (body[i] === "\x1b") {
			const len = ansiLength(body, i);
			if (len > 0) {
				out += body.slice(i, i + len);
				i += len;
				continue;
			}
		}
		const cp = body.codePointAt(i);
		const want = expected.codePointAt(exp);
		if (cp === undefined || want === undefined) break;
		const ch = String.fromCodePoint(cp);
		const wantCh = String.fromCodePoint(want);
		if (ch !== wantCh) {
			if (visibleWidth(ch) === 0) {
				out += ch;
				i += ch.length;
				continue;
			}
			break;
		}
		const next = spanAt(spans, base + exp);
		if (next !== active) {
			close();
			if (next) open(next);
		}
		out += ch;
		i += ch.length;
		exp += wantCh.length;
	}
	close();
	return out + body.slice(i);
}

/**
 * Selection paint is inverse video. Inverse on a tag turns the blue pill white.
 * Drop inverse for the cells between the tag caps and keep it on the text around them.
 */
function clearsBackground(code: string): boolean {
	if (!code.startsWith("\x1b[") || !code.endsWith("m")) return false;
	const params = code.slice(2, -1).split(";");
	for (let i = 0; i < params.length; i += 1) {
		const param = params[i];
		if (param === "0" || param === "49") return true;
	}
	return false;
}

export function plainTagsInSelection(line: string): string {
	if (!line.includes("\x1b[7m")) return line;
	if (!line.includes(LEFT) && !line.includes(RIGHT) && !line.includes("48;5;67")) return line;
	let out = "";
	let inPill = false;
	let inFill = false;
	let inverse = false;
	for (let i = 0; i < line.length; i += 1) {
		if (line[i] === "\x1b") {
			const len = ansiLength(line, i);
			if (len > 0) {
				const code = line.slice(i, i + len);
				if (code === "\x1b[7m") {
					inverse = true;
					if (!inPill && !inFill) out += code;
				} else if (code === "\x1b[27m") {
					inverse = false;
					if (!inPill && !inFill) out += code;
				} else {
					if (!inPill && !inFill && code.includes("48;5;67")) {
						inFill = true;
						if (inverse) out += "\x1b[27m";
					}
					out += code;
					if (inFill && !inPill && clearsBackground(code)) {
						inFill = false;
						if (inverse) out += "\x1b[7m";
					}
				}
				i += len - 1;
				continue;
			}
		}
		const ch = line[i] ?? "";
		if (ch === LEFT) {
			inPill = true;
			if (inverse) out += "\x1b[27m";
		} else if (ch === RIGHT && !inPill && inverse) {
			out += "\x1b[27m";
		}
		out += ch;
		if (ch === RIGHT) {
			inPill = false;
			if (inverse) out += "\x1b[7m";
		}
	}
	return out;
}

function chipifyUpTo(line: string, cursorCol: number, root: string): { line: string; cursorCol: number } {
	const before = line.slice(0, cursorCol);
	const nextBefore = chipifyFinished(before, root);
	if (nextBefore === before) return { line, cursorCol };
	return { line: nextBefore + line.slice(cursorCol), cursorCol: nextBefore.length };
}

function chipifyHost(editor: EditorHost): void {
	const line = editor.state.lines[editor.state.cursorLine] ?? "";
	const next = chipifyUpTo(line, editor.state.cursorCol, cwd);
	if (next.line === line) return;
	editor.state.lines[editor.state.cursorLine] = next.line;
	editor.setCursorCol(next.cursorCol);
	editor.onChange?.(editor.getText());
}

function mergePills(text: string, segments: Iterable<{ segment: string; index: number; input: string }>) {
	if (!text.includes(LEFT)) return segments;
	const list = [...segments];
	const merged = [];
	for (let i = 0; i < list.length; i += 1) {
		const seg = list[i];
		if (!seg || seg.index < 0 || text[seg.index] !== LEFT) {
			if (seg) merged.push(seg);
			continue;
		}
		const end = text.indexOf(RIGHT, seg.index + LEFT.length);
		if (end === -1) {
			merged.push(seg);
			continue;
		}
		const markerEnd = end + RIGHT.length;
		merged.push({ segment: text.slice(seg.index, markerEnd), index: seg.index, input: text });
		while (i + 1 < list.length && list[i + 1]!.index < markerEnd) i += 1;
	}
	return merged;
}

type WordSeg = { segment: string; index: number; input: string; isWordLike?: boolean };

function isPill(segment: string): boolean {
	return segment.startsWith(LEFT) && segment.endsWith(RIGHT) && segment.length > LEFT.length + RIGHT.length;
}

function isAtomic(segment: string): boolean {
	return isPill(segment) || PASTE_MARKER.test(segment);
}

/**
 * One step of Alt+Backspace. A tag is one unit. The space inside a tag must
 * not count as a gap, or every tag and the word before them go together.
 */
export function wordBackIndex(prefix: string, segments: WordSeg[]): number {
	let cursor = prefix.length;
	const list = [...segments];
	while (list.length > 0 && !isAtomic(list[list.length - 1]!.segment) && /\s/.test(list[list.length - 1]!.segment)) {
		cursor -= list.pop()!.segment.length;
	}
	if (list.length === 0) return cursor;
	const last = list[list.length - 1]!;
	if (isAtomic(last.segment)) {
		cursor -= last.segment.length;
	} else if (last.isWordLike) {
		const matches = [...last.segment.matchAll(new RegExp(PUNCT, "g"))];
		if (matches.length === 0) cursor -= last.segment.length;
		else {
			const hit = matches[matches.length - 1]!;
			cursor -= last.segment.length - ((hit.index ?? 0) + hit[0].length);
		}
	} else {
		while (
			list.length > 0 &&
			!isAtomic(list[list.length - 1]!.segment) &&
			!list[list.length - 1]!.isWordLike &&
			!/\s/.test(list[list.length - 1]!.segment)
		) {
			cursor -= list.pop()!.segment.length;
		}
	}
	return cursor;
}

export function wordForwardIndex(cursor: number, segments: WordSeg[]): number {
	let index = 0;
	let pos = cursor;
	while (index < segments.length && !isAtomic(segments[index]!.segment) && /\s/.test(segments[index]!.segment)) {
		pos += segments[index]!.segment.length;
		index += 1;
	}
	if (index >= segments.length) return pos;
	const next = segments[index]!;
	if (isAtomic(next.segment)) {
		pos += next.segment.length;
	} else if (next.isWordLike) {
		pos += PUNCT.exec(next.segment)?.index ?? next.segment.length;
	} else {
		while (index < segments.length && !isAtomic(segments[index]!.segment) && !segments[index]!.isWordLike && !/\s/.test(segments[index]!.segment)) {
			pos += segments[index]!.segment.length;
			index += 1;
		}
	}
	return pos;
}

type Orig = {
	segment: (text: string, mode: string) => Iterable<WordSeg>;
	render: (width: number) => string[];
	handlePaste: (text: string) => void;
	handleMouse: (event: PointerEvent) => { handled?: boolean; focus?: boolean; render?: boolean } | undefined;
	insertCharacter: (ch: string) => void;
	insertTextAtCursor: (text: string) => void;
	expandPasteMarkers: (text: string) => string;
	setText: (text: string) => void;
};

type PointerEvent = { type: string; x: number; y: number; width: number; button?: string; clickCount?: number };

type HitHost = EditorHost & {
	paddingX: number;
	scrollOffset: number;
	renderedVisibleLineCount: number;
	lastWidth: number;
	buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }>;
	segment(text: string, mode: string): Iterable<{ segment: string; index: number }>;
};

function pathInPill(logical: string, index: number): string | null {
	const pill = enclosingPill(logical, index);
	if (!pill) return null;
	const body = logical.slice(pill.start + LEFT.length, pill.end - RIGHT.length);
	const gap = body[1];
	const path = (body.startsWith(FILE_ICON) || body.startsWith(FOLDER_ICON)) && (gap === GAP || gap === " ") ? body.slice(2) : body;
	return path || null;
}

function tagDisplayAt(editor: HitHost, event: PointerEvent): string | null {
	if (event.y <= 0 || event.y > editor.renderedVisibleLineCount) return null;
	const frame = event.width >= 2 ? 1 : 0;
	const innerWidth = Math.max(1, event.width - frame * 2);
	const paddingX = Math.min(editor.paddingX, Math.max(0, Math.floor((innerWidth - 1) / 2)));
	const targetColumn = Math.max(0, event.x - frame - paddingX);
	const visualLine = editor.buildVisualLineMap(editor.lastWidth)[editor.scrollOffset + event.y - 1];
	if (!visualLine) return null;
	const logical = editor.state.lines[visualLine.logicalLine] ?? "";
	const chunk = logical.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
	let pos = 0;
	let col = 0;
	for (const grapheme of editor.segment(chunk, "grapheme")) {
		const next = col + visibleWidth(grapheme.segment);
		if (targetColumn < next) return pathInPill(logical, visualLine.startCol + pos);
		pos += grapheme.segment.length;
		col = next;
	}
	const end = visualLine.startCol + visualLine.length;
	if (targetColumn >= col && end > visualLine.startCol) {
		const pill = enclosingPill(logical, end - 1);
		if (pill && pill.end > end) return pathInPill(logical, end - 1);
	}
	return null;
}

/** True when the pointer is on a tag. A press there must not start text selection. */
export function pointerOnTag(editor: HitHost, event: PointerEvent): boolean {
	if (event.y <= 0 || event.y > editor.renderedVisibleLineCount) return false;
	const frame = event.width >= 2 ? 1 : 0;
	const innerWidth = Math.max(1, event.width - frame * 2);
	const paddingX = Math.min(editor.paddingX, Math.max(0, Math.floor((innerWidth - 1) / 2)));
	const targetColumn = Math.max(0, event.x - frame - paddingX);
	const visualLine = editor.buildVisualLineMap(editor.lastWidth)[editor.scrollOffset + event.y - 1];
	if (!visualLine) return false;
	const logical = editor.state.lines[visualLine.logicalLine] ?? "";
	const chunk = logical.slice(visualLine.startCol, visualLine.startCol + visualLine.length);
	let pos = 0;
	let col = 0;
	for (const grapheme of editor.segment(chunk, "grapheme")) {
		const next = col + visibleWidth(grapheme.segment);
		if (targetColumn < next) return isPill(grapheme.segment) || enclosingPill(logical, visualLine.startCol + pos) !== null;
		pos += grapheme.segment.length;
		col = next;
	}
	const end = visualLine.startCol + visualLine.length;
	const pill = end > visualLine.startCol ? enclosingPill(logical, end - 1) : null;
	return targetColumn >= col && pill !== null && pill.end > end;
}

type MoveHost = EditorHost & {
	lastAction: string | null;
	segment(text: string, mode: string): Iterable<WordSeg>;
};

type MenuHost = EditorHost & {
	autocompleteState: string | null;
	autocompleteDebounceTimer?: unknown;
	autocompleteAbort?: unknown;
	tryTriggerAutocomplete(explicitTab?: boolean): void;
	updateAutocomplete(): void;
};

const SYNCED = Symbol.for("val.pi.path-tags.synced");

/**
 * Pi re-asks for suggestions from typing, backspace and the arrow keys only. Every
 * other move of the cursor (word jump, Home/End, mouse, Alt+Backspace) leaves the
 * `@` menu open on a stale query, or shut when the cursor is back on a live `@`
 * token. One check per render keeps the menu in step with the cursor. A request Pi
 * already has in flight is left alone, so typing keeps its own debounce.
 */
function syncAtMenu(editor: MenuHost): void {
	const host = editor as MenuHost & { [SYNCED]?: string };
	const key = `${editor.state.cursorLine}:${editor.state.cursorCol}:${editor.getText()}`;
	if (host[SYNCED] === key) return;
	if (editor.autocompleteDebounceTimer !== undefined || editor.autocompleteAbort !== undefined) return;
	host[SYNCED] = key;
	if (editor.autocompleteState) {
		editor.updateAutocomplete();
		return;
	}
	const line = editor.state.lines[editor.state.cursorLine] ?? "";
	if (openAtToken(line.slice(0, editor.state.cursorCol)) !== null) editor.tryTriggerAutocomplete();
}

/** Tags for a paste that is only existing absolute paths, with a trailing space. Null otherwise. */
function pastedPills(text: string): string | null {
	const paths = droppedPaths(text);
	if (!paths) return null;
	return `${paths.map((path) => pillForAbsolute(path, cwd) ?? path).join(" ")} `;
}

function urlUnderPointer(editor: HitHost, event: PointerEvent): UrlSpan & { line: number } | null {
	if (event.y <= 0 || event.y > editor.renderedVisibleLineCount) return null;
	const frame = event.width >= 2 ? 1 : 0;
	const innerWidth = Math.max(1, event.width - frame * 2);
	const maxPadding = Math.max(0, Math.floor((innerWidth - 1) / 2));
	const paddingX = Math.min(editor.paddingX, maxPadding);
	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const visual = visualLines[editor.scrollOffset + event.y - 1];
	if (!visual) return null;
	const logical = editor.state.lines[visual.logicalLine] ?? "";
	const chunk = logical.slice(visual.startCol, visual.startCol + visual.length);
	const targetColumn = Math.max(0, event.x - frame - paddingX);
	let visibleColumn = 0;
	let targetIndex = chunk.length;
	for (const grapheme of editor.segment(chunk, "grapheme")) {
		const nextColumn = visibleColumn + visibleWidth(grapheme.segment);
		if (targetColumn < nextColumn) {
			targetIndex = grapheme.index;
			break;
		}
		visibleColumn = nextColumn;
	}
	if (targetIndex >= chunk.length) return null;
	const index = visual.startCol + targetIndex;
	const span = spanAt(urlSpans(logical), index);
	if (!span || enclosingPill(logical, span.start)) return null;
	return { ...span, line: visual.logicalLine };
}

function installEditorPatches(): void {
	const proto = Editor.prototype as unknown as Orig & { [ORIG]?: Orig } & MoveHost;
	if (!proto[ORIG]) {
		proto[ORIG] = {
			segment: proto.segment,
			render: proto.render,
			handlePaste: proto.handlePaste,
			handleMouse: proto.handleMouse,
			insertCharacter: proto.insertCharacter,
			insertTextAtCursor: proto.insertTextAtCursor,
			expandPasteMarkers: proto.expandPasteMarkers,
			setText: proto.setText,
		};
	}
	const orig = proto[ORIG];
	// Originals saved by an earlier version of this file, still alive after /reload: fill in what it
	// did not save, and put back handleInput, which it patched and this version no longer does.
	if (!orig.handleMouse) orig.handleMouse = proto.handleMouse;
	if (!orig.insertTextAtCursor) orig.insertTextAtCursor = proto.insertTextAtCursor;
	const stale = orig as Orig & { handleInput?: (data: string) => void };
	if (stale.handleInput) {
		(proto as unknown as { handleInput: (data: string) => void }).handleInput = stale.handleInput;
		delete stale.handleInput;
	}

	proto.segment = function (this: unknown, text: string, mode: string) {
		return mergePills(text, orig.segment.call(this, text, mode));
	};

	proto.render = function (this: HitHost, width: number) {
		syncAtMenu(this as unknown as MenuHost);
		const lines = orig.render.call(this, width);
		const frame = width >= 2 ? 1 : 0;
		const innerWidth = Math.max(1, width - frame * 2);
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((innerWidth - 1) / 2)));
		const map = this.buildVisualLineMap(this.lastWidth);
		const count = this.renderedVisibleLineCount;
		return lines.map((line, index) => {
			const slot = index - 1;
			if (slot < 0 || slot >= count) return line;
			const visual = map[this.scrollOffset + slot];
			if (!visual) return line;
			const logical = this.state.lines[visual.logicalLine] ?? "";
			const painted = paintChunkLine(line, logical, visual.startCol, paddingX);
			const hover = linkHover?.editor === this ? linkHover : null;
			return paintPromptLinks(painted, logical, visual.startCol, visual.length, paddingX, visual.logicalLine, hover);
		});
	};

	proto.expandPasteMarkers = function (this: unknown, text: string) {
		return expandPills(orig.expandPasteMarkers.call(this, text));
	};

	proto.setText = function (this: unknown, text: string) {
		orig.setText.call(this, chipifyFinished(text, cwd));
	};

	proto.insertCharacter = function (this: EditorHost, ch: string) {
		orig.insertCharacter.call(this, ch);
		if (ch === " ") chipifyHost(this);
	};

	/** Pi's Alt+V clipboard paste (copied files, saved clipboard image, plain text) lands here, not in `handlePaste`. */
	proto.insertTextAtCursor = function (this: EditorHost, text: string) {
		const lead = /^\s*/.exec(text)?.[0] ?? "";
		const body = text.slice(lead.length).trimEnd();
		const pills = body ? pastedPills(body) : null;
		orig.insertTextAtCursor.call(this, pills ? lead + pills : text);
	};

	proto.handleMouse = function (this: HitHost, event: PointerEvent) {
		linkHoverClaimed = true;
		if (event.type === "move") {
			const next = urlUnderPointer(this, event);
			const prev = linkHover?.editor === this ? linkHover : null;
			const same =
				(next === null && prev === null) ||
				(next !== null &&
					prev !== null &&
					prev.line === next.line &&
					prev.start === next.start &&
					prev.end === next.end);
			if (!same) {
				linkHover = next ? { editor: this, ...next } : null;
				return { handled: true, render: true };
			}
			return { handled: true };
		}
		const clicked = event.type === "click" && (event.button === "left" || event.button === undefined) && (event.clickCount ?? 1) === 1;
		if (clicked) {
			const hit = urlUnderPointer(this, event);
			if (hit && (event.clickCount ?? 1) === 1) {
				openLink(hit.url);
				return { handled: true, focus: true };
			}
		}
		if (clicked) {
			const display = tagDisplayAt(this, event);
			if (display) {
				const abs = isAbsolute(display) ? display : resolve(cwd, display);
				if (openIfMedia(abs)) return { handled: true, focus: true };
			}
		}
		if (event.type === "press" && (event.button === "left" || event.button === undefined) && pointerOnTag(this, event)) {
			return { handled: true, focus: true };
		}
		return orig.handleMouse.call(this, event);
	};

	proto.handlePaste = function (this: EditorHost, text: string) {
		const pills = pastedPills(text);
		if (!pills) {
			orig.handlePaste.call(this, text);
			return;
		}
		orig.handlePaste.call(this, pills);
	};

	proto.moveWordBackwards = function (this: MoveHost) {
		this.lastAction = null;
		const line = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine -= 1;
				this.setCursorCol((this.state.lines[this.state.cursorLine] || "").length);
			}
			return;
		}
		const prefix = line.slice(0, this.state.cursorCol);
		this.setCursorCol(wordBackIndex(prefix, [...this.segment(prefix, "word")]));
	};

	proto.moveWordForwards = function (this: MoveHost) {
		this.lastAction = null;
		const line = this.state.lines[this.state.cursorLine] || "";
		if (this.state.cursorCol >= line.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine += 1;
				this.setCursorCol(0);
			}
			return;
		}
		const rest = line.slice(this.state.cursorCol);
		this.setCursorCol(wordForwardIndex(this.state.cursorCol, [...this.segment(rest, "word")]));
	};
}

/** An `@` token the text ends inside. A quoted token holds spaces, so it only ends at the closing quote. */
const OPEN_AT = /(?:^|[\s"'=({[<`])(@"[^"]*"?|@[^\s"'=]*)$/u;

/** The `@` token the cursor sits in. Null once a space closed it, or when `@` is inside a word. */
export function openAtToken(text: string): string | null {
	return OPEN_AT.exec(text)?.[1] ?? null;
}

/** `@` or `@text` then whitespace. A real path is already a tag, so the query is over. */
export function atTokenClosedBySpace(text: string): boolean {
	if (!/\s$/u.test(text)) return false;
	if (openAtToken(text) !== null) return false;
	return openAtToken(text.replace(/\s+$/u, "")) !== null;
}

function legacyFileMenu(result: { prefix?: string; items?: unknown[] } | null): boolean {
	if (!result?.items?.length) return false;
	const prefix = result.prefix ?? "";
	return !prefix.startsWith("@") && !prefix.startsWith("/") && !prefix.startsWith("#");
}

function wrap(current: AutocompleteProvider): AutocompleteProvider {
	if (MARK in current) return current;
	let atMenu = false;
	const wrapped: AutocompleteProvider = {
		triggerCharacters: current.triggerCharacters,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (item.value === AT_NO_MATCH) return { lines, cursorLine, cursorCol };
			const result = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = result.lines[result.cursorLine] ?? "";
			const next = chipifyUpTo(line, result.cursorCol, cwd);
			if (next.line === line) return result;
			const copy = result.lines.slice();
			copy[result.cursorLine] = next.line;
			return { ...result, lines: copy, cursorCol: next.cursorCol };
		},
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const text = (lines[cursorLine] || "").slice(0, cursorCol);
			const force = options?.force === true;
			const token = openAtToken(text);
			if (!force && atTokenClosedBySpace(text)) {
				atMenu = false;
				return null;
			}
			const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (options.signal?.aborted) return null;
			const prefix = result?.prefix ?? "";
			if (prefix.startsWith("@") && (result?.items?.length ?? 0) > 0 && result.items[0]?.value !== AT_NO_MATCH) {
				atMenu = true;
				return result;
			}
			if (!force && token) {
				atMenu = true;
				return { items: [{ value: AT_NO_MATCH, label: NO_MATCH_TEXT }], prefix: token };
			}
			// The `@` menu just closed. Pi's plain path menu for the same text waits for an explicit Tab.
			if (atMenu && !force && legacyFileMenu(result)) {
				atMenu = false;
				return null;
			}
			atMenu = false;
			return result;
		},
	};
	Object.defineProperty(wrapped, MARK, { value: true });
	return wrapped;
}

type ListItem = { value?: string };

type ListHost = {
	filteredItems: ListItem[];
	render(width: number): string[];
	getSelectedItem(): ListItem | null;
	handleMouse(event: unknown): unknown;
	handleInput(data: string): void;
};

function isNoMatchList(list: { filteredItems?: ListItem[] }): boolean {
	const items = list.filteredItems ?? [];
	return items.length === 1 && items[0]?.value === AT_NO_MATCH;
}

/** One centered row, same slot as the file menu, with nothing to select. */
function noMatchLines(width: number): string[] {
	const pad = Math.max(0, Math.floor((Math.max(0, width) - NO_MATCH_TEXT.length) / 2));
	return [`${" ".repeat(pad)}${NO_MATCH_RED}`];
}

function installListPatches(): void {
	const proto = SelectList.prototype as unknown as ListHost & { [LIST_ORIG]?: ListHost };
	if (!proto[LIST_ORIG]) {
		proto[LIST_ORIG] = {
			render: proto.render,
			getSelectedItem: proto.getSelectedItem,
			handleMouse: proto.handleMouse,
			handleInput: proto.handleInput,
		};
	}
	const orig = proto[LIST_ORIG];
	proto.render = function (this: ListHost, width: number) {
		if (isNoMatchList(this)) return noMatchLines(width);
		return orig.render.call(this, width);
	};
	proto.getSelectedItem = function (this: ListHost) {
		if (isNoMatchList(this)) return null;
		return orig.getSelectedItem.call(this);
	};
	proto.handleMouse = function (this: ListHost, event: unknown) {
		if (isNoMatchList(this)) return { handled: true };
		return orig.handleMouse.call(this, event);
	};
	proto.handleInput = function (this: ListHost, data: string) {
		if (isNoMatchList(this)) return;
		return orig.handleInput.call(this, data);
	};
}

type MdPointer = { type: string; x: number; y: number; button?: string; clickCount?: number };
type TagHit = { line: number; start: number; end: number; abs: string };
type MdHost = {
	text: string;
	defaultTextStyle?: unknown;
	renderInlineTokens(tokens: unknown[], styleContext?: unknown): string;
	render(width: number): string[];
	handleMouse?(event: MdPointer): { handled?: boolean } | undefined;
};
type MarkedFn<T> = T & { [MD_MARK]?: T };

function cells(line: string): { ch: string; col: number; w: number }[] {
	const out: { ch: string; col: number; w: number }[] = [];
	let i = 0;
	let col = 0;
	while (i < line.length) {
		if (line[i] === "\x1b") {
			const len = ansiLength(line, i);
			if (len > 0) {
				i += len;
				continue;
			}
		}
		const cp = line.codePointAt(i);
		if (cp === undefined) break;
		const ch = String.fromCodePoint(cp);
		const w = visibleWidth(ch);
		out.push({ ch, col, w });
		col += w;
		i += ch.length;
	}
	return out;
}

/** One hit per tag, including a tag that wraps onto the next line. */
function collectHits(lines: string[], paths: string[]): TagHit[] {
	const hits: TagHit[] = [];
	let n = 0;
	let open: { abs: string; line: number; start: number } | null = null;
	for (let line = 0; line < lines.length; line++) {
		for (const cell of cells(lines[line] ?? "")) {
			if (cell.ch === LEFT && !open) {
				const abs = paths[n++];
				if (!abs) continue;
				open = { abs, line, start: cell.col };
			} else if (cell.ch === RIGHT && open) {
				const start = open.line === line ? open.start : 0;
				hits.push({ line, start, end: cell.col + cell.w, abs: open.abs });
				if (open.line !== line) hits.push({ line: open.line, start: open.start, end: Number.POSITIVE_INFINITY, abs: open.abs });
				open = null;
			}
		}
		if (open && open.line === line) hits.push({ line, start: open.start, end: Number.POSITIVE_INFINITY, abs: open.abs });
		else if (open && open.line < line) hits.push({ line, start: 0, end: Number.POSITIVE_INFINITY, abs: open.abs });
	}
	return hits;
}

function unwrap<T extends (...args: never[]) => unknown>(fn: T | undefined): T | undefined {
	if (!fn) return undefined;
	if (Object.prototype.hasOwnProperty.call(fn, MD_MARK)) return (fn as MarkedFn<T>)[MD_MARK];
	return fn;
}

/** Each wrapper keeps its base under MD_MARK, so a /reload wraps Pi's original instead of the last wrapper. */
function installMarkdownPatches(): void {
	const proto = Markdown.prototype as unknown as MdHost;
	const baseInline = unwrap(proto.renderInlineTokens) ?? proto.renderInlineTokens;
	const baseRender = unwrap(proto.render) ?? proto.render;
	const baseMouse = unwrap(proto.handleMouse);
	const hits = new WeakMap<MdHost, TagHit[]>();

	const renderInlineTokens: MarkedFn<MdHost["renderInlineTokens"]> = function (this: MdHost, tokens, styleContext) {
		const raw = baseInline.call(this, tokens, styleContext);
		if (!this.defaultTextStyle || !raw.includes("\uE000")) return raw;
		return paintSentinels(raw);
	};
	renderInlineTokens[MD_MARK] = baseInline;

	const render: MarkedFn<MdHost["render"]> = function (this: MdHost, width: number) {
		const lines = baseRender.call(this, width);
		if (this.defaultTextStyle) hits.set(this, collectHits(lines, tagPaths(this.text, cwd)));
		return lines;
	};
	render[MD_MARK] = baseRender;

	const handleMouse: MarkedFn<NonNullable<MdHost["handleMouse"]>> = function (this: MdHost, event) {
		const clicked = event.type === "click" && (event.button === "left" || event.button === undefined) && (event.clickCount ?? 1) === 1;
		if (this.defaultTextStyle && clicked) {
			const hit = (hits.get(this) ?? []).find((item) => item.line === event.y && event.x >= item.start && event.x < item.end);
			if (hit && openIfMedia(hit.abs)) return { handled: true };
		}
		return baseMouse?.call(this, event);
	};
	handleMouse[MD_MARK] = baseMouse;

	proto.renderInlineTokens = renderInlineTokens;
	proto.render = render;
	proto.handleMouse = handleMouse;
}

type ScreenOrig = {
	applySelection: (screen: string[], layout?: unknown) => string[];
	handleMouseEvent: (raw: unknown) => void;
	requestRender: (force?: boolean) => void;
};

function installScreenPatches(): void {
	const proto = TuiAltScreen.prototype as unknown as ScreenOrig & { [ORIG]?: ScreenOrig };
	if (!proto[ORIG]) proto[ORIG] = { applySelection: proto.applySelection, handleMouseEvent: proto.handleMouseEvent, requestRender: proto.requestRender };
	const orig = proto[ORIG];
	if (!orig.handleMouseEvent) orig.handleMouseEvent = proto.handleMouseEvent;
	proto.applySelection = function (this: unknown, screen: string[], layout?: unknown) {
		return orig.applySelection.call(this, screen, layout).map(plainTagsInSelection);
	};
	// The TUI has no pointer-leave event. A mouse event the prompt editor did not handle
	// means the pointer is elsewhere, so the link underline goes.
	proto.handleMouseEvent = function (this: ScreenOrig, raw: unknown) {
		linkHoverClaimed = false;
		orig.handleMouseEvent.call(this, raw);
		if (!linkHoverClaimed && linkHover) {
			linkHover = null;
			this.requestRender();
		}
	};
}

export default function (pi: ExtensionAPI) {
	installEditorPatches();
	installListPatches();
	installScreenPatches();
	installMarkdownPatches();
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user") return markdown;
		return tagSentinels(markdown, cwd);
	});
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
		ctxRef = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider(wrap);
	});
}
