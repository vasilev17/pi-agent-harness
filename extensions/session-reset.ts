/**
 * Let `/resume` delete the session that is open, then start a fresh one.
 * Any other terminal still sitting on that file does the same once the file is gone.
 *
 * `/new` already starts a fresh session and leaves the old file in `/resume`.
 * This only changes what happens after a delete.
 *
 * The new session must stay persistent. `newSession()` reads `isPersisted()` on
 * the session it is leaving, so clearing `persist` first would make the
 * replacement an in-memory session with no file.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PATCH = Symbol.for("val.pi.session-reset");

type SessionList = {
	filteredSessions: { session: { path: string } }[];
	selectedIndex: number;
	onDeleteSession?: (sessionPath: string) => Promise<void> | void;
	isCurrentSessionPath(path: string): boolean;
	setConfirmingDeletePath(path: string | null): void;
	startDeleteConfirmationForSelectedSession(): void;
};

type SelectorComponent = {
	getSessionList?: () => SessionList;
};

type ShowSelector = (create: (done: () => void) => { component?: SelectorComponent }) => void;

type Mode = {
	sessionManager: {
		getSessionFile(): string | undefined;
	};
	editor?: { setText?(text: string): void; getText?(): string };
	chatContainer: { addChild(child: unknown): void };
	ui: { requestRender(): void };
	showError(message: string): void;
	clearStatusIndicator?(): void;
	pendingUserInputs?: unknown[];
	runtimeHost: { newSession(): Promise<{ cancelled?: boolean }> };
	showSelector: ShowSelector;
	updateAvailableProviderCount(): void;
};

type DeleteResult = { ok: true } | { ok: false; error: string };

/** `dev:ino` from `stat` with bigint. Stable across append and rewrite, new after delete+create. */
type Identity = string;

let mode: Mode | undefined;
let closeSelector: (() => void) | undefined;
let resetting = false;
let watchedPath: string | undefined;
let seenIdentity: Identity | undefined;
let generation = 0;
let watcher: FSWatcher | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function samePath(a: string, b: string): boolean {
	return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function stopWatch(): void {
	generation++;
	watchedPath = undefined;
	seenIdentity = undefined;
	watcher?.close();
	watcher = undefined;
	if (timer) clearInterval(timer);
	timer = undefined;
}

function identityOf(file: string): Identity | undefined {
	try {
		const stat = statSync(file, { bigint: true });
		if (!stat.isFile()) return undefined;
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
}

function sameBase(file: string, reported: string | null): boolean {
	if (!reported) return true;
	return basename(reported).toLowerCase() === basename(file).toLowerCase();
}

/** Watch the open session file. A path that was never written is not a delete. */
function arm(next: Mode): void {
	if (resetting) return;
	const file = next.sessionManager.getSessionFile();
	if (!file) {
		stopWatch();
		return;
	}
	if (file === watchedPath && timer) return;
	stopWatch();
	watchedPath = file;
	seenIdentity = identityOf(file);
	const gen = generation;
	const tick = (reported?: string | null) => {
		if (gen !== generation || resetting) return;
		if (reported !== undefined && !sameBase(file, reported)) return;
		const identity = identityOf(file);
		if (identity) {
			if (seenIdentity && identity !== seenIdentity) {
				resetting = true;
				void resetDeleted(next, file, seenIdentity);
				return;
			}
			seenIdentity = identity;
			return;
		}
		if (!seenIdentity) return;
		resetting = true;
		void resetDeleted(next, file, seenIdentity);
	};
	try {
		watcher = watch(dirname(file), { persistent: false }, (_event, reported) => tick(reported));
		watcher.on("error", () => {});
	} catch {
		watcher = undefined;
	}
	timer = setInterval(() => tick(), 400);
	timer.unref?.();
}

function notify(next: Mode): void {
	next.chatContainer.addChild(new Spacer(1));
	next.chatContainer.addChild(new Text("\x1b[32mSession deleted. New session started.\x1b[0m", 1, 0));
	next.ui.requestRender();
}

function clearDraft(next: Mode): string {
	const draft = next.editor?.getText?.() ?? "";
	next.editor?.setText?.("");
	if (Array.isArray(next.pendingUserInputs)) next.pendingUserInputs.length = 0;
	next.clearStatusIndicator?.();
	return draft;
}

/**
 * Switch to a real new session, then remove `file` if it is still there.
 * `previous` is the identity we were watching. The same identity means the
 * delete report was a false alarm and this session stays.
 */
async function resetDeleted(next: Mode, file: string, previous: Identity | undefined): Promise<void> {
	stopWatch();
	try {
		const identity = identityOf(file);
		if (identity && previous && identity === previous) return;
		closeSelector?.();
		const draft = clearDraft(next);
		const result = await next.runtimeHost.newSession();
		if (result?.cancelled) {
			if (draft) next.editor?.setText?.(draft);
			next.showError("Session file was deleted, but starting a new session was cancelled.");
			return;
		}
		const current = next.sessionManager.getSessionFile();
		if (!current || samePath(current, file)) {
			next.showError("New session did not switch away from the deleted file. Session file was kept.");
			return;
		}
		if (existsSync(file)) {
			const removed = await removeSessionFile(file);
			if (!removed.ok) {
				next.showError(`New session started, but the old session file stayed: ${removed.error}`);
			}
		}
		notify(next);
	} catch (error) {
		next.showError(`Session file was deleted, but the new session failed: ${messageOf(error)}`);
	} finally {
		resetting = false;
		if (mode) arm(mode);
	}
}

/** Same order as Pi's own delete: `trash` when it exists, otherwise unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteResult> {
	if (!existsSync(sessionPath)) return { ok: true };
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8", windowsHide: true });
	if (trashResult.status === 0 || !existsSync(sessionPath)) return { ok: true };
	try {
		await unlink(sessionPath);
		return { ok: true };
	} catch (error) {
		const unlinkError = messageOf(error);
		const trashError = trashResult.error?.message ?? trashResult.stderr?.trim().split("\n")[0];
		return { ok: false, error: trashError ? `${unlinkError} (${trashError})` : unlinkError };
	}
}

async function replaceAfterDelete(next: Mode, done: () => void, sessionPath: string): Promise<void> {
	if (resetting) return;
	resetting = true;
	stopWatch();
	try {
		done();
		const draft = clearDraft(next);
		const result = await next.runtimeHost.newSession();
		if (result?.cancelled) {
			if (draft) next.editor?.setText?.(draft);
			next.showError("New session was cancelled. Session file was kept.");
			return;
		}
		const current = next.sessionManager.getSessionFile();
		if (!current || samePath(current, sessionPath)) {
			next.showError("New session did not switch away from the deleted file. Session file was kept.");
			return;
		}
		const removed = await removeSessionFile(sessionPath);
		notify(next);
		if (!removed.ok) {
			next.showError(`New session started, but the old session file stayed: ${removed.error}`);
		}
	} catch (error) {
		next.showError(`Failed to start a new session: ${messageOf(error)}`);
	} finally {
		resetting = false;
		if (mode) arm(mode);
	}
}

function allowCurrentDelete(list: SessionList): void {
	list.startDeleteConfirmationForSelectedSession = function (this: SessionList) {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;
		this.setConfirmingDeletePath(selected.session.path);
	};
}

function hookList(list: SessionList, next: Mode, done: () => void): void {
	allowCurrentDelete(list);
	const original = list.onDeleteSession;
	list.onDeleteSession = async (sessionPath: string) => {
		if (list.isCurrentSessionPath(sessionPath)) {
			await replaceAfterDelete(next, done, sessionPath);
			return;
		}
		await original?.(sessionPath);
	};
}

function install(): () => void {
	const proto = InteractiveMode.prototype as unknown as Mode & Record<PropertyKey, { restore(): void } | undefined>;
	proto[PATCH]?.restore();

	const originalShow = proto.showSelector;
	const originalCount = proto.updateAvailableProviderCount;

	const showSelector: ShowSelector = function (this: Mode, create) {
		return originalShow.call(this, (done) => {
			const wrappedDone = () => {
				if (closeSelector === wrappedDone) closeSelector = undefined;
				done();
			};
			closeSelector = wrappedDone;
			const created = create(wrappedDone);
			const list = created?.component?.getSessionList?.();
			if (list) hookList(list, this, wrappedDone);
			return created;
		});
	};

	const updateAvailableProviderCount = function (this: Mode) {
		mode = this;
		arm(this);
		return originalCount.call(this);
	};

	proto.showSelector = showSelector;
	proto.updateAvailableProviderCount = updateAvailableProviderCount;

	const record = {
		restore() {
			if (proto.showSelector === showSelector) proto.showSelector = originalShow;
			if (proto.updateAvailableProviderCount === updateAvailableProviderCount) {
				proto.updateAvailableProviderCount = originalCount;
			}
			if (proto[PATCH] === record) delete proto[PATCH];
			stopWatch();
			mode = undefined;
			closeSelector = undefined;
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
		if (mode) arm(mode);
	});

	pi.on("session_shutdown", () => {
		stopWatch();
		restore?.();
		restore = undefined;
	});
}
