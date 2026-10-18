import { closeSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DynamicBorder, getAgentDir, getMarkdownTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";

/** One marker file per version shown, so two Pi processes can't both show it. */
const NOTICE_DIRECTORY = "compact-tools-notices";
const WIDGET_KEY = "compact-tools-release-notes";
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The headings a version's notes are grouped under, in the order they are shown. */
export const RELEASE_SECTIONS = ["New", "Fix", "Deprecated"] as const;
export type ReleaseSection = (typeof RELEASE_SECTIONS)[number];
/** A version's notes: grouped under New, Fix, and Deprecated, or, as older versions have them, a plain list. */
export type ReleaseEntry = readonly string[] | Partial<Record<ReleaseSection, readonly string[]>>;
export type ReleaseNotes = Record<string, ReleaseEntry>;

/**
 * A version's notes as Markdown, the way Pi's own changelog reads: a `### New`
 * heading over each group's `- ` items, or the items alone for a plain list.
 */
export function releaseMarkdown(entry: ReleaseEntry): string {
	return releaseSections(entry)
		.map(({ title, notes }) => [...(title ? [`### ${title}`, ""] : []), ...notes.map((note) => `- ${note}`)].join("\n"))
		.join("\n\n");
}

/** A version's notes as the groups they are shown in: a heading for each section with notes, none for a plain list. */
export function releaseSections(entry: ReleaseEntry): Array<{ title?: ReleaseSection; notes: readonly string[] }> {
	if (Array.isArray(entry)) return entry.length > 0 ? [{ notes: entry }] : [];
	const sections = entry as Partial<Record<ReleaseSection, readonly string[]>>;
	return RELEASE_SECTIONS.flatMap((title) => sections[title]?.length ? [{ title, notes: sections[title]! }] : []);
}

type Chat = { children: unknown[]; addChild(component: unknown): void };

function readReleaseNotes(): ReleaseNotes | undefined {
	try {
		return JSON.parse(readFileSync(new URL("../release-notes.json", import.meta.url), "utf8")) as ReleaseNotes;
	} catch {
		return undefined;
	}
}

export function installedVersion(): string {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
	return manifest.version;
}

/** Order two plain x.y.z versions; anything else sorts first. */
export function compareVersions(left: string, right: string): number {
	const a = VERSION.exec(left);
	const b = VERSION.exec(right);
	if (!a || !b) return a ? 1 : b ? -1 : 0;
	for (let part = 1; part <= 3; part++) {
		const difference = Number(a[part]) - Number(b[part]);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * The notes to show, newest first: every version with notes after the last one
 * shown, up to the installed one. An empty list marks a quiet release, such as a
 * documentation update, that shows nothing. With nothing shown before, only the
 * newest notes up to the installed version appear: that is either a new install
 * or an update from a version that predates these notices, and there is no
 * telling which.
 */
export function releasesToShow(
	installed: string,
	notes: ReleaseNotes,
	lastShown: string | undefined,
): Array<{ version: string; notes: ReleaseEntry }> {
	const withNotes = Object.keys(notes)
		.filter((version) =>
			VERSION.test(version)
			&& compareVersions(version, installed) <= 0
			&& releaseSections(notes[version]!).length > 0)
		.sort((left, right) => compareVersions(right, left));
	const versions = lastShown === undefined
		? withNotes.slice(0, 1)
		: withNotes.filter((version) => compareVersions(version, lastShown) > 0);
	return versions.map((version) => ({ version, notes: notes[version]! }));
}

function lastShownVersion(directory: string): string | undefined {
	try {
		return readdirSync(directory)
			.filter((name) => VERSION.test(name))
			.sort(compareVersions)
			.at(-1);
	} catch {
		return undefined;
	}
}

/** Pi's chat, the transcript document's last child, reached the same way in regular and fullscreen mode. */
function chatOf(tui: unknown): Chat | undefined {
	const chat = (tui as { children?: Array<{ children?: unknown[] }> }).children?.[0]?.children?.at(-1) as Chat | undefined;
	return Array.isArray(chat?.children) && typeof chat.addChild === "function" ? chat : undefined;
}

/** Drawn like Pi's own "What's New": a bordered block in the chat, never saved to the session or sent to the model. */
function addReleaseBlock(chat: Chat, theme: Theme, releases: ReturnType<typeof releasesToShow>): void {
	const border = (line: string) => theme.fg("border", line);
	if (chat.children.length > 0) chat.addChild(new Spacer(1));
	chat.addChild(new DynamicBorder(border));
	releases.forEach(({ version, notes }, index) => {
		if (index > 0) chat.addChild(new Spacer(1));
		chat.addChild(new Text(theme.bold(theme.fg("accent", `What's new in pi-compact-tools v${version}`)), 1, 0));
		chat.addChild(new Spacer(1));
		// Drawn as Pi draws its own changelog, so the headings and items look the same.
		chat.addChild(new Markdown(releaseMarkdown(notes), 1, 0, getMarkdownTheme()));
	});
	chat.addChild(new DynamicBorder(border));
}

/**
 * Show what changed since the version last shown, once, the way Pi shows its own
 * changelog: only when a conversation starts, as a bordered block in the chat.
 * A resumed session keeps the notes for the next new one.
 */
export function showReleaseNotice(
	ctx: ExtensionContext,
	version = installedVersion(),
	agentDir = getAgentDir(),
	notes: ReleaseNotes | undefined = readReleaseNotes(),
): boolean {
	if (ctx.mode !== "tui" || !VERSION.test(version) || !notes) return false;
	const resumed = ctx.sessionManager?.getEntries?.().some((entry) => entry.type === "message") ?? false;
	if (resumed) return false;
	const directory = join(agentDir, NOTICE_DIRECTORY);
	const releases = releasesToShow(version, notes, lastShownVersion(directory));
	if (releases.length === 0) return false;
	try {
		mkdirSync(directory, { recursive: true });
		// Exclusive creation: of two Pi processes starting together, only one shows it.
		closeSync(openSync(join(directory, version), "wx"));
	} catch {
		return false;
	}
	let shown = false;
	// An invisible widget is the extension API's way to reach Pi's TUI and its chat.
	// Pi builds the widget at once, so it can be removed right after.
	ctx.ui.setWidget(WIDGET_KEY, (tui) => {
		const chat = chatOf(tui);
		if (chat) {
			addReleaseBlock(chat, ctx.ui.theme, releases);
			shown = true;
		}
		return { render: () => [], invalidate() {} };
	}, { placement: "belowEditor" });
	ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
	if (!shown) {
		const text = releases.map(({ version: shownVersion, notes: shownNotes }) =>
			`pi-compact-tools v${shownVersion}\n\n${releaseMarkdown(shownNotes)}`).join("\n\n");
		ctx.ui.notify(text, "info");
	}
	return true;
}
