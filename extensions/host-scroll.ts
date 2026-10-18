/**
 * While Pi's TUI is up, the mouse wheel must not scroll the host terminal.
 * Pi already owns the viewport. Alternate-scroll is the mode that turns the
 * wheel into terminal history. Hiding the scrollbar leaves its track as gaps,
 * so the bar stays and only that mode is turned off.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOCK = "\x1b[?1007l";
const UNLOCK = "\x1b[?1007h";

let locked = false;

function lockHostScroll(): void {
	if (!process.stdout.isTTY || locked) return;
	process.stdout.write(LOCK);
	locked = true;
}

function unlockHostScroll(): void {
	if (!locked || !process.stdout.isTTY) return;
	process.stdout.write(UNLOCK);
	locked = false;
}

export default function (pi: ExtensionAPI) {
	process.on("exit", unlockHostScroll);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !process.stdout.isTTY) return;
		lockHostScroll();
	});

	pi.on("session_shutdown", unlockHostScroll);
}
