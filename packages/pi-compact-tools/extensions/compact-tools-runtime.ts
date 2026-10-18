import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "./compact-tools-config.ts";
import { isSilent } from "./compact-tools-silent.ts";
import {
	SUPPORTED_TOOL_SET,
	type BuiltInDefinition,
	type CompactToolName,
	type CompactToolsConfig,
	type RenderContext,
	type RowState,
} from "./compact-tools-types.ts";

const MAX_TRACKED_ROWS = 2_000;
const INDICATOR_INTERVAL_MS = 45;
/**
 * How long a running row may go undrawn before it stops asking for frames. Pi draws
 * every row it shows on every frame, so only a row that left the transcript, or
 * never got its result, goes this long; it asks again the next time it is drawn.
 */
const UNDRAWN_ROW_MS = 1_500;
const EXECUTION_TIMINGS_KEY = Symbol.for("pi.compact-tools.execution-timings");

type ExecutionTiming = { startedAt: number; endedAt?: number; durationMs?: number };

/** Treat missing or malformed host durations like an older host; zero is valid. */
export function validDurationMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
type Indicator = { invalidate: () => void; drawnAt: number };
type TimedExecute = (...args: any[]) => Promise<AgentToolResult<unknown>>;
type SharedState = typeof globalThis & {
	[EXECUTION_TIMINGS_KEY]?: Map<string, ExecutionTiming>;
};

export class ToolRuntime {
	private configValue = DEFAULT_CONFIG;
	private configRevision: object = {};
	private readonly executionTimings: Map<string, ExecutionTiming>;
	private readonly indicators = new Map<string, Indicator>();
	private indicatorFrame = 0;
	private indicatorTimer: ReturnType<typeof setInterval> | undefined;
	/** Pi's frame request, once bound to its terminal; rows then repaint without being rebuilt. */
	private requestRender: (() => void) | undefined;
	/** Whether the agent is working; undefined until the host says, which counts as working. */
	private busy: boolean | undefined;
	/**
	 * The calls Pi announced in the run going on. Only these can be running, so
	 * nothing about earlier calls has to be remembered, and the set never holds
	 * more than one run's calls.
	 */
	private readonly currentCalls = new Set<string>();
	/**
	 * Calls a tool is making through `ctx.executeTool()`, as codemode scripts do. They
	 * never get a row of their own, so no execution timing is kept for them.
	 * The independent nested-summary observer keeps only their outcome counts.
	 */
	private readonly nestedCalls = new Set<string>();

	constructor(private readonly clock: () => number = () => performance.now()) {
		const shared = globalThis as SharedState;
		this.executionTimings = shared[EXECUTION_TIMINGS_KEY] ?? new Map<string, ExecutionTiming>();
		shared[EXECUTION_TIMINGS_KEY] = this.executionTimings;
	}

	get config(): CompactToolsConfig {
		return this.configValue;
	}

	/** The shared animation frame of running indicators, for rows drawn outside a tool renderer. */
	get frame(): number {
		return this.indicatorFrame;
	}

	/** When a tool call started and, once it has, ended. */
	timing(toolCallId: string): Readonly<ExecutionTiming> | undefined {
		return this.executionTimings.get(toolCallId);
	}

	configure(config: CompactToolsConfig): void {
		this.configValue = config;
		this.configRevision = {};
	}

	clearTimings(): void {
		this.executionTimings.clear();
	}

	reset(clearTimings: boolean): void {
		this.stopIndicators();
		if (clearTimings) this.clearTimings();
	}

	/**
	 * Bind the animation to Pi's frame requests. A running dot is painted when its
	 * row is drawn, so a frame only has to be asked for, once, however many rows
	 * run. Unbound, each running row is rebuilt to repaint, as Pi does on its own.
	 */
	bindRenderer(requestRender: (() => void) | undefined): void {
		this.requestRender = requestRender;
	}

	/** A late summary changes only a draw-time footer, not every row's layout. */
	repaint(): void {
		if (!isSilent()) this.requestRender?.();
	}

	/**
	 * The agent started or stopped working. Once it stops nothing can still be
	 * running, so a row that never got its result stops pulsing and waits instead.
	 */
	setBusy(busy: boolean): void {
		if (busy && this.busy !== true) {
			this.currentCalls.clear();
			this.nestedCalls.clear();
		}
		this.busy = busy;
		if (busy) return;
		const animating = this.indicators.size > 0;
		this.stopIndicators();
		if (animating) this.requestRender?.();
	}

	/**
	 * Pi announced a call of the run going on: its arguments began to stream, or it
	 * began to run. Pi tells extensions before it makes the call's row. The set is
	 * emptied as each run starts, so it holds one run's calls at most.
	 */
	noteCall(toolCallId: string): void {
		this.currentCalls.add(toolCallId);
	}

	/** A call another tool made began (`running`) or finished; Pi says so with `parentToolCallId`. */
	noteNestedCall(toolCallId: string, running: boolean): void {
		if (running) this.nestedCalls.add(toolCallId);
		else this.nestedCalls.delete(toolCallId);
	}

	/**
	 * Whether a call can be running: only one Pi announced in the run going on. A
	 * row restored from the session, one left without a result when its run ended,
	 * and one Pi made again for an old call when it rebuilt the transcript were
	 * never announced in this run; whatever they did is over. Until the host says
	 * whether the agent works, every call can run, as before.
	 */
	canRun(toolCallId: string): boolean {
		return this.busy === undefined || (this.busy && this.currentCalls.has(toolCallId));
	}

	syncIndicator(toolCallId: string, running: boolean, invalidate: () => void): number {
		if (!running) {
			this.removeIndicator(toolCallId);
			return 0;
		}
		const indicator = this.indicators.get(toolCallId);
		if (indicator) {
			indicator.invalidate = invalidate;
			indicator.drawnAt = this.clock();
		} else {
			this.indicators.set(toolCallId, { invalidate, drawnAt: this.clock() });
		}
		if (!this.indicatorTimer) {
			this.indicatorTimer = setInterval(() => this.tick(), INDICATOR_INTERVAL_MS);
			this.indicatorTimer.unref?.();
		}
		return this.indicatorFrame;
	}

	/**
	 * A running row that is out of sight but still counts, such as one folded into
	 * a group whose line pulses for it, keeps the animation going.
	 */
	keepAnimating(toolCallId: string): void {
		const indicator = this.indicators.get(toolCallId);
		if (indicator) indicator.drawnAt = this.clock();
	}

	syncExpansion(state: RowState, hostExpanded: boolean, name: string): boolean {
		const initialized = this.initializeExpansion(state, name, hostExpanded);
		if (!initialized && state.lastHostExpanded !== hostExpanded) {
			state.lastHostExpanded = hostExpanded;
			state.expanded = hostExpanded;
			// A non-auto-compacted row collapses back to its bounded preview. Hiding it
			// here removes the clicked row from under the pointer, so the next click can
			// accidentally hit the Thinking block that moved into the same coordinates.
			state.preview = !hostExpanded && !this.autoCompact(name);
		}
		return state.expanded ?? false;
	}

	setResultAvailable(state: RowState, name: string, available: boolean): void {
		this.initializeExpansion(state, name);
		state.hasResult = available;
	}

	syncRow(ctx: RenderContext, finished = false): RowState {
		const state = ctx.state;
		// Pi can rebuild the transcript mid-run, making new rows for old calls; a call
		// keeps the run its first row was made in.
		this.restoreTiming(state, ctx.toolCallId);
		if (validDurationMs(ctx.durationMs)) state.durationMs = ctx.durationMs;
		// A row is timed from when it runs, as Pi times its own: the model writing the
		// arguments is not the tool's time. A restored row never ran in front of the
		// reader, so it has no time to measure unless this process timed it before a
		// /reload, and a call that never ran has none either.
		const started = this.canRun(ctx.toolCallId) && ctx.executionStarted;
		if (started && state.startedAt === undefined) state.startedAt = Date.now();
		if (finished) state.finished = true;
		if (finished && state.startedAt !== undefined && state.endedAt === undefined) state.endedAt = Date.now();
		if (finished) this.removeIndicator(ctx.toolCallId);
		this.persistTiming(state, ctx.toolCallId);
		return state;
	}

	/**
	 * Record when a tool this extension does not wrap starts and ends. Pi reports
	 * both to extensions before it redraws the row, and the row draws its status
	 * dot before its result, so without this a finished custom tool kept the
	 * running dot. Wrapped built-ins already have timings, which are kept.
	 */
	noteExecutionStart(toolCallId: string): void {
		if (!this.executionTimings.has(toolCallId)) this.executionTimings.set(toolCallId, { startedAt: Date.now() });
		this.trimTimings();
	}

	noteExecutionEnd(toolCallId: string, durationMs?: number): void {
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: Date.now() };
		timing.endedAt ??= Date.now();
		if (validDurationMs(durationMs)) timing.durationMs = durationMs;
		this.executionTimings.set(toolCallId, timing);
		this.trimTimings();
	}

	createTimedExecute(definition: BuiltInDefinition): TimedExecute {
		const execute = definition.execute as TimedExecute;
		return async (...args: any[]) => {
			const toolCallId = typeof args[0] === "string" && !this.nestedCalls.has(args[0]) ? args[0] : undefined;
			const startedAt = (toolCallId ? this.executionTimings.get(toolCallId)?.startedAt : undefined) ?? Date.now();
			if (toolCallId && !this.executionTimings.has(toolCallId)) {
				this.executionTimings.set(toolCallId, { startedAt });
				this.trimTimings();
			}
			try {
				return await execute.apply(definition, args);
			} finally {
				const timing = toolCallId ? this.executionTimings.get(toolCallId) : undefined;
				if (timing) timing.endedAt = Date.now();
			}
		};
	}

	private tick(): void {
		this.indicatorFrame++;
		const requestRender = this.requestRender;
		if (requestRender) {
			const oldest = this.clock() - UNDRAWN_ROW_MS;
			for (const [toolCallId, indicator] of this.indicators) {
				if (indicator.drawnAt < oldest) this.removeIndicator(toolCallId);
			}
			if (this.indicators.size === 0) return;
		}
		// Silent mode hides tool rows; repainting the screen for them would be pure cost.
		if (isSilent()) return;
		if (requestRender) {
			requestRender();
			return;
		}
		for (const { invalidate } of this.indicators.values()) invalidate();
	}

	private removeIndicator(toolCallId: string): void {
		this.indicators.delete(toolCallId);
		if (this.indicators.size > 0 || !this.indicatorTimer) return;
		clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicatorFrame = 0;
	}

	private stopIndicators(): void {
		if (this.indicatorTimer) clearInterval(this.indicatorTimer);
		this.indicatorTimer = undefined;
		this.indicators.clear();
		this.indicatorFrame = 0;
	}

	/** Built-ins follow their own auto_compact entry; a custom tool its own entry if it has one, else the custom_tools policy. */
	private autoCompact(name: string): boolean {
		return SUPPORTED_TOOL_SET.has(name)
			? this.configValue.auto_compact[name as CompactToolName]
			: this.configValue.auto_compact[name] ?? this.configValue.custom_tools.auto_compact;
	}

	private initializeExpansion(state: RowState, name: string, hostExpanded = false): boolean {
		if (state.configRevision === this.configRevision) return false;
		state.configRevision = this.configRevision;
		state.lastHostExpanded = hostExpanded;
		state.expanded = hostExpanded;
		state.preview = !hostExpanded && !this.autoCompact(name);
		return true;
	}

	private restoreTiming(state: RowState, toolCallId: string): void {
		const timing = this.executionTimings.get(toolCallId);
		if (!timing) return;
		state.startedAt = timing.startedAt;
		state.endedAt = timing.endedAt;
		if (validDurationMs(timing.durationMs)) state.durationMs = timing.durationMs;
	}

	private persistTiming(state: RowState, toolCallId: string): void {
		if (state.startedAt === undefined) return;
		const timing = this.executionTimings.get(toolCallId) ?? { startedAt: state.startedAt };
		timing.startedAt = state.startedAt;
		if (state.endedAt !== undefined) timing.endedAt = state.endedAt;
		if (validDurationMs(state.durationMs)) timing.durationMs = state.durationMs;
		this.executionTimings.set(toolCallId, timing);
		this.trimTimings();
	}

	/** Bound every insertion, including calls never drawn (for example in silent mode). */
	private trimTimings(): void {
		if (this.executionTimings.size <= MAX_TRACKED_ROWS) return;
		// Prefer settled calls so a long-running sibling keeps its start time. If all
		// 2,001 calls are active, retain the original FIFO fallback to stay bounded.
		for (const [id, timing] of this.executionTimings) {
			if (timing.endedAt !== undefined) {
				this.executionTimings.delete(id);
				return;
			}
		}
		const oldest = this.executionTimings.keys().next().value;
		if (oldest !== undefined) this.executionTimings.delete(oldest);
	}
}
