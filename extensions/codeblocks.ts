/**
 * Code blocks: language label above, theme background sized to the widest
 * line plus a few columns, and a clickable copy glyph at the top right that copies the raw source.
 *
 * Pi has no public hook for fenced code, so this patches the private
 * Markdown.renderToken. Clicks need mouse input, which Pi only enables in
 * fullscreen TUI mode (the default `tuiMode`).
 */

import { copyToClipboard, getLanguageFromPath, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	sliceByColumn,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.codeblocks.patch");
/** Pi draws syntax-highlighted tool output on this background, so every theme keeps code readable on it. */
const BG_TOKEN = "toolPendingBg";
const PAD = " ";
/** Background is the widest code line plus this many columns. */
const BG_EXTRA = 4;
/** nf-oct-copy. Same Nerd Font private-use glyph as the git mark in the footer. */
const COPY_ICON = "\uf4bb";
/** nf-oct-check. Brief feedback after a successful copy. */
const COPIED_ICON = "\uf42e";
const BUTTON_WIDTH = Math.max(visibleWidth(COPY_ICON), visibleWidth(COPIED_ICON));
const COPIED_MS = 1500;
const STATUS_KEY = "codeblocks";
/** Resets inside highlighted code would end the block background early. */
const BG_RESET = /\x1b\[(?:0|49)?m/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n {0,3}\1[`~]*[ \t]*$/gm;

type CodeToken = { type?: string; lang?: string; text?: string };

type MarkdownTheme = {
	highlightCode?: (code: string, lang?: string) => string[];
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
};

type MarkdownInternals = {
	text: string;
	theme: MarkdownTheme;
	defaultTextStyle?: unknown;
	cachedLines?: string[];
	cachedText?: string;
	cachedWidth?: number;
	invalidate(): void;
	renderToken(token: CodeToken, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};

type ThemeLike = ExtensionContext["ui"]["theme"];

type Block = {
	source: string;
	/** Plain text of the label row, used to find the block in rendered output. */
	header: string;
	buttonOffset: number;
	buttonWidth: number;
};

type Hit = { y: number; startX: number; endX: number; index: number };

/** Markdown replaces tabs with spaces before lexing; recover the tabs from the raw message. */
function rawSource(markdown: string, text: string): string {
	if (!markdown.includes("\t")) return text;
	for (const match of markdown.matchAll(FENCE)) {
		const body = match[2] ?? "";
		if (body.replace(/\t/g, "   ") === text) return body;
	}
	return text;
}

/**
 * A fence tagged `jsx` is already a language. A fence tagged with a path
 * (`21:32:src/Hero.jsx` or `src/Hero.jsx`) is not. Highlight from the extension.
 * The label stays the path.
 */
function fenceHighlightLang(tag: string): string {
	const path = tag.replace(/^\d+:\d+:/, "");
	const looksLikePath = path !== tag || path.includes("/") || path.includes("\\") || path.includes(".");
	if (!looksLikePath) return tag;
	return getLanguageFromPath(path) ?? tag;
}

function hardWrap(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const parts: string[] = [];
	for (let col = 0; col < visibleWidth(line); col += width) parts.push(sliceByColumn(line, col, width));
	return parts;
}

function renderBlock(
	md: MarkdownTheme,
	theme: ThemeLike,
	code: string,
	lang: string,
	highlightLang: string,
	width: number,
	copied: boolean,
): { lines: string[]; block: Omit<Block, "source"> } {
	const highlighted = md.highlightCode
		? md.highlightCode(code, highlightLang || undefined)
		: code.split("\n").map((line) => md.codeBlock(line));
	const widest = Math.max(0, ...highlighted.map((line) => visibleWidth(line)));
	const headerWidth = PAD.length + visibleWidth(lang) + 1 + BUTTON_WIDTH;
	const boxWidth = Math.max(1, Math.min(width, Math.max(widest + BG_EXTRA, headerWidth)));
	const inner = Math.max(1, boxWidth - PAD.length * 2);
	const bg = theme.getBgAnsi(BG_TOKEN);

	const button = copied ? COPIED_ICON : COPY_ICON;
	const gap = Math.max(1, boxWidth - PAD.length - visibleWidth(lang) - button.length);
	const label = lang ? theme.fg("accent", lang) : "";
	const lines = [`${PAD}${label}${" ".repeat(gap)}${theme.fg("accent", button)}`];
	const blank = `${bg}${" ".repeat(boxWidth)}\x1b[39m\x1b[49m`;

	lines.push(blank);
	for (const line of highlighted) {
		for (const part of hardWrap(line, inner)) {
			const fill = " ".repeat(Math.max(0, inner - visibleWidth(part)));
			lines.push(`${bg}${PAD}${part.replace(BG_RESET, (reset) => reset + bg)}${fill}${PAD}\x1b[39m\x1b[49m`);
		}
	}
	lines.push(blank);

	return {
		lines,
		block: {
			header: stripTerminalSequences(lines[0] ?? ""),
			buttonOffset: PAD.length + visibleWidth(lang) + gap,
			buttonWidth: button.length,
		},
	};
}

function locate(lines: readonly string[], blocks: readonly Block[]): Hit[] {
	const hits: Hit[] = [];
	let y = 0;
	for (const [index, block] of blocks.entries()) {
		for (; y < lines.length; y++) {
			const plain = stripTerminalSequences(lines[y] ?? "");
			const at = plain.lastIndexOf(block.header);
			if (at < 0) continue;
			const startX = visibleWidth(plain.slice(0, at)) + block.buttonOffset;
			hits.push({ y, startX, endX: startX + block.buttonWidth, index });
			y++;
			break;
		}
	}
	return hits;
}

function installPatch(getTheme: () => ThemeLike | undefined, copy: (source: string) => Promise<void>, repaint: () => void): () => void {
	const proto = Markdown.prototype as unknown as MarkdownInternals & Record<PropertyKey, { restore(): void } | undefined>;
	proto[PATCH]?.restore();

	const originalRenderToken = proto.renderToken;
	const originalRender = proto.render;
	const originalHandleMouse = proto.handleMouse;

	const capture = new WeakMap<MarkdownInternals, Block[]>();
	const blocks = new WeakMap<MarkdownInternals, Block[]>();
	const layouts = new WeakMap<MarkdownInternals, { lines: string[]; hits: Hit[] }>();
	const copiedIndex = new WeakMap<MarkdownInternals, number>();

	const renderToken = function (
		this: MarkdownInternals,
		token: CodeToken,
		width: number,
		nextTokenType?: string,
		styleContext?: unknown,
	): string[] {
		const theme = getTheme();
		// User messages and thinking pass a defaultTextStyle and paint their own background.
		if (token?.type !== "code" || this.defaultTextStyle || !theme || !(token.text ?? "").trim()) {
			return originalRenderToken.call(this, token, width, nextTokenType, styleContext);
		}
		const list = capture.get(this);
		const index = list ? list.length : -1;
		const lang = (token.lang ?? "").trim().split(/\s+/, 1)[0] ?? "";
		const text = token.text ?? "";
		const { lines, block } = renderBlock(
			this.theme,
			theme,
			text,
			lang,
			fenceHighlightLang(lang),
			width,
			copiedIndex.get(this) === index,
		);
		list?.push({ ...block, source: rawSource(this.text, text) });
		if (nextTokenType && nextTokenType !== "space") lines.push("");
		return lines;
	};

	const render = function (this: MarkdownInternals, width: number): string[] {
		if (this.defaultTextStyle) return originalRender.call(this, width);
		const cached = !!this.cachedLines && this.cachedText === this.text && this.cachedWidth === width;
		const list: Block[] = [];
		capture.set(this, list);
		let lines: string[];
		try {
			lines = originalRender.call(this, width);
		} finally {
			capture.delete(this);
		}
		if (!cached) blocks.set(this, list);
		const known = blocks.get(this) ?? [];
		if (known.length === 0) {
			layouts.delete(this);
			return lines;
		}
		if (layouts.get(this)?.lines !== lines) layouts.set(this, { lines, hits: locate(lines, known) });
		return lines;
	};

	const handleMouse = function (this: MarkdownInternals, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left" && (event.clickCount ?? 1) === 1) {
			const hit = layouts.get(this)?.hits.find((h) => h.y === event.y && event.x >= h.startX && event.x < h.endX);
			const block = hit ? blocks.get(this)?.[hit.index] : undefined;
			if (hit && block) {
				const instance = this;
				const reset = () => {
					if (copiedIndex.get(instance) !== hit.index) return;
					copiedIndex.delete(instance);
					instance.invalidate();
					repaint();
				};
				copiedIndex.set(instance, hit.index);
				instance.invalidate();
				copy(block.source).then(() => setTimeout(reset, COPIED_MS), reset);
				return { handled: true, render: true };
			}
		}
		return originalHandleMouse?.call(this, event);
	};

	proto.renderToken = renderToken;
	proto.render = render;
	proto.handleMouse = handleMouse;

	const record = {
		restore() {
			if (proto.renderToken === renderToken) proto.renderToken = originalRenderToken;
			if (proto.render === render) proto.render = originalRender;
			if (proto.handleMouse === handleMouse) {
				if (originalHandleMouse) proto.handleMouse = originalHandleMouse;
				else delete proto.handleMouse;
			}
			if (proto[PATCH] === record) delete proto[PATCH];
		},
	};
	proto[PATCH] = record;
	return record.restore;
}

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let restore: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restore?.();
		restore = undefined;
		ctxRef = ctx;
		if (ctx.mode !== "tui") return;
		restore = installPatch(
			() => ctxRef?.ui.theme,
			async (source) => {
				try {
					await copyToClipboard(source);
				} catch (error) {
					ctxRef?.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					throw error;
				}
			},
			// Extensions have no TUI handle outside a component; setStatus is what requests a render.
			() => ctxRef?.ui.setStatus(STATUS_KEY, undefined),
		);
	});

	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
		ctxRef = undefined;
	});
}
