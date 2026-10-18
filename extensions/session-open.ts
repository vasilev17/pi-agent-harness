/**
 * Green dot in `/resume` for a session some Pi on this machine has loaded.
 *
 * Pi does not record that. Each process writes `~/.pi/agent/session-open/<pid>`
 * on session start and removes it on shutdown. A dead pid is dropped on the
 * next read. The dot is the same `⦁` compact tool rows use, in the success color,
 * placed after the tree prefix and before the session name.
 * This Pi's session is first and focused on open. Other live sessions follow it.
 * Sort order applies to the sessions under that live group.
 * Ctrl+R rename keeps an existing name and leaves the cursor at the end of it.
 * After save or cancel, the highlight stays on the session that was renamed
 * until the user moves it. A reload that builds the list in pages cannot
 * replace that highlight with whatever row lands on the old index.
 *
 * This file draws the rows. Pi's own `SessionList.render` is not used.
 * An unnamed title is the last whole word that fits in 32 characters, with no
 * ellipsis from that cut. The bracket stays right-aligned, with at least 20%
 * of the window between the name and the bracket. When that no longer fits,
 * the bracket drops the first path segment, then the path, then the prompt
 * count, then the bracket itself. Only that last state truncates the name.
 */

import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, InteractiveMode, keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.session-open");
const LIST_PATCH = Symbol.for("val.pi.session-open.list");
const STATE = Symbol.for("val.pi.session-open.state");

/** Compact tool rows use this spot, painted with the success color. */
const OPEN_DOT = "⦁";
const CACHE_MS = 300;

type ThemePaint = {
	fg(name: string, text: string): string;
	bold(text: string): string;
	bg(name: string, text: string): string;
	style(text: string, options: { fg?: string; bg?: string; bold?: boolean }): string;
};

type SessionRow = {
	session: {
		path: string;
		name?: string;
		firstMessage: string;
		modified: Date;
		messageCount: number;
		cwd?: string;
	};
	depth: number;
	isLast: boolean;
	ancestorContinues: boolean[];
};

type SessionList = {
	filteredSessions: SessionRow[];
	selectedIndex: number;
	selectionTouched: boolean;
	maxVisible: number;
	nameFilter: string;
	showCwd: boolean;
	showPath: boolean;
	confirmingDeletePath: string | null;
	searchInput: { render(width: number): string[] };
	isCurrentSessionPath(path: string): boolean;
	getSelectedSessionPath(): string | undefined;
	buildTreePrefix(node: SessionRow): string;
	filterSessions(query: string): void;
	setSessions(sessions: unknown, showCwd: boolean): void;
	handleInput(data: string): void;
	render(width: number): string[];
};

const RENAME_FOCUS = Symbol.for("val.pi.session-open.rename-focus");

type RenameFocused = SessionList & { [RENAME_FOCUS]?: string };

type RenameInput = { getValue(): string; cursor: number };

type RenameHost = {
	enterRenameMode(sessionPath: string, currentName?: string): void;
	renameInput?: RenameInput;
	sessionList?: SessionList;
};

type ShowSelector = (create: (done: () => void) => {
	component?: { getSessionList?: () => SessionList };
}) => void;

type Mode = {
	sessionManager: { getSessionFile(): string | undefined };
	showSelector: ShowSelector;
	showSessionSelector(): void;
};

type Shared = { theme?: ThemePaint };

type ListProto = {
	render: (this: SessionList, width: number) => string[];
	filterSessions?: (this: SessionList, query: string) => void;
	setSessions?: (this: SessionList, sessions: unknown, showCwd: boolean) => void;
	handleInput?: (this: SessionList, data: string) => void;
	[LIST_PATCH]?: { restore(): void };
};

const RENAME_PATCH = Symbol.for("val.pi.session-open.rename");

type RenameProto = RenameHost & { [RENAME_PATCH]?: { restore(): void } };

function shared(): Shared {
	const g = globalThis as typeof globalThis & { [STATE]?: Shared };
	return (g[STATE] ??= {});
}

export function markerDir(): string {
	return join(getAgentDir(), "session-open");
}

function markerFile(): string {
	return join(markerDir(), String(process.pid));
}

export function sessionKey(file: string): string {
	let full: string;
	try {
		full = realpathSync(file);
	} catch {
		full = resolve(file);
	}
	return process.platform === "win32" ? full.toLowerCase() : full;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		return code === "EPERM";
	}
}

let cacheAt = 0;
let cache = new Set<string>();

export function openSessionKeys(refresh = false): Set<string> {
	const now = Date.now();
	if (!refresh && now - cacheAt < CACHE_MS) return cache;
	const next = new Set<string>();
	let names: string[] = [];
	try {
		names = readdirSync(markerDir());
	} catch {
		cache = next;
		cacheAt = now;
		return next;
	}
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		const file = join(markerDir(), name);
		if (!pidAlive(pid)) {
			try {
				unlinkSync(file);
			} catch {
				// another read already removed it
			}
			continue;
		}
		let text = "";
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const sessionPath = text.trim();
		if (!sessionPath || sessionPath.length > 4096) continue;
		next.add(sessionKey(sessionPath));
	}
	cache = next;
	cacheAt = now;
	return next;
}

export function publishSession(file: string | undefined): void {
	if (!file) return;
	mkdirSync(markerDir(), { recursive: true });
	writeFileSync(markerFile(), file, "utf8");
	cacheAt = 0;
}

export function clearSession(): void {
	try {
		unlinkSync(markerFile());
	} catch {
		// already gone
	}
	cacheAt = 0;
}

let exitHooked = false;

function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.on("exit", clearSession);
}

function formatSessionDate(date: Date): string {
	const diffMs = Date.now() - date.getTime();
	if (diffMs < 60_000) return "now";
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 60) return `${diffMins} min`;
	const diffHours = Math.floor(diffMs / 3_600_000);
	if (diffHours < 24) return diffHours === 1 ? "1 hour" : `${diffHours} hours`;
	const diffDays = Math.floor(diffMs / 86_400_000);
	if (diffDays < 7) return diffDays === 1 ? "1 day" : `${diffDays} days`;
	if (diffDays < 30) {
		const weeks = Math.floor(diffDays / 7);
		return weeks === 1 ? "1 week" : `${weeks} weeks`;
	}
	if (diffDays < 365) {
		const months = Math.floor(diffDays / 30);
		return months === 1 ? "1 month" : `${months} months`;
	}
	const years = Math.floor(diffDays / 365);
	return years === 1 ? "1 year" : `${years} years`;
}

/** Last whole word that fits in 32 characters. No ellipsis from this cut. */
function autoSessionTitle(text: string): string {
	const clean = String(text || "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= 32) return clean;
	const slice = clean.slice(0, 32);
	const space = slice.lastIndexOf(" ");
	return space > 0 ? slice.slice(0, space) : slice;
}

function sessionMetaOptions(cwd: string | undefined, count: string, age: string, showPath: boolean): string[] {
	const prompts = `Prompts: ${count}`;
	const ageText = `Age: ${age}`;
	const options: string[] = [];
	if (showPath) {
		const parts = String(cwd || "")
			.split(/[\\/]+/)
			.filter((part) => part && !/^[A-Za-z]:$/.test(part));
		const last = parts.slice(-2);
		if (last.length === 2) options.push(`[\\${last.join("\\")} | ${prompts} | ${ageText}]`);
		if (last.length >= 1) options.push(`[\\${last[last.length - 1]} | ${prompts} | ${ageText}]`);
	}
	options.push(`[${prompts} | ${ageText}]`, `[${ageText}]`);
	return options;
}

const promptCounts = new Map<string, { mtimeMs: number; count: number }>();

/** User messages with content. `messageCount` counts every message entry. */
function userPromptCount(file: string, fallback: number): number {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(file).mtimeMs;
	} catch {
		return fallback;
	}
	const cached = promptCounts.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.count;
	let count = 0;
	try {
		const text = readFileSync(file, "utf8");
		for (const line of text.split("\n")) {
			if (!line.includes('"user"')) continue;
			const trimmed = line.trim();
			if (!trimmed) continue;
			let entry: { type?: string; message?: { role?: string } };
			try {
				entry = JSON.parse(trimmed) as { type?: string; message?: { role?: string } };
			} catch {
				continue;
			}
			const message = entry.message;
			if (entry.type !== "message" || !message || typeof message.role !== "string" || !("content" in message)) continue;
			if (message.role === "user") count++;
		}
	} catch {
		return fallback;
	}
	promptCounts.set(file, { mtimeMs, count });
	return count;
}

function paint(theme: ThemePaint, text: string, fg: string | undefined, selected: boolean, bold = false): string {
	if (!text) return "";
	if (!selected && !fg && !bold) return text;
	return theme.style(text, {
		...(fg ? { fg } : {}),
		...(selected ? { bg: "selectedBg" } : {}),
		...(bold ? { bold: true } : {}),
	});
}

export function renderSessions(list: SessionList, width: number, theme: ThemePaint): string[] {
	const lines: string[] = [];
	lines.push(...list.searchInput.render(width));
	lines.push("");
	if (list.filteredSessions.length === 0) {
		let emptyMessage: string;
		if (list.nameFilter === "named") {
			const toggleKey = keyText("app.session.toggleNamedFilter");
			emptyMessage = list.showCwd
				? `  No named sessions found. Press ${toggleKey} to show all.`
				: `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
		} else if (list.showCwd) {
			emptyMessage = "  No sessions found";
		} else {
			emptyMessage = "  No sessions in current folder. Press Tab to view all.";
		}
		lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
		return lines;
	}
	const open = openSessionKeys();
	const startIndex = Math.max(
		0,
		Math.min(list.selectedIndex - Math.floor(list.maxVisible / 2), list.filteredSessions.length - list.maxVisible),
	);
	const endIndex = Math.min(startIndex + list.maxVisible, list.filteredSessions.length);
	for (let i = startIndex; i < endIndex; i++) {
		const node = list.filteredSessions[i]!;
		const session = node.session;
		const isSelected = i === list.selectedIndex;
		const isConfirmingDelete = session.path === list.confirmingDeletePath;
		const isCurrent = list.isCurrentSessionPath(session.path);
		const prefix = list.buildTreePrefix(node);
		const normalizedMessage = (session.name ?? autoSessionTitle(session.firstMessage))
			.replace(/[\x00-\x1f\x7f]/g, " ")
			.trim();
		const age = formatSessionDate(session.modified);
		const count = String(userPromptCount(session.path, session.messageCount));
		const minGap = Math.max(1, Math.floor(width * 0.2));
		const markText = isCurrent || open.has(sessionKey(session.path)) ? `${OPEN_DOT} ` : "";
		const prefixWidth = visibleWidth(prefix);
		const markWidth = visibleWidth(markText);
		const nameWidth = visibleWidth(normalizedMessage);
		const room = width - 2 - prefixWidth - markWidth;
		let rightPart = "";
		for (const meta of sessionMetaOptions(session.cwd, count, age, list.showPath)) {
			if (nameWidth + minGap + visibleWidth(meta) <= room) {
				rightPart = meta;
				break;
			}
		}
		const showMeta = rightPart.length > 0;
		let messageColor: string | undefined;
		if (isConfirmingDelete) messageColor = "error";
		else if (isCurrent) messageColor = "accent";
		const truncatedMsg = showMeta ? normalizedMessage : room > 0 ? truncateToWidth(normalizedMessage, room, "...") : "";
		const metaWidth = showMeta ? visibleWidth(rightPart) : 0;
		const gap = showMeta ? Math.max(minGap, room - visibleWidth(truncatedMsg) - metaWidth) : 0;
		const cursor = paint(theme, isSelected ? "› " : "  ", isSelected ? "accent" : undefined, isSelected);
		const styledPrefix = paint(theme, prefix, prefix ? "dim" : undefined, isSelected);
		const styledMark = paint(theme, markText, markText ? "success" : undefined, isSelected);
		const styledMsg = paint(theme, truncatedMsg, messageColor, isSelected, isSelected);
		const gapText = gap > 0 ? paint(theme, " ".repeat(gap), undefined, isSelected) : "";
		const styledRight = showMeta ? paint(theme, rightPart, isConfirmingDelete ? "error" : "dim", isSelected) : "";
		let line = cursor + styledPrefix + styledMark + styledMsg + gapText + styledRight;
		const pad = width - visibleWidth(line);
		if (pad > 0) line += paint(theme, " ".repeat(pad), undefined, isSelected);
		lines.push(truncateToWidth(line, width));
	}
	if (startIndex > 0 || endIndex < list.filteredSessions.length) {
		const scrollText = `  (${list.selectedIndex + 1}/${list.filteredSessions.length})`;
		lines.push(theme.fg("muted", truncateToWidth(scrollText, width, "")));
	}
	return lines;
}

function liftLive(node: SessionRow): SessionRow {
	node.depth = 0;
	node.isLast = true;
	node.ancestorContinues = [];
	return node;
}

/**
 * This Pi's session first, then other sessions open on this machine, in the
 * order the sort already gave them. Everything else stays in that sort order
 * underneath. Focus stays on this Pi's session until the user moves.
 */
export function pinCurrentSession(list: SessionList, selectedPath: string | undefined): void {
	const open = openSessionKeys();
	const current: SessionRow[] = [];
	const live: SessionRow[] = [];
	const rest: SessionRow[] = [];
	for (const node of list.filteredSessions) {
		if (list.isCurrentSessionPath(node.session.path)) current.push(liftLive(node));
		else if (open.has(sessionKey(node.session.path))) live.push(liftLive(node));
		else rest.push(node);
	}
	const sessions = [...current, ...live, ...rest];
	list.filteredSessions = sessions;
	if (!list.selectionTouched && !renameFocusPath(list)) {
		list.selectedIndex = 0;
		return;
	}
	selectSession(list, renameFocusPath(list) ?? selectedPath);
}

/** Path of the session being renamed, kept until the user moves the highlight. */
export function renameFocusPath(list: SessionList): string | undefined {
	return (list as RenameFocused)[RENAME_FOCUS];
}

export function setRenameFocus(list: SessionList, path: string): void {
	(list as RenameFocused)[RENAME_FOCUS] = path;
}

export function clearRenameFocus(list: SessionList): void {
	delete (list as RenameFocused)[RENAME_FOCUS];
}

/** Select `path` after a reload. Missing from a partial list leaves the index alone. */
export function selectSession(list: SessionList, path: string | undefined): boolean {
	if (!path) return false;
	const wanted = sessionKey(path);
	const selectedIndex = list.filteredSessions.findIndex((node) => sessionKey(node.session.path) === wanted);
	if (selectedIndex < 0) return false;
	list.selectedIndex = selectedIndex;
	return true;
}

function isMoveKey(data: string): boolean {
	const kb = getKeybindings();
	return (
		kb.matches(data, "tui.select.up") ||
		kb.matches(data, "tui.select.down") ||
		kb.matches(data, "tui.select.pageUp") ||
		kb.matches(data, "tui.select.pageDown")
	);
}

/** Named rename starts at the end of the existing name. An empty name stays empty. */
export function placeRenameCursor(input: RenameInput, currentName: string | undefined): void {
	if (!currentName?.trim()) return;
	input.cursor = input.getValue().length;
}

function patchList(list: SessionList): void {
	const proto = Object.getPrototypeOf(list) as ListProto | null;
	if (
		!proto ||
		typeof proto.render !== "function" ||
		typeof proto.filterSessions !== "function" ||
		typeof proto.setSessions !== "function" ||
		typeof proto.handleInput !== "function"
	)
		return;
	proto[LIST_PATCH]?.restore();
	const originalRender = proto.render;
	const originalFilter = proto.filterSessions;
	const originalSetSessions = proto.setSessions;
	const originalHandleInput = proto.handleInput;
	const render = function (this: SessionList, width: number): string[] {
		const theme = shared().theme;
		if (!theme) return originalRender.call(this, width);
		try {
			return renderSessions(this, width, theme);
		} catch {
			return originalRender.call(this, width);
		}
	};
	const filterSessions = function (this: SessionList, query: string): void {
		const selectedPath = renameFocusPath(this) ?? (this.selectionTouched ? this.getSelectedSessionPath() : undefined);
		originalFilter.call(this, query);
		pinCurrentSession(this, selectedPath);
	};
	const setSessions = function (this: SessionList, sessions: unknown, showCwd: boolean): void {
		originalSetSessions.call(this, sessions, showCwd);
		selectSession(this, renameFocusPath(this));
	};
	const handleInput = function (this: SessionList, data: string): void {
		if (isMoveKey(data)) clearRenameFocus(this);
		originalHandleInput.call(this, data);
	};
	proto.render = render;
	proto.filterSessions = filterSessions;
	proto.setSessions = setSessions;
	proto.handleInput = handleInput;
	const record = {
		restore() {
			if (proto.render === render) proto.render = originalRender;
			if (proto.filterSessions === filterSessions) proto.filterSessions = originalFilter;
			if (proto.setSessions === setSessions) proto.setSessions = originalSetSessions;
			if (proto.handleInput === handleInput) proto.handleInput = originalHandleInput;
			if (proto[LIST_PATCH] === record) delete proto[LIST_PATCH];
		},
	};
	proto[LIST_PATCH] = record;
}

function patchRename(component: object): void {
	const proto = Object.getPrototypeOf(component) as RenameProto | null;
	if (!proto || typeof proto.enterRenameMode !== "function") return;
	proto[RENAME_PATCH]?.restore();
	const original = proto.enterRenameMode;
	const enterRenameMode = function (this: RenameHost, sessionPath: string, currentName?: string): void {
		original.call(this, sessionPath, currentName);
		if (this.sessionList) setRenameFocus(this.sessionList, sessionPath);
		if (this.renameInput) placeRenameCursor(this.renameInput, currentName);
	};
	proto.enterRenameMode = enterRenameMode;
	const record = {
		restore() {
			if (proto.enterRenameMode === enterRenameMode) proto.enterRenameMode = original;
			if (proto[RENAME_PATCH] === record) delete proto[RENAME_PATCH];
		},
	};
	proto[RENAME_PATCH] = record;
}

function install(): void {
	const proto = InteractiveMode.prototype as unknown as Mode & { [PATCH]?: { restore(): void } };
	proto[PATCH]?.restore();
	const original = proto.showSessionSelector;
	const showSessionSelector = function (this: Mode): void {
		try {
			publishSession(this.sessionManager.getSessionFile());
		} catch {
			// the selector still opens without a marker
		}
		const hadOwn = Object.prototype.hasOwnProperty.call(this, "showSelector");
		const own = this.showSelector;
		this.showSelector = (create) =>
			own.call(this, (done) => {
				const created = create(done);
				const list = created?.component?.getSessionList?.();
				if (list) patchList(list);
				if (created?.component) patchRename(created.component);
				return created;
			});
		try {
			original.call(this);
		} finally {
			if (hadOwn) this.showSelector = own;
			else delete (this as { showSelector?: ShowSelector }).showSelector;
		}
	};
	proto.showSessionSelector = showSessionSelector;
	const record = {
		restore() {
			if (proto.showSessionSelector === showSessionSelector) proto.showSessionSelector = original;
			if (proto[PATCH] === record) delete proto[PATCH];
		},
	};
	proto[PATCH] = record;
}

export default function (pi: ExtensionAPI) {
	hookExit();
	pi.on("session_start", (_event, ctx) => {
		shared().theme = ctx.ui.theme;
		publishSession(ctx.sessionManager.getSessionFile());
		install();
	});
	pi.on("session_shutdown", () => {
		clearSession();
	});
}
