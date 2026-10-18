/**
 * Termflix ocean above the prompt while a run is active.
 * Gallery clip: https://paulrobello.github.io/termflix/ocean.gif
 * Half-blocks, same solid waves as that clip, plus smaller ripples.
 * Sky cells set no color, so the terminal background shows through.
 * Foam stays white and water stays blue. Removed when the run ends.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CustomEditor, InteractiveMode, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";

const ROWS = 8;
const FRAME_MS = 80;
const WIDGET = "termflix-ocean";

type RGB = [number, number, number];

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}

function byte(n: number): number {
	if (n <= 0) return 0;
	if (n >= 255) return 255;
	return n | 0;
}

function rgb(r: number, g: number, b: number): RGB {
	return [byte(r), byte(g), byte(b)];
}

/** Original four swells, plus smaller chops so the crest is less blocky. */
function surfaceAt(x: number, width: number, height: number, time: number): number {
	const fx = x / width;
	return (
		height * 0.35 +
		Math.sin(fx * 6 + time * 1.5) * height * 0.08 +
		Math.sin(fx * 12 + time * 2.5) * height * 0.04 +
		Math.sin(fx * 3 + time * 0.8) * height * 0.12 +
		Math.sin(fx * 18 + time * 3.5) * height * 0.02 +
		Math.sin(fx * 27 + time * 2.4) * height * 0.012 +
		Math.sin(fx * 44 - time * 3.2) * height * 0.006
	);
}

/** Undefined = sky. Do not paint it. */
function pixel(x: number, y: number, width: number, surface: number, time: number, height: number): RGB | undefined {
	const depth = y - surface;
	if (depth < -2) return undefined;
	const fx = x / width;
	if (depth < 0) {
		const foam = clamp(Math.sin(fx * 20 + time * 3) * 0.5 + 0.5, 0, 1);
		const spark = Math.sin(fx * 46 + time * 5);
		if (depth < -1.15 && spark > 0.35) return undefined;
		const brightness = 0.88 + foam * 0.12;
		return rgb(220 * brightness, 240 * brightness, 255 * brightness);
	}
	const depthRatio = clamp(depth / (height * 0.5), 0, 1);
	const shade = depthRatio * depthRatio * (3 - 2 * depthRatio);
	const underwater = Math.sin(fx * 8 + y * 0.05 + time * 1.2) * 0.08;
	const ripple = Math.sin(fx * 19 + y * 0.42 + time * 1.7) * 0.04;
	const t = clamp(shade + underwater + ripple, 0, 1);
	// Crest stays light cyan. Lower water goes deeper blue, still short of navy-black.
	return rgb(58 + (14 - 58) * t, 178 + (64 - 178) * t, 244 + (128 - 244) * t);
}

/** Yellow swim ring. Outer radius in pixels; one pixel is one column by half a row. */
const RING_OUTER = 3.1;
const RING_INNER = 1.15;
/** Independent chance the ring appears for this run. Rolled once when the banner is created. */
const BUOY_CHANCE = 0.5;
/** Columns per second. Faster than a drift: the current carries it right to left with the waves. */
const DRIFT = 11;
/** Seconds the ring stays off the right before it first enters. */
const ENTER_DELAY = 1.25;
/** Seconds fully off-screen between leaving the left and entering from the right again. */
const REENTRY_GAP = 2;
/** Foam rim past the tube. */
const RIM = RING_OUTER + 1.05;

type Buoy = { x: number; y: number };

function mix(a: RGB, b: RGB, t: number): RGB {
	return rgb(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

/** Top-down: the ring lies flat on open water below the foam, rising and falling with the swell. */
function buoyState(width: number, height: number, time: number): Buoy {
	// Sit just off the right until ENTER_DELAY, drift across, then sit just off the right again
	// for REENTRY_GAP. The jump from off the left back to that spot paints nothing.
	const enterX = width - 1 + RIM;
	const leaveX = -RIM;
	const cross = (enterX - leaveX) / DRIFT;
	const cycle = cross + REENTRY_GAP;
	let x = enterX;
	if (time > ENTER_DELAY) {
		const phase = (time - ENTER_DELAY) % cycle;
		if (phase < cross) x = enterX - phase * DRIFT;
	}

	const swell = surfaceAt(clamp(x, 0, width - 1), width, height, time);
	const y = clamp(swell + RING_OUTER + 2.6 + Math.sin(time * 3.1) * 0.25, RING_OUTER + 1, height - RING_OUTER - 0.6);
	return { x, y };
}

/** Flat donut seen from above, lit from upper left, with a contact shadow and a little foam at the rim. */
function buoyPixel(x: number, y: number, buoy: Buoy, water: RGB | undefined, time: number): RGB | undefined {
	const dx = x - buoy.x;
	const dy = y - buoy.y;
	const d = Math.hypot(dx, dy);

	if (d > RING_OUTER) {
		if (!water) return undefined;
		const sd = Math.hypot(dx - 0.7, dy - 0.8);
		if (sd <= RING_OUTER + 0.2) return mix(water, [6, 28, 70], 0.45);
		if (d <= RING_OUTER + 1.05) {
			const angle = Math.atan2(dy, dx);
			const fleck = Math.sin(angle * 4 + time * 7) + Math.sin(angle * 7 - time * 5) * 0.6;
			if (fleck > 1.15) return mix(water, [230, 248, 255], 0.85);
		}
		return undefined;
	}
	if (d < RING_INNER) return undefined;

	const mid = (RING_OUTER + RING_INNER) / 2;
	const tube = (d - mid) / ((RING_OUTER - RING_INNER) / 2);
	const nx = (dx / (d || 1)) * tube;
	const ny = (dy / (d || 1)) * tube;
	const nz = Math.sqrt(Math.max(0, 1 - tube * tube));
	const light = clamp(-nx * 0.45 - ny * 0.6 + nz * 0.65, 0, 1);

	let color = light < 0.5 ? mix([186, 112, 10], [255, 200, 26], light * 2) : mix([255, 200, 26], [255, 240, 150], (light - 0.5) * 2);
	if (light > 0.9 && ny < 0 && nx < 0.2) color = [255, 252, 225];
	return color;
}

function specFor(top: RGB | undefined, bot: RGB | undefined): { code: string; ch: string } | undefined {
	if (!top && !bot) return undefined;
	if (top && bot) return { code: `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[48;2;${bot[0]};${bot[1]};${bot[2]}m`, ch: "▀" };
	if (top) return { code: `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[49m`, ch: "▀" };
	return { code: `\x1b[38;2;${bot![0]};${bot![1]};${bot![2]}m\x1b[49m`, ch: "▄" };
}

function oceanFrame(width: number, time: number, withBuoy: boolean): string[] {
	if (width <= 0) return [];
	const height = ROWS * 2;
	const surface = new Float64Array(width);
	for (let x = 0; x < width; x++) surface[x] = surfaceAt(x, width, height, time);
	const buoy = withBuoy ? buoyState(width, height, time) : undefined;

	const lines: string[] = [];
	for (let row = 0; row < ROWS; row++) {
		const y0 = row * 2;
		let line = "";
		let open = "";
		for (let x = 0; x < width; x++) {
			const waterTop = pixel(x, y0, width, surface[x]!, time, height);
			const waterBot = pixel(x, y0 + 1, width, surface[x]!, time, height);
			const top = buoy ? (buoyPixel(x, y0, buoy, waterTop, time) ?? waterTop) : waterTop;
			const bot = buoy ? (buoyPixel(x, y0 + 1, buoy, waterBot, time) ?? waterBot) : waterBot;
			const cell = specFor(top, bot);
			if (!cell) {
				if (open) {
					line += "\x1b[0m";
					open = "";
				}
				line += " ";
				continue;
			}
			if (cell.code !== open) {
				line += cell.code;
				open = cell.code;
			}
			line += cell.ch;
		}
		// 49/39, not only SGR 0. A later EL (\x1b[2K) paints with the current background,
		// and a truecolor water background here is what covers the prompt border.
		lines.push(open ? `${line}\x1b[49m\x1b[39m\x1b[0m` : line);
	}
	return lines;
}

class OceanBanner implements Component {
	private tui: TUI;
	private timer: ReturnType<typeof setInterval> | undefined;
	private start = Date.now();
	private stopped = false;
	private readonly withBuoy = Math.random() < BUOY_CHANCE;

	constructor(tui: TUI) {
		this.tui = tui;
		this.timer = setInterval(() => {
			if (!this.stopped) this.tui.requestRender();
		}, FRAME_MS);
		this.timer.unref?.();
	}

	invalidate(): void {}

	dispose(): void {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	render(width: number): string[] {
		return oceanFrame(width, (Date.now() - this.start) / 1000, this.withBuoy);
	}
}

let ui: ExtensionUIContext | undefined;
let visible = false;
/** Hide for the current run only. The next agent_start clears this and shows the ocean. */
let suppressed = false;

const CHROME = Symbol.for("val.pi.ocean.chrome");
const KEYS = Symbol.for("val.pi.ocean.keys.v2");
const TOGGLE_KEY = Key.ctrlShift("h");
const LEGACY_CTRL_H = "\x08";
const KITTY_CTRL_SHIFT_H = "\x1b[104;6u";

type NativeHelper = { isModifierPressed?(key: string): boolean };
let nativeHelper: NativeHelper | null | undefined;

/** Pi's own Windows helper (the one it uses for Shift+Enter). Not exported by pi-tui, so load it by path. */
function loadNativeHelper(): NativeHelper | undefined {
	if (nativeHelper !== undefined) return nativeHelper ?? undefined;
	nativeHelper = null;
	if (process.platform !== "win32" || !process.argv[1]) return undefined;
	try {
		const req = createRequire(process.argv[1]);
		const tuiEntry = req.resolve("@earendil-works/pi-tui");
		nativeHelper = req(join(dirname(tuiEntry), "..", "native", "win32", "prebuilds", `win32-${process.arch}`, "win32-platform.node"));
	} catch {
		nativeHelper = null;
	}
	return nativeHelper ?? undefined;
}

function modifierHeld(key: "control" | "shift"): boolean {
	try {
		return loadNativeHelper()?.isModifierPressed?.(key) === true;
	} catch {
		return false;
	}
}

type EditorHost = {
	render(width: number): string[];
};

/**
 * Row kept above the prompt border while the ocean is up.
 * The dock clips the ocean from the bottom, so the last visible wave row is
 * sometimes the crest and sometimes sky. That row is full width and sets a
 * truecolor background. The next dirty row is erased with that background,
 * which is the prompt's top rule whenever the spinner repaints it. This row
 * is part of the editor, so it survives that clip, and the stamp changes every
 * frame so the erase lands here instead of on the border. One column short:
 * a full-width line arms pending wrap and can eat the ╭.
 */
let shieldStamp = 0;

function shieldLine(width: number): string {
	shieldStamp = (shieldStamp + 1) >>> 0;
	const cols = Math.max(0, width - 1);
	return `\x1b[0m\x1b[49m\x1b[39m${" ".repeat(cols)}\x1b_ocean-shield:${shieldStamp}\x07`;
}

type WidgetHost = {
	renderWidgetContainer(
		container: unknown,
		widgets: unknown,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void;
};

/**
 * While the ocean is up, keep the prompt's top rule and put a clear row above it.
 * Drop the blank row Pi inserts above an aboveEditor widget so the sky meets the chat.
 */
function installChrome(): void {
	const editorProto = CustomEditor.prototype as unknown as EditorHost & { [CHROME]?: boolean };
	if (!editorProto[CHROME]) {
		const parentRender = (Object.getPrototypeOf(editorProto) as EditorHost).render;
		editorProto.render = function (this: EditorHost, width: number): string[] {
			const lines = parentRender.call(this, width);
			if (!visible || width <= 0 || lines.length === 0) return lines;
			lines.unshift(shieldLine(width));
			return lines;
		};
		editorProto[CHROME] = true;
	}

	const modeProto = InteractiveMode.prototype as unknown as WidgetHost & { [CHROME]?: boolean };
	if (!modeProto[CHROME]) {
		const original = modeProto.renderWidgetContainer;
		modeProto.renderWidgetContainer = function (container, widgets, spacerWhenEmpty, leadingSpacer) {
			if (visible && leadingSpacer) leadingSpacer = false;
			return original.call(this, container, widgets, spacerWhenEmpty, leadingSpacer);
		};
		modeProto[CHROME] = true;
	}
}

/**
 * Kitty reports the key press and the key release as two matches for ctrl+shift+h.
 * The shortcut handler cannot tell them apart, so a press toggled the ocean and the
 * release toggled it straight back. Swallow release and repeat here. The press still
 * reaches the registered shortcut.
 *
 * Windows Terminal has no Kitty keyboard protocol, so ctrl+shift+h arrives as plain
 * ctrl+h (0x08) and never matches. When Ctrl and Shift are physically held, rewrite
 * it to the Kitty press sequence so the registered shortcut fires.
 */
function installToggleKey(): void {
	const proto = CustomEditor.prototype as unknown as {
		handleInput(data: string): void;
		[KEYS]?: boolean;
	};
	if (proto[KEYS]) return;
	const original = proto.handleInput;
	proto.handleInput = function (this: unknown, data: string): void {
		if (data === LEGACY_CTRL_H && modifierHeld("control") && modifierHeld("shift")) data = KITTY_CTRL_SHIFT_H;
		if (matchesKey(data, TOGGLE_KEY) && (isKeyRelease(data) || isKeyRepeat(data))) return;
		return original.call(this, data);
	};
	proto[KEYS] = true;
}

function show(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || suppressed) return;
	ui = ctx.ui;
	if (visible) return;
	visible = true;
	installChrome();
	ctx.ui.setWidget(WIDGET, (tui) => new OceanBanner(tui), { placement: "aboveEditor" });
}

function toggle(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ui = ctx.ui;
	if (ctx.isIdle()) {
		ctx.ui.notify("Ocean shows on the next run", "info");
		return;
	}
	if (visible) {
		suppressed = true;
		hide();
		ctx.ui.notify("Ocean hidden for this run", "info");
		return;
	}
	suppressed = false;
	show(ctx);
	ctx.ui.notify("Ocean on", "info");
}

function hide(): void {
	if (!visible || !ui) return;
	visible = false;
	ui.setWidget(WIDGET, undefined);
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut(Key.ctrlShift("h"), {
		description: "Toggle ocean for this run",
		handler: (ctx) => toggle(ctx),
	});
	pi.registerCommand("toggle-animation", {
		description: "Toggle ocean for this run. Next run shows it again.",
		handler: async (_args, ctx) => toggle(ctx),
	});
	installToggleKey();
	pi.on("session_start", (_event, ctx) => {
		installChrome();
		if (!ctx.isIdle()) show(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		suppressed = false;
		show(ctx);
	});
	pi.on("agent_end", hide);
	pi.on("session_shutdown", () => {
		suppressed = false;
		hide();
	});
}
