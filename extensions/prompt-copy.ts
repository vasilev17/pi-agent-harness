/**
 * Ctrl+D copies the whole prompt box to the clipboard when it has text.
 * Ctrl+C still clears the box. Alt+V pastes that copy back.
 * An empty box still exits.
 *
 * Pi's running editor is not the CustomEditor class extensions import, so a
 * prototype patch never saw the key. This replaces the live editor instead.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRepeat, type EditorTheme, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

let notify: Notify | undefined;

function copyPrompt(text: string): void {
	const file = join(tmpdir(), `pi-prompt-${randomUUID()}.txt`);
	writeFileSync(file, text, "utf8");
	const path = file.replaceAll("'", "''");
	try {
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Set-Clipboard -Value ([IO.File]::ReadAllText('${path}', [Text.Encoding]::UTF8))`,
			],
			{ windowsHide: true, timeout: 8000 },
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			const detail = result.stderr?.toString("utf8").trim();
			throw new Error(detail || `Set-Clipboard exited ${result.status}`);
		}
	} finally {
		try {
			unlinkSync(file);
		} catch {
			/* already gone */
		}
	}
}

class PromptCopyEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
	}

	override handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.exit") && this.getText().length > 0) {
			if (!isKeyRepeat(data)) {
				try {
					copyPrompt(this.getText());
					notify?.("Copied prompt", "info");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					notify?.(`Copy failed: ${message}`, "error");
				}
			}
			return;
		}
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		notify = (message, type) => ctx.ui.notify(message, type);
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new PromptCopyEditor(tui, theme, keybindings),
		);
	});
}
