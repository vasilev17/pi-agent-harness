import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";

/**
 * Pi resolves a language from the file extension and deliberately never falls back to
 * content auto-detection, because highlight.js guesses confidently and wrongly on the
 * things people read most: prose scores as AppleScript or LiveCode, logs and `git log`
 * output as Apache, a one-line TypeScript statement as AutoIt. Relevance scores do not
 * separate those from real matches, and the library is not reachable from this package
 * anyway — Pi keeps it nested.
 *
 * So this module only widens the deterministic signals: names that identify a file
 * without an extension, extensions Pi's table omits, and an interpreter the file
 * declares itself. Anything still unknown stays unhighlighted rather than guessed.
 */

/** Files whose name, not extension, states the language. Keyed by lowercased basename. */
const FILENAME_LANGUAGES: Readonly<Record<string, string>> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	"cmakelists.txt": "cmake",
	rakefile: "ruby",
	gemfile: "ruby",
	guardfile: "ruby",
	podfile: "ruby",
	brewfile: "ruby",
	vagrantfile: "ruby",
	jenkinsfile: "groovy",
	".bashrc": "bash",
	".bash_profile": "bash",
	".bash_aliases": "bash",
	".zshrc": "bash",
	".zprofile": "bash",
	".profile": "bash",
	".editorconfig": "ini",
	".npmrc": "ini",
	".yarnrc": "ini",
};

/** Extensions Pi's own table does not cover. Unsupported names degrade to plain text. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
	mts: "typescript",
	cts: "typescript",
	jsonc: "json",
	json5: "json",
	bat: "dos",
	cmd: "dos",
	psm1: "powershell",
	psd1: "powershell",
	ini: "ini",
	cfg: "ini",
	conf: "ini",
	properties: "properties",
	diff: "diff",
	patch: "diff",
	svg: "xml",
	gradle: "groovy",
	groovy: "groovy",
	dart: "dart",
	nix: "nix",
	zig: "zig",
	mm: "objectivec",
	pl: "perl",
	pm: "perl",
	rake: "ruby",
	kts: "kotlin",
	sc: "scala",
	vb: "vbnet",
	jl: "julia",
	cr: "crystal",
	awk: "awk",
	tcl: "tcl",
	f90: "fortran",
	f95: "fortran",
};

/** Interpreters seen after `#!`, with any version suffix already stripped. */
const INTERPRETER_LANGUAGES: Readonly<Record<string, string>> = {
	bash: "bash",
	sh: "bash",
	zsh: "bash",
	dash: "bash",
	ksh: "bash",
	fish: "fish",
	python: "python",
	node: "javascript",
	deno: "typescript",
	bun: "typescript",
	ruby: "ruby",
	perl: "perl",
	php: "php",
	lua: "lua",
	awk: "awk",
	gawk: "awk",
	rscript: "r",
	pwsh: "powershell",
	powershell: "powershell",
	tclsh: "tcl",
};

function basename(path: string): string {
	const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return separator === -1 ? path : path.slice(separator + 1);
}

/** `python3.12` and `ruby2.7` name the same languages as `python` and `ruby`. */
function stripVersion(interpreter: string): string {
	return interpreter.replace(/[\d.]+$/u, "");
}

/** Read the language a `#!` line declares, e.g. `#!/usr/bin/env -S python3 -u`. */
export function languageFromShebang(line: string): string | undefined {
	const shebang = line.match(/^#!\s*(\S+)((?:\s+\S+)*)$/u);
	if (!shebang) return undefined;
	const command = basename(shebang[1]!).toLowerCase();
	if (command !== "env") return INTERPRETER_LANGUAGES[stripVersion(command)];
	// `env` forwards to the first argument that is not one of its own flags.
	for (const argument of shebang[2]!.trim().split(/\s+/u)) {
		if (!argument || argument.startsWith("-") || argument.includes("=")) continue;
		return INTERPRETER_LANGUAGES[stripVersion(basename(argument).toLowerCase())];
	}
	return undefined;
}

/** Resolve a language from the path alone, without looking at file contents. */
export function languageFromPath(path: string): string | undefined {
	const fromPi = getLanguageFromPath(path);
	if (fromPi) return fromPi;
	const name = basename(path).toLowerCase();
	const byName = FILENAME_LANGUAGES[name];
	if (byName) return byName;
	// `.env`, `.env.local`, and `.env.production` all hold the same KEY=value shape.
	if (name === ".env" || name.startsWith(".env.")) return "ini";
	const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : undefined;
	return extension ? EXTENSION_LANGUAGES[extension] : undefined;
}

/**
 * Resolve a language for a file view. `firstLine` is only consulted when it is genuinely
 * the file's first line, so a `read` starting at an offset never mistakes a comment for
 * a shebang.
 */
export function resolveLanguage(path: string, firstLine?: string): string | undefined {
	return languageFromPath(path) ?? (firstLine === undefined ? undefined : languageFromShebang(firstLine));
}
