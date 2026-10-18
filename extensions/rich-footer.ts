/**
 * Rich footer: model, thinking level, session tokens, Cursor usage.
 * Git path sits centered between the token count and Cursor usage.
 *
 * Auth: reads %APPDATA%/Cursor/auth.json (or ~/.cursor / cursor-agent paths).
 * Usage: GET https://cursor.com/api/usage-summary
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

const USAGE_URL = "https://cursor.com/api/usage-summary";
const POLL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type SubUsage = {
	cursorPct: number | null;
	otherPct: number | null;
	membership?: string;
	resetAt?: string;
	error?: string;
	fetchedAt: number;
};

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtPct(n: number): string {
	return `${Math.round(n)}`;
}

type ContextChoice = { values: string[]; current?: string };

type CursorCatalog = {
	mode: string;
	fastOverride?: boolean;
	contextOverride?: string;
	fastByModel: Map<string, boolean>;
	nameByModel: Map<string, string>;
	contextByModel: Map<string, ContextChoice>;
	configMtime: number;
	modelsMtime: number;
};

const catalog: CursorCatalog = {
	mode: "agent",
	fastByModel: new Map(),
	nameByModel: new Map(),
	contextByModel: new Map(),
	configMtime: 0,
	modelsMtime: 0,
};

// The Cursor provider owns these files. The footer renders every frame, so each is re-read only when its mtime changes.
const CONFIG_PATH = join(getAgentDir(), "cursor-acp-provider", "config.json");
const MODELS_PATH = join(getAgentDir(), "cursor-acp-provider", "models.json");

function readCursorConfig(): void {
	try {
		const mtime = statSync(CONFIG_PATH).mtimeMs;
		if (mtime === catalog.configMtime) return;
		catalog.configMtime = mtime;
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { mode?: unknown; fast?: unknown; context?: unknown };
		if (cfg.mode === "agent" || cfg.mode === "plan" || cfg.mode === "ask") catalog.mode = cfg.mode;
		catalog.fastOverride = typeof cfg.fast === "boolean" ? cfg.fast : undefined;
		catalog.contextOverride = typeof cfg.context === "string" ? cfg.context : undefined;
	} catch {
		// keep last
	}
}

function readModelsCatalog(): void {
	try {
		const mtime = statSync(MODELS_PATH).mtimeMs;
		if (mtime === catalog.modelsMtime) return;
		catalog.modelsMtime = mtime;
		const raw = JSON.parse(readFileSync(MODELS_PATH, "utf8")) as {
			models?: Array<{
				value?: string;
				name?: string;
				configOptions?: Array<{ id?: string; currentValue?: unknown; options?: unknown }>;
			}>;
		};
		catalog.fastByModel.clear();
		catalog.nameByModel.clear();
		catalog.contextByModel.clear();
		for (const model of raw.models ?? []) {
			if (!model.value) continue;
			if (model.name) catalog.nameByModel.set(model.value, model.name);
			const fast = model.configOptions?.find((opt) => opt.id === "fast");
			if (fast) catalog.fastByModel.set(model.value, fast.currentValue === "true");
			const context = model.configOptions?.find((opt) => opt.id === "context");
			if (context) {
				const values = flattenOptionValues(context.options);
				if (values.length) {
					const current = typeof context.currentValue === "string" ? context.currentValue : undefined;
					catalog.contextByModel.set(model.value, { values, ...(current ? { current } : {}) });
				}
			}
		}
	} catch {
		// keep last
	}
}

async function loadCursorCatalog(): Promise<void> {
	readCursorConfig();
	readModelsCatalog();
}

function modeLabel(mode: string): string {
	if (mode === "plan") return "Plan";
	if (mode === "ask") return "Ask";
	return "Agent";
}

function flattenOptionValues(options: unknown): string[] {
	if (!Array.isArray(options)) return [];
	const values: string[] = [];
	for (const item of options) {
		if (!item || typeof item !== "object") continue;
		const record = item as { value?: unknown; options?: unknown };
		if (typeof record.value === "string") values.push(record.value);
		else values.push(...flattenOptionValues(record.options));
	}
	return values;
}

function parseSize(value: string): number | undefined {
	const match = value.toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
	if (!match?.[1]) return undefined;
	const amount = Number(match[1]);
	const scale = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.round(amount * scale);
}

/** Written by the provider's `/fast`, `/mode`, `/context`. Like the provider, it wins over config.json. */
const SESSION_CURSOR = "cursor-acp-session";

function sessionCursor(ctx: ExtensionContext): { mode?: string; fast?: boolean; context?: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (!entry || entry.type !== "custom" || entry.customType !== SESSION_CURSOR) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") return undefined;
		const record = data as Record<string, unknown>;
		const cursor: { mode?: string; fast?: boolean; context?: string } = {};
		if (record.mode === "agent" || record.mode === "plan" || record.mode === "ask") cursor.mode = record.mode;
		if (typeof record.fast === "boolean") cursor.fast = record.fast;
		if (typeof record.context === "string" && record.context.length > 0) cursor.context = record.context;
		return cursor;
	}
	return undefined;
}

function selectedContextTokens(modelId: string, contextOverride: string | undefined): number | undefined {
	const info = catalog.contextByModel.get(modelId);
	if (!info || info.values.length === 0) return undefined;
	const override = contextOverride?.toLowerCase();
	const chosen = override ? info.values.find((value) => value.toLowerCase() === override) : info.current;
	const size = chosen ?? info.current;
	return size ? parseSize(size) : undefined;
}

function jwtSub(token: string): string | undefined {
	try {
		const part = token.split(".")[1];
		if (!part) return undefined;
		const json = Buffer.from(part, "base64url").toString("utf8");
		const payload = JSON.parse(json) as { sub?: unknown; exp?: unknown };
		// A token that expires within a minute would fail the request, so it counts as missing.
		if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 60_000) {
			return undefined;
		}
		return typeof payload.sub === "string" ? payload.sub : undefined;
	} catch {
		return undefined;
	}
}

function authCandidates(): string[] {
	const home = homedir();
	const appData = process.env.APPDATA;
	const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const out: string[] = [];
	if (appData) {
		out.push(join(appData, "Cursor", "auth.json"));
		out.push(join(appData, "cursor", "auth.json"));
	}
	out.push(join(home, ".cursor", "auth.json"));
	out.push(join(xdg, "cursor", "auth.json"));
	out.push(join(home, "Library", "Application Support", "Cursor", "auth.json"));
	return out;
}

async function readAccessToken(): Promise<string | undefined> {
	for (const path of authCandidates()) {
		try {
			const raw = await readFile(path, "utf8");
			const data = JSON.parse(raw) as { accessToken?: unknown };
			if (typeof data.accessToken === "string" && data.accessToken.length > 20) {
				return data.accessToken;
			}
		} catch {
			// try next
		}
	}
	return undefined;
}

async function fetchSubUsage(signal?: AbortSignal): Promise<SubUsage> {
	const token = await readAccessToken();
	if (!token) {
		return { cursorPct: null, otherPct: null, error: "no-auth", fetchedAt: Date.now() };
	}
	const userId = jwtSub(token);
	if (!userId) {
		return { cursorPct: null, otherPct: null, error: "bad-token", fetchedAt: Date.now() };
	}

	// The usage endpoint belongs to the web dashboard and takes its session cookie, `<user id>::<access token>`.
	const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const res = await fetch(USAGE_URL, {
			headers: { Accept: "application/json", Cookie: cookie },
			signal: controller.signal,
		});
		if (!res.ok) {
			return {
				cursorPct: null,
				otherPct: null,
				error: `http-${res.status}`,
				fetchedAt: Date.now(),
			};
		}
		const body = (await res.json()) as {
			membershipType?: string;
			billingCycleEnd?: string;
			individualUsage?: {
				plan?: {
					autoPercentUsed?: number;
					apiPercentUsed?: number;
					enabled?: boolean;
				};
			};
		};
		const plan = body.individualUsage?.plan;
		// The plan meters two pools: Auto and Cursor's own models ("Cursor"), and API-priced models ("Other Models").
		const cursorPct =
			typeof plan?.autoPercentUsed === "number" ? plan.autoPercentUsed : null;
		const otherPct =
			typeof plan?.apiPercentUsed === "number" ? plan.apiPercentUsed : null;
		return {
			cursorPct,
			otherPct,
			membership: body.membershipType,
			resetAt: body.billingCycleEnd,
			fetchedAt: Date.now(),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.name : "fetch-error";
		return { cursorPct: null, otherPct: null, error: msg, fetchedAt: Date.now() };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function pctColor(
	theme: { fg: (name: string, text: string) => string },
	label: string,
	pct: number | null,
	error?: string,
): string {
	if (pct === null) {
		const tip = error === "no-auth" ? "?" : error ? "err" : "?";
		return theme.fg("dim", `${label}: ${tip}`);
	}
	const text = `${label}: ${fmtPct(pct)}%`;
	if (pct >= 90) return theme.fg("error", text);
	if (pct >= 70) return theme.fg("warning", text);
	return theme.fg("dim", text);
}

function padLine(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, width);
}

/** nf-oct-git_branch. Needs a Nerd Font in the terminal. */
const GIT_ICON = "\uf418";

/** Last `count` directories, Windows separators. `D:\a\b\c` with 2 becomes `\b\c`. */
function pathTail(cwd: string, count: number): string {
	const tail = cwd.split(/[\\/]+/).filter(Boolean).slice(-count);
	return tail.length ? `\\${tail.join("\\")}` : cwd;
}

/**
 * Longest git label first. Icon sits flush left.
 * `\a\b (branch)` then `\b (branch)` then `(branch)`.
 */
function gitForms(cwd: string, branch: string | undefined): string[] {
	const two = pathTail(cwd, 2);
	const one = pathTail(cwd, 1);
	if (!branch) return two === one ? [two] : [two, one];
	const mark = `${GIT_ICON} `;
	const forms = [`${mark}${two} (${branch})`];
	if (one !== two) forms.push(`${mark}${one} (${branch})`);
	forms.push(`${mark}(${branch})`);
	return forms;
}

/** True when `center` fits between left and right with one space on each side. */
function fitsBetween(leftWidth: number, centerWidth: number, rightWidth: number, width: number): boolean {
	return centerWidth + 2 <= width - leftWidth - rightWidth;
}

/** Longest git label that fits. Otherwise the branch-only label, cut with `...`. */
function gitThatFits(forms: readonly string[], width: number): string {
	return forms.find((form) => visibleWidth(form) <= width) ?? truncateToWidth(forms[forms.length - 1] ?? "", width, "...");
}

type GitHit = { line: number; start: number; end: number; dir: string; width: number };

/** Column span of a centered git label. Column math matches `placeCenter` on `layoutWidth`. */
function centeredGitHit(left: string, center: string, right: string, layoutWidth: number, line: number, renderWidth: number, dir: string): GitHit | undefined {
	const gap = layoutWidth - visibleWidth(left) - visibleWidth(right);
	const centerWidth = visibleWidth(center);
	if (!center || centerWidth > gap) return undefined;
	const start = visibleWidth(left) + Math.floor((gap - centerWidth) / 2);
	return { line, start, end: start + centerWidth, dir, width: renderWidth };
}

/** Column span of a git label drawn on its own line, flush left. */
function ownLineGitHit(gitLine: string, line: number, width: number, dir: string): GitHit | undefined {
	const end = visibleWidth(gitLine);
	if (end <= 0) return undefined;
	return { line, start: 0, end, dir, width };
}

type RevealKind = "opened" | "focused";

// Kept warm so a click can see an existing Explorer window without paying PowerShell startup.
// Hidden CabinetWClass ghosts (not visible, not minimized) are ignored — they are not on screen.
const EXPLORER_REVEAL_SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiExplorerFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
  public static void Focus(IntPtr hWnd) {
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint thisThread = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != thisThread && AttachThreadInput(thisThread, fgThread, true);
    try {
      if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
      BringWindowToTop(hWnd);
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(thisThread, fgThread, false);
    }
  }
}
'@
function Get-NormPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  $p = $p.Trim()
  if ($p.StartsWith("file:", [System.StringComparison]::OrdinalIgnoreCase)) {
    try { $p = ([Uri]$p).LocalPath } catch { return "" }
  }
  try { $p = [System.IO.Path]::GetFullPath($p) } catch {}
  return $p.TrimEnd('\').ToLowerInvariant()
}
function Convert-ToHwnd($value) {
  $n = [int64]$value
  if ($n -lt 0) { $n = $n -band ([int64]4294967295) }
  return New-Object IntPtr $n
}
$shell = New-Object -ComObject Shell.Application
[Console]::Out.WriteLine("ready")
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $target = Get-NormPath $line
  $chosenId = [int64]0
  $chosenVisible = $false
  if ($target.Length -gt 0) {
    try { $windows = @($shell.Windows()) } catch { $shell = New-Object -ComObject Shell.Application; $windows = @() }
    foreach ($w in $windows) {
      try {
        $name = [string]$w.Name
        if ($name -ne "File Explorer" -and $name -ne "Windows Explorer") { continue }
        if ((Get-NormPath ([string]$w.Document.Folder.Self.Path)) -ne $target) { continue }
        $hwnd = Convert-ToHwnd $w.HWND
        if ($hwnd.ToInt64() -eq 0 -or -not [PiExplorerFocus]::IsWindow($hwnd)) { continue }
        $visible = [PiExplorerFocus]::IsWindowVisible($hwnd)
        $iconic = [PiExplorerFocus]::IsIconic($hwnd)
        if (-not $visible -and -not $iconic) { continue }
        if ($visible -and -not $iconic) { $chosenId = $hwnd.ToInt64(); $chosenVisible = $true; break }
        if (-not $chosenVisible) { $chosenId = $hwnd.ToInt64() }
      } catch {}
    }
  }
  if ($chosenId -ne 0) {
    try {
      [PiExplorerFocus]::Focus((New-Object IntPtr $chosenId))
      [Console]::Out.WriteLine("focused")
    } catch {
      [Console]::Out.WriteLine("opened")
    }
  } else {
    [Console]::Out.WriteLine("opened")
  }
  [Console]::Out.Flush()
}
`;

type RevealWaiter = {
	resolve: (kind: RevealKind) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

class ExplorerReveal {
	private child: ChildProcessWithoutNullStreams | undefined;
	private generation = 0;
	private ready = false;
	private buffer = "";
	private outgoing: string[] = [];
	private waiters: RevealWaiter[] = [];

	prewarm(): void {
		if (process.platform !== "win32") return;
		this.ensure();
	}

	stop(): void {
		this.generation++;
		const child = this.child;
		this.drop(new Error("stopped"));
		if (child && !child.killed) child.kill();
	}

	ask(dir: string): Promise<RevealKind> {
		this.ensure();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.generation++;
				const child = this.child;
				this.drop(new Error("explorer reveal timed out"));
				if (child && !child.killed) child.kill();
			}, 8000);
			if (typeof timer === "object" && "unref" in timer) timer.unref();
			this.waiters.push({ resolve, reject, timer });
			this.outgoing.push(dir.replace(/[\r\n]+/g, ""));
			this.flush();
		});
	}

	private ensure(): void {
		if (process.platform !== "win32") return;
		if (this.child && this.child.exitCode === null && !this.child.killed) return;
		const generation = ++this.generation;
		this.ready = false;
		this.buffer = "";
		const encoded = Buffer.from(EXPLORER_REVEAL_SCRIPT, "utf16le").toString("base64");
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NoLogo", "-NonInteractive", "-EncodedCommand", encoded],
			{ windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
		);
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (generation !== this.generation) return;
			this.onData(chunk);
		});
		const lost = (error: Error) => {
			if (generation !== this.generation) return;
			this.drop(error);
		};
		child.on("error", lost);
		child.on("exit", () => lost(new Error("explorer reveal helper exited")));
		child.stdin.on("error", () => {});
		child.stdout.unref();
		child.stdin.unref();
		child.unref();
	}

	private drop(error: Error): void {
		const waiters = this.waiters.splice(0);
		this.outgoing = [];
		this.ready = false;
		this.buffer = "";
		this.child = undefined;
		for (const waiter of waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	private flush(): void {
		if (!this.ready || !this.child?.stdin.writable) return;
		while (this.outgoing.length > 0) {
			const dir = this.outgoing.shift();
			if (dir === undefined) break;
			this.child.stdin.write(`${dir}\n`);
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			this.onLine(line);
			nl = this.buffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		if (!line) return;
		if (line === "ready") {
			this.ready = true;
			this.flush();
			return;
		}
		if (line !== "focused" && line !== "opened") return;
		const waiter = this.waiters.shift();
		if (!waiter) return;
		clearTimeout(waiter.timer);
		waiter.resolve(line);
	}
}

const explorerReveal = new ExplorerReveal();

/** Open `dir` in Explorer, Finder, or the desktop file manager. */
function openInFileManager(dir: string, notify: (message: string) => void): void {
	// Same Windows opener Pi uses for links. FileProtocolHandler opens a directory in Explorer.
	// explorer.exe plus windowsHide often starts behind a fullscreen terminal and looks like a miss.
	const child =
		process.platform === "win32"
			? spawn("rundll32", ["url.dll,FileProtocolHandler", pathToFileURL(dir).href], { detached: true, stdio: "ignore" })
			: process.platform === "darwin"
				? spawn("open", [dir], { detached: true, stdio: "ignore" })
				: spawn("xdg-open", [dir], { detached: true, stdio: "ignore" });
	child.on("error", (error) => notify(error.message));
	child.unref();
}

/** Focus an Explorer window already showing `dir`. Open one when none is on screen. */
function revealInFileManager(dir: string, notify: (message: string) => void): Promise<RevealKind> {
	if (process.platform !== "win32") {
		openInFileManager(dir, notify);
		return Promise.resolve("opened");
	}
	return explorerReveal.ask(dir).then(
		(kind) => {
			if (kind === "opened") openInFileManager(dir, notify);
			return kind;
		},
		(error: Error) => {
			if (error.message === "stopped") return "opened";
			openInFileManager(dir, notify);
			return "opened" as const;
		},
	);
}

/** Center `center` in the gap between `left` and `right`. Drop it when the gap is too small. */
function placeCenter(left: string, center: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	const centerWidth = visibleWidth(center);
	if (!center || centerWidth > gap) return padLine(left, right, width);
	const spare = gap - centerWidth;
	const leftPad = Math.floor(spare / 2);
	const rightPad = spare - leftPad;
	return left + " ".repeat(leftPad) + center + " ".repeat(rightPad) + right;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let usage: SubUsage = { cursorPct: null, otherPct: null, fetchedAt: 0 };
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let fetchInFlight: Promise<void> | undefined;
	let renderHook: (() => void) | undefined;
	let sessionAbort: AbortController | undefined;

	async function refreshUsage(force = false): Promise<void> {
		if (!enabled) return;
		if (!force && usage.fetchedAt && Date.now() - usage.fetchedAt < 30_000) return;
		if (fetchInFlight) return fetchInFlight;
		fetchInFlight = (async () => {
			usage = await fetchSubUsage(sessionAbort?.signal);
			renderHook?.();
		})().finally(() => {
			fetchInFlight = undefined;
		});
		return fetchInFlight;
	}

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const requestRender = () => tui.requestRender();
			renderHook = requestRender;
			let gitHit: GitHit | undefined;
			let openedLines: string[] = [];

			const hitAt = (event: TuiMouseEvent): GitHit | undefined => {
				if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
				const hit = gitHit;
				if (!hit || hit.width !== event.width) return undefined;
				// One cell of slop. The git icon can be 1 cell on screen and 2 in the width count.
				if (event.y !== hit.line || event.x < hit.start - 1 || event.x >= hit.end + 1) return undefined;
				return hit;
			};

			return {
				dispose() {
					unsubBranch();
					if (renderHook === requestRender) renderHook = undefined;
				},
				invalidate() {},
				handleMouse(event: TuiMouseEvent) {
					const hit = hitAt(event);
					if (!hit) return undefined;
					// Windows Terminal reports a move between press and release, so Pi never
					// synthesizes a click. Open on press. Ignore the click that follows a still pointer.
					if (event.type === "press") {
						void revealInFileManager(hit.dir, (message) => ctx.ui.notify(message, "error")).then((kind) => {
							const verb = kind === "focused" ? "Focused" : "Opened";
							openedLines.push(`${verb} ${hit.dir}`);
							if (openedLines.length > 20) openedLines = openedLines.slice(-20);
							ctx.ui.notify(openedLines.join("\n"), "info");
						});
					}
					return { handled: true, render: false };
				},
				render(width: number): string[] {
					gitHit = undefined;
					readCursorConfig();
					readModelsCatalog();
					const branch = footerData.getGitBranch() || undefined;
					const modelId = ctx.model?.id || "no-model";
					const session = sessionCursor(ctx);
					const modeName = session?.mode ?? catalog.mode;
					const fastOverride = session && "fast" in session ? session.fast : catalog.fastOverride;
					const contextOverride = session?.context ?? catalog.contextOverride;
					const ctxUsage = ctx.getContextUsage();
					const used = ctxUsage?.tokens;
					// A Cursor model's limit is the context size chosen for it, not the model's maximum.
					const selectedLimit = ctx.model?.provider === "cursor-acp" ? selectedContextTokens(modelId, contextOverride) : undefined;
					const limit = selectedLimit ?? ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const usedStr = used === null || used === undefined ? "?" : fmtTokens(used);
					const limitStr = limit > 0 ? fmtTokens(limit) : "?";
					const modelName = catalog.nameByModel.get(modelId) || modelId;
					const thinking = ctx.thinkingLevel ?? "off";
					const gitColor = theme.getThinkingBorderColor(thinking);
					const supportsFast = catalog.fastByModel.has(modelId);
					const fastKnown = supportsFast ? (fastOverride ?? catalog.fastByModel.get(modelId)) : undefined;
					const fastStr = fastKnown === undefined ? "" : `Fast: ${fastKnown ? "\u2713" : "\u2717"}`;
					const mode = ctx.model?.provider === "cursor-acp" ? modeLabel(modeName) : "";
					const sep = theme.fg("dim", " │ ");
					const paint = (bits: readonly string[]) => theme.fg("dim", bits.join("\0")).split("\0").join(sep);

					const leftBits = [mode, modelName, fastStr, `Effort: ${thinking}`, `${usedStr} / ${limitStr}`].filter(Boolean);
					const left = paint(leftBits);
					const tightLeft = paint([mode, modelName, fastStr, thinking, `${usedStr} / ${limitStr}`].filter(Boolean));
					const cur = pctColor(theme, "Cursor", usage.cursorPct, usage.error);
					const oth = pctColor(theme, "Other Models", usage.otherPct, usage.error);
					const right = `${cur}${sep}${oth}`;
					const inset = Math.max(8, width - 2);
					const rule = theme.fg("dim", "─".repeat(Math.max(0, inset)));
					const ellipsis = theme.fg("dim", "...");
					const forms = gitForms(ctx.cwd, branch);
					const leftWidth = visibleWidth(left);
					const rightWidth = visibleWidth(right);
					const centered = forms.find((form) => fitsBetween(leftWidth, visibleWidth(form), rightWidth, inset)) ?? "";
					const lines = [truncateToWidth(rule, width)];
					const gitLine = forms.length ? gitColor(gitThatFits(forms, inset)) : "";
					const firstLine = visibleWidth(left) <= inset ? left : visibleWidth(tightLeft) <= inset ? tightLeft : truncateToWidth(tightLeft, inset, ellipsis);
					if (centered) {
						const center = gitColor(centered);
						lines.push(placeCenter(left, center, right, inset));
						gitHit = centeredGitHit(left, center, right, inset, lines.length - 1, width, ctx.cwd);
					} else if (leftWidth + rightWidth + 1 <= inset) {
						lines.push(padLine(left, right, inset));
						if (gitLine) {
							lines.push(gitLine);
							gitHit = ownLineGitHit(gitLine, lines.length - 1, width, ctx.cwd);
						}
					} else {
						lines.push(firstLine);
						if (gitLine) {
							lines.push(gitLine);
							gitHit = ownLineGitHit(gitLine, lines.length - 1, width, ctx.cwd);
						}
						lines.push(truncateToWidth(right, inset, ellipsis));
					}

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const text = Array.from(statuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, t]) => t.replace(/[\r\n\t]+/g, " ").trim())
							.join(" ");
						lines.push(truncateToWidth(text, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	}

	function startPolling(): void {
		stopPolling();
		pollTimer = setInterval(() => {
			void refreshUsage(true);
		}, POLL_MS);
		if (typeof pollTimer === "object" && "unref" in pollTimer) {
			pollTimer.unref();
		}
	}

	function stopPolling(): void {
		if (pollTimer !== undefined) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		rememberEffort(ctx.model);
		sessionAbort?.abort();
		sessionAbort = new AbortController();
		if (!enabled || ctx.mode !== "tui") return;
		installFooter(ctx);
		explorerReveal.prewarm();
		startPolling();
		void loadCursorCatalog();
		void refreshUsage(true);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
		explorerReveal.stop();
		sessionAbort?.abort();
		sessionAbort = undefined;
		renderHook = undefined;
	});

	pi.on("model_select", (event) => {
		rememberEffort(event.model);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled || ctx.mode !== "tui") return;
		catalog.modelsMtime = 0;
		void loadCursorCatalog();
		void refreshUsage(true);
	});

	const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	type EffortLevel = (typeof EFFORT_LEVELS)[number];

	let effortChoices: readonly EffortLevel[] = EFFORT_LEVELS;

	function effortsFor(model: { thinkingLevelMap?: Partial<Record<EffortLevel, string | null>> } | undefined): EffortLevel[] {
		const map = model?.thinkingLevelMap;
		if (!map) return [...EFFORT_LEVELS];
		const levels = EFFORT_LEVELS.filter((level) => typeof map[level] === "string");
		return levels.length > 0 ? levels : [...EFFORT_LEVELS];
	}

	function rememberEffort(model: { thinkingLevelMap?: Partial<Record<EffortLevel, string | null>> } | undefined): void {
		effortChoices = effortsFor(model);
	}

	function supportedEfforts(ctx: ExtensionContext): EffortLevel[] {
		return effortsFor(ctx.model);
	}

	function parseEffort(raw: string): EffortLevel | undefined {
		const value = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
		if (value === "extra-high" || value === "extrahigh" || value === "x-high") return "xhigh";
		if (value === "none") return "off";
		return EFFORT_LEVELS.find((level) => level === value);
	}

	pi.registerCommand("effort", {
		description: "Cycle effort, or set it: /effort high",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toLowerCase();
			const items = effortChoices.filter((level) => level.startsWith(needle)).map((level) => ({ label: level, value: level }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const levels = supportedEfforts(ctx);
			const raw = args.trim();
			let next: EffortLevel;
			if (!raw) {
				const current = (ctx.thinkingLevel ?? pi.getThinkingLevel()) as EffortLevel;
				const index = levels.indexOf(current);
				next = levels[(index + 1) % levels.length] ?? levels[0]!;
			} else {
				const parsed = parseEffort(raw);
				if (!parsed) {
					ctx.ui.notify(`Usage: /effort [${levels.join("|")}]`, "warning");
					return;
				}
				if (!levels.includes(parsed)) {
					ctx.ui.notify(`Effort ${parsed} not on this model. Use ${levels.join(", ")}`, "warning");
					return;
				}
				next = parsed;
			}
			pi.setThinkingLevel(next);
			renderHook?.();
			ctx.ui.notify(`Effort: ${pi.getThinkingLevel()}`, "info");
		},
	});

	pi.registerCommand("footer", {
		description: "Toggle rich footer (model, thinking, tokens, branch, Cursor usage)",
		getArgumentCompletions: (prefix) => completeOnOff(prefix),
		handler: async (args, ctx) => {
			const flag = parseOnOff(args);
			if (flag === "invalid") {
				ctx.ui.notify("Usage: /footer [on|off]", "warning");
				return;
			}
			enabled = flag === "toggle" ? !enabled : flag;
			if (enabled) {
				installFooter(ctx);
				explorerReveal.prewarm();
				startPolling();
				void loadCursorCatalog();
				void refreshUsage(true);
				const tip =
					usage.cursorPct !== null
						? `Cursor: ${fmtPct(usage.cursorPct)}%  Other Models: ${fmtPct(usage.otherPct ?? 0)}%`
						: "fetching Cursor usage…";
				ctx.ui.notify(`Rich footer on — ${tip}`, "info");
			} else {
				stopPolling();
				explorerReveal.stop();
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}

function completeOnOff(prefix: string): { label: string; value: string }[] | null {
	const needle = prefix.trim().toLowerCase();
	const items = ["on", "off"].filter((item) => item.startsWith(needle)).map((item) => ({ label: item, value: item }));
	return items.length ? items : null;
}

function parseOnOff(args: string): boolean | "toggle" | "invalid" {
	const value = args.trim().toLowerCase();
	if (!value) return "toggle";
	if (value === "on" || value === "true") return true;
	if (value === "off" || value === "false") return false;
	return "invalid";
}
