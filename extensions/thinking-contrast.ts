/**
 * Thinking vs the answer.
 *
 * Pi already paints thinking with the thinkingText token and italic. On the
 * dark theme that gray sits next to muted UI text, and Windows Terminal often
 * draws italic as roman, so the two blocks look the same. Answer markdown has
 * no default text style. Thinking markdown sets italic. This patch flattens
 * only those italic blocks to one cool gray, and leaves the answer bright
 * with its syntax colors.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.thinking-contrast");
/** Slate, well under the dark theme's near-white answer text. Italic plus color. */
const THINKING = "\x1b[3;38;2;126;138;156m";
const RESET = "\x1b[23;39m";

type StyledMarkdown = {
	defaultTextStyle?: { italic?: boolean };
	render(width: number): string[];
};

function mute(line: string): string {
	const plain = stripTerminalSequences(line);
	if (plain.length === 0) return line;
	return THINKING + plain + RESET;
}

function install(): () => void {
	const proto = Markdown.prototype as unknown as StyledMarkdown & Record<PropertyKey, { restore(): void } | undefined>;
	proto[PATCH]?.restore();

	const original = proto.render;
	const render = function (this: StyledMarkdown, width: number): string[] {
		const lines = original.call(this, width);
		if (!this.defaultTextStyle?.italic) return lines;
		return lines.map(mute);
	};

	proto.render = render;
	const record = {
		restore() {
			if (proto.render === render) proto.render = original;
			if (proto[PATCH] === record) delete proto[PATCH];
		},
	};
	proto[PATCH] = record;
	return record.restore;
}

export default function (pi: ExtensionAPI) {
	let restore: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		restore?.();
		restore = undefined;
		if (ctx.mode !== "tui") return;
		restore = install();
	});

	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}
