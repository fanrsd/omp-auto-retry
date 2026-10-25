/**
 * End-to-end harness: prove that omp-auto-retry actually resumes a session.
 *
 * Stands up a mock OpenAI-compatible provider that answers every completion
 * request with a real 429 quota wall (`retry-after: 2`) until it sees the
 * extension log a resume, then succeeds. Drives a real `omp --mode rpc` against
 * it and reports what the extension did.
 *
 * Why `retry-after: 2` and not a long window: omp's transport layer retries
 * 408/429/5xx up to 5 attempts on its own, honouring the hint. A short hint
 * makes that transport budget cheap to exhaust, after which the failure is
 * terminal — which is exactly the state this extension exists for. (A hint
 * above the transport's 60s cap would also return immediately, but then the
 * extension would legitimately sleep for the whole window.)
 *
 * Run: node e2e/run.mjs   (needs `omp` on PATH)
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SANDBOX = join(process.env.TEMP ?? "/tmp", "omp-e2e");
const AGENT_DIR = join(SANDBOX, "agent");
const LOG_DIR = join(SANDBOX, "logs");
const CONFIG_PATH = join(SANDBOX, "auto-retry.json");
const PORT = 8791;
const WALL_SECONDS = 2;
const DEADLINE_MS = 45_000;

// --- mock provider ----------------------------------------------------------

let completions = 0;
let resumesSeen = 0;

/** The extension log, read synchronously so the mock can react to it. */
function extensionLog() {
	const date = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	const path = join(LOG_DIR, `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`);
	if (!existsSync(path)) return "";
	return readFileSync(path, "utf8");
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => {
		body += chunk;
	});
	req.on("end", () => {
		if (!req.url.includes("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}

		completions += 1;
		log(`mock: completion request #${completions} (${body.length} bytes)`);

		// Stay walled until the extension has committed to a resume. That keeps
		// the harness independent of how many attempts omp's transport spends.
		const resumed = extensionLog().includes("sending resume");
		if (!resumed) {
			res.writeHead(429, {
				"content-type": "application/json",
				"retry-after": String(WALL_SECONDS),
				"x-request-id": `req_mock_${completions}`,
			});
			res.end(
				JSON.stringify({
					error: {
						message: `You have exceeded your quota. Your quota will reset after ${WALL_SECONDS}s.`,
						type: "insufficient_quota",
						code: "quota_exceeded",
					},
				}),
			);
			log(`mock: replied 429 quota wall, retry-after=${WALL_SECONDS}s`);
			return;
		}

		resumesSeen += 1;
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const frame = (delta, finish) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-mock",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "mock-1",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		res.write(frame({ role: "assistant", content: "" }, null));
		res.write(frame({ content: "resumed-ok" }, null));
		res.write(frame({}, "stop"));
		res.write("data: [DONE]\n\n");
		res.end();
		log("mock: replied 200 (streamed) — the resume request succeeded");
	});
});

// --- helpers ----------------------------------------------------------------

function log(message) {
	process.stdout.write(`[e2e] ${message}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function logLines() {
	return extensionLog()
		.split(/\r?\n/)
		.filter(Boolean);
}

// --- sandbox ----------------------------------------------------------------

function prepareSandbox() {
	rmSync(SANDBOX, { recursive: true, force: true });
	mkdirSync(join(AGENT_DIR, "extensions"), { recursive: true });
	mkdirSync(LOG_DIR, { recursive: true });

	// Turn off omp's own retry saga so a failure that survives the transport
	// layer surfaces as terminal instead of being slept-and-retried by the host.
	writeFileSync(
		join(AGENT_DIR, "config.yml"),
		["retry:", "  enabled: false", "  modelFallback: false", ""].join("\n"),
		"utf8",
	);

	writeFileSync(
		join(AGENT_DIR, "models.yml"),
		[
			"providers:",
			"  mock:",
			`    baseUrl: http://127.0.0.1:${PORT}/v1`,
			"    api: openai-completions",
			"    apiKey: test-key",
			"    authHeader: true",
			"    models:",
			"      - id: mock-1",
			"        name: Mock Model",
			"        contextWindow: 200000",
			"        maxTokens: 8192",
			"",
		].join("\n"),
		"utf8",
	);

	// Deterministic timing: no jitter, no safety margin on top of the published
	// reset, so the resume must land ~2s after the wall.
	writeFileSync(
		CONFIG_PATH,
		JSON.stringify({ notify: false, usageLimit: { marginMs: 0, jitterRatio: 0 } }, null, 2),
		"utf8",
	);

	cpSync(join(ROOT, "extension"), join(AGENT_DIR, "extensions", "omp-auto-retry"), { recursive: true });
	log(`sandbox ready at ${SANDBOX}`);
}

// --- driver -----------------------------------------------------------------

async function main() {
	prepareSandbox();
	await new Promise((done) => server.listen(PORT, "127.0.0.1", done));
	log(`mock provider listening on 127.0.0.1:${PORT}`);

	const child = spawn("omp", ["--mode", "rpc", "--no-ui", "--model", "mock/mock-1"], {
		cwd: SANDBOX,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: AGENT_DIR,
			OMP_AUTO_RETRY_CONFIG: CONFIG_PATH,
			OMP_AUTO_RETRY_LOG_DIR: LOG_DIR,
			NO_COLOR: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdoutBuffer = "";
	const seen = [];
	const turns = [];

	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk.toString();
		let index = stdoutBuffer.indexOf("\n");
		while (index !== -1) {
			const line = stdoutBuffer.slice(0, index).trim();
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			index = stdoutBuffer.indexOf("\n");
			if (!line) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			const type = frame.type ?? "?";
			if (!seen.includes(type)) seen.push(type);
			if (["turn_end", "auto_retry_start", "auto_retry_end"].includes(type)) turns.push(frame);
		}
	});

	child.stderr.on("data", (chunk) => log(`omp stderr: ${chunk.toString().trim().slice(0, 200)}`));

	await sleep(2500);
	child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "say ok" })}\n`);
	log("prompt sent");

	const startedAt = Date.now();
	let resumeAt = null;
	let recoveredAt = null;
	while (Date.now() - startedAt < DEADLINE_MS) {
		await sleep(500);
		const lines = logLines();
		if (resumeAt === null && lines.some((line) => line.includes("sending resume"))) {
			resumeAt = Date.now() - startedAt;
			log(`resume sent at T+${(resumeAt / 1000).toFixed(1)}s`);
		}
		if (lines.some((line) => line.includes("session recovered"))) {
			recoveredAt = Date.now() - startedAt;
			log(`session recovered at T+${(recoveredAt / 1000).toFixed(1)}s`);
			break;
		}
	}

	child.stdin.end();
	await sleep(1500);
	child.kill();
	server.close();

	const lines = logLines();
	process.stdout.write("\n===== extension log =====\n");
	for (const line of lines) process.stdout.write(`${line}\n`);

	process.stdout.write("\n===== rpc frames =====\n");
	process.stdout.write(`${seen.join(", ")}\n`);

	process.stdout.write("\n===== turn outcomes =====\n");
	for (const frame of turns) {
		if (frame.type === "turn_end") {
			const reason = frame.message?.stopReason;
			const error = frame.message?.errorMessage ?? frame.message?.errorClassificationMessage ?? null;
			process.stdout.write(`turn_end stopReason=${reason} error=${JSON.stringify(error).slice(0, 120)}\n`);
		} else {
			process.stdout.write(`${frame.type} ${JSON.stringify(frame).slice(0, 160)}\n`);
		}
	}

	const scheduled = lines.some((line) => line.includes("resume scheduled"));
	const sent = lines.some((line) => line.includes("sending resume"));
	const recovered = lines.some((line) => line.includes("session recovered"));
	// omp appends `retry-after-ms=<n>` to a failed request's message, derived from
	// the very headers the transport layer acted on. That annotation is the only
	// authoritative signal reachable from an extension, so it must be the one
	// that drives the wait.
	const annotated = lines.some((line) => line.includes("source=message:retry-after-ms"));
	const waited = lines.some((line) => line.includes(`in=${WALL_SECONDS}s`));
	const failedTurn = turns.some(
		(frame) => frame.type === "turn_end" && frame.message?.stopReason === "error",
	);

	process.stdout.write("\n===== verdict =====\n");
	const checks = [
		["terminal error turn", failedTurn],
		["resume scheduled", scheduled],
		["omp-annotated wait", annotated && waited],
		["resume sent", sent],
		["session recovered", recovered],
		["mock served the resume", resumesSeen >= 1],
		["transport budget spent", completions > 1],
	];
	for (const [name, ok] of checks) {
		process.stdout.write(`${name.padEnd(24)} ${ok ? "PASS" : "FAIL"}\n`);
	}
	process.stdout.write(`\ncompletions=${completions} resumes=${resumesSeen}\n`);

	const pass = checks.every(([, ok]) => ok);
	process.stdout.write(`\n${pass ? "E2E PASS" : "E2E FAIL"}\n`);
	process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
	process.stderr.write(`${error?.stack ?? error}\n`);
	process.exitCode = 1;
});
