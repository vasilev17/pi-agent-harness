/**
 * Reload status is orange. Other status lines stay dim.
 * The in-progress line inside the reload box uses the same orange.
 * Orange is the theme string color (dark theme: okhsl 52).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.reload-color");
const LINE = Symbol.for("val.pi.reload-color.line");
const STATE = Symbol.for("val.pi.reload-color.state");
const FG = Symbol.for("val.pi.reload-color.fg");
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

type ThemeFg = { fg(name: string, text: string): string };

type Host = {
	chatContainer: { children: unknown[]; addChild(child: unknown): void; removeChild(child: unknown): void };
	lastStatusMessage: string;
	lastStatusText: unknown;
	lastStatusSpacer: unknown;
	ui: { requestRender(): void };
	showStatus(message: string): void;
};

type Paint = { current?: ThemeFg };

function shared(): Paint {
	const g = globalThis as typeof globalThis & { [STATE]?: Paint };
	return (g[STATE] ??= {});
}

function isReload(message: string): boolean {
	return message.startsWith("Reloaded ");
}

function color(message: string): string {
	const theme = shared().current;
	if (!theme) return message;
	if (!isReload(message)) return theme.fg("dim", message);
	// A theme without a syntaxString color throws. 208 is the xterm-256 orange.
	try {
		return theme.fg("syntaxString", message);
	} catch {
		return `\x1b[38;5;208m${message}\x1b[39m`;
	}
}

class StatusLine {
	readonly [LINE] = true;

	constructor(private readonly host: Host) {}

	invalidate(): void {}

	render(width: number): string[] {
		return new Text(color(this.host.lastStatusMessage ?? ""), 1, 0).render(width);
	}
}

/**
 * The reload box draws its in-progress line with `theme.fg("muted", …)` and offers no
 * hook, so the shared Theme prototype is patched for that one string only.
 */
function installReloadTextColor(): void {
	const instance = (globalThis as typeof globalThis & { [THEME_KEY]?: object })[THEME_KEY];
	if (!instance) return;
	const proto = Object.getPrototypeOf(instance) as {
		fg?: (color: string, text: string) => string;
		[FG]?: boolean;
	};
	if (!proto || proto[FG] || typeof proto.fg !== "function") return;
	const original = proto.fg;
	proto.fg = function (this: unknown, color: string, text: string) {
		if (color === "muted" && text.startsWith("Reloading keybindings")) {
			return original.call(this, "syntaxString", text);
		}
		return original.call(this, color, text);
	};
	proto[FG] = true;
}

function install(): void {
	const proto = InteractiveMode.prototype as unknown as Host & { [PATCH]?: boolean };
	if (proto[PATCH]) return;
	// Same collapsing as Pi's own showStatus: a status right after another replaces it.
	// The line reads its text and color at render time, so a theme switch repaints it.
	proto.showStatus = function (this: Host, message: string) {
		const children = this.chatContainer.children;
		const last = children[children.length - 1];
		const secondLast = children[children.length - 2];
		const updating = last !== undefined && secondLast !== undefined && last === this.lastStatusText && secondLast === this.lastStatusSpacer;
		if (updating && !!last && (last as { [LINE]?: boolean })[LINE] === true) {
			this.lastStatusMessage = message;
			this.ui.requestRender();
			return;
		}
		if (updating) {
			this.chatContainer.removeChild(last);
			this.chatContainer.removeChild(secondLast);
		}
		const spacer = new Spacer(1);
		const line = new StatusLine(this);
		this.lastStatusMessage = message;
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(line);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = line;
		this.ui.requestRender();
	};
	proto[PATCH] = true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		shared().current = ctx.ui.theme;
		installReloadTextColor();
		install();
	});
}
