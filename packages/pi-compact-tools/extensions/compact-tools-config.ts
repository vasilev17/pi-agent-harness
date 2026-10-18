import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DISPLAY_MODES,
	DISPLAY_STYLES,
	SUPPORTED_TOOL_SET,
	type CompactToolName,
	type CompactToolsConfig,
	type DisplayMode,
	type DisplayStyle,
} from "./compact-tools-types.ts";

const CONFIG_FILE = "compact-tools.json";
type JsonObject = Record<string, unknown>;

export const DEFAULT_CONFIG: CompactToolsConfig = {
	mode: "normal",
	style: "compact",
	tools: ["read", "write", "edit", "bash"],
	previewLines: 10,
	auto_compact: {
		read: true,
		write: true,
		edit: false,
		bash: true,
		powershell: true,
		grep: true,
		find: true,
		ls: true,
	},
	custom_tools: {
		enabled: true,
		auto_compact: true,
		exclude: [],
	},
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(path: string, message: string): void {
	console.error(`[compact-tools] ${path}: ${message}`);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function parseChoice<T extends string>(value: unknown, choices: readonly T[], key: string, path: string): T | undefined {
	if ((choices as readonly unknown[]).includes(value)) return value as T;
	warn(path, `${key} must be one of ${choices.join(", ")}; using previous value`);
	return undefined;
}

function parseTools(value: unknown, path: string): CompactToolName[] | undefined {
	if (!Array.isArray(value)) {
		warn(path, "tools must be an array; using previous values");
		return undefined;
	}
	const tools: CompactToolName[] = [];
	const invalid: unknown[] = [];
	for (const item of value) {
		if (typeof item === "string" && SUPPORTED_TOOL_SET.has(item)) tools.push(item as CompactToolName);
		else invalid.push(item);
	}
	if (invalid.length > 0) warn(path, `ignoring unsupported tools: ${invalid.map(String).join(", ")}`);
	return [...new Set(tools)];
}

function parseAutoCompact(
	base: CompactToolsConfig["auto_compact"],
	value: unknown,
	path: string,
): CompactToolsConfig["auto_compact"] {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "auto_compact must be an object; using previous values");
		return base;
	}
	const result = { ...base };
	// Any tool name is accepted: a custom tool's entry overrides custom_tools.auto_compact.
	for (const [name, enabled] of Object.entries(value)) {
		if (typeof enabled !== "boolean") {
			warn(path, `auto_compact.${name} must be true or false; using previous value`);
		} else {
			result[name] = enabled;
		}
	}
	return result;
}

function parseCustomTools(
	base: CompactToolsConfig["custom_tools"],
	value: unknown,
	path: string,
): CompactToolsConfig["custom_tools"] {
	if (value === undefined) return base;
	if (typeof value === "boolean") return { ...base, enabled: value };
	if (!isObject(value)) {
		warn(path, "custom_tools must be true, false, or an object; using previous values");
		return base;
	}
	const result = { ...base };
	for (const key of ["enabled", "auto_compact"] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] === "boolean") result[key] = value[key];
		else warn(path, `custom_tools.${key} must be true or false; using previous value`);
	}
	if (value.exclude !== undefined) {
		if (Array.isArray(value.exclude) && value.exclude.every((name) => typeof name === "string")) {
			result.exclude = [...new Set(value.exclude as string[])];
		} else {
			warn(path, "custom_tools.exclude must be an array of tool names; using previous values");
		}
	}
	return result;
}

export function mergeConfig(base: CompactToolsConfig, value: unknown, path: string): CompactToolsConfig {
	if (value === undefined) return base;
	if (!isObject(value)) {
		warn(path, "expected a JSON object; using previous values");
		return base;
	}
	const mode = value.mode === undefined ? base.mode : (parseChoice<DisplayMode>(value.mode, DISPLAY_MODES, "mode", path) ?? base.mode);
	const style = value.style === undefined ? base.style : (parseChoice<DisplayStyle>(value.style, DISPLAY_STYLES, "style", path) ?? base.style);
	const tools = value.tools === undefined ? base.tools : (parseTools(value.tools, path) ?? base.tools);
	const auto_compact = parseAutoCompact(base.auto_compact, value.auto_compact, path);
	const custom_tools = parseCustomTools(base.custom_tools, value.custom_tools, path);
	const previewLines = value.previewLines === undefined ? base.previewLines
		: isIntegerInRange(value.previewLines, 1, 100) ? value.previewLines : base.previewLines;
	if (value.previewLines !== undefined && !isIntegerInRange(value.previewLines, 1, 100)) {
		warn(path, "previewLines must be 1–100; using previous value");
	}
	return { mode, style, tools, auto_compact, custom_tools, previewLines };
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warn(path, error instanceof Error ? error.message : String(error));
		return undefined;
	}
}

export function loadConfig(cwd?: string, projectTrusted = false): CompactToolsConfig {
	const globalPath = join(getAgentDir(), CONFIG_FILE);
	const globalConfig = mergeConfig(DEFAULT_CONFIG, readJson(globalPath), globalPath);
	if (!cwd || !projectTrusted) return globalConfig;
	const projectPath = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE);
	return mergeConfig(globalConfig, readJson(projectPath), projectPath);
}
