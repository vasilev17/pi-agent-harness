import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
export const SUPPORTED_TOOL_SET = new Set<string>(SUPPORTED_TOOLS);

export type CompactToolName = (typeof SUPPORTED_TOOLS)[number];
export type ShellToolName = "bash" | "powershell";
export type ToolArgs = Record<string, unknown>;
export type BuiltInDefinition = ToolDefinition<any, any, any>;

export const DISPLAY_MODES = ["normal", "silent"] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
/** How tool rows are drawn: compactly, the way Claude Code or Codex draws them, or by Pi itself. */
export const DISPLAY_STYLES = ["compact", "claude", "codex", "off"] as const;
export type DisplayStyle = (typeof DISPLAY_STYLES)[number];

export interface CustomToolsConfig {
	/** Render tools registered by other extensions compactly as well. */
	enabled: boolean;
	auto_compact: boolean;
	exclude: string[];
}

export interface CompactToolsConfig {
	mode: DisplayMode;
	style: DisplayStyle;
	tools: CompactToolName[];
	/** Built-ins always have an entry; custom tools may, and otherwise use custom_tools.auto_compact. */
	auto_compact: Record<CompactToolName, boolean> & { [tool: string]: boolean | undefined };
	custom_tools: CustomToolsConfig;
	previewLines: number;
}

export interface RowState {
	expanded?: boolean;
	preview?: boolean;
	hasResult?: boolean;
	lastHostExpanded?: boolean;
	configRevision?: object;
	/** The row has its final result, whether or not it was timed. */
	finished?: boolean;
	startedAt?: number;
	endedAt?: number;
	/** Host-recorded final duration, when available (Pi 1.1+). */
	durationMs?: number;
	resultLineSummary?: string;
	resultLineSummaryComputed?: boolean;
	lastResultContent?: unknown;
	lastResultDetails?: unknown;
	lastResultPartial?: boolean;
	lastResultExpanded?: boolean;
	lastResultPreview?: boolean;
	lastResultError?: boolean;
	lastResultConfigRevision?: object;
	lastResultPalette?: object;
	lastResultDurationMs?: number;
	lastResultOutputPad?: number;
	/** What a Codex row's head reads from its result: a command's exit code, an edit's counts. */
	codex?: {
		exitCode?: number;
		changes?: { added: number; removed: number };
		/** Whether the row draws opened at a width: Codex opens only a call whose preview leaves something out. */
		opens?: (width: number) => boolean;
	};
}

type BaseRenderContext = Parameters<NonNullable<BuiltInDefinition["renderCall"]>>[2];
export type RenderContext<TArgs = ToolArgs> = Omit<BaseRenderContext, "args" | "state" | "durationMs" | "outputPad"> & {
	args: TArgs;
	state: RowState;
	/** Optional across hosts: older Pi versions do not provide these fields. */
	durationMs?: number;
	outputPad?: number;
};
