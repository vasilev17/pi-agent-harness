/**
 * Each editor window listens on 127.0.0.1 and writes its port plus workspace
 * folders to ~/.pi/editor-open/windows/<pid>.json.
 *
 * Pi POSTs /open. This window opens the file only when `folder` is one of its
 * workspace folders and the file is inside that folder.
 *
 * POST /open
 * { "folder": "<session cwd>", "file": "<absolute path>", "startLine": 21, "endLine": 32 }
 * → { "opened": true } or { "opened": false, "reason": "..." }
 *
 * Lines are 1-based and inclusive. endLine may be omitted.
 * GET /health → { "ok": true, "folders": [...] }
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const REGISTRY_DIR = path.join(os.homedir(), ".pi", "editor-open", "windows");

type OpenRequest = {
	folder?: unknown;
	file?: unknown;
	startLine?: unknown;
	endLine?: unknown;
};

type RegistryRecord = {
	port: number;
	pid: number;
	folders: string[];
};

let server: http.Server | undefined;
let registryFile: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	sweepDeadRecords();
	server = http.createServer((req, res) => {
		void handle(req, res);
	});
	await listen(server);
	writeRegistry();
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => writeRegistry()),
		vscode.commands.registerCommand("piEditorOpen.status", () => {
			const address = server?.address();
			const port = address && typeof address === "object" ? address.port : 0;
			const folders = workspaceFolders();
			void vscode.window.showInformationMessage(
				folders.length
					? `Pi Reference Support on 127.0.0.1:${port} — ${folders.join(", ")}`
					: `Pi Reference Support on 127.0.0.1:${port} — no folder open`,
			);
		}),
		new vscode.Disposable(() => {
			server?.close();
			server = undefined;
			if (registryFile) {
				try {
					fs.rmSync(registryFile, { force: true });
				} catch {
					// The window is closing. A stale pid file is swept on the next start.
				}
			}
		}),
	);
}

export function deactivate(): void {
	server?.close();
	if (registryFile) {
		try {
			fs.rmSync(registryFile, { force: true });
		} catch {
			// Same as dispose.
		}
	}
}

function listen(instance: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		instance.once("error", reject);
		instance.listen(0, "127.0.0.1", () => {
			instance.off("error", reject);
			resolve();
		});
	});
}

function workspaceFolders(): string[] {
	return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function writeRegistry(): void {
	const address = server?.address();
	if (!address || typeof address !== "object") return;
	fs.mkdirSync(REGISTRY_DIR, { recursive: true });
	const record: RegistryRecord = { port: address.port, pid: process.pid, folders: workspaceFolders() };
	const file = path.join(REGISTRY_DIR, `${process.pid}.json`);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(record));
	fs.renameSync(temp, file);
	registryFile = file;
}

function sweepDeadRecords(): void {
	let names: string[] = [];
	try {
		names = fs.readdirSync(REGISTRY_DIR);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(REGISTRY_DIR, name);
		let pid = Number(name.slice(0, -".json".length));
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
			if (typeof parsed.pid === "number") pid = parsed.pid;
		} catch {
			// A broken record is removed when its pid is dead.
		}
		if (!Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// Another window may have removed it.
		}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		if (req.method === "GET" && req.url === "/health") {
			send(res, 200, { ok: true, folders: workspaceFolders() });
			return;
		}
		if (req.method !== "POST" || req.url !== "/open") {
			send(res, 404, { opened: false, reason: "not found" });
			return;
		}
		const body = await readBody(req);
		let parsed: OpenRequest;
		try {
			parsed = JSON.parse(body) as OpenRequest;
		} catch {
			send(res, 400, { opened: false, reason: "invalid json" });
			return;
		}
		const result = await openInThisWindow(parsed);
		send(res, 200, result);
	} catch (error) {
		send(res, 500, { opened: false, reason: error instanceof Error ? error.message : String(error) });
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 64 * 1024) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function openInThisWindow(request: OpenRequest): Promise<{ opened: boolean; reason?: string }> {
	if (typeof request.folder !== "string" || typeof request.file !== "string") {
		return { opened: false, reason: "folder and file are required" };
	}
	if (!path.isAbsolute(request.folder) || !path.isAbsolute(request.file)) {
		return { opened: false, reason: "folder and file must be absolute" };
	}
	const folder = workspaceFolders().find((candidate) => sameDir(candidate, request.folder as string));
	if (!folder) return { opened: false, reason: "folder not open in this window" };
	if (!isInside(folder, request.file)) return { opened: false, reason: "file is outside the session folder" };

	const startLine = lineNumber(request.startLine) ?? 1;
	const endLine = lineNumber(request.endLine) ?? startLine;
	try {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.file));
		const last = Math.max(0, document.lineCount - 1);
		const start = Math.min(last, Math.max(0, startLine - 1));
		const end = Math.min(last, Math.max(start, endLine - 1));
		const selection = new vscode.Selection(start, 0, end, document.lineAt(end).text.length);
		await vscode.window.showTextDocument(document, { selection, preview: false, preserveFocus: false });
		return { opened: true };
	} catch (error) {
		return { opened: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function lineNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function sameDir(left: string, right: string): boolean {
	return normalizeDir(left) === normalizeDir(right);
}

function normalizeDir(value: string): string {
	const resolved = path.resolve(value).replace(/[\\/]+$/, "");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, file: string): boolean {
	const relative = path.relative(normalizeDir(root), normalizeDir(file));
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
	res.end(payload);
}
