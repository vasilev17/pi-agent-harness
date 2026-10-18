import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
// A namespace import: Pi before 0.99 has no color functions, and a named import of one would fail to load.
import * as tui from "@earendil-works/pi-tui";

/** Plain channels, 0-255, so the math below stays arithmetic on three numbers. */
export type Rgb = { r: number; g: number; b: number };

/**
 * What Pi 0.99 added to its Theme for extensions, and what Pi 0.85 to 0.87 keep on
 * theirs. Each piece is read as optional, and typed here rather than taken from Pi,
 * so the extension builds and runs against every Pi it supports.
 */
type HostColor = object;
type HostTheme = {
	colors?: Readonly<Record<string, HostColor | undefined>>;
	appearance?: "dark" | "light";
	fgColors?: unknown;
};
const host = (theme: Theme) => theme as unknown as HostTheme;
const colorToRgb = (tui as unknown as { colorToRgb?: (color: HostColor) => Rgb }).colorToRgb;

/**
 * A theme token's concrete color. Pi 0.99 resolves every token, including one set
 * to the terminal's own color and one it renders faint; older Pi only writes an
 * escape sequence, which is read back. A token Pi does not know resolves to
 * nothing rather than throwing, since callers compute names from host state.
 */
export function themeColorRgb(theme: Theme, color: ThemeColor): Rgb | undefined {
	const { colors } = host(theme);
	if (colors && colorToRgb) {
		const concrete = colors[color];
		if (!concrete) return undefined;
		const { r, g, b } = colorToRgb(concrete);
		// Rounded as Pi rounds a color it writes out, so derived shades start from what the terminal shows.
		return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
	}
	return escapeColorRgb(theme, color);
}

/** Pi before 0.99: the color inside the token's escape sequence. */
function escapeColorRgb(theme: Theme, color: ThemeColor): Rgb | undefined {
	let ansi: string;
	try {
		ansi = theme.getFgAnsi(color);
	} catch {
		return undefined;
	}
	const trueColor = ansi.match(/\[38;2;(\d+);(\d+);(\d+)m/u);
	if (trueColor) return { r: Number(trueColor[1]), g: Number(trueColor[2]), b: Number(trueColor[3]) };
	const indexed = ansi.match(/\[38;5;(\d+)m/u);
	return indexed ? indexedRgb(Number(indexed[1])) : undefined;
}

const BASIC_RGB: readonly Rgb[] = [
	{ r: 0, g: 0, b: 0 }, { r: 128, g: 0, b: 0 }, { r: 0, g: 128, b: 0 }, { r: 128, g: 128, b: 0 },
	{ r: 0, g: 0, b: 128 }, { r: 128, g: 0, b: 128 }, { r: 0, g: 128, b: 128 }, { r: 192, g: 192, b: 192 },
	{ r: 128, g: 128, b: 128 }, { r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 },
	{ r: 0, g: 0, b: 255 }, { r: 255, g: 0, b: 255 }, { r: 0, g: 255, b: 255 }, { r: 255, g: 255, b: 255 },
];
/** The 256-color cube's channel values and its gray ramp, as xterm and Pi define them. */
const CUBE = [0, 95, 135, 175, 215, 255];
const GRAYS = Array.from({ length: 24 }, (_, index) => 8 + index * 10);

function indexedRgb(index: number): Rgb {
	if (index < 16) return BASIC_RGB[index] ?? BASIC_RGB[7]!;
	if (index < 232) {
		const cube = index - 16;
		return { r: CUBE[Math.floor(cube / 36)]!, g: CUBE[Math.floor((cube % 36) / 6)]!, b: CUBE[cube % 6]! };
	}
	const gray = GRAYS[Math.min(23, index - 232)]!;
	return { r: gray, g: gray, b: gray };
}

function nearest(values: readonly number[], target: number): number {
	let best = 0;
	for (let index = 1; index < values.length; index++) {
		if (Math.abs(target - values[index]!) < Math.abs(target - values[best]!)) best = index;
	}
	return best;
}

/**
 * The 256-color entry Pi 0.99 picks for a color: the nearest cube or gray step, never
 * the first sixteen, which are whatever the terminal makes of them. Written here so
 * every Pi this extension runs on draws a derived color the same way.
 */
function ansi256(rgb: Rgb): number {
	const [r, g, b] = [nearest(CUBE, rgb.r), nearest(CUBE, rgb.g), nearest(CUBE, rgb.b)];
	const cube = { r: CUBE[r]!, g: CUBE[g]!, b: CUBE[b]! };
	const grayIndex = nearest(GRAYS, Math.round(luminanceRgb(rgb)));
	const gray = GRAYS[grayIndex]!;
	const distance = (to: Rgb) => (rgb.r - to.r) ** 2 * 0.299 + (rgb.g - to.g) ** 2 * 0.587 + (rgb.b - to.b) ** 2 * 0.114;
	const spread = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
	return spread < 10 && distance({ r: gray, g: gray, b: gray }) < distance(cube) ? 232 + grayIndex : 16 + 36 * r + 6 * g + b;
}

/** The opening escape sequence for a color, foreground (38) or background (48), in the terminal's color mode. */
function openColor(theme: Theme, color: Rgb, set: 38 | 48): string {
	return theme.getColorMode?.() === "256color"
		? `\x1b[${set};5;${ansi256(color)}m`
		: `\x1b[${set};2;${Math.round(color.r)};${Math.round(color.g)};${Math.round(color.b)}m`;
}

export function colorizeRgb(theme: Theme, color: Rgb, text: string): string {
	return `${openColor(theme, color, 38)}${text}\x1b[39m`;
}

export function fillRgb(theme: Theme, color: Rgb, text: string): string {
	return `${openColor(theme, color, 48)}${text}\x1b[49m`;
}

/** A painter for one color, its escape sequence written once for every text it paints. */
export function rgbPainter(theme: Theme, color: Rgb): (text: string) => string {
	const open = openColor(theme, color, 38);
	return (text) => `${open}${text}\x1b[39m`;
}

/**
 * The palette a theme draws with right now, as an object to key derived colors by.
 * Pi 0.99 hands out a new `theme.colors` whenever the theme or the terminal's colors
 * change. Pi 0.85 to 0.87 give every theme its own map of escape sequences, reached
 * through the same Theme object, which `/theme` points at another theme. A host with
 * neither is told apart by the escape sequences of the colors derived from.
 */
export function paletteOf(theme: Theme): object {
	const { colors, fgColors } = host(theme);
	if (colors) return colors;
	if (fgColors instanceof Map) return fgColors;
	let key = theme.getColorMode?.() ?? "";
	for (const token of PALETTE_TOKENS) {
		try {
			key += theme.getFgAnsi(token);
		} catch {
			key += "?";
		}
	}
	let palette = escapePalettes.get(key);
	if (!palette) escapePalettes.set(key, palette = {});
	return palette;
}

/** Every token the derived colors are made from. */
const PALETTE_TOKENS: readonly ThemeColor[] = [
	"text", "dim", "muted", "toolTitle", "success", "error", "warning", "toolDiffAdded", "toolDiffRemoved",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
];
/** One object per palette seen; a session switches among a handful of themes at most. */
const escapePalettes = new Map<string, object>();

export function interpolateRgb(from: Rgb, to: Rgb, amount: number): Rgb {
	const bounded = Math.max(0, Math.min(1, amount));
	const channel = (start: number, end: number) => Math.round(start + (end - start) * bounded);
	return {
		r: channel(from.r, to.r),
		g: channel(from.g, to.g),
		b: channel(from.b, to.b),
	};
}

/** Perceived brightness on the same 0-255 scale as the channels, and linear under interpolation. */
function luminanceRgb(rgb: Rgb): number {
	return rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114;
}

/** The poles stand in for the terminal background: standing out means moving away from the theme's own. */
const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** The theme's declared appearance; before Pi 0.99, a theme with light text is a dark one. */
function isDark(theme: Theme): boolean {
	const { appearance } = host(theme);
	if (appearance) return appearance === "dark";
	const text = themeColorRgb(theme, "text");
	return !text || luminanceRgb(text) > 128;
}

/** Mix a color toward its own gray so a vivid theme hue cannot turn chrome into a highlight. */
export function neutralizeRgb(rgb: Rgb, keepHue: number): Rgb {
	const gray = Math.round(luminanceRgb(rgb));
	return interpolateRgb({ r: gray, g: gray, b: gray }, rgb, keepHue);
}

/**
 * Reach a luminance by scaling every channel, which moves the color along its own ray from
 * black and so leaves hue and saturation untouched — the same color, brighter or darker.
 * Scaling up stops where the first channel would clip; past that only white can add light,
 * and the color washes out the way a real highlight does.
 */
function atBrightness(rgb: Rgb, target: number): Rgb {
	const brightness = luminanceRgb(rgb);
	if (brightness <= 0) return interpolateRgb(BLACK, WHITE, target / 255);
	const headroom = 255 / Math.max(rgb.r, rgb.g, rgb.b, 1);
	const scale = Math.min(target / brightness, headroom);
	const scaled: Rgb = { r: rgb.r * scale, g: rgb.g * scale, b: rgb.b * scale };
	const reached = luminanceRgb(scaled);
	const rounded: Rgb = { r: Math.round(scaled.r), g: Math.round(scaled.g), b: Math.round(scaled.b) };
	return reached >= target - 0.5 ? rounded : interpolateRgb(rounded, WHITE, (target - reached) / (255 - reached));
}

/** How far a color stands off the background: 0 for invisible, 1 for the opposite pole. */
function contrastLevel(dark: boolean, rgb: Rgb): number {
	const brightness = luminanceRgb(rgb) / 255;
	return dark ? brightness : 1 - brightness;
}

function atContrast(dark: boolean, rgb: Rgb, level: number): Rgb {
	return atBrightness(rgb, (dark ? level : 1 - level) * 255);
}

/** Lift a color part of the way to maximum contrast, keeping its hue for as long as it can. */
export function liftContrast(theme: Theme, rgb: Rgb, amount: number): Rgb {
	const dark = isDark(theme);
	const level = contrastLevel(dark, rgb);
	return atContrast(dark, rgb, level + (1 - level) * amount);
}

/**
 * Move a color until its contrast against the background lands inside the band. A color
 * already inside is returned untouched, so a theme's own choice survives wherever it is
 * legible to begin with.
 */
export function withContrast(theme: Theme, rgb: Rgb, minimum: number, maximum: number): Rgb {
	const dark = isDark(theme);
	const level = contrastLevel(dark, rgb);
	const target = Math.min(maximum, Math.max(minimum, level));
	return target === level ? rgb : atContrast(dark, rgb, target);
}

/**
 * Diff rows need a tint that reads on the terminal background without hijacking `toolSuccessBg`
 * and `toolErrorBg`, which Pi paints across the whole tool row.
 */
export function diffTintRgb(theme: Theme, color: ThemeColor, amount = 0.17): Rgb | undefined {
	const rgb = themeColorRgb(theme, color);
	return rgb && interpolateRgb(isDark(theme) ? BLACK : WHITE, rgb, amount);
}
