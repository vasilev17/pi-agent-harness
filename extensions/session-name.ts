/**
 * `/name` with no arguments prints the same label `/resume` shows.
 *
 * Another window on this session writes a new `session_info` into the file.
 * This window keeps the name it loaded at start, so `/name` used to print that
 * stale name. `/resume` reads the file, so it already showed the new one.
 * A bare `/name` now reads the file too. `/name <name>` still sets the name.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.session-name");

type SessionEntry = {
	type?: string;
	name?: string;
	message?: { role?: string; content?: unknown };
};

type DiskLabel = {
	name?: string;
	firstMessage?: string;
};

type NameHost = {
	sessionManager: {
		getSessionName(): string | undefined;
		getSessionFile(): string | undefined;
		getEntries(): SessionEntry[];
	};
	chatContainer: { addChild(child: unknown): void };
	ui: { requestRender(): void };
	handleNameCommand(text: string): void;
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => (block as { text?: string }).text ?? "")
		.join(" ");
}

function clean(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").trim();
}

/** Same label `/resume` shows when the session has no stored name. */
function resumeLabel(entries: SessionEntry[]): string {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = clean(textOf(entry.message.content));
		if (text) return text;
	}
	return "(no messages)";
}

/**
 * Latest `session_info` name and first user message, same rules as `/resume`.
 * An empty name clears the title. Returns undefined when the file cannot be read.
 */
function readDiskLabel(filePath: string | undefined): DiskLabel | undefined {
	if (!filePath) return undefined;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	let name: string | undefined;
	let firstMessage: string | undefined;
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line) as SessionEntry;
		} catch {
			continue;
		}
		if (entry.type === "session_info") {
			name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
			continue;
		}
		if (firstMessage || entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = clean(textOf(entry.message.content));
		if (text) firstMessage = text;
	}
	return { name, firstMessage };
}

function install(): () => void {
	const proto = InteractiveMode.prototype as unknown as NameHost & Record<PropertyKey, { restore(): void } | undefined>;
	proto[PATCH]?.restore();

	const original = proto.handleNameCommand;
	const handleNameCommand = function (this: NameHost, text: string): void {
		const requested = text.replace(/^\/name\s*/, "").trim();
		if (requested) {
			original.call(this, text);
			return;
		}
		const disk = readDiskLabel(this.sessionManager.getSessionFile());
		const label = disk
			? (disk.name ?? disk.firstMessage ?? "(no messages)")
			: (this.sessionManager.getSessionName() ?? resumeLabel(this.sessionManager.getEntries()));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`\x1b[90mSession name: ${label}\x1b[0m`, 1, 0));
		this.ui.requestRender();
	};

	proto.handleNameCommand = handleNameCommand;
	const record = {
		restore() {
			if (proto.handleNameCommand === handleNameCommand) proto.handleNameCommand = original;
			if (proto[PATCH] === record) delete proto[PATCH];
		},
	};
	proto[PATCH] = record;
	return record.restore;
}

export default function (pi: ExtensionAPI) {
	let restore: (() => void) | undefined;

	pi.on("session_start", () => {
		restore?.();
		restore = install();
	});

	pi.on("session_shutdown", () => {
		restore?.();
		restore = undefined;
	});
}
