import { realpathSync } from "node:fs";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { type Component, rgbColor } from "@earendil-works/pi-tui";
import { classifyCallStatus, formatDurationMs, normalizeLineEndings, type RowStatus } from "./compact-tools-core.ts";
import { loadConfig } from "./compact-tools-config.ts";
import { paletteOf } from "./compact-tools-color.ts";
import { hasAuthorRenderers, refreshRowShell } from "./compact-tools-rendering.ts";
import { registerCompactToolsCommand } from "./compact-tools-command.ts";
import { clearRowResolver, installToolRowPatch, setRowResolver, type RowRenderers, type ToolRow } from "./compact-tools-custom.ts";
import {
	formatResultLineSummary,
	countEditChanges,
	getArgumentDetails,
	getCallDetails,
	getEditDiff,
	getEditPatch,
	getFileOutput,
	getTextResult,
	isReadTextResult,
	splitReadFooter,
	summarizeCustomArguments,
	summarizeFailure,
	summarizeShellCommand,
} from "./compact-tools-invocation.ts";
import {
	CachedContainer,
	claudeRows,
	LiveCallContainer,
	limitComponentLines,
	prefixedSentence,
	prefixedText,
	railComponent,
	withOutputPad,
	renderArguments,
	renderCodeDiff,
	renderCodeView,
	renderOutput,
	renderToolCall,
	styleMultiline,
	WithinWidth,
} from "./compact-tools-layout.ts";
import { CLAUDE_DIFF_CONTEXT_LINES, CLAUDE_INDENT, CLAUDE_OUTPUT_ROWS, CLAUDE_RESULT_PREFIX, CLAUDE_TITLE_INDENT, CLAUDE_WRITE_ROWS, claudeFailure, claudeOutcome, claudeTitle } from "./compact-tools-claude.ts";
import { CODEX_BULLET, CODEX_INDENT } from "./compact-tools-codex.ts";
import { NestedCallSummaries } from "./compact-tools-nested.ts";
import { renderCodexCall, renderCodexResult } from "./compact-tools-codex-rows.ts";
import { ToolGroupController } from "./compact-tools-grouping.ts";
import { chromePainter, completionPainter, paintIndicator } from "./compact-tools-palette.ts";
import { ProgressController } from "./compact-tools-progress.ts";
import { showReleaseNotice } from "./compact-tools-release.ts";
import { ToolRuntime } from "./compact-tools-runtime.ts";
import { findChat, isKind, SilentModeController } from "./compact-tools-silent.ts";
import { ThinkingCycleController } from "./compact-tools-thinking.ts";
import { ViewportKeeper } from "./compact-tools-viewport.ts";
import {
	SUPPORTED_TOOL_SET,
	type CompactToolName,
	type RenderContext,
	type RowState,
	type ToolArgs,
} from "./compact-tools-types.ts";

/** Context lines kept around each change while an edit result is collapsed. */
const PREVIEW_DIFF_CONTEXT_LINES = 1;

const runtime = new ToolRuntime();
const nestedSummaries = new NestedCallSummaries();
const RENDER_WIDGET_KEY = "compact-tools-render";
let registeredConfiguration: string | undefined;
/**
 * Whether the last session found its directory trusted. A /reload rebuilds the
 * transcript before session_start says so again, so the tools a trusted project
 * adds are registered from the start rather than after its rows were made. Pi
 * evaluates this module afresh on every load, so the answer is kept on globalThis.
 */
const TRUST_KEY = Symbol.for("pi-compact-tools.trust");
type TrustSlot = typeof globalThis & { [TRUST_KEY]?: { cwd: string; trusted: boolean } };

/** A directory as the file system names it, so `/var` and `/private/var` are one place. */
function realDirectory(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** How a tool's row is drawn: a file tool's result is code, a shell's is output, a custom tool's is its author's. */
type RowKind = "file" | "shell" | "custom";
type AuthorResultRenderer = (expanded: boolean) => Component | undefined;

function rowKind(name: string): RowKind {
	return name === "bash" || name === "powershell" ? "shell" : SUPPORTED_TOOL_SET.has(name) ? "file" : "custom";
}

function isClaude(): boolean {
	return runtime.config.style === "claude";
}

function isCodex(): boolean {
	return runtime.config.style === "codex";
}

function pathArgument(args: ToolArgs): string {
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
}

function callStatus(ctx: RenderContext, state: RowState): RowStatus {
	// write/edit arguments can stream for much longer than their eventual filesystem
	// operation. Treat that active tool-call phase as running so every built-in row
	// animates consistently instead of waiting for execute() to begin.
	const active = runtime.canRun(ctx.toolCallId) && (ctx.executionStarted || !ctx.argsComplete);
	return classifyCallStatus(ctx.isError, active, state.finished === true || state.endedAt !== undefined);
}

/**
 * The status dot, painted each time the row is drawn. Pi draws a call before its
 * result, so a dot painted with the call would miss the result that arrived with
 * it; reading the row's state at draw time sees it. A settled dot never changes.
 */
function liveIndicator(theme: Theme, ctx: RenderContext, state: RowState, glyph?: string): () => string {
	let settled: string | undefined;
	return () => {
		if (settled !== undefined) return settled;
		const status = callStatus(ctx, state);
		const indicator = paintIndicator(theme, status,
			runtime.syncIndicator(ctx.toolCallId, status === "running", () => ctx.invalidate()), glyph);
		if (status === "success" || status === "error") settled = indicator;
		return indicator;
	};
}

function formatDuration(state: RowState): string | undefined {
	if (state.durationMs !== undefined) return formatDurationMs(state.durationMs);
	if (state.startedAt === undefined) return undefined;
	return formatDurationMs((state.endedAt ?? Date.now()) - state.startedAt);
}

function canReuseResult<TArgs>(
	state: RowState,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext<TArgs>,
): ctx is RenderContext<TArgs> & { lastComponent: Component } {
	return ctx.lastComponent !== undefined
		&& state.lastResultContent === result.content
		&& state.lastResultDetails === result.details
		&& state.lastResultPartial === options.isPartial
		&& state.lastResultExpanded === state.expanded
		&& state.lastResultPreview === state.preview
		&& state.lastResultError === ctx.isError
		&& state.lastResultConfigRevision === state.configRevision
		&& state.lastResultPalette === paletteOf(theme)
		&& state.lastResultDurationMs === state.durationMs
		&& state.lastResultOutputPad === ctx.outputPad;
}

function rememberResult(state: RowState, result: AgentToolResult<unknown>, options: ToolRenderResultOptions, isError: boolean, theme: Theme): void {
	state.lastResultContent = result.content;
	state.lastResultDetails = result.details;
	state.lastResultPartial = options.isPartial;
	state.lastResultExpanded = state.expanded;
	state.lastResultPreview = state.preview;
	state.lastResultError = isError;
	state.lastResultConfigRevision = state.configRevision;
	state.lastResultPalette = paletteOf(theme);
}

function renderControls(
	theme: Theme,
	state: RowState,
	running: boolean,
	isError: boolean,
	failureReason?: string,
	changes?: { added: number; removed: number },
	nestedSummary?: string,
	prefix = " └ ",
	indent = "   ",
): Component {
	const duration = running ? undefined : formatDuration(state);
	const status = running
		? (duration ?? "Running")
		: `${isError ? "Failed" : "Done"}${duration ? ` in ${duration}` : ""}`;
	// A failed row already reads as an error through its output color and Pi's row
	// background, so completion metadata stays neutral rather than repeating that signal.
	const chrome = chromePainter(theme);
	const metadata = running ? chrome : completionPainter(theme);
	let details = metadata(status);
	if (failureReason && isError && !running) details += chrome(" · ") + theme.fg("error", failureReason);
	// A file change reports what it changed the way a diff does: lines added and removed.
	else if (changes && !running && !isError) {
		details += chrome(" (") + theme.fg("toolDiffAdded", `+${changes.added}`) + chrome(" ")
			+ theme.fg("toolDiffRemoved", `-${changes.removed}`) + chrome(")");
	}
	// A failed call produced no result worth counting; "(0 lines)" would only mislead.
	else if (state.resultLineSummary && !running && !isError) details += metadata(` (${state.resultLineSummary})`);
	if (nestedSummary && !running) details += chrome(" · ") + nestedSummary;
	return nestedSummary ? prefixedSentence(details, chrome(prefix), indent, true) : prefixedText(details, chrome(prefix), indent);
}

/** Arguments a one-line summary cannot show: objects, or lists of them. */
function hasNestedArguments(args: ToolArgs): boolean {
	return Object.values(args).some((value) => typeof value === "object" && value !== null
		&& (!Array.isArray(value) || value.some((item) => typeof item === "object" && item !== null)));
}

/** Only the action words take a color. The path stays the normal tool text color. */
const CURSOR_ACTION_COLOR = {
	"Create File": rgbColor(63, 185, 80),
	"Create Folder": rgbColor(63, 185, 80),
	"Edit File": rgbColor(240, 136, 62),
	"Delete File": rgbColor(248, 81, 73),
	"Delete Folder": rgbColor(248, 81, 73),
	Wait: rgbColor(230, 200, 70),
} as const;

function paintCursorDetail(theme: Theme, text: string): string {
	const match = /(?<action>Create File|Create Folder|Edit File|Delete File|Delete Folder|Wait)\b/u.exec(text);
	const action = match?.groups?.action as keyof typeof CURSOR_ACTION_COLOR | undefined;
	if (match?.index === undefined || !action) return theme.fg("toolOutput", text);
	const before = text.slice(0, match.index);
	const after = text.slice(match.index + action.length);
	return (before ? theme.fg("toolOutput", before) : "")
		+ theme.style(action, { fg: CURSOR_ACTION_COLOR[action] })
		+ (after ? theme.fg("toolOutput", after) : "");
}

/** The call line: a status dot, the tool, and what it was asked, then any arguments the line leaves out. */
function renderRowCall(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	return withOutputPad(renderRowCallContent(name, args, theme, ctx), ctx.outputPad);
}

function renderRowCallContent(name: string, args: ToolArgs, theme: Theme, ctx: RenderContext): Component {
	const state = runtime.syncRow(ctx);
	runtime.syncExpansion(state, ctx.expanded, name);
	const kind = rowKind(name);
	const indicator = liveIndicator(theme, ctx, state, isCodex() ? CODEX_BULLET : undefined);
	// Painted once now as well, so a row that starts running starts the animation clock.
	indicator();
	// Codex's head reads the call's outcome, so it is worded each time it is drawn.
	if (isCodex()) return renderCodexCall(name, kind, args, theme, state, () => callStatus(ctx, state), indicator, ctx.toolCallId);
	if (isClaude()) {
		// Claude Code's call line: `⦁ Bash(npm test)`, `⦁ Update(src/app.ts)`.
		const { label, argument } = claudeTitle(name, args, state.expanded === true);
		const title = ` ${theme.fg("toolTitle", theme.bold(label))}`
			+ (argument
				? name === "Cursor"
					? paintCursorDetail(theme, `(${argument})`)
					: styleMultiline(`(${argument})`, (line) => theme.fg("toolOutput", line))
				: "");
		// The title wraps under the tool's name rather than being cut to the row; only a
		// very long command is shortened.
		const container = new LiveCallContainer(indicator, (dot) => renderToolCall(dot + title, undefined, theme, CLAUDE_TITLE_INDENT));
		// The title already lists plain arguments; only nested ones need the full view.
		if (kind === "custom" && state.expanded && hasNestedArguments(args)) container.addChild(renderArguments(args, theme, CLAUDE_INDENT));
		return new WithinWidth(container);
	}
	const title = ` ${theme.fg("toolTitle", theme.bold(name))}`;
	let details: string | undefined;
	if (kind === "shell") {
		const command = normalizeLineEndings(typeof args.command === "string" ? args.command : "");
		details = state.expanded
			? styleMultiline(command || "…", (line) => theme.fg("toolOutput", line))
			: theme.fg("toolOutput", summarizeShellCommand(name, command));
	} else {
		const summary = kind === "file" ? getCallDetails(name, args) : summarizeCustomArguments(args);
		details = summary
			? name === "Cursor"
				? paintCursorDetail(theme, summary)
				: styleMultiline(summary, (line) => theme.fg("toolOutput", line))
			: undefined;
	}
	const container = new LiveCallContainer(indicator, (dot) => renderToolCall(dot + title, details, theme));
	// Cursor's title already names the file. Opening the row should not print that title again as JSON.
	const extra = name === "Cursor" ? {} : kind === "file" ? getArgumentDetails(name, args) : kind === "custom" && state.expanded ? args : {};
	if (Object.keys(extra).length > 0) container.addChild(renderArguments(extra, theme));
	return new WithinWidth(container);
}

/**
 * A result body as code where it is code: numbered file text, or an edit's diff.
 * `rail` is what each row starts with; the compact result rail unless given.
 */
function renderFileBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
	rail?: string,
): Component | undefined {
	const fallback = () => renderOutput(output, theme, isError, rail);
	if (isError) return fallback();
	const path = pathArgument(args);
	if (name === "edit" && getEditDiff(result)) {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme,
			expanded ? { rail } : { contextLines: PREVIEW_DIFF_CONTEXT_LINES, rail }) ?? fallback();
	}
	if (name === "read" && isReadTextResult(result)) {
		const { body, footer } = splitReadFooter(output);
		const startLine = typeof args.offset === "number" ? args.offset : 1;
		return renderCodeView(body, path, theme, { startLine, footer, rail }) ?? fallback();
	}
	if (name === "write") return renderCodeView(output, path, theme, { rail }) ?? fallback();
	return fallback();
}

function renderRowBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	isError: boolean,
	author: AuthorResultRenderer | undefined,
	rail?: string,
): Component | undefined {
	if (!author && rowKind(name) !== "custom") return renderFileBody(name, args, result, output, expanded, theme, isError, rail);
	if (author) {
		try {
			const component = author(expanded);
			if (component) return railComponent(component, theme, rail);
		} catch {
			// A failing third-party renderer degrades to the plain text result.
		}
	}
	return renderOutput(output, theme, isError, rail);
}

function claudeMoreLines(theme: Theme, hidden: number): string {
	return chromePainter(theme)(`… +${hidden} ${hidden === 1 ? "line" : "lines"} (ctrl+o to expand)`);
}

/** Output previewed in rows the way Claude Code previews it, all of it once opened. */
function claudeOutput(output: string, expanded: boolean, theme: Theme, isError: boolean, empty: string, firstPrefix: string, completion?: Component): Component {
	const normalized = normalizeLineEndings(output).trimEnd();
	// Pi's bash reports an empty run as "(no output)"; Claude Code dims its own words for it.
	const lines = !normalized || normalized === "(no output)"
		? [chromePainter(theme)(empty)]
		: normalized.split("\n").map((line) => theme.fg(isError ? "error" : "toolOutput", line));
	return claudeRows(lines, firstPrefix, CLAUDE_INDENT, expanded ? undefined : CLAUDE_OUTPUT_ROWS,
		(hidden) => claudeMoreLines(theme, hidden), completion);
}

/**
 * What Claude Code draws beneath a finished call: an edit's every hunk, a write's
 * first rows, the author's view of a custom tool once opened, and otherwise
 * nothing until the row is opened.
 */
function claudeBody(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	output: string,
	expanded: boolean,
	theme: Theme,
	author: AuthorResultRenderer | undefined,
): Component | undefined {
	if (author && expanded) return renderRowBody(name, args, result, output, true, theme, false, author, CLAUDE_INDENT);
	const path = pathArgument(args);
	if (name === "edit") {
		return renderCodeDiff(getEditPatch(result), getEditDiff(result), path, theme,
			{ contextLines: CLAUDE_DIFF_CONTEXT_LINES, rail: CLAUDE_INDENT });
	}
	if (name === "write") {
		const component = renderCodeView(output, path, theme, { rail: CLAUDE_INDENT });
		return component && !expanded
			? limitComponentLines(component, CLAUDE_WRITE_ROWS, theme, (hidden) => CLAUDE_INDENT + claudeMoreLines(theme, hidden))
			: component;
	}
	// A command's output is already the result line itself.
	const kind = rowKind(name);
	if (!expanded || kind === "shell") return undefined;
	if (kind === "custom") return author ? renderRowBody(name, args, result, output, true, theme, false, author, CLAUDE_INDENT) : undefined;
	return renderFileBody(name, args, result, output, true, theme, false, CLAUDE_INDENT);
}

/**
 * Claude Code's result block: a "⎿" line saying what happened, or the output
 * itself for commands and custom tools, then any diff or code beneath it.
 */
function renderClaudeResult(
	name: string,
	args: ToolArgs,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
	expanded: boolean,
	output: string,
	author: AuthorResultRenderer | undefined,
	completion?: Component,
): Component {
	const chrome = chromePainter(theme);
	const container = new CachedContainer();
	// One line under the call, wrapped rather than cut to the row.
	const line = (text: string) => prefixedSentence(text, chrome(CLAUDE_RESULT_PREFIX), CLAUDE_INDENT);
	if (options.isPartial) {
		container.addChild(line(chrome("Running…")));
		return container;
	}
	if (isError) {
		const failure = claudeFailure(name, output);
		// A command's output says why beneath its exit code; another tool's message is
		// shortened to one line, and a click shows it whole in its place.
		if (failure.detail) {
			container.addChild(line(theme.fg("error", failure.headline)));
			container.addChild(claudeOutput(failure.detail, expanded, theme, true, "", CLAUDE_INDENT, completion));
		} else if (expanded && output.trim()) {
			container.addChild(claudeOutput(`Error: ${output.trim()}`, true, theme, true, "", chrome(CLAUDE_RESULT_PREFIX), completion));
		} else {
			container.addChild(line(theme.fg("error", failure.headline)));
			if (completion) container.addChild(completion);
		}
		return container;
	}
	const body = claudeBody(name, args, result, output, expanded, theme, author);
	// The author's view already shows a custom tool's output, so the line above it only counts it.
	const outcome = body && rowKind(name) === "custom"
		? formatResultLineSummary(name, args, result, output) ?? "Done"
		: claudeOutcome(name, args, result, output, (value) => theme.bold(value));
	if (outcome !== undefined) container.addChild(line(theme.fg("toolOutput", outcome)));
	else container.addChild(claudeOutput(output, expanded, theme, false, rowKind(name) === "shell" ? "(No output)" : "(No content)", chrome(CLAUDE_RESULT_PREFIX), completion));
	if (body) container.addChild(body);
	if (completion && outcome !== undefined) container.addChild(completion);
	return container;
}

/**
 * Cursor create/edit results store Pi diffs (`+12 line` / `-12 line`).
 * Count those rows so the Done line can show `(+N -N)` the same way an edit does.
 */
function countCursorFileChanges(result: AgentToolResult<unknown>): { added: number; removed: number } | undefined {
	const files = (result.details as { files?: unknown } | undefined)?.files;
	if (!Array.isArray(files)) return undefined;
	let added = 0;
	let removed = 0;
	let saw = false;
	for (const file of files) {
		const diff = file && typeof file === "object" ? (file as { diff?: unknown }).diff : undefined;
		if (typeof diff !== "string" || diff.length === 0) continue;
		saw = true;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
	}
	return saw ? { added, removed } : undefined;
}

/**
 * The result under a call: a preview or the whole of it when shown, and a status
 * line with how long it took and how much it returned. An unchanged result reuses
 * the component it drew last, so a large output is laid out once.
 */
function renderRowResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	ctx: RenderContext,
	author?: AuthorResultRenderer,
	watchNested = true,
): Component {
	const state = runtime.syncRow(ctx, !options.isPartial);
	runtime.syncExpansion(state, ctx.expanded, name);
	if (canReuseResult(state, result, options, theme, ctx)) return ctx.lastComponent;
	const kind = rowKind(name);
	const output = kind === "file" && !author ? getFileOutput(name, ctx.args, result, ctx.isError) : getTextResult(result);
	const hasEditDiff = name === "edit" && getEditDiff(result).length > 0;
	runtime.setResultAvailable(state, name, hasEditDiff || output.length > 0 || author !== undefined);
	const nestedSummary = name === "codemode" && !options.isPartial ? nestedSummaries.format(ctx.toolCallId, theme, state.expanded === true) : undefined;
	if (nestedSummary && !state.resultLineSummaryComputed) {
		state.resultLineSummary = output ? formatResultLineSummary(name, ctx.args, result, output) : undefined;
		state.resultLineSummaryComputed = true;
	}
	let component: Component;
	if (isCodex()) {
		component = renderCodexResult({
			name, kind: author ? "custom" : kind, args: ctx.args, result, output, theme, state, isError: ctx.isError,
			isPartial: options.isPartial, expanded: state.expanded === true, toolCallId: ctx.toolCallId, author,
			completion: nestedSummary ? renderControls(theme, state, false, ctx.isError, undefined, undefined, nestedSummary, CODEX_INDENT, CODEX_INDENT) : undefined,
		});
	} else if (isClaude()) {
		const container = new CachedContainer();
		const completion = nestedSummary ? renderControls(theme, state, false, ctx.isError, undefined, undefined, nestedSummary, CLAUDE_INDENT, CLAUDE_INDENT) : undefined;
		container.addChild(renderClaudeResult(name, ctx.args, result, options, theme, ctx.isError, state.expanded === true, output, author, completion));
		component = new WithinWidth(container);
	} else {
		if (!options.isPartial && !state.resultLineSummaryComputed) {
			// A custom tool with no text has nothing to count.
			state.resultLineSummary = kind === "custom" && !output ? undefined : formatResultLineSummary(name, ctx.args, result, output);
			state.resultLineSummaryComputed = true;
		}
		const container = new CachedContainer();
		if (state.expanded || state.preview) {
			const body = renderRowBody(name, ctx.args, result, output, state.expanded === true, theme, ctx.isError, author);
			if (body) container.addChild(state.expanded ? body : limitComponentLines(body, runtime.config.previewLines, theme));
		}
		// A failed row whose output is hidden gets its reason on the status line. When
		// the output shows, it already says why, and repeating it only doubles the error.
		const failureReason = ctx.isError && !state.expanded && !state.preview ? summarizeFailure(name, output) : undefined;
		const changes = name === "edit" ? countEditChanges(result) : name === "Cursor" ? countCursorFileChanges(result) : undefined;
		container.addChild(renderControls(theme, state, options.isPartial, ctx.isError, failureReason,
			changes, nestedSummary));
		component = new WithinWidth(container);
	}
	rememberResult(state, result, options, ctx.isError, theme);
	state.lastResultDurationMs = state.durationMs;
	state.lastResultOutputPad = ctx.outputPad;
	let drawn = withOutputPad(component, ctx.outputPad);
	if (name !== "codemode" || options.isPartial || !watchNested) return drawn;
	// The host can deliver a final nested snapshot (or a cancelled child's end)
	// after the parent's result. Read through at draw time, not only on updateResult.
	let revision = nestedSummaries.revision(ctx.toolCallId);
	return {
		render(width) {
			const next = nestedSummaries.revision(ctx.toolCallId);
			if (next !== revision) {
				revision = next;
				drawn = renderRowResult(name, result, options, theme, { ...ctx, lastComponent: undefined }, author, false);
			}
			return drawn.render(width);
		},
		invalidate() { drawn.invalidate(); },
	};
}

/**
 * Compact renderers for one row of a tool this extension did not register. The
 * author's result renderer still draws the expanded body; the row chrome, status,
 * and collapse behavior match the built-ins.
 */
let authorStates = new WeakMap<object, { state: RowState; component?: Component }>();
function createCustomRenderers(name: string, author: ToolDefinition<any, any, any> | undefined): RowRenderers {
	// Pi hands both renderers the row's own state object, which belongs to the tool's
	// author. Compact bookkeeping is kept here so neither side overwrites the other.
	const slot = (ctx: RenderContext<any>) => {
		let value = authorStates.get(ctx.state);
		if (!value) authorStates.set(ctx.state, value = { state: {} });
		return value;
	};
	const own = (ctx: RenderContext<any>): RenderContext => ({ ...ctx, args: ctx.args ?? {}, state: slot(ctx).state });
	return {
		renderCall: (args, theme, ctx) => renderRowCall(name, (args ?? {}) as ToolArgs, theme, own(ctx)),
		renderResult: (result, options, theme, ctx) => {
			const authorRenderer = author?.renderResult;
			const renderAuthorResult = authorRenderer
				? (expanded: boolean) => {
					const value = slot(ctx);
					// Compact owns the outer margin and the result rail. An author
					// renderer is embedded content, not another host-padded shell.
					// Leave the field absent on legacy hosts.
					value.component = authorRenderer(result, { ...options, expanded }, theme, {
						...ctx, lastComponent: value.component, ...((ctx as { outputPad?: number }).outputPad === undefined ? {} : { outputPad: 0 }),
					});
					return value.component;
				}
				: undefined;
			return renderRowResult(name, result, options, theme, own(ctx), renderAuthorResult);
		},
	};
}

// Renderer resolvers may run repeatedly for the same call, notably HTML export.
let builtinStates = new WeakMap<object, RowState>();
const compactRendererDefinitions = new WeakSet<object>();
function builtinContext(ctx: RenderContext): RenderContext {
	let state = builtinStates.get(ctx.state);
	if (!state) builtinStates.set(ctx.state, state = {});
	return { ...ctx, state };
}

/** UI-only routing: never register, activate, or replace model-facing tools. */
function resolveCustomRow(row: ToolRow): RowRenderers | undefined {
	if (runtime.config.style === "off") return undefined;
	const customTools = runtime.config.custom_tools;
	if (SUPPORTED_TOOL_SET.has(row.toolName) && (!row.toolDefinition || compactRendererDefinitions.has(row.toolDefinition) || (row.toolDefinition.renderResult && compactRendererDefinitions.has(row.toolDefinition.renderResult)) || !hasAuthorRenderers(row.toolName, row.toolDefinition))) {
		if (!runtime.config.tools.includes(row.toolName as CompactToolName)) return undefined;
		const renderers: RowRenderers = {
			renderCall: (args, theme, ctx) => renderRowCall(row.toolName, (args ?? {}) as ToolArgs, theme, builtinContext(ctx as RenderContext)),
			renderResult: (result, options, theme, ctx) => renderRowResult(row.toolName, result, options, theme, builtinContext(ctx as RenderContext)),
		};
		compactRendererDefinitions.add(renderers);
		compactRendererDefinitions.add(renderers.renderResult);
		return renderers;
	}
	if (!customTools.enabled || customTools.exclude.includes(row.toolName)) return undefined;
	return createCustomRenderers(row.toolName, row.toolDefinition);
}

type RendererAPI = ExtensionAPI & {
	registerToolRenderer?: (resolver: (name: string, next: () => ToolDefinition<any, any, any> | undefined) => ToolDefinition<any, any, any> | undefined) => void;
};
let publicRendering = false;
let sessionReady = false;
let publicOwners = new WeakMap<object, { call?: unknown; result?: unknown }>();
function publicRowDefinition(name: string, base: ToolDefinition<any, any, any> | undefined): ToolDefinition<any, any, any> | undefined {
	// Preserve next()'s result exactly once the session's configuration is known.
	let config: unknown;
	let decision: RowRenderers | undefined;
	const decide = () => {
		if (config !== runtime.config) {
			config = runtime.config;
			decision = resolveCustomRow({ toolName: name, toolDefinition: base });
		}
		return decision;
	};
	if (!decide() && (sessionReady || !base)) return base;
	const context = (ctx: Parameters<RowRenderers["renderCall"]>[2], kind: "call" | "result", render: unknown): typeof ctx => {
		let owner = publicOwners.get(ctx.state);
		if (!owner) publicOwners.set(ctx.state, owner = {});
		const changed = owner[kind] !== render;
		owner[kind] = render;
		return changed ? { ...ctx, lastComponent: undefined } : ctx;
	};
	const call: RowRenderers["renderCall"] = (args, theme, ctx) => {
		const render = decide()?.renderCall ?? base?.renderCall;
		return render!(args, theme, context(ctx, "call", render));
	};
	const result: RowRenderers["renderResult"] = (value, options, theme, ctx) => {
		const render = decide()?.renderResult ?? base?.renderResult;
		return render!(value, options, theme, context(ctx, "result", render));
	};
	return {
		get renderShell() { return decide() ? "self" : base?.renderShell ?? "default"; },
		get renderCall() { return decide()?.renderCall || base?.renderCall ? call : undefined; },
		get renderResult() { return decide()?.renderResult || base?.renderResult ? result : undefined; },
	} as ToolDefinition<any, any, any>;
}
let legacyResolver: ((row: ToolRow) => RowRenderers | undefined) | undefined;
let refreshTranscriptRows: (() => void) | undefined;
function invalidateRowDecisions(): void {
	if (!publicRendering) {
		legacyResolver = (row) => resolveCustomRow(row);
		setRowResolver(legacyResolver);
	}
	refreshTranscriptRows?.();
}

function configure(_pi: ExtensionAPI, cwd?: string, projectTrusted = false): void {
	const resolvedCwd = cwd ?? process.cwd();
	const config = loadConfig(resolvedCwd, projectTrusted);
	const signature = JSON.stringify([resolvedCwd, config]);
	if (signature === registeredConfiguration) return;
	runtime.configure(config);
	registeredConfiguration = signature;
	invalidateRowDecisions();
}

/**
 * Apply a style saved by /compact-tools without reloading Pi. The compact, Claude, and
 * Codex styles share every tool registration and read the style as they draw, so the
 * configuration is swapped and each tool row on screen is drawn again, a running one
 * included. Anything else that changed, or a switch to or from off, needs a reload.
 */
function applyStyle(cwd: string, trusted: boolean): boolean {
	const config = loadConfig(cwd, trusted);
	const current = runtime.config;
	if (config.style === "off" || current.style === "off") return false;
	if (JSON.stringify({ ...config, style: current.style }) !== JSON.stringify(current)) return false;
	runtime.configure(config);
	registeredConfiguration = JSON.stringify([cwd, config]);
	invalidateRowDecisions();
	return true;
}

/** Note the calls an assistant message makes, as Pi reads them to make their rows. */
function noteCalls(message: unknown): void {
	// Only a run's own updates announce calls; the check is cheap enough for every update.
	const content = (message as { role?: string; content?: unknown }).role === "assistant"
		? (message as { content?: unknown }).content
		: undefined;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?.type === "toolCall" && typeof block.id === "string") runtime.noteCall(block.id);
	}
}

/**
 * Whether another tool made the call through `ctx.executeTool()`, as codemode scripts
 * do. Pi 0.99 marks such calls with `parentToolCallId`; older Pi never makes them.
 */
function madeByTool(event: object): boolean {
	return typeof (event as { parentToolCallId?: unknown }).parentToolCallId === "string";
}

/** Hand the animation Pi's frame request, reached through an invisible widget as the extension API allows. */
function bindRenderer(ctx: ExtensionContext): void {
	ctx.ui.setWidget(RENDER_WIDGET_KEY, (tui) => {
		runtime.bindRenderer(() => tui.requestRender());
		refreshTranscriptRows = () => {
			const visit = (parent: { children?: unknown[] }) => {
				for (const child of parent.children ?? []) {
					if (!child || typeof child !== "object") continue;
					if (isKind(child, ToolExecutionComponent)) {
						const row = child as ToolRow & { updateDisplay?(): void };
						refreshRowShell(row);
						row.updateDisplay?.();
					} else visit(child as { children?: unknown[] });
				}
			};
			const chat = findChat(tui);
			if (chat && chat.children.length > 0) { visit(chat); tui.requestRender(); }
		};
		return { render: () => [], invalidate() {} };
	}, { placement: "belowEditor" });
	refreshTranscriptRows?.();
}

function unbindRenderer(ctx: ExtensionContext | undefined): void {
	refreshTranscriptRows = undefined;
	runtime.bindRenderer(undefined);
	ctx?.ui.setWidget(RENDER_WIDGET_KEY, undefined, { placement: "belowEditor" });
}

export default function compactTools(pi: ExtensionAPI): void {
	// The cached factory is invoked again after session replacement and reload.
	// Reset configuration memoization, but never change the host's tool registry.
	registeredConfiguration = undefined;
	sessionReady = false;
	publicOwners = new WeakMap();

	registerCompactToolsCommand(pi, () => runtime.config, applyStyle);
	const thinkingCycle = new ThinkingCycleController(pi);
	const progress = new ProgressController(pi);
	const viewport = new ViewportKeeper();
	const silent = new SilentModeController(pi, showReleaseNotice);
	const groups = new ToolGroupController(runtime);
	builtinStates = new WeakMap();
	authorStates = new WeakMap();
	const rendererAPI = pi as RendererAPI;
	publicRendering = typeof rendererAPI.registerToolRenderer === "function";
	const customRowsAvailable = publicRendering || installToolRowPatch();
	if (publicRendering) {
		setRowResolver(undefined);
		rendererAPI.registerToolRenderer!((name, next) => {
			const base = next();
			return publicRowDefinition(name, base as ToolDefinition<any, any, any> | undefined);
		});
	} else invalidateRowDecisions();
	let customRowsWarned = false;
	let renderContext: ExtensionContext | undefined;
	// Configure UI routing before Pi rebuilds transcript rows. Tool declarations
	// and the active loadout must remain exactly as the host selected them.
	const cwd = process.cwd();
	const lastTrust = (globalThis as TrustSlot)[TRUST_KEY];
	configure(pi, cwd, lastTrust?.cwd === realDirectory(cwd) && lastTrust.trusted);
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") {
			runtime.clearTimings();
			nestedSummaries.clear();
		}
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) nestedSummaries.restoreBranch(branch);
		// Rows restored from the session are drawn next; while idle none of them is running.
		if (typeof ctx.isIdle === "function") runtime.setBusy(!ctx.isIdle());
		const trusted = ctx.isProjectTrusted();
		(globalThis as TrustSlot)[TRUST_KEY] = { cwd: realDirectory(ctx.cwd), trusted };
		configure(pi, ctx.cwd, trusted);
		sessionReady = true;
		unbindRenderer(renderContext);
		renderContext = undefined;
		// Even off must reconcile rows built before trusted config was available.
		if (ctx.mode === "tui") bindRenderer(ctx);
		if (ctx.mode === "tui" && runtime.config.style !== "off") {
			renderContext = ctx;
			// First, so its input listener sees relayout keys before the thinking controller consumes them.
			viewport.bind(ctx);
			progress.bind(ctx);
			thinkingCycle.bind(ctx);
			silent.bind(ctx, runtime.config.mode, event.reason === "reload");
			groups.bind(ctx);
			if (!silent.isEnabled()) showReleaseNotice(ctx);
			if ((runtime.config.custom_tools.enabled || runtime.config.tools.length > 0) && !customRowsAvailable && !customRowsWarned) {
				customRowsWarned = true;
				ctx.ui.notify("Compact tool rendering is unavailable in this version of Pi", "warning");
			}
		} else {
			if (ctx.mode === "tui") unbindRenderer(ctx);
			viewport.dispose();
			progress.dispose();
			thinkingCycle.dispose();
			silent.dispose();
			groups.dispose();
		}
	});
	// /tree changes the branch without session_start. Fill sibling-branch records
	// before Pi rebuilds its transcript, while retaining richer same-process deltas.
	pi.on("session_tree", (_event, ctx) => {
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) nestedSummaries.restoreBranch(branch);
		runtime.repaint();
	});
	pi.on("agent_start", () => runtime.setBusy(true));
	pi.on("agent_end", () => runtime.setBusy(false));
	// The calls of the run going on, read from each update as Pi reads them to make
	// their rows, and told to extensions before Pi makes them.
	pi.on("message_update", (event) => noteCalls(event.message));
	// Notification-only: read the host's nested record without changing any message.
	pi.on("message_end", (event) => {
		if (nestedSummaries.restore(event.message)) runtime.repaint();
	});
	pi.on("tool_execution_start", (event) => {
		if (madeByTool(event)) {
			runtime.noteNestedCall(event.toolCallId, true);
			nestedSummaries.note(event, false);
			return;
		}
		nestedSummaries.begin(event.toolCallId, event.toolName);
		runtime.noteCall(event.toolCallId);
		runtime.noteExecutionStart(event.toolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		if (madeByTool(event)) {
			runtime.noteNestedCall(event.toolCallId, false);
			if (nestedSummaries.note(event, true)) runtime.repaint();
			return;
		}
		nestedSummaries.finish(event.toolCallId);
		runtime.noteExecutionEnd(event.toolCallId, (event as { durationMs?: number }).durationMs);
	});
	pi.on("session_shutdown", (event) => {
		thinkingCycle.dispose();
		progress.dispose();
		silent.dispose();
		groups.dispose();
		viewport.dispose();
		unbindRenderer(renderContext);
		renderContext = undefined;
		runtime.reset(event.reason !== "reload");
		if (event.reason !== "reload") nestedSummaries.clear();
		// A reload that keeps the extension sets it again before Pi rebuilds the transcript.
		if (legacyResolver) clearRowResolver(legacyResolver);
		refreshTranscriptRows = undefined;
	});
}
