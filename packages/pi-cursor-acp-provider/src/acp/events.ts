import type { SessionNotification } from "@agentclientprotocol/sdk";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "plan" | "status"; text: string }
	| { type: "tool"; tool: CursorToolUpdate }
	| { type: "unknown"; updateType: string };

/** One `tool_call` or `tool_call_update`. Omitted fields keep their previous values. */
export interface CursorToolUpdate {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: string;
	content?: unknown[];
	rawOutput?: unknown;
	/** File paths named by this update: locations, raw input, or a diff. */
	paths?: string[];
}

export function cursorActionRequired(modelId: string, delta: string): string | undefined {
	if (delta.trim().toLowerCase() !== "check your settings to continue") return undefined;
	if (/fable/iu.test(modelId)) {
		return "Cursor requires acceptance of Claude Fable 5/5.1's data-retention policy before this model can run. Open the Cursor web dashboard, go to Settings → Models/Model Access → Claude Fable 5.1 → View Policy, review and accept it, then retry. For a team account, an administrator may need to accept it. The provider cannot accept this policy on your behalf. See https://cursor.com/docs/models/claude-fable-5";
	}
	return "Cursor blocked this request pending an account or model setting. Open Cursor Settings or the Cursor web dashboard, resolve the requested setting, and retry.";
}

export function mapSessionUpdate(notification: SessionNotification): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk": return update.content.type === "text" ? [{ type: "text", delta: update.content.text }] : [];
		case "agent_thought_chunk": return update.content.type === "text" ? [{ type: "thought", delta: update.content.text }] : [];
		case "tool_call":
		case "tool_call_update": {
			const paths = toolPaths(update);
			return [{ type: "tool", tool: {
				toolCallId: update.toolCallId,
				...(update.title ? { title: clean(update.title) } : {}),
				...(update.kind ? { kind: update.kind } : {}),
				...(update.status ? { status: update.status } : {}),
				...(Array.isArray(update.content) ? { content: update.content.slice(0, 8).map(cleanDiff) } : {}),
				...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
				...(paths.length ? { paths } : {}),
			} }];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Cursor plan]\n${lines.join("\n")}\n` }] : [];
		}
		case "current_mode_update": return [{ type: "status", text: `\n[Cursor mode: ${clean(update.currentModeId)}]\n` }];
		default: return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

/**
 * Cursor rebuilds a write's diff from a unified patch, so its old and new text can open
 * with the `--- /dev/null` and `+++ b/file` header lines, one character shorter.
 */
function cleanDiff(item: unknown): unknown {
	if (!item || typeof item !== "object" || Array.isArray(item)) return item;
	const record = item as Record<string, unknown>;
	if (record.type !== "diff") return item;
	return {
		...record,
		...(typeof record.oldText === "string" ? { oldText: dropPatchHeader(record.oldText, "-- ") } : {}),
		...(typeof record.newText === "string" ? { newText: dropPatchHeader(record.newText, "++ ") } : {}),
	};
}

function dropPatchHeader(text: string, marker: string): string {
	const [first, ...rest] = text.split("\n");
	if (!first?.startsWith(marker)) return text;
	const target = first.slice(marker.length).trim();
	return target === "/dev/null" || /^[ab]\//u.test(target) ? rest.join("\n") : text;
}

function clean(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000); }

const PATH_INPUT_KEYS = ["path", "file_path", "filePath", "target_file", "target_notebook"] as const;

/** Paths a tool update names, so the row can show the file before its title does. */
function toolPaths(update: { locations?: ReadonlyArray<{ path?: string | null }> | null; rawInput?: unknown; content?: ReadonlyArray<unknown> | null }): string[] {
	const paths: string[] = [];
	const push = (value: unknown) => {
		if (typeof value !== "string" || !value.trim()) return;
		const path = clean(value.trim());
		if (path && !paths.includes(path)) paths.push(path);
	};
	for (const location of update.locations ?? []) push(location?.path);
	const raw = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput) ? update.rawInput as Record<string, unknown> : undefined;
	if (raw) for (const key of PATH_INPUT_KEYS) push(raw[key]);
	for (const item of update.content ?? []) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") push(record.path);
	}
	return paths.slice(0, 8);
}
