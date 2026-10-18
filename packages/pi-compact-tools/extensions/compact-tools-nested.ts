import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { chromePainter, nestedCountPainter, nestedTitlePainter } from "./compact-tools-palette.ts";

const SUMMARY_KEY = Symbol.for("pi-compact-tools.nested-summaries.v1");
const MAX_PARENTS = 2_000;
const MAX_CALLS = 256;
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 1_024;
type Status = "ok" | "error" | "unfinished";
type Call = { name: string; status: Status };
type Summary = { calls: Map<string, Call>; partial: boolean; finished: boolean; live: boolean; revision: object };
type Shared = typeof globalThis & { [SUMMARY_KEY]?: Map<string, Summary> };
type NestedEvent = { toolCallId: string; toolName: string; parentToolCallId?: string; isError?: boolean; result?: unknown };

/** UI-only, bounded bookkeeping. Never retain arguments, results, or full diffs. */
export class NestedCallSummaries {
	private readonly summaries: Map<string, Summary>;

	constructor() {
		const shared = globalThis as Shared;
		this.summaries = shared[SUMMARY_KEY] ??= new Map();
	}

	clear(): void {
		this.summaries.clear();
	}

	begin(id: string, name: string): void {
		if (name !== "codemode" || id.length > MAX_ID_LENGTH) return;
		this.summaries.delete(id);
		this.summaries.set(id, { calls: new Map(), partial: false, finished: false, live: true, revision: {} });
		this.trim();
	}

	finish(id: string): void {
		const summary = this.summaries.get(id);
		if (summary) {
			summary.finished = true;
			summary.revision = {};
		}
	}

	/** A revision is also read at draw time, so even a late child end cannot freeze a footer. */
	revision(id: string): object | undefined {
		return this.summaries.get(id)?.revision;
	}

	/** Host-assigned descendant ids are `<caller id>/<n>`; retain the whole provider root id. */
	private root(parent: string): string | undefined {
		let id = parent;
		while (id) {
			if (this.summaries.has(id)) return id;
			const slash = id.lastIndexOf("/");
			if (slash < 0) return undefined;
			id = id.slice(0, slash);
		}
		return undefined;
	}

	/** Returns true only when a finished parent needs a fresh terminal frame. */
	note(event: NestedEvent, ended: boolean): boolean {
		if (typeof event.parentToolCallId !== "string" || event.parentToolCallId.length > MAX_ID_LENGTH) return false;
		const root = this.root(event.parentToolCallId);
		const summary = root === undefined ? undefined : this.summaries.get(root);
		if (!summary) return false;
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string"
			|| event.toolCallId.length > MAX_ID_LENGTH || event.toolName.length > MAX_NAME_LENGTH) {
			if (!summary.partial) { summary.partial = true; summary.revision = {}; }
			return summary.finished;
		}
		const previous = summary.calls.get(event.toolCallId);
		// A duplicate start must not turn an already settled call back into a running one.
		if (!ended && previous) return false;
		if (!previous && summary.calls.size >= MAX_CALLS) {
			if (!summary.partial) { summary.partial = true; summary.revision = {}; }
			return summary.finished;
		}
		const status = ended ? event.isError ? "error" : "ok" : "unfinished";
		if (previous?.name === event.toolName && previous.status === status) return false;
		summary.calls.set(event.toolCallId, { name: event.toolName, status });
		summary.live = true;
		summary.revision = {};
		return summary.finished;
	}

	/** Pi persists `{calls: [{id, name, status}], complete}`, deliberately without results. */
	restore(message: unknown): boolean {
		if (!message || typeof message !== "object") return false;
		const value = message as { role?: string; toolName?: string; toolCallId?: string; nestedCalls?: { calls?: unknown; complete?: unknown } };
		if (value.role !== "toolResult" || value.toolName !== "codemode" || typeof value.toolCallId !== "string"
			|| value.toolCallId.length > MAX_ID_LENGTH || !Array.isArray(value.nestedCalls?.calls)) return false;
		// A bounded persisted snapshot must not drop observed live calls.
		const existing = this.summaries.get(value.toolCallId);
		if (existing?.live && existing.calls.size > 0) return false;
		const summary: Summary = { calls: new Map(), partial: value.nestedCalls.complete !== true, finished: true, live: false, revision: {} };
		let inspected = 0;
		for (const item of value.nestedCalls.calls) {
			if (inspected++ >= MAX_CALLS) { summary.partial = true; break; }
			if (!item || typeof item !== "object") { summary.partial = true; continue; }
			const call = item as { id?: unknown; name?: unknown; status?: unknown };
			if (typeof call.id !== "string" || typeof call.name !== "string"
				|| call.id.length > MAX_ID_LENGTH || call.name.length > MAX_NAME_LENGTH
				|| (call.status !== "ok" && call.status !== "error" && call.status !== "unfinished")) { summary.partial = true; continue; }
			if (!summary.calls.has(call.id) && summary.calls.size >= MAX_CALLS) { summary.partial = true; break; }
			summary.calls.set(call.id, { name: call.name, status: call.status as Status });
		}
		this.summaries.set(value.toolCallId, summary);
		this.trim();
		return true;
	}

	/** The live branch only, never abandoned entries; callers clear on non-reload session changes. */
	restoreBranch(entries: readonly unknown[]): void {
		for (const entry of entries) {
			if (entry && typeof entry === "object") this.restore((entry as { message?: unknown }).message);
		}
	}

	/** Other tool groups keep first-occurrence order; edit counts always come last. */
	format(id: string, theme: Theme, _expanded = false): string | undefined {
		const summary = this.summaries.get(id);
		if (!summary || (summary.calls.size === 0 && !summary.partial)) return undefined;
		type Group = { name: string; calls: Call[] };
		const groups: Group[] = [];
		const byTool = new Map<string, Group>();
		for (const call of summary.calls.values()) {
			const key = call.name;
			let group = byTool.get(key);
			if (!group) {
				group = { name: call.name, calls: [] };
				byTool.set(key, group);
				groups.push(group);
			}
			group.calls.push(call);
		}
		const editIndex = groups.findIndex((group) => group.name === "edit");
		if (editIndex >= 0) groups.push(...groups.splice(editIndex, 1));
		const title = nestedTitlePainter(theme);
		const chrome = chromePainter(theme);
		const success = nestedCountPainter(theme, "success");
		const error = nestedCountPainter(theme, "error");
		const warning = nestedCountPainter(theme, "warning");
		const parts = groups.map((group) => {
			const name = stripTerminalSequences(group.name).replace(/[\x00-\x20\x7f-\x9f]/gu, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "").trim() || "tool";

			const successes = group.calls.filter((call) => call.status === "ok").length;
			const failures = group.calls.filter((call) => call.status === "error").length;
			const unfinished = group.calls.filter((call) => call.status === "unfinished").length;
			const counts = [successes ? success(String(successes)) : "",
				failures ? error(String(failures)) : ""].filter(Boolean);
			const settled = counts.length > 0;
			if (!settled) counts.push(warning(String(unfinished)));
			return title(name) + chrome(" ") + counts.join(chrome(" "))
				+ (settled && unfinished ? chrome(" ") + warning(`${unfinished} unfinished`) : "");
		});
		const partial = summary.partial || [...summary.calls.values()].some((call) => call.status === "unfinished");
		return parts.join(chrome(" · ")) + (partial ? (parts.length ? " " : "") + warning("(partial)") : "");
	}

	private trim(): void {
		if (this.summaries.size <= MAX_PARENTS) return;
		for (const [id, summary] of this.summaries) {
			if (summary.finished) { this.summaries.delete(id); return; }
		}
		const oldest = this.summaries.keys().next().value;
		if (oldest !== undefined) this.summaries.delete(oldest);
	}
}
