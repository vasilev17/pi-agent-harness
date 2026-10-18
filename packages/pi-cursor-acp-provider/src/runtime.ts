import type {
	ContentBlock,
	InitializeResponse,
	NewSessionResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Context, Model, SimpleStreamOptions, ThinkingLevel, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import { CursorAcpConnection, type CursorConnectionOptions } from "./acp/connection.js";
import {
	describeExtensionNotification,
	parseExtensionInteraction,
	planDecision,
	questionCancelled,
	type CursorAskQuestion,
	type CursorCreatePlan,
} from "./acp/cursor-extension.js";
import { abortError, CursorAcpError } from "./acp/errors.js";
import { cursorActionRequired, mapSessionUpdate, type CursorToolUpdate } from "./acp/events.js";
import { AcpSessionStore } from "./acp/session-store.js";
import type { CursorAcpConfig, CursorMode, PermissionMode } from "./config.js";
import {
	CURSOR_TOOL_NAME,
	INTERACTION_RESULT_KIND,
	MANAGED_AUTH_MARKER,
	PERMISSION_TOOL_NAME,
	PLAN_TOOL_NAME,
	QUESTION_TOOL_NAME,
} from "./constants.js";
import { PiMcpBridge, piToolFingerprint, type PiToolInvocation } from "./mcp/bridge.js";
import {
	FALLBACK_DEFINITIONS,
	dedupeDefinitions,
	hasOptionValue,
	parseModelExtension,
	parseSessionModels,
	resolveReasoningConfig,
	type CursorModelDefinition,
} from "./models.js";
import { buildPromptParts, type PromptParts } from "./stream/context.js";
import { PiEventWriter } from "./stream/pi-events.js";
import { usageFromPrompt } from "./stream/usage.js";

const INTERACTION_TIMEOUT_MS = 5 * 60_000;
const TOOL_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;
const MAX_CURSOR_TOOLS = 200;

type CursorModel = Model<"cursor-acp">;
type InteractionKind = "permission" | "question" | "plan";

export type InteractionView =
	| { id: string; kind: "permission"; title: string; options: Array<{ id: string; label: string; kind: string }> }
	| { id: string; kind: "question"; title: string; questions: CursorAskQuestion["questions"] }
	| { id: string; kind: "plan"; title: string; plan: string; overview?: string };

/** The latest state of a tool Cursor ran, as the display-only Cursor row reads it. */
export interface CursorToolView {
	title: string;
	kind?: string;
	status?: string;
	content: unknown[];
	rawOutput?: unknown;
	/** Files this call named. The collapsed row shows these. */
	paths: string[];
	/** True once the row has been sent. Arguments cannot change after that. */
	shown: boolean;
	/** False while Cursor's turn is still running, so Pi draws the row and comes back for the rest. */
	terminate?: boolean;
}

export interface InteractionToolResult {
	kind: typeof INTERACTION_RESULT_KIND;
	requestId: string;
	response: Record<string, unknown>;
}

interface PendingInteraction {
	id: string;
	kind: InteractionKind;
	toolName: string;
	view: InteractionView;
	resolve: (response: never) => void;
	cancelResponse: Record<string, unknown>;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingPiTool {
	invocation: PiToolInvocation;
	resolve: (result: CallToolResult) => void;
	timer: ReturnType<typeof setTimeout>;
}

type BufferedActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "status"; text: string }
	| { type: "tool-ready" };

interface Binding {
	key: string;
	cwd: string;
	connection: CursorAcpConnection;
	initialize: InitializeResponse;
	session: NewSessionResponse;
	configOptions: SessionConfigOption[];
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	queue: Promise<void>;
	writer: PiEventWriter | undefined;
	interaction: PendingInteraction | undefined;
	pendingTools: Map<string, PendingPiTool>;
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	/** Cursor's tool call ids, mapped to the ids of their Pi rows. */
	cursorToolIds: Map<string, string>;
	/** Pi row ids handed to the agent so a finished call can be opened before the turn ends. */
	displayPendingIds: string[];
	/** Text and thinking that arrived between those handoffs, in order. */
	activityBuffer: BufferedActivity[];
	handoffTimer: ReturnType<typeof setTimeout> | undefined;
	promptInFlight: boolean;
	promptFinished: boolean;
	resumeWait: (() => void) | undefined;
	promptUsage: ReturnType<typeof usageFromPrompt> | undefined;
	promptStop: "stop" | "length";
	promptRawStop: string | undefined;
	promptFailed: unknown;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	/** Never prompted again: canceled, or closed. A canceled Cursor session still holds the prompt. */
	retired: boolean;
	piSessionId: string | undefined;
	restored: boolean;
	completedTurns: number;
	actionRequired: string | undefined;
}

export interface RuntimeSnapshot {
	bindings: number;
	config: CursorAcpConfig;
	models: number;
	processes: Array<{
		pid?: number;
		generation: number;
		sessionId: string;
		modelId: string;
		alive: boolean;
		restored: boolean;
		waitingFor?: InteractionKind;
		waitingForTools: number;
		agentVersion?: string;
		mcpHttp: boolean;
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
	}>;
}

export type CursorConnectionFactory = (options: CursorConnectionOptions) => CursorAcpConnection;

export class CursorRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	/** Mode, fast, and context chosen inside one Pi session. Missing fields keep the file default. */
	private readonly sessionCursor = new Map<string, { mode?: CursorMode; fast?: boolean; context?: string }>();
	private readonly sessionStore: AcpSessionStore;
	private readonly connectionFactory: CursorConnectionFactory;
	private definitions = new Map(FALLBACK_DEFINITIONS.map((item) => [item.id, item]));
	private readonly cursorTools = new Map<string, CursorToolView>();
	private disposed = false;
	private config: CursorAcpConfig;

	constructor(config: CursorAcpConfig, connectionFactory?: CursorConnectionFactory, sessionStore = new AcpSessionStore()) {
		this.config = { ...config };
		this.connectionFactory = connectionFactory ?? ((options) => new CursorAcpConnection(options));
		this.sessionStore = sessionStore;
	}

	stream(model: CursorModel, context: Context, options: SimpleStreamOptions = {}): PiEventWriter {
		const writer = new PiEventWriter(model);
		void this.runQueued(model, context, options, writer).catch((error: unknown) => writer.fail(error, options.signal?.aborted === true || isAbort(error)));
		return writer;
	}

	async discoverModels(apiKey?: string, signal?: AbortSignal): Promise<CursorModelDefinition[]> {
		this.assertActive();
		if (signal?.aborted) throw abortError();
		const connection = this.connectionFactory({
			cwd: process.cwd(),
			permissionMode: "prompt",
			...(apiKey && apiKey !== MANAGED_AUTH_MARKER ? { env: { ...process.env, CURSOR_API_KEY: apiKey } } : {}),
		});
		try {
			const initialize = await connection.initialize(signal);
			await authenticateCursor(connection, initialize, signal);
			const session = await connection.newSession(process.cwd(), signal);
			let definitions: CursorModelDefinition[] = [];
			try { definitions = parseModelExtension(await connection.listAvailableModels(session.sessionId, signal)); }
			catch { /* private extension is optional */ }
			if (!definitions.length) definitions = parseSessionModels(session);
			definitions = dedupeDefinitions(definitions);
			if (definitions.length) this.definitions = new Map(definitions.map((item) => [item.id, item]));
			return definitions.length ? definitions : FALLBACK_DEFINITIONS;
		} finally { await connection.close(); }
	}

	setDefinitions(definitions: readonly CursorModelDefinition[]): void {
		if (definitions.length) this.definitions = new Map(definitions.map((item) => [item.id, item]));
	}

	getInteraction(id: string): InteractionView | undefined {
		for (const binding of this.resolvedBindings) if (binding.interaction?.id === id) return binding.interaction.view;
		return undefined;
	}

	/** The final state of a Cursor tool row, handed out once to the tool that draws it. */
	takeCursorTool(id: string): CursorToolView | undefined {
		const view = this.cursorTools.get(id);
		this.cursorTools.delete(id);
		return view;
	}

	async updateConfig(config: CursorAcpConfig): Promise<void> {
		const rotate = config.permissions !== this.config.permissions || config.piTools !== this.config.piTools;
		this.config = { ...config };
		if (rotate) await this.closeBindings();
		else await Promise.allSettled([...this.resolvedBindings].map((binding) => this.applyConfiguration(binding, binding.modelId)));
	}

	/** Apply mode, fast, and context to one Pi session. Does not change the file or any other session. */
	async syncSessionCursor(piSessionId: string, cursor: { mode?: CursorMode; fast?: boolean; context?: string } | undefined): Promise<void> {
		if (cursor && (cursor.mode !== undefined || cursor.fast !== undefined || cursor.context !== undefined)) this.sessionCursor.set(piSessionId, { ...cursor });
		else this.sessionCursor.delete(piSessionId);
		const binding = [...this.resolvedBindings].find((item) => item.piSessionId === piSessionId);
		if (binding) await this.applyConfiguration(binding, binding.modelId);
	}

	clearSessions(): void { this.sessionStore.clear(); }

	async snapshot(verbose = false): Promise<RuntimeSnapshot> {
		const processes = await Promise.all([...this.bindings.values()].map(async (pending) => {
			const binding = await pending;
			return {
				...(binding.connection.process.pid === undefined ? {} : { pid: binding.connection.process.pid }),
				generation: binding.connection.process.generation,
				sessionId: binding.session.sessionId,
				modelId: binding.modelId,
				alive: binding.connection.process.alive,
				restored: binding.restored,
				...(binding.interaction ? { waitingFor: binding.interaction.kind } : {}),
				waitingForTools: binding.pendingTools.size,
				...(binding.initialize.agentInfo?.version ? { agentVersion: binding.initialize.agentInfo.version } : {}),
				mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
				ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
				...(verbose && binding.connection.process.stderrTail ? { stderrTail: binding.connection.process.stderrTail } : {}),
			};
		}));
		return { bindings: this.bindings.size, config: { ...this.config }, models: this.definitions.size, processes };
	}

	async close(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.closeBindings();
	}

	private async closeBindings(): Promise<void> {
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelInteraction(binding);
			cancelPiTools(binding, "Cursor session closed before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		await Promise.allSettled(pending.map(async (item) => {
			const binding = await item;
			await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
		}));
	}

	private async runQueued(model: CursorModel, context: Context, options: SimpleStreamOptions, writer: PiEventWriter): Promise<void> {
		this.assertActive();
		if (options.signal?.aborted) throw abortError();
		const persistent = Boolean(options.sessionId);
		const key = options.sessionId ? `sid:${options.sessionId}` : this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`;
		const tools = context.tools ?? [];
		let binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);

		if (this.isDisplayContinuation(binding, context)) {
			await this.resumeDisplay(binding, context, writer);
			return;
		}

		if (binding.interaction) {
			const pending = binding.interaction;
			const result = findInteractionResult(context, pending.id, pending.toolName);
			if (!result) {
				cancelInteraction(binding);
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				this.flushText(binding);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				binding.interaction = undefined;
				clearTimeout(pending.timer);
				pending.resolve(validateInteractionResponse(pending, result.response) as never);
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		if (binding.pendingTools.size) {
			const results = [...binding.pendingTools.values()].map((pending) => ({ pending, message: findToolResult(context, pending.invocation.id, pending.invocation.name) }));
			if (results.some((item) => !item.message)) {
				cancelPiTools(binding, "Pi continued without returning every requested tool result");
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				this.flushText(binding);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				for (const { pending, message } of results) {
					clearTimeout(pending.timer);
					binding.pendingTools.delete(pending.invocation.id);
					pending.resolve(toMcpToolResult(message as ToolResultMessage));
				}
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		if (binding.toolFingerprint !== piToolFingerprint(tools)) {
			await this.dropBinding(key, binding);
			binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);
		}

		let release!: () => void;
		// A prompt queued behind a canceled one must not run on that retired session:
		// Cursor still holds the canceled prompt there.
		for (;;) {
			const previous = binding.queue;
			binding.queue = new Promise((resolve) => { release = resolve; });
			await previous;
			if (!binding.retired) break;
			release();
			binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);
		}
		let completeTurn: (() => void) | undefined;
		try {
			if (context.messages.length < binding.messageCount || messagesFingerprint(context.messages.slice(0, binding.messageCount)) !== binding.historyFingerprint) {
				if (binding.piSessionId) this.sessionStore.remove(binding.piSessionId);
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model.id, options.apiKey, writer, tools, options.signal);
			}
			binding.writer = writer;
			const stopAbortWatch = this.watchAbort(binding, writer, options.signal);
			try {
			await this.applyConfiguration(binding, model.id, options.reasoning, options.signal);
			const fresh = binding.messageCount === 0;
			let unseenStart = binding.messageCount;
			const expected = context.messages[unseenStart];
			if (!fresh && expected?.role === "assistant" && binding.expectedAssistantFingerprint === messageFingerprint(expected)) unseenStart += 1;
			const parts = adaptPromptToCapabilities(buildPromptParts(context, fresh, unseenStart), binding.initialize);
			binding.pendingContextCount = context.messages.length;
			binding.pendingContextFingerprint = messagesFingerprint(context.messages);
			binding.actionRequired = undefined;
			binding.promptFailed = undefined;
			binding.activityBuffer = [];
			binding.promptInFlight = true;
			binding.promptFinished = false;
			binding.turnCompletion = new Promise((resolve) => { completeTurn = resolve; });
			const response = await binding.connection.prompt({ sessionId: binding.session.sessionId, prompt: parts.prompt }, options.signal);
			if (binding.abortRequested) throw abortError();
			if (binding.actionRequired) throw new CursorAcpError("action_required", binding.actionRequired);
			binding.promptFinished = true;
			binding.promptUsage = usageFromPrompt(response);
			binding.promptRawStop = response.stopReason;
			binding.promptStop = response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests" ? "length" : "stop";
			if (response.stopReason === "cancelled") throw abortError();
			const activeWriter = binding.writer && !binding.writer.finished ? binding.writer : !writer.finished ? writer : undefined;
			if (binding.displayPendingIds.length === 0 && activeWriter) {
				binding.writer = activeWriter;
				this.flushReady(binding);
			}
			if (binding.displayPendingIds.length === 0 && binding.writer && !binding.writer.finished) this.finishWriter(binding, binding.writer);
			this.wakeDisplay(binding);
			} finally {
				stopAbortWatch();
			}
		} catch (error) {
			const aborted = options.signal?.aborted === true || isAbort(error);
			const failure = aborted && !isAbort(error) ? abortError() : error;
			binding.promptFinished = true;
			binding.promptFailed = failure;
			binding.writer?.fail(failure, aborted);
			this.wakeDisplay(binding);
			if (aborted) this.retire(binding);
			else if (!binding.connection.process.alive || (error instanceof CursorAcpError && error.code === "action_required")) await this.dropBinding(key, binding);
			throw failure;
		} finally {
			completeTurn?.();
			binding.turnCompletion = undefined;
			binding.promptInFlight = false;
			binding.abortRequested = false;
			// After a display handoff, the binding writes to the next request's message. Leave that one open.
			if (binding.writer === writer) binding.writer = undefined;
			release();
			if (!persistent || binding.retired) await this.dropBinding(key, binding);
		}
	}

	/** A retired or failed binding is replaced. Concurrent callers share one creation. */
	private async getBinding(key: string, modelId: string, apiKey: string | undefined, writer: PiEventWriter, tools: NonNullable<Context["tools"]>, signal?: AbortSignal): Promise<Binding> {
		for (let existing = this.bindings.get(key); existing; existing = this.bindings.get(key)) {
			const binding = await existing.catch(() => undefined);
			if (binding && !binding.retired) return binding;
			if (this.bindings.get(key) === existing) this.bindings.delete(key);
		}
		const created: Promise<Binding> = this.createBinding(key, modelId, apiKey, writer, tools, signal).catch((error: unknown) => {
			if (this.bindings.get(key) === created) this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	/**
	 * Cursor keeps a canceled prompt in its session, and ACP has no way to remove it.
	 * Retire the session so the next prompt starts a new one from Pi's history,
	 * which leaves the canceled run out. Runs synchronously on Esc, before Pi can
	 * send the next prompt. An in-flight prompt closes the session once it settles.
	 */
	private retire(binding: Binding): void {
		if (binding.retired) return;
		binding.retired = true;
		if (binding.piSessionId) this.sessionStore.remove(binding.piSessionId, binding.session.sessionId);
		if (!binding.promptInFlight) void this.dropBinding(binding.key, binding);
	}

	/** Esc ends the open Pi message at once and retires the session. Cursor cancel still runs underneath. */
	private watchAbort(binding: Binding, writer: PiEventWriter, signal?: AbortSignal): () => void {
		if (!signal) return () => undefined;
		const abort = () => {
			this.retire(binding);
			if (!writer.finished) writer.fail(abortError(), true);
			if (binding.writer && !binding.writer.finished) binding.writer.fail(abortError(), true);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		return () => signal.removeEventListener("abort", abort);
	}

	private async createBinding(key: string, modelId: string, apiKey: string | undefined, writer: PiEventWriter, tools: NonNullable<Context["tools"]>, signal?: AbortSignal): Promise<Binding> {
		const cwd = process.cwd();
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const connection = this.connectionFactory({
			cwd,
			permissionMode: this.config.permissions,
			...(apiKey && apiKey !== MANAGED_AUTH_MARKER ? { env: { ...process.env, CURSOR_API_KEY: apiKey } } : {}),
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onPermission: (request) => this.requestPermission(binding, request),
				onExtensionRequest: (method, params) => this.requestExtension(binding, method, params),
				onExtensionNotification: (method, params) => this.consumeExtension(binding, method, params),
			},
		});
		try {
			const initialize = await connection.initialize();
			await authenticateCursor(connection, initialize, signal);
			if (this.config.piTools && tools.length && initialize.agentCapabilities?.mcpCapabilities?.http === true) {
				bridge = new PiMcpBridge({ tools, onCall: (invocation) => this.requestPiTool(binding, invocation) });
				await bridge.start();
			}
			const descriptor = bridge ? await bridge.start() : undefined;
			const mcpServers = descriptor ? [descriptor] : [];
			const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
			const saved = piSessionId ? this.sessionStore.get(piSessionId) : undefined;
			let session: NewSessionResponse | undefined;
			let restored = false;
			if (saved?.cwd === cwd && initialize.agentCapabilities?.loadSession === true) {
				try {
					const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal);
					session = { sessionId: saved.acpSessionId, ...loaded };
					restored = true;
				} catch { this.sessionStore.remove(saved.piSessionId); }
			}
			session ??= await connection.newSession(cwd, signal, mcpServers);
			const created: Binding = {
				key, cwd, connection, initialize, session,
				configOptions: session.configOptions ?? [],
				modelId,
				messageCount: restored && saved ? saved.messageCount : 0,
				historyFingerprint: restored && saved ? saved.historyFingerprint : messagesFingerprint([]),
				expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: messagesFingerprint([]),
				queue: Promise.resolve(), writer,
				interaction: undefined,
				pendingTools: new Map(), toolBatchTimer: undefined, cursorToolIds: new Map(),
				displayPendingIds: [], activityBuffer: [], handoffTimer: undefined,
				promptInFlight: false, promptFinished: false, resumeWait: undefined,
				promptUsage: undefined, promptStop: "stop", promptRawStop: undefined, promptFailed: undefined, bridge,
				toolFingerprint: piToolFingerprint(tools), turnCompletion: undefined,
				abortRequested: false, retired: false, piSessionId, restored,
				completedTurns: restored ? 1 : 0, actionRequired: undefined,
			};
			binding = created;
			await this.applyConfiguration(created, modelId, undefined, signal);
			this.resolvedBindings.add(created);
			void connection.process.exited.then(() => {
				this.resolvedBindings.delete(created);
				void bridge?.close();
				const current = this.bindings.get(key);
				if (current) void current.then((value) => value === created && this.bindings.delete(key));
			});
			return created;
		} catch (error) {
			await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private async applyConfiguration(binding: Binding, modelId: string, reasoning?: ThinkingLevel, signal?: AbortSignal): Promise<void> {
		let options = binding.configOptions;
		const modelOption = findOption(options, "model");
		if (modelOption && hasOptionValue(modelOption, modelId) && currentValue(modelOption) !== modelId) options = await binding.connection.setConfig(binding.session.sessionId, modelOption.id, modelId, signal);
		else if (!modelOption && binding.session.models?.currentModelId !== modelId) await binding.connection.setModel(binding.session.sessionId, modelId, signal);
		binding.modelId = modelId;

		const cursor = binding.piSessionId ? this.sessionCursor.get(binding.piSessionId) : undefined;
		const mode = cursor?.mode ?? this.config.mode;
		const fast = cursor && "fast" in cursor ? cursor.fast : this.config.fast;
		const context = cursor?.context ?? this.config.context;
		const modeOption = findOption(options, "mode");
		if (modeOption && hasOptionValue(modeOption, mode) && currentValue(modeOption) !== mode) options = await binding.connection.setConfig(binding.session.sessionId, modeOption.id, mode, signal);
		else if (!modeOption && binding.session.modes?.availableModes.some((item) => item.id === mode) && binding.session.modes.currentModeId !== mode) await binding.connection.setMode(binding.session.sessionId, mode, signal);

		for (const desired of [
			...resolveReasoningConfig(options, reasoning),
			...(context ? [{ id: "context", value: context }] : []),
			...(fast === undefined ? [] : [{ id: "fast", value: fast }]),
		]) {
			const option = options.find((item) => item.id === desired.id);
			if (option && hasOptionValue(option, desired.value) && currentValue(option) !== desired.value) options = await binding.connection.setConfig(binding.session.sessionId, option.id, desired.value, signal);
		}
		binding.configOptions = options;
	}

	private requestPermission(binding: Binding | undefined, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		if (!binding?.writer || binding.interaction || request.sessionId !== binding.session.sessionId) return Promise.resolve({ outcome: { outcome: "cancelled" } });
		if (this.config.permissions === "full-access") {
			const option = request.options.find((item) => item.kind === "allow_always") ?? request.options.find((item) => item.kind === "allow_once");
			if (option) return Promise.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
		}
		const call = request.toolCall;
		return this.beginInteraction(binding, "permission", PERMISSION_TOOL_NAME, {
			id: "", kind: "permission",
			title: `${call.title ?? "Cursor requests permission"}\n\n${JSON.stringify({ kind: call.kind, locations: call.locations, content: call.content, rawInput: call.rawInput }, null, 2).slice(0, 8_000)}`,
			options: request.options.map((item) => ({ id: item.optionId, label: item.name, kind: item.kind })),
		}, { outcome: { outcome: "cancelled" } });
	}

	private requestExtension(binding: Binding | undefined, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const interaction = parseExtensionInteraction(method, params);
		if (!binding?.writer || binding.interaction) return Promise.resolve(interaction.kind === "question" ? questionCancelled() : planDecision(false));
		if (interaction.kind === "question") {
			return this.beginInteraction(binding, "question", QUESTION_TOOL_NAME, {
				id: "", kind: "question", title: interaction.request.title ?? "Cursor asks a question", questions: interaction.request.questions,
			}, questionCancelled());
		}
		return this.beginInteraction(binding, "plan", PLAN_TOOL_NAME, {
			id: "", kind: "plan", title: interaction.request.name ?? "Cursor plan approval", plan: interaction.request.plan,
			...(interaction.request.overview ? { overview: interaction.request.overview } : {}),
		}, planDecision(false));
	}

	private beginInteraction<T>(binding: Binding, kind: InteractionKind, toolName: string, view: InteractionView, cancelResponse: Record<string, unknown>): Promise<T> {
		const id = crypto.randomUUID();
		return new Promise<T>((resolve) => {
			const timer = setTimeout(() => {
				if (binding.interaction?.id !== id) return;
				binding.interaction = undefined;
				resolve(cancelResponse as T);
			}, INTERACTION_TIMEOUT_MS);
			timer.unref();
			binding.interaction = { id, kind, toolName, view: { ...view, id } as InteractionView, resolve: resolve as (response: never) => void, cancelResponse, timer };
			binding.writer?.toolCall(id, toolName, { requestId: id });
			binding.writer?.done("toolUse");
		});
	}

	private consumeExtension(binding: Binding | undefined, method: string, params: Record<string, unknown>): void {
		const text = describeExtensionNotification(method, params);
		if (text && binding?.writer && !binding.writer.finished) binding.writer.thinking(text);
	}

	private requestPiTool(binding: Binding | undefined, invocation: PiToolInvocation): Promise<CallToolResult> {
		if (!binding?.writer || binding.writer.finished || binding.interaction) return Promise.resolve({ content: [{ type: "text", text: "Pi cannot accept this tool call in the current turn" }], isError: true });
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!binding.pendingTools.delete(invocation.id)) return;
				resolve({ content: [{ type: "text", text: "Pi tool call timed out" }], isError: true });
			}, TOOL_TIMEOUT_MS);
			timer.unref();
			binding.pendingTools.set(invocation.id, { invocation, resolve, timer });
			binding.writer?.toolCall(invocation.id, invocation.name, invocation.arguments);
			if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
			binding.toolBatchTimer = setTimeout(() => { binding.toolBatchTimer = undefined; binding.writer?.done("toolUse"); }, TOOL_BATCH_MS);
			binding.toolBatchTimer.unref();
		});
	}

	private consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {
		if (!binding || notification.sessionId !== binding.session.sessionId) return;
		for (const activity of mapSessionUpdate(notification)) {
			if (activity.type === "tool") {
				this.trackCursorTool(binding, activity.tool);
				continue;
			}
			if (!binding.writer || binding.writer.finished) {
				if (activity.type === "text" || activity.type === "thought") binding.activityBuffer.push(activity);
				else if (activity.type === "plan" || activity.type === "status") binding.activityBuffer.push({ type: "status", text: activity.text });
				continue;
			}
			if (activity.type === "plan" || activity.type === "status") this.writeActivity(binding, { type: "status", text: activity.text });
			else if (activity.type === "text" || activity.type === "thought") this.writeActivity(binding, activity);
		}
	}

	private writeActivity(binding: Binding, activity: BufferedActivity): void {
		const writer = binding.writer;
		if (!writer || writer.finished) return;
		if (activity.type === "text") {
			const required = cursorActionRequired(binding.modelId, activity.delta);
			if (required) binding.actionRequired = required;
			else writer.text(activity.delta);
		} else if (activity.type === "thought" || activity.type === "status") writer.thinking(activity.type === "thought" ? activity.delta : activity.text);
	}

	/**
	 * Cursor has already run this tool. The row is sent only once that call has
	 * finished, so Pi can draw it and let it be opened while the rest of the turn
	 * is still streaming.
	 */
	private trackCursorTool(binding: Binding, update: CursorToolUpdate): void {
		const known = binding.cursorToolIds.get(update.toolCallId);
		if (known) {
			const view = this.cursorTools.get(known);
			if (!view || view.shown) return;
			const readyBefore = cursorToolReady(view);
			if (update.title) view.title = update.title;
			if (update.kind) view.kind = update.kind;
			if (update.status) view.status = update.status;
			if (update.content) view.content = update.content;
			if (update.rawOutput !== undefined) view.rawOutput = update.rawOutput;
			rememberPaths(view, update);
			if (!readyBefore && cursorToolReady(view)) this.scheduleHandoff(binding);
			return;
		}
		const title = update.title ?? "";
		if (binding.bridge?.names(title)) return;
		const id = `cursor_${crypto.randomUUID()}`;
		binding.cursorToolIds.set(update.toolCallId, id);
		const view: CursorToolView = {
			title, paths: [], shown: false, content: update.content ?? [],
			...(update.kind ? { kind: update.kind } : {}),
			...(update.status ? { status: update.status } : {}),
			...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
		};
		rememberPaths(view, update);
		this.cursorTools.set(id, view);
		for (const stale of this.cursorTools.keys()) {
			if (this.cursorTools.size <= MAX_CURSOR_TOOLS) break;
			this.cursorTools.delete(stale);
		}
		if (cursorToolReady(view)) this.scheduleHandoff(binding);
	}

	/** A finished call closes the current message so Pi can draw its result before the turn ends. */
	private scheduleHandoff(binding: Binding): void {
		if (binding.handoffTimer) return;
		// A short wait lets calls that finish together go out in one handoff, one Pi round trip.
		binding.handoffTimer = setTimeout(() => {
			binding.handoffTimer = undefined;
			if (!binding.writer || binding.writer.finished || binding.pendingTools.size || binding.interaction || binding.toolBatchTimer) {
				// No message to close right now. The marker keeps the row's place among buffered text.
				binding.activityBuffer.push({ type: "tool-ready" });
				return;
			}
			this.maybeHandoff(binding);
		}, 40);
		binding.handoffTimer.unref?.();
	}

	private maybeHandoff(binding: Binding): void {
		const writer = binding.writer;
		if (!writer || writer.finished || binding.pendingTools.size || binding.interaction || binding.toolBatchTimer) return;
		const ids = this.emitCursorTools(binding, writer, false);
		if (!ids.length) return;
		binding.displayPendingIds = ids;
		writer.done("toolUse");
		if (binding.writer === writer) binding.writer = undefined;
		this.wakeDisplay(binding);
	}

	/** Pi came back after drawing a finished call. Keep streaming the same Cursor turn. */
	private async resumeDisplay(binding: Binding, context: Context, writer: PiEventWriter): Promise<void> {
		binding.displayPendingIds = [];
		binding.writer = writer;
		// The prompt may finish in runQueued, which records the turn from these. Without them the
		// next prompt would resend this turn's own handoff messages to Cursor as unseen context.
		binding.pendingContextCount = context.messages.length;
		binding.pendingContextFingerprint = messagesFingerprint(context.messages);
		if (binding.promptFailed !== undefined) {
			writer.fail(binding.promptFailed, isAbort(binding.promptFailed));
			return;
		}
		this.flushText(binding);
		this.flushReady(binding);
		if (writer.finished) return;
		if (binding.promptFinished) {
			this.finishWriter(binding, writer, context);
			return;
		}
		await new Promise<void>((resolve) => { binding.resumeWait = resolve; });
		if (writer.finished) return;
		if (binding.promptFailed !== undefined) {
			writer.fail(binding.promptFailed, isAbort(binding.promptFailed));
			return;
		}
		this.finishWriter(binding, writer, context);
	}

	/** Write buffered text up to the next finished call, without closing the message. */
	private flushText(binding: Binding): void {
		while (binding.activityBuffer.length && binding.writer && !binding.writer.finished) {
			const next = binding.activityBuffer[0];
			if (!next || next.type === "tool-ready") break;
			binding.activityBuffer.shift();
			this.writeActivity(binding, next);
		}
	}

	/** Draw finished calls that were waiting, then keep any text that arrived after them. */
	private flushReady(binding: Binding): void {
		while (binding.activityBuffer.length && binding.writer && !binding.writer.finished) {
			const activity = binding.activityBuffer.shift();
			if (!activity) break;
			if (activity.type === "tool-ready") this.maybeHandoff(binding);
			else this.writeActivity(binding, activity);
		}
		if (binding.writer && !binding.writer.finished) this.maybeHandoff(binding);
	}

	private isDisplayContinuation(binding: Binding, context: Context): boolean {
		return binding.displayPendingIds.length > 0 && binding.displayPendingIds.every((id) => findToolResult(context, id, CURSOR_TOOL_NAME));
	}

	private wakeDisplay(binding: Binding): void {
		const resume = binding.resumeWait;
		binding.resumeWait = undefined;
		resume?.();
	}

	/**
	 * End the message. Finished calls that were not sent yet go out first, and Pi
	 * comes back once more to close the turn after drawing them.
	 */
	private finishWriter(binding: Binding, writer: PiEventWriter, context?: Context): void {
		if (writer.finished) return;
		if (binding.handoffTimer) {
			clearTimeout(binding.handoffTimer);
			binding.handoffTimer = undefined;
		}
		const ids = this.emitCursorTools(binding, writer, true);
		if (ids.length) {
			const terminal = ids.every((id) => this.cursorTools.get(id)?.terminate !== false);
			if (terminal) {
				binding.displayPendingIds = [];
				this.rememberTurn(binding, writer, context);
			} else binding.displayPendingIds = ids;
			writer.done("toolUse");
			if (binding.writer === writer) binding.writer = undefined;
			return;
		}
		this.rememberTurn(binding, writer, context);
		writer.done(binding.promptStop);
		if (binding.writer === writer) binding.writer = undefined;
	}

	private rememberTurn(binding: Binding, writer: PiEventWriter, context?: Context): void {
		if (binding.promptUsage) writer.message.usage = binding.promptUsage;
		if (binding.promptRawStop) writer.message.rawStopReason = binding.promptRawStop;
		if (context) {
			binding.messageCount = context.messages.length;
			binding.historyFingerprint = messagesFingerprint(context.messages);
		} else {
			binding.messageCount = binding.pendingContextCount;
			binding.historyFingerprint = binding.pendingContextFingerprint;
		}
		binding.expectedAssistantFingerprint = messageFingerprint(writer.message);
		binding.completedTurns += 1;
		this.persistBinding(binding);
	}

	/** Send rows that are ready. `force` also sends a call that ended without a status. */
	private emitCursorTools(binding: Binding, writer: PiEventWriter, force: boolean): string[] {
		if (writer.finished) return [];
		const ids: string[] = [];
		for (const id of binding.cursorToolIds.values()) {
			const view = this.cursorTools.get(id);
			if (!view || view.shown) continue;
			if (!force && !cursorToolReady(view)) continue;
			view.shown = true;
			view.terminate = force && binding.promptFinished;
			writer.toolCall(id, CURSOR_TOOL_NAME, cursorToolArgs(view));
			ids.push(id);
		}
		return ids;
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion ?? Promise.resolve();
		if (!signal) { await completion; return; }
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (binding.abortRequested) return;
			binding.abortRequested = true;
			this.retire(binding);
			binding.writer?.fail(abortError(), true);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => void binding.connection.close(), 1_500);
		};
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		try { await completion; } finally { signal.removeEventListener("abort", abort); if (killTimer) clearTimeout(killTimer); }
	}

	private findContinuationKey(context: Context): string | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.retired) continue;
			if (this.isDisplayContinuation(binding, context)) return binding.key;
			if (binding.interaction && findInteractionResult(context, binding.interaction.id, binding.interaction.toolName)) return binding.key;
			if (binding.pendingTools.size && [...binding.pendingTools.values()].every((pending) => findToolResult(context, pending.invocation.id, pending.invocation.name))) return binding.key;
		}
		return undefined;
	}

	private persistBinding(binding: Binding): void {
		if (!binding.piSessionId || binding.completedTurns < 1 || binding.retired) return;
		this.sessionStore.save({
			piSessionId: binding.piSessionId, acpSessionId: binding.session.sessionId, acpModelId: binding.modelId, cwd: binding.cwd,
			messageCount: binding.messageCount, historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint ? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint } : {}), lastActive: Date.now(),
		});
	}

	private async dropBinding(key: string, binding: Binding): Promise<void> {
		binding.retired = true;
		const current = this.bindings.get(key);
		if (current && await current.catch(() => undefined) === binding && this.bindings.get(key) === current) this.bindings.delete(key);
		this.resolvedBindings.delete(binding);
		cancelInteraction(binding);
		cancelPiTools(binding, "Cursor session closed before Pi returned the tool result");
		await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
	}

	private assertActive(): void { if (this.disposed) throw new CursorAcpError("process_exit", "Cursor ACP runtime is closed"); }
}

async function authenticateCursor(connection: CursorAcpConnection, initialize: InitializeResponse, signal?: AbortSignal): Promise<void> {
	const method = initialize.authMethods?.find((item) => item.id === "cursor_login") ?? initialize.authMethods?.find((item) => /cursor|login/iu.test(`${item.id} ${item.name}`));
	if (!method) return;
	await connection.authenticate({ methodId: method.id }, signal);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) throw new CursorAcpError("invalid_input", "This Cursor ACP runtime did not advertise image input");
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			if ("text" in block.resource) output.push({ type: "text", text: block.resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output };
}

function findOption(options: readonly SessionConfigOption[], category: string): SessionConfigOption | undefined { return options.find((item) => item.category === category || item.id === category); }
function currentValue(option: SessionConfigOption): string | boolean { return option.currentValue; }

function findInteractionResult(context: Context, id: string, toolName: string): InteractionToolResult | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "toolResult" || message.toolName !== toolName || message.toolCallId !== id) continue;
		const details = message.details as Partial<InteractionToolResult> | undefined;
		if (details?.kind === INTERACTION_RESULT_KIND && details.requestId === id && details.response && typeof details.response === "object") return details as InteractionToolResult;
		return { kind: INTERACTION_RESULT_KIND, requestId: id, response: fallbackResponse(toolName) };
	}
	return undefined;
}

function fallbackResponse(toolName: string): Record<string, unknown> {
	if (toolName === PERMISSION_TOOL_NAME) return { outcome: { outcome: "cancelled" } };
	if (toolName === QUESTION_TOOL_NAME) return questionCancelled();
	return planDecision(false);
}

function validateInteractionResponse(pending: PendingInteraction, response: Record<string, unknown>): Record<string, unknown> {
	const outcome = asRecord(response.outcome);
	if (!outcome || typeof outcome.outcome !== "string") return pending.cancelResponse;
	if (pending.kind === "permission" && pending.view.kind === "permission") {
		if (outcome.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
		if (outcome.outcome === "selected" && typeof outcome.optionId === "string" && pending.view.options.some((option) => option.id === outcome.optionId)) {
			return { outcome: { outcome: "selected", optionId: outcome.optionId } };
		}
		return pending.cancelResponse;
	}
	if (pending.kind === "plan") {
		if (outcome.outcome === "accepted") return { outcome: { outcome: "accepted" } };
		if (outcome.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
		if (outcome.outcome === "rejected") return { outcome: { outcome: "rejected", ...(typeof outcome.reason === "string" ? { reason: outcome.reason.slice(0, 2_000) } : {}) } };
		return pending.cancelResponse;
	}
	if (pending.kind === "question" && pending.view.kind === "question") {
		if (outcome.outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
		if (outcome.outcome === "skipped") return { outcome: { outcome: "skipped", ...(typeof outcome.reason === "string" ? { reason: outcome.reason.slice(0, 2_000) } : {}) } };
		if (outcome.outcome !== "answered" || !Array.isArray(outcome.answers)) return pending.cancelResponse;
		const answers: Array<{ questionId: string; selectedOptionIds: string[] }> = [];
		const seen = new Set<string>();
		for (const value of outcome.answers) {
			const answer = asRecord(value);
			if (!answer || typeof answer.questionId !== "string" || !Array.isArray(answer.selectedOptionIds) || seen.has(answer.questionId)) return pending.cancelResponse;
			const question = pending.view.questions.find((item) => item.id === answer.questionId);
			if (!question) return pending.cancelResponse;
			const selected = answer.selectedOptionIds.filter((item): item is string => typeof item === "string");
			if (selected.length !== answer.selectedOptionIds.length || new Set(selected).size !== selected.length || selected.some((id) => !question.options.some((option) => option.id === id)) || (!question.allowMultiple && selected.length !== 1)) return pending.cancelResponse;
			seen.add(answer.questionId);
			answers.push({ questionId: answer.questionId, selectedOptionIds: selected });
		}
		if (answers.length !== pending.view.questions.length) return pending.cancelResponse;
		return { outcome: { outcome: "answered", answers } };
	}
	return pending.cancelResponse;
}

function rememberPaths(view: CursorToolView, update: CursorToolUpdate): void {
	for (const path of update.paths ?? []) if (!view.paths.includes(path)) view.paths.push(path);
}

/** A call can be drawn once Cursor has finished it. A file call also waits for its path. */
function cursorToolReady(view: CursorToolView): boolean {
	if (view.status !== "completed" && view.status !== "failed") return false;
	if (needsPath(view) && view.paths.length === 0) return false;
	// The diff arrives with the result. Wait for it so a new file is not labeled Edit.
	if (view.kind === "edit" && view.status === "completed" && fileDiffs(view).length === 0) return false;
	return true;
}

function needsPath(view: CursorToolView): boolean {
	if (view.kind === "execute" || view.kind === "think" || view.kind === "search" || view.kind === "fetch" || view.kind === "switch_mode") return false;
	if (view.kind === "edit" || view.kind === "delete" || view.kind === "read" || view.kind === "move") return true;
	return isNewFile(view);
}

/** Collapsed row text. Every call uses `Action - target`. A new file is `Create File`. */
function cursorToolArgs(view: CursorToolView): Record<string, string> {
	const action = cursorAction(view);
	const text = action.detail ? `${action.label} - ${action.detail}` : action.label;
	return { [action.key]: text };
}

interface CursorAction { key: string; label: string; detail: string }

function cursorAction(view: CursorToolView): CursorAction {
	const path = view.paths.map(displayPath).join(", ");
	if (view.kind === "execute") return shellAction(view.title, path);
	if (view.kind === "delete") return { key: "Delete", label: "Delete File", detail: path };
	if (view.kind === "read") return { key: "Read", label: "Read File", detail: path || untitled(view.title, /^read(?:\s+file)?\b/i) };
	if (view.kind === "move") return { key: "Move", label: "Move File", detail: path || cleanTitle(view.title) };
	if (view.kind === "search") return { key: "Search", label: "Search", detail: searchDetail(view, path) };
	if (view.kind === "fetch") return { key: "Fetch", label: "Fetch", detail: cleanTitle(view.title) };
	if (view.kind === "think") return { key: "Think", label: "Think", detail: "" };
	if (view.kind === "switch_mode") return { key: "Mode", label: "Mode", detail: cleanTitle(view.title) };
	if (isNewFile(view)) return { key: "Create", label: "Create File", detail: path };
	if (view.kind === "edit") return { key: "Edit", label: "Edit File", detail: path };
	const shell = shellAction(view.title, path);
	if (shell.key !== "Shell") return shell;
	return { key: "Tool", label: "Tool", detail: cleanTitle(view.title) || path };
}

/** A write of a file that did not exist yet. An edit that replaces old text stays an edit. */
function isNewFile(view: CursorToolView): boolean {
	const diffs = fileDiffs(view);
	if (diffs.length > 0) return diffs.every((diff) => typeof diff.newText === "string" && isBlank(diff.oldText));
	return /^write\b/i.test(cleanTitle(view.title));
}

/** Cursor sends `null` for a new file, and `""` when the old file was empty. */
function isBlank(value: unknown): boolean {
	return value == null || value === "";
}

function fileDiffs(view: CursorToolView): Array<{ oldText?: unknown; newText?: unknown }> {
	const diffs: Array<{ oldText?: unknown; newText?: unknown }> = [];
	for (const item of view.content) {
		const record = asRecord(item);
		if (record?.type === "diff") diffs.push(record);
	}
	return diffs;
}

function searchDetail(view: CursorToolView, path: string): string {
	const title = cleanTitle(view.title);
	if (title && path && !title.includes(path)) return `${title} in ${path}`;
	return title || path;
}

/** A shell command, named the same way as a file call when the command is one. */
function shellAction(title: string, path: string): CursorAction {
	const command = cleanTitle(title);
	const first = command.split(/[\s;|&]+/u)[0]?.replace(/\.exe$/i, "").toLowerCase() ?? "";
	const named = commandPath(command) || path;
	if (["remove-item", "rm", "del", "erase", "rmdir", "rd", "ri"].includes(first)) {
		// The command does not say file or folder. A name with an extension is taken as a file.
		const file = /\.[A-Za-z0-9]+$/u.test(named.split(/[\\/]/u).pop() ?? "");
		return { key: "Delete", label: file ? "Delete File" : "Delete Folder", detail: displayPath(named) || shorten(command) };
	}
	if (["start-sleep", "sleep", "timeout"].includes(first)) {
		const seconds = command.match(/-seconds\s+(\d+(?:\.\d+)?)/i)?.[1] ?? command.match(/\b(\d+(?:\.\d+)?)s?\b/u)?.[1];
		return { key: "Wait", label: "Wait", detail: seconds ? `${seconds}s` : shorten(command) };
	}
	if (["new-item", "mkdir", "md", "ni"].includes(first)) {
		return { key: "Create", label: "Create Folder", detail: displayPath(named) || shorten(command) };
	}
	return { key: "Shell", label: "Shell", detail: shorten(command) };
}

function commandPath(command: string): string {
	const flagged = command.match(/(?:-LiteralPath|-Path)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
	if (flagged) return flagged[1] || flagged[2] || flagged[3] || "";
	const positional = command.match(/^(?:remove-item|rm|del|erase|rmdir|rd|ri|new-item|mkdir|md|ni)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
	return positional ? positional[1] || positional[2] || positional[3] || "" : "";
}

function untitled(title: string, prefix: RegExp): string {
	return cleanTitle(title).replace(prefix, "").trim();
}

function cleanTitle(title: string): string {
	return title.replace(/^`+|`+$/g, "").replace(/\s+/g, " ").trim();
}

function shorten(text: string): string {
	return text.length <= 120 ? text : `${text.slice(0, 119).trimEnd()}…`;
}

/** Keep the file name visible when a long path is shortened to one line. */
function displayPath(path: string): string {
	if (path.length <= 120) return path;
	const name = path.split(/[\\/]/u).filter(Boolean).pop();
	return name && name !== path ? `${name} — ${path}` : path;
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function messagesFingerprint(messages: Context["messages"]): string { return createHash("sha256").update(messages.map(messageFingerprint).join("\n")).digest("hex"); }
function messageFingerprint(message: Context["messages"][number]): string {
	const value = message.role === "user" ? { role: message.role, content: message.content } : message.role === "assistant" ? { role: message.role, provider: message.provider, model: message.model, content: message.content } : { role: message.role, toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, isError: message.isError };
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
function findToolResult(context: Context, id: string, name: string): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) { const message = context.messages[index]; if (message?.role === "toolResult" && message.toolCallId === id && message.toolName === name) return message; }
	return undefined;
}
function toMcpToolResult(message: ToolResultMessage): CallToolResult { return { content: message.content.map((block) => block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, data: block.data, mimeType: block.mimeType }), isError: message.isError }; }
function cancelInteraction(binding: Binding): void {
	const pending = binding.interaction;
	if (!pending) return;
	clearTimeout(pending.timer);
	pending.resolve(pending.cancelResponse as never);
	binding.interaction = undefined;
}
function cancelPiTools(binding: Binding, reason: string): void {
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) { clearTimeout(pending.timer); pending.resolve({ content: [{ type: "text", text: reason }], isError: true }); }
	binding.pendingTools.clear();
}
/** Node's AbortError is a plain Error, the signal's default reason is a DOMException. Both carry the name. */
function isAbort(error: unknown): boolean {
	if (error instanceof CursorAcpError) return error.code === "aborted";
	return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
