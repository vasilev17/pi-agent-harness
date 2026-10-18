/**
 * Enter while a prompt runs waits, then sends.
 * Steer injects at the next tool handoff, before the running answer prints.
 * Hold the text until that run finishes, then send it. Label stays "Queued:".
 */

import { AgentSession, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Spacer, TruncatedText } from "@earendil-works/pi-tui";

const PATCH = Symbol.for("val.pi.queued-label");

type ThemeFg = { fg(name: string, text: string): string };

type PromptOptions = {
	streamingBehavior?: "steer" | "followUp";
	[key: string]: unknown;
};

type Host = {
	pendingMessagesContainer: { clear(): void; addChild(child: unknown): void };
	getAllQueuedMessages(): { steering: string[]; followUp: string[] };
	getAppKeyDisplay(action: string): string;
	updatePendingMessagesDisplay(): void;
	queueCompactionMessage(text: string, mode: "steer" | "followUp"): void;
};

let theme: ThemeFg | undefined;

function install(): void {
	const proto = InteractiveMode.prototype as unknown as Host & { [PATCH]?: boolean };
	if (proto[PATCH]) return;

	const sessionProto = AgentSession.prototype as AgentSession & { [PATCH]?: boolean };
	if (!sessionProto[PATCH]) {
		const originalPrompt = sessionProto.prompt;
		sessionProto.prompt = function (this: AgentSession, text: string, options?: PromptOptions) {
			if (this.isStreaming && options?.streamingBehavior === "steer") {
				return originalPrompt.call(this, text, { ...options, streamingBehavior: "followUp" });
			}
			return originalPrompt.call(this, text, options);
		};
		sessionProto[PATCH] = true;
	}

	// Text sent while compaction runs is queued on a separate path. It waits the same way.
	const originalQueue = proto.queueCompactionMessage;
	proto.queueCompactionMessage = function (this: Host, text: string, mode: "steer" | "followUp") {
		return originalQueue.call(this, text, mode === "steer" ? "followUp" : mode);
	};

	proto.updatePendingMessagesDisplay = function (this: Host) {
		this.pendingMessagesContainer.clear();
		const { steering, followUp } = this.getAllQueuedMessages();
		const queued = [...steering, ...followUp];
		if (queued.length === 0) return;
		const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
		this.pendingMessagesContainer.addChild(new Spacer(1));
		for (const message of queued) {
			this.pendingMessagesContainer.addChild(new TruncatedText(dim(`Queued: ${message}`), 1, 0));
		}
		const hint = dim(`↳ ${this.getAppKeyDisplay("app.message.dequeue")} to edit all queued messages`);
		this.pendingMessagesContainer.addChild(new TruncatedText(hint, 1, 0));
	};
	proto[PATCH] = true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		theme = ctx.ui.theme;
		install();
	});
}
