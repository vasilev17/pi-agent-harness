/**
 * `@` file completion follows `fd`, and `fd` skips gitignored files.
 * This adds a second search with `--no-ignore-vcs` so those files show up too.
 * `.git` stays excluded. A bare `@` still uses Pi's normal list.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { AT_NO_MATCH } from "./path-tags.ts";

const MARK = Symbol.for("val.pi.at-ignored");

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const PATH_WRAPPERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

type FdEntry = { path: string; isDirectory: boolean };

type AtPrefix = {
	prefix: string;
	raw: string;
	quoted: boolean;
};

let cwd = "";

function fdBinary(): string {
	const name = process.platform === "win32" ? "fd.exe" : "fd";
	const local = join(getAgentDir(), "bin", name);
	return existsSync(local) ? local : name;
}

function toDisplayPath(value: string): string {
	return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFdPathQuery(query: string): string {
	const normalized = toDisplayPath(query);
	if (!normalized.includes("/")) return normalized;
	const hasTrailingSeparator = normalized.endsWith("/");
	const trimmed = normalized.replace(/^\/+|\/+$/g, "");
	if (!trimmed) return normalized;
	const segments = trimmed.split("/").filter(Boolean).map(escapeRegex);
	if (segments.length === 0) return normalized;
	let pattern = segments.join("[\\\\/]");
	if (hasTrailingSeparator) pattern += "[\\\\/]";
	return pattern;
}

function findLastDelimiter(text: string): number {
	let lastDelimiter = -1;
	let index = 0;
	for (const character of text) {
		index += character.length;
		if (PATH_DELIMITERS.has(character) || /\s/u.test(character)) lastDelimiter = index - 1;
	}
	return lastDelimiter;
}

function stripLeadingWrappers(token: string): string {
	let result = token;
	while (result.length > 0) {
		const closer = PATH_WRAPPERS[result[0]];
		if (!closer || result.includes(closer, 1)) break;
		result = result.slice(1);
	}
	return result;
}

function findUnclosedQuoteStart(text: string): number | null {
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] !== '"') continue;
		inQuotes = !inQuotes;
		if (inQuotes) quoteStart = i;
	}
	return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
	let start = index;
	while (start > 0 && PATH_WRAPPERS[text[start - 1]]) start -= 1;
	const previous = text[start - 1] ?? "";
	return start === 0 || PATH_DELIMITERS.has(previous) || /\s/u.test(previous);
}

/** Same `@` token Pi's autocomplete treats as a file reference. */
export function atPrefixFrom(textBeforeCursor: string): AtPrefix | null {
	const quoteStart = findUnclosedQuoteStart(textBeforeCursor);
	let prefix: string | null = null;
	if (quoteStart !== null && quoteStart > 0 && textBeforeCursor[quoteStart - 1] === "@") {
		if (isTokenStart(textBeforeCursor, quoteStart - 1)) prefix = textBeforeCursor.slice(quoteStart - 1);
	}
	if (!prefix) {
		const lastDelimiter = findLastDelimiter(textBeforeCursor);
		const token = stripLeadingWrappers(lastDelimiter === -1 ? textBeforeCursor : textBeforeCursor.slice(lastDelimiter + 1));
		if (token.startsWith("@")) prefix = token;
	}
	if (!prefix?.startsWith("@")) return null;
	if (prefix.startsWith('@"')) return { prefix, raw: prefix.slice(2), quoted: true };
	return { prefix, raw: prefix.slice(1), quoted: false };
}

function completionValue(path: string, quoted: boolean): string {
	if (quoted || /\s/u.test(path)) return `@"${path}"`;
	return `@${path}`;
}

function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
	const fileName = basename(filePath).toLowerCase();
	const lowerQuery = query.toLowerCase();
	let score = 0;
	if (fileName === lowerQuery) score = 100;
	else if (fileName.startsWith(lowerQuery)) score = 80;
	else if (fileName.includes(lowerQuery)) score = 50;
	else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;
	if (isDirectory && score > 0) score += 10;
	return score;
}

function resolveSearch(root: string, raw: string): { baseDir: string; query: string; displayBase: string } {
	const normalized = toDisplayPath(raw);
	const slashIndex = normalized.lastIndexOf("/");
	if (slashIndex === -1) return { baseDir: root, query: normalized, displayBase: "" };
	const displayBase = normalized.slice(0, slashIndex + 1);
	const query = normalized.slice(slashIndex + 1);
	let baseDir: string;
	if (displayBase.startsWith("~/")) baseDir = join(homedir(), displayBase.slice(2));
	else if (displayBase.startsWith("/")) baseDir = displayBase;
	else baseDir = join(root, displayBase);
	try {
		if (!statSync(baseDir).isDirectory()) return { baseDir: root, query: normalized, displayBase: "" };
	} catch {
		return { baseDir: root, query: normalized, displayBase: "" };
	}
	return { baseDir, query, displayBase };
}

function walkIgnored(baseDir: string, query: string, signal: AbortSignal): Promise<FdEntry[]> {
	const args = [
		"--base-directory",
		baseDir,
		"--max-results",
		"300",
		"--type",
		"f",
		"--type",
		"d",
		"--follow",
		"--hidden",
		"--no-ignore-vcs",
		"--exclude",
		".git",
		"--exclude",
		".git/*",
		"--exclude",
		".git/**",
	];
	const displayQuery = toDisplayPath(query);
	if (displayQuery.includes("/")) args.push("--full-path");
	if (query) args.push(buildFdPathQuery(query));

	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}
		const child = spawn(fdBinary(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let settled = false;
		const finish = (results: FdEntry[]) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(results);
		};
		const onAbort = () => {
			if (child.exitCode === null) child.kill();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => finish([]));
		child.on("close", (code) => {
			if (signal.aborted || code !== 0 || !stdout) {
				finish([]);
				return;
			}
			const results: FdEntry[] = [];
			for (const line of stdout.trim().split("\n")) {
				if (!line) continue;
				const displayLine = toDisplayPath(line);
				const hasTrailingSeparator = displayLine.endsWith("/");
				const normalizedPath = hasTrailingSeparator ? displayLine.slice(0, -1) : displayLine;
				if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) continue;
				results.push({ path: displayLine, isDirectory: hasTrailingSeparator });
			}
			finish(results);
		});
	});
}

export async function ignoredFileItems(root: string, at: AtPrefix, signal: AbortSignal): Promise<AutocompleteItem[]> {
	if (!at.raw) return [];
	const search = resolveSearch(root, at.raw);
	const entries = await walkIgnored(search.baseDir, search.query, signal);
	if (signal.aborted) return [];
	const scored = entries
		.map((entry) => ({ ...entry, score: search.query ? scoreEntry(entry.path, search.query, entry.isDirectory) : 1 }))
		.filter((entry) => entry.score > 0);
	scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return scored.slice(0, 20).map((entry) => {
		const pathWithoutSlash = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
		const displayPath = search.displayBase ? `${toDisplayPath(search.displayBase)}${toDisplayPath(pathWithoutSlash)}` : pathWithoutSlash;
		const completionPath = entry.isDirectory ? `${displayPath}/` : displayPath;
		const name = basename(pathWithoutSlash);
		return {
			value: completionValue(completionPath, at.quoted),
			label: entry.isDirectory ? `${name}/` : name,
			description: displayPath,
		};
	});
}

function itemScore(item: AutocompleteItem, query: string): number {
	const path = item.description || item.label.replace(/\/$/, "");
	return scoreEntry(path, query, item.label.endsWith("/"));
}

function wrap(current: AutocompleteProvider): AutocompleteProvider {
	if (MARK in current) return current;
	const wrapped: AutocompleteProvider = {
		triggerCharacters: current.triggerCharacters,
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
		applyCompletion: current.applyCompletion.bind(current),
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const textBeforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
			const at = atPrefixFrom(textBeforeCursor);
			if (!at) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const basePromise = current.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!at.raw) return basePromise;
			const [base, extra] = await Promise.all([
				basePromise,
				ignoredFileItems(cwd, at, options.signal),
			]);
			if (options.signal.aborted || extra.length === 0) return base;
			// path-tags fills an empty menu with a "No Matches" row. Ignored files are real matches, so it goes.
			const items = [...(base?.items ?? [])].filter((item) => item.value !== AT_NO_MATCH);
			const seen = new Set(items.map((item) => item.value));
			for (const item of extra) {
				if (seen.has(item.value)) continue;
				seen.add(item.value);
				items.push(item);
			}
			const query = toDisplayPath(at.raw).split("/").filter(Boolean).pop() ?? at.raw;
			items.sort((a, b) => itemScore(b, query) - itemScore(a, query) || a.label.localeCompare(b.label));
			return { items: items.slice(0, 20), prefix: base?.prefix ?? at.prefix };
		},
	};
	Object.defineProperty(wrapped, MARK, { value: true });
	return wrapped;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		cwd = ctx.cwd;
		ctx.ui.addAutocompleteProvider(wrap);
	});
}
