/** Pure timing and text helpers for compact tool rendering. */

export type RowStatus = "pending" | "running" | "success" | "error";

export type IndicatorTone = "muted" | "dim" | "borderMuted" | "success" | "error";

export const RUNNING_INDICATOR_FRAME_COUNT = 14;
const RUNNING_INDICATOR_MIN_STRENGTH = 0.08;

export function indicatorStrength(status: RowStatus, frame = 0): number {
	if (status !== "running") return 1;
	const normalizedFrame = ((frame % RUNNING_INDICATOR_FRAME_COUNT) + RUNNING_INDICATOR_FRAME_COUNT)
		% RUNNING_INDICATOR_FRAME_COUNT;
	const wave = (Math.cos((normalizedFrame / RUNNING_INDICATOR_FRAME_COUNT) * Math.PI * 2) + 1) / 2;
	return RUNNING_INDICATOR_MIN_STRENGTH + (1 - RUNNING_INDICATOR_MIN_STRENGTH) * wave;
}

/** Semantic fallback for themes whose foreground RGB values cannot be resolved. */
export function indicatorTone(status: RowStatus, frame = 0): IndicatorTone {
	if (status === "success") return "success";
	if (status === "error") return "error";
	if (status === "pending") return "muted";
	const strength = indicatorStrength(status, frame);
	return strength >= 0.7 ? "muted" : strength >= 0.35 ? "dim" : "borderMuted";
}

export function indicatorGlyph(_status: RowStatus, _frame = 0): string {
	return "⦁";
}

export function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?|\n/g, "\n");
}

export function classifyCallStatus(isError: boolean, executionStarted: boolean, completed: boolean): RowStatus {
	if (isError) return "error";
	if (completed) return "success";
	return executionStarted ? "running" : "pending";
}

/**
 * Sub-minute durations keep millisecond precision; longer runs switch to the
 * minute and hour grouping Pi's own bash and powershell renderers use.
 */
export function formatDurationMs(elapsedMs: number): string {
	const seconds = elapsedMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(3)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainderSeconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainderSeconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainderSeconds}s`;
}
