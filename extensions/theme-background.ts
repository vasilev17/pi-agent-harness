/**
 * Paint the terminal's default background with the active theme's export.pageBg
 * while Pi is running, then restore the terminal color on exit.
 *
 * Theme JSON has no full-window background. Text and a few widgets set their
 * own colors, and empty cells keep the terminal default. OSC 11 changes that
 * default for this terminal session only. OSC 111 puts the profile color back.
 * Classic conhost (cmd.exe window) ignores both; Windows Terminal honors them.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { colorToHex, parseColor } from "@earendil-works/pi-tui";

type ThemeLike = { name?: string; sourcePath?: string };

let applied = false;

function pageBackground(theme: ThemeLike): string | undefined {
	if (!theme.sourcePath) return undefined;
	try {
		const json = JSON.parse(readFileSync(theme.sourcePath, "utf8")) as { vars?: Record<string, unknown>; export?: { pageBg?: unknown } };
		const raw = json.export?.pageBg;
		if (typeof raw !== "string" || raw === "") return undefined;
		const value = json.vars?.[raw] ?? raw;
		return typeof value === "string" && value !== "" ? colorToHex(parseColor(value)) : undefined;
	} catch {
		return undefined;
	}
}

function restore(): void {
	if (!applied || !process.stdout.isTTY) return;
	applied = false;
	process.stdout.write("\x1b]111\x07");
}

export default function (pi: ExtensionAPI) {
	process.on("exit", restore);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
		const hex = pageBackground(ctx.ui.theme);
		if (!hex) return restore();
		process.stdout.write(`\x1b]11;${hex}\x07`);
		applied = true;
	});

	pi.on("session_shutdown", restore);
}
