// Starts Pi in RPC mode, lists registered commands, and exits. No prompt is sent,
// so no model is called. Every extension and package still loads, which is
// what this checks: a load error shows up in `stderr` or as `ok: false`.
import { spawn } from "node:child_process";

const child = spawn("pi --mode rpc --no-session", { shell: true, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
const responses = new Map();
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	stdout += chunk;
	let nl;
	while ((nl = stdout.indexOf("\n")) !== -1) {
		const line = stdout.slice(0, nl).replace(/\r$/, "");
		stdout = stdout.slice(nl + 1);
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (record.type === "response" && record.id) responses.set(record.id, record);
		} catch {
			stderr += `[non-json stdout] ${line}\n`;
		}
	}
});
child.stderr.on("data", (chunk) => { stderr += chunk; });

const send = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
const wait = async (id, ms = 30000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (responses.has(id)) return responses.get(id);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timeout waiting for ${id}`);
};

try {
	send({ id: "cmds", type: "get_commands" });
	const cmds = await wait("cmds");
	send({ id: "state", type: "get_state" });
	const state = await wait("state");
	const commands = (cmds.data?.commands ?? cmds.data ?? []).map((item) => `${item.source ?? "?"}:${item.name}`).sort();
	const errors = stderr.trim().split("\n").filter(Boolean);
	console.log(JSON.stringify({
		ok: cmds.success && state.success && errors.length === 0,
		model: state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : null,
		commands,
		stderr: errors,
	}, null, 2));
	if (errors.length) process.exitCode = 1;
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: String(error), stderr: stderr.trim().split("\n") }, null, 2));
	process.exitCode = 1;
} finally {
	child.kill();
	setTimeout(() => process.exit(), 500);
}
