/**
 * Startup header: dragon.png, at the small 28-column size.
 *
 * The terminal emulator decides the drawing, not the shell:
 * - Windows Terminal (WT_SESSION): Sixel. One 20px strip per row, which is how
 *   a real image survived Pi's per-row redraw on the last try.
 * - Kitty, Ghostty, WezTerm, Warp: Kitty graphics protocol.
 * - iTerm2: its inline image sequence.
 * - tmux, screen, Terminal.app, conhost, and anything else: no custom header,
 *   so Pi keeps its own.
 *
 * The flat backdrop baked into dragon.png is cut out, so the terminal color
 * shows through. Swap the picture by replacing dragon.png and running /reload.
 * /header on|off toggles it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { allocateImageId, detectCapabilities, encodeITerm2, encodeKitty, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Bitmap = { width: number; height: number; data: Uint8Array };
type RGB = [number, number, number];

type HeaderTheme = {
	fg(color: "dim", text: string): string;
};

/** Matches the earlier small header. A cell is fixed size, so this is the width. */
const MAX_COLUMNS = 28;
/** Windows Terminal maps Sixel onto a fixed 10 by 20 cell, whatever the font is. */
const SIXEL_CELL_WIDTH = 10;
const SIXEL_CELL_HEIGHT = 20;
/** Rows kept free under the header so the editor and footer still fit on first paint. */
const RESERVED_ROWS = 12;
const SIXEL_COLORS = 255;
/** Palette index left unpainted. Sixel and the PNG alpha both leave that pixel empty. */
const TRANSPARENT = 255;
/**
 * pi-tui only skips its width clamp for Kitty and iTerm2 image lines. Sixel is
 * neither, so each strip carries an empty iTerm2 OSC that Windows Terminal ignores.
 * Without it, Pi slices the strip down to the terminal width and the image dies.
 */
const IMAGE_LINE_MARK = "\x1b]1337;File=\x07";
const HINT = "esc interrupt  ·  ctrl+c/ctrl+d clear/exit  ·  / commands  ·  ! bash  ·  ctrl+o more";

export type HeaderStrategy = "sixel" | "kitty" | "iterm2" | "none";

/** Which header this process can actually draw. Reads the emulator, not the shell. */
export function headerStrategy(): HeaderStrategy {
	const term = (process.env.TERM ?? "").toLowerCase();
	// tmux and screen do not reliably forward images, even when the outer emulator could.
	if (process.env.TMUX || term.startsWith("tmux") || term.startsWith("screen")) return "none";
	if (process.env.WT_SESSION) return "sixel";
	const images = detectCapabilities().images;
	if (images === "kitty" || images === "iterm2") return images;
	return "none";
}

export function decodePng(buf: Buffer): Bitmap {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let offset = 8;
	let width = 0;
	let height = 0;
	let depth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Buffer | undefined;
	let alphaTable: Buffer | undefined;
	const idat: Buffer[] = [];
	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("latin1", offset + 4, offset + 8);
		const body = buf.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8]!;
			colorType = body[9]!;
			interlace = body[12]!;
		} else if (type === "PLTE") palette = body;
		else if (type === "tRNS") alphaTable = body;
		else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		offset += length + 12;
	}
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
	if (depth !== 8 || interlace !== 0 || channels === undefined) throw new Error("unsupported PNG layout");

	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? pixels[dst + x - channels]! : 0;
			const up = y > 0 ? pixels[dst - stride + x]! : 0;
			const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels]! : 0;
			let value = raw[src + x]!;
			if (filter === 1) value += left;
			else if (filter === 2) value += up;
			else if (filter === 3) value += (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
			}
			pixels[dst + x] = value & 0xff;
		}
	}

	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const s = i * channels;
		const d = i * 4;
		if (colorType === 6) data.set(pixels.subarray(s, s + 4), d);
		else if (colorType === 2) data.set([pixels[s]!, pixels[s + 1]!, pixels[s + 2]!, 255], d);
		else if (colorType === 4) data.set([pixels[s]!, pixels[s]!, pixels[s]!, pixels[s + 1]!], d);
		else if (colorType === 0) data.set([pixels[s]!, pixels[s]!, pixels[s]!, 255], d);
		else {
			const index = pixels[s]!;
			data.set([palette![index * 3]!, palette![index * 3 + 1]!, palette![index * 3 + 2]!, alphaTable?.[index] ?? 255], d);
		}
	}
	return { width, height, data };
}

/**
 * Cut the flat backdrop out of an opaque picture. Alpha comes from how far a
 * pixel sits from the border color, and the stored RGB is the ink with that
 * backdrop removed, so a terminal can composite it onto its own background.
 * The result is cropped to the drawing.
 */
export function matte(src: Bitmap): Bitmap {
	const { width, height, data } = src;
	const border: number[][] = [[], [], []];
	for (let x = 0; x < width; x++) {
		for (const y of [0, height - 1]) for (let c = 0; c < 3; c++) border[c]!.push(data[(y * width + x) * 4 + c]!);
	}
	for (let y = 0; y < height; y++) {
		for (const x of [0, width - 1]) for (let c = 0; c < 3; c++) border[c]!.push(data[(y * width + x) * 4 + c]!);
	}
	const backdrop = border.map((values) => values.sort((a, b) => a - b)[values.length >> 1]!);

	const out = new Uint8Array(data.length);
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const dr = data[i]! - backdrop[0]!;
			const dg = data[i + 1]! - backdrop[1]!;
			const db = data[i + 2]! - backdrop[2]!;
			const alpha = Math.min(1, Math.max(0, (Math.sqrt(dr * dr + dg * dg + db * db) - 12) / 40)) * (data[i + 3]! / 255);
			out[i + 3] = Math.round(alpha * 255);
			if (alpha > 0) {
				for (let c = 0; c < 3; c++) {
					const ink = backdrop[c]! + (data[i + c]! - backdrop[c]!) / alpha;
					out[i + c] = Math.min(255, Math.max(0, Math.round(ink)));
				}
			}
			if (alpha > 0.5) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
	}
	if (maxX < 0) return { width, height, data: out };
	minX = Math.max(0, minX - 2);
	minY = Math.max(0, minY - 2);
	maxX = Math.min(width - 1, maxX + 2);
	maxY = Math.min(height - 1, maxY + 2);
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const cropped = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) cropped.set(out.subarray(((y + minY) * width + minX) * 4, ((y + minY) * width + maxX + 1) * 4), y * w * 4);
	return { width: w, height: h, data: cropped };
}

/** Area-average resample. Transparent pixels contribute no color, so the backdrop cannot tint an edge. */
export function resample(src: Bitmap, width: number, height: number): Bitmap {
	const data = new Uint8Array(width * height * 4);
	const sx = src.width / width;
	const sy = src.height / height;
	for (let y = 0; y < height; y++) {
		const y0 = y * sy;
		const y1 = Math.max(y0 + 1e-6, (y + 1) * sy);
		for (let x = 0; x < width; x++) {
			const x0 = x * sx;
			const x1 = Math.max(x0 + 1e-6, (x + 1) * sx);
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let area = 0;
			for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
				const wy = Math.min(y1, py + 1) - Math.max(y0, py);
				for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
					const wx = Math.min(x1, px + 1) - Math.max(x0, px);
					const i = (Math.min(src.height - 1, py) * src.width + Math.min(src.width - 1, px)) * 4;
					const weight = wx * wy * (src.data[i + 3]! / 255);
					r += src.data[i]! * weight;
					g += src.data[i + 1]! * weight;
					b += src.data[i + 2]! * weight;
					a += weight;
					area += wx * wy;
				}
			}
			const o = (y * width + x) * 4;
			const coverage = a / area;
			if (coverage <= 0.001) continue;
			data[o] = Math.min(255, Math.max(0, Math.round(r / a)));
			data[o + 1] = Math.min(255, Math.max(0, Math.round(g / a)));
			data[o + 2] = Math.min(255, Math.max(0, Math.round(b / a)));
			data[o + 3] = Math.round(coverage * 255);
		}
	}
	return { width, height, data };
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	CRC_TABLE[n] = c;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type), data]);
	let crc = 0xffffffff;
	for (const value of body) crc = CRC_TABLE[(crc ^ value) & 0xff]! ^ (crc >>> 8);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
	return out;
}

/** RGBA PNG. Zero alpha leaves the terminal background showing. */
export function encodePng(bitmap: Bitmap): Buffer {
	const { width, height, data } = bitmap;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width * 4 + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) raw.set(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), row + 1 + x * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

/** Cell grid for a square-ish cell (about twice as tall as it is wide). */
export function fitCells(picture: Bitmap, width: number, terminalRows = process.stdout.rows || 40): { columns: number; rows: number } {
	const maxRows = Math.max(6, terminalRows - RESERVED_ROWS);
	let columns = Math.max(4, Math.min(MAX_COLUMNS, width - 2));
	let rows = Math.max(1, Math.round((columns * picture.height) / picture.width / 2));
	if (rows > maxRows) {
		rows = maxRows;
		columns = Math.max(4, Math.round((rows * 2 * picture.width) / picture.height));
	}
	return { columns, rows };
}

function medianCut(samples: RGB[], count: number): RGB[] {
	let boxes: RGB[][] = [samples];
	while (boxes.length < count) {
		let best = -1;
		let bestRange = 0;
		let channel = 0;
		for (let i = 0; i < boxes.length; i++) {
			const box = boxes[i]!;
			if (box.length < 2) continue;
			const range = [0, 1, 2].map((c) => {
				let min = 255;
				let max = 0;
				for (const pixel of box) {
					min = Math.min(min, pixel[c]);
					max = Math.max(max, pixel[c]);
				}
				return max - min;
			});
			const widest = range[0]! >= range[1]! && range[0]! >= range[2]! ? 0 : range[1]! >= range[2]! ? 1 : 2;
			if (range[widest]! > bestRange) {
				bestRange = range[widest]!;
				best = i;
				channel = widest;
			}
		}
		if (best < 0) break;
		const box = boxes[best]!;
		box.sort((a, b) => a[channel]! - b[channel]!);
		const mid = box.length >> 1;
		boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
	}
	return boxes.map((box) => {
		let r = 0;
		let g = 0;
		let b = 0;
		for (const pixel of box) {
			r += pixel[0];
			g += pixel[1];
			b += pixel[2];
		}
		const n = box.length || 1;
		return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
	});
}

/** 255-color palette plus Floyd-Steinberg. Pixels under half coverage stay transparent, and Sixel color 0 stays unused. */
function quantize(src: Bitmap, colors: number): { index: Uint8Array; palette: RGB[] } {
	const { width, height, data } = src;
	const solid = new Uint8Array(width * height);
	const samples: RGB[] = [];
	const step = Math.max(1, Math.floor((width * height) / 20000));
	let solidCount = 0;
	for (let i = 0; i < width * height; i++) {
		if (data[i * 4 + 3]! < 128) continue;
		solid[i] = 1;
		if (solidCount % step === 0) {
			const o = i * 4;
			samples.push([data[o]!, data[o + 1]!, data[o + 2]!]);
		}
		solidCount++;
	}
	const index = new Uint8Array(width * height);
	index.fill(TRANSPARENT);
	if (samples.length === 0) return { index, palette: [] };
	const palette = medianCut(samples, colors);
	const work = new Float32Array(width * height * 3);
	for (let i = 0; i < width * height; i++) {
		if (!solid[i]) continue;
		work[i * 3] = data[i * 4]!;
		work[i * 3 + 1] = data[i * 4 + 1]!;
		work[i * 3 + 2] = data[i * 4 + 2]!;
	}
	const cache = new Map<number, number>();
	const nearest = (r: number, g: number, b: number) => {
		const key = (r << 16) | (g << 8) | b;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < palette.length; i++) {
			const dr = r - palette[i]![0];
			const dg = g - palette[i]![1];
			const db = b - palette[i]![2];
			const dist = dr * dr + dg * dg + db * db;
			if (dist < bestDist) {
				bestDist = dist;
				best = i;
				if (dist === 0) break;
			}
		}
		cache.set(key, best);
		return best;
	};
	const clamp = (value: number) => Math.min(255, Math.max(0, Math.round(value)));
	const add = (x: number, y: number, er: number, eg: number, eb: number, factor: number) => {
		if (x < 0 || x >= width || y < 0 || y >= height || !solid[y * width + x]) return;
		const o = (y * width + x) * 3;
		work[o] = (work[o] ?? 0) + er * factor;
		work[o + 1] = (work[o + 1] ?? 0) + eg * factor;
		work[o + 2] = (work[o + 2] ?? 0) + eb * factor;
	};
	for (let y = 0; y < height; y++) {
		const forward = y % 2 === 0;
		for (let stepX = 0; stepX < width; stepX++) {
			const x = forward ? stepX : width - 1 - stepX;
			if (!solid[y * width + x]) continue;
			const o = (y * width + x) * 3;
			const r = clamp(work[o] ?? 0);
			const g = clamp(work[o + 1] ?? 0);
			const b = clamp(work[o + 2] ?? 0);
			const chosen = nearest(r, g, b);
			index[y * width + x] = chosen;
			const tone = palette[chosen]!;
			const dir = forward ? 1 : -1;
			add(x + dir, y, r - tone[0], g - tone[1], b - tone[2], 7 / 16);
			add(x - dir, y + 1, r - tone[0], g - tone[1], b - tone[2], 3 / 16);
			add(x, y + 1, r - tone[0], g - tone[1], b - tone[2], 5 / 16);
			add(x + dir, y + 1, r - tone[0], g - tone[1], b - tone[2], 1 / 16);
		}
	}
	return { index, palette };
}

function sixelRepeat(codes: number[]): string {
	let end = codes.length;
	while (end > 0 && codes[end - 1] === 63) end--;
	let out = "";
	let i = 0;
	while (i < end) {
		let j = i + 1;
		while (j < end && codes[j] === codes[i]) j++;
		const count = j - i;
		const glyph = String.fromCharCode(codes[i]!);
		out += count >= 3 ? `!${count}${glyph}` : glyph.repeat(count);
		i = j;
	}
	return out;
}

/** One Sixel image, `height` pixels tall, taken from a full indexed picture at `y0`. */
function encodeSixelStrip(index: Uint8Array, width: number, y0: number, height: number, palette: RGB[]): string {
	const used: number[] = [];
	const seen = new Uint8Array(palette.length);
	for (let y = 0; y < height; y++) {
		const row = (y0 + y) * width;
		for (let x = 0; x < width; x++) {
			const color = index[row + x]!;
			if (color === TRANSPARENT || color >= palette.length || seen[color]) continue;
			seen[color] = 1;
			used.push(color);
		}
	}
	const percent = (value: number) => Math.round((value * 100) / 255);
	// P2=1 keeps unset pixels transparent on xterm-style Sixel, which Windows Terminal follows.
	let out = `\x1bP0;1;q"1;1;${width};${height}`;
	for (const color of used) {
		const tone = palette[color]!;
		out += `#${color + 1};2;${percent(tone[0])};${percent(tone[1])};${percent(tone[2])}`;
	}
	const bands = Math.ceil(height / 6);
	for (let band = 0; band < bands; band++) {
		for (const color of used) {
			const codes: number[] = [];
			let painted = false;
			for (let x = 0; x < width; x++) {
				let bits = 0;
				for (let k = 0; k < 6; k++) {
					const y = band * 6 + k;
					const sample = y < height ? index[(y0 + y) * width + x]! : TRANSPARENT;
					if (sample === color) bits |= 1 << k;
				}
				if (bits !== 0) painted = true;
				codes.push(63 + bits);
			}
			if (painted) out += `#${color + 1}${sixelRepeat(codes)}$`;
		}
		if (band !== bands - 1) out += "-";
	}
	return `${out}\x1b\\`;
}

function sixelLines(picture: Bitmap, columns: number, rows: number, pad: string): string[] {
	const scaled = resample(picture, columns * SIXEL_CELL_WIDTH, rows * SIXEL_CELL_HEIGHT);
	const { index, palette } = quantize(scaled, SIXEL_COLORS);
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		lines.push(pad + IMAGE_LINE_MARK + encodeSixelStrip(index, scaled.width, row * SIXEL_CELL_HEIGHT, SIXEL_CELL_HEIGHT, palette));
	}
	return lines;
}

function protocolLines(picture: Bitmap, strategy: "kitty" | "iterm2", columns: number, rows: number, pad: string): string[] {
	const base64 = encodePng(picture).toString("base64");
	if (strategy === "kitty") {
		const sequence = encodeKitty(base64, { columns, rows, imageId: allocateImageId(), moveCursor: false });
		const lines = [pad + sequence];
		for (let i = 1; i < rows; i++) lines.push("");
		return lines;
	}
	const sequence = encodeITerm2(base64, { width: columns, height: "auto" });
	const lines: string[] = [];
	for (let i = 0; i < rows - 1; i++) lines.push("");
	const up = rows > 1 ? `\x1b[${rows - 1}A` : "";
	lines.push(pad + up + sequence);
	return lines;
}

/** The picture rows, centered. The hint is added by the header. */
export function buildLines(picture: Bitmap, strategy: Exclude<HeaderStrategy, "none">, width: number, terminalRows?: number): string[] {
	const { columns, rows } = fitCells(picture, width, terminalRows);
	const pad = " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
	return strategy === "sixel" ? sixelLines(picture, columns, rows, pad) : protocolLines(picture, strategy, columns, rows, pad);
}

function place(line: string, width: number, artWidth: number): string {
	const vis = visibleWidth(line);
	if (vis > width) return truncateToWidth(line, width);
	return `${" ".repeat(Math.max(0, Math.floor((width - artWidth) / 2)))}${line}`;
}

type HeaderUi = {
	mode: string;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setHeader(factory: ((tui: unknown, theme: HeaderTheme) => { invalidate(): void; render(width: number): string[] }) | undefined): void;
	};
};

export default function dragonHeader(pi: ExtensionAPI): void {
	let enabled = true;
	let source: Bitmap | undefined;
	let cut: Bitmap | undefined;
	const rendered = new Map<string, string[]>();

	function picture(): Bitmap {
		if (!cut) {
			source ??= decodePng(readFileSync(join(getAgentDir(), "extensions", "dragon-header", "dragon.png")));
			cut = matte(source);
		}
		return cut;
	}

	function render(theme: HeaderTheme, width: number, strategy: Exclude<HeaderStrategy, "none">): string[] {
		const image = picture();
		const key = `${strategy}|${process.stdout.rows || 0}|${width}`;
		let lines = rendered.get(key);
		if (!lines) {
			const art = buildLines(image, strategy, width);
			const hint = theme.fg("dim", HINT);
			lines = [...art, "", place(hint, width, visibleWidth(hint)), ""];
			rendered.set(key, lines);
		}
		return lines;
	}

	function install(ctx: HeaderUi): "shown" | "default" | "error" {
		if (ctx.mode !== "tui") return "default";
		const strategy = headerStrategy();
		if (!enabled || strategy === "none") {
			ctx.ui.setHeader(undefined);
			return "default";
		}
		try {
			picture();
		} catch (error) {
			ctx.ui.notify(`Dragon header: ${error instanceof Error ? error.message : String(error)}`, "warning");
			ctx.ui.setHeader(undefined);
			return "error";
		}
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render(width: number) {
				return render(theme, width, strategy);
			},
		}));
		return "shown";
	}

	pi.on("session_start", async (_event, ctx) => {
		install(ctx);
	});

	pi.registerCommand("header", {
		description: "Toggle the dragon startup header",
		getArgumentCompletions: (prefix) => completeArgs(prefix),
		handler: async (args, ctx) => {
			const flag = parseOnOff(args.trim().toLowerCase());
			if (flag === "invalid") {
				ctx.ui.notify("Usage: /header [on|off]", "warning");
				return;
			}
			enabled = flag === "toggle" ? !enabled : flag;
			const result = install(ctx);
			if (result === "error") return;
			if (enabled && result === "default") {
				ctx.ui.notify("This terminal cannot show the dragon image. Default header stays.", "warning");
				return;
			}
			ctx.ui.notify(enabled ? "Dragon header on" : "Default header restored", "info");
		},
	});
}

function completeArgs(prefix: string): { label: string; value: string }[] | null {
	const needle = prefix.trim().toLowerCase();
	const items = ["on", "off"].filter((item) => item.startsWith(needle)).map((item) => ({ label: item, value: item }));
	return items.length ? items : null;
}

function parseOnOff(value: string): boolean | "toggle" | "invalid" {
	if (!value) return "toggle";
	if (value === "on" || value === "true") return true;
	if (value === "off" || value === "false") return false;
	return "invalid";
}
