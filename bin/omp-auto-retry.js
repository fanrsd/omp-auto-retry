#!/usr/bin/env node
/**
 * omp-auto-retry — installer and inspection CLI.
 *
 * The tool itself is an omp extension; this binary only moves files around,
 * reads logs, and reports what the extension will do. Keeping the two separate
 * means the extension never needs write access to the filesystem beyond its
 * own log directory, and `install` stays reversible.
 *
 * Zero dependencies, Node >= 18.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	watchFile,
	unwatchFile,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, loadConfig, resolveConfigPaths, validateConfig } from "../extension/lib/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const EXTENSION_SRC = join(PACKAGE_ROOT, "extension");
const EXTENSION_NAME = "omp-auto-retry";

const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));

// --- output helpers ---------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

const ok = (text) => `${green("✓")} ${text}`;
const bad = (text) => `${red("✗")} ${text}`;
const warn = (text) => `${yellow("!")} ${text}`;
const info = (text) => `${cyan("·")} ${text}`;

function out(line = "") {
	process.stdout.write(`${line}\n`);
}

function fail(message, code = 1) {
	process.stderr.write(`${red("error")}: ${message}\n`);
	process.exit(code);
}

// --- environment ------------------------------------------------------------

/**
 * Resolve omp's agent directory the way omp does, so an install lands where the
 * host actually looks. A named profile (`OMP_PROFILE`, else `PI_PROFILE`; empty
 * or `default` means none) wins: `~/$PI_CONFIG_DIR (or .omp)/profiles/<p>/agent`.
 * Otherwise `PI_CODING_AGENT_DIR`, else `~/$PI_CONFIG_DIR (or .omp)/agent`.
 *
 * @param {Record<string, string | undefined>} env
 */
export function resolveOmpAgentDir(env = process.env) {
	const configDir = env.PI_CONFIG_DIR || ".omp";
	const profile = (env.OMP_PROFILE ?? env.PI_PROFILE ?? "").trim();
	if (profile && profile !== "default") return join(homedir(), configDir, "profiles", profile, "agent");
	if (env.PI_CODING_AGENT_DIR) return resolve(env.PI_CODING_AGENT_DIR);
	return join(homedir(), configDir, "agent");
}

function extensionsDir({ project = false } = {}) {
	return project
		? join(process.cwd(), ".omp", "extensions")
		: join(resolveOmpAgentDir(), "extensions");
}

function installedPath({ project = false } = {}) {
	return join(extensionsDir({ project }), EXTENSION_NAME);
}

function detectOmp() {
	// No `shell: true`: `omp` ships as `omp.exe` on Windows, which CreateProcess
	// resolves on PATH, and passing args through a shell is both slower and
	// flagged by Node (DEP0190).
	const result = spawnSync("omp", ["--version"], { encoding: "utf8" });
	if (result.error) return undefined;
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	if (text.length === 0) return undefined;
	return { command: "omp", version: text.split(/\r?\n/)[0] };
}

function listInstalled() {
	const found = [];
	for (const [label, project] of [
		["global", false],
		["project", true],
	]) {
		const path = installedPath({ project });
		if (!existsSync(path)) continue;
		let mode = "copy";
		try {
			if (lstatSync(path).isSymbolicLink()) mode = "link";
		} catch {
			// Unreadable entry: report it as a copy.
		}
		found.push({ scope: label, path, mode });
	}
	return found;
}

function todayLogPath(paths) {
	const date = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return join(paths.logDir, `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`);
}

// --- commands ---------------------------------------------------------------

function commandInstall(args) {
	const project = args.flags.has("project");
	const link = args.flags.has("link");
	const target = installedPath({ project });
	const scope = project ? "project" : "global";

	if (!existsSync(EXTENSION_SRC)) fail(`extension sources not found at ${EXTENSION_SRC}`);

	if (existsSync(target)) {
		// The installed directory is ours alone; replacing it is how `install`
		// doubles as `upgrade`. A symlink is unlinked, never followed.
		removePath(target);
	}

	mkdirSync(dirname(target), { recursive: true });

	try {
		if (link) {
			symlinkSync(EXTENSION_SRC, target, process.platform === "win32" ? "junction" : "dir");
		} else {
			cpSync(EXTENSION_SRC, target, { recursive: true });
		}
	} catch (error) {
		fail(`install failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	out(`${ok(`installed ${bold(EXTENSION_NAME)} (${scope}, ${link ? "symlink" : "copy"})`)}`);
	out(`  ${dim("from")} ${relative(process.cwd(), EXTENSION_SRC) || EXTENSION_SRC}`);
	out(`  ${dim("to  ")} ${target}`);
	out();
	out(info("Start omp. The extension loads automatically and logs to ~/.omp-auto-retry/logs/."));
	out(info("Disable for one run with: omp --no-auto-retry"));
	out(info("Inspect at runtime with: /auto-retry status"));
	return 0;
}

function removePath(path) {
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink()) unlinkSync(path);
		else rmSync(path, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function commandUninstall() {
	const installed = listInstalled();
	if (installed.length === 0) {
		out(warn("nothing installed"));
		return 0;
	}
	for (const entry of installed) {
		if (!removePath(entry.path)) {
			out(bad(`could not remove ${entry.path}`));
			continue;
		}
		out(`${ok(`removed ${entry.scope} install`)} ${dim(entry.path)}`);
	}
	out();
	out(info("Configuration and logs were left in place (~/.omp-auto-retry.json, ~/.omp-auto-retry/logs/)."));
	return 0;
}

function commandStatus(args) {
	const { config, warnings, sources, paths } = loadConfig();
	const omp = detectOmp();
	const installed = listInstalled();

	if (args.flags.has("json")) {
		out(
			JSON.stringify(
				{
					version: pkg.version,
					omp: omp ?? null,
					agentDir: resolveOmpAgentDir(),
					installed,
					config,
					configFiles: { ...paths, sources },
					warnings,
				},
				null,
				2,
			),
		);
		return 0;
	}

	out(`${bold("omp-auto-retry")} ${dim(`v${pkg.version}`)}`);
	out();
	out(`${bold("Host")}`);
	out(`  omp        ${omp ? `${omp.version} ${dim(`(${omp.command})`)}` : red("not found on PATH")}`);
	out(`  agent dir  ${dim(resolveOmpAgentDir())}`);
	out();
	out(`${bold("Install")}`);
	if (installed.length === 0) {
		out(`  ${warn("not installed")} ${dim("run: omp-auto-retry install")}`);
	} else {
		for (const entry of installed) {
			out(`  ${ok(entry.scope.padEnd(7))} ${entry.mode.padEnd(4)} ${dim(entry.path)}`);
		}
	}
	out();
	out(`${bold("Config")}`);
	out(`  enabled          ${config.enabled ? green("yes") : yellow("no")}`);
	out(`  max attempts     ${config.maxAttempts}`);
	out(`  resume prompt    ${JSON.stringify(config.resumePrompt)}`);
	out(`  respect host     ${config.respectHostRetries ? "yes (never fights omp's own retries)" : "no"}`);
	out(`  usage limit wait ${config.usageLimit.fallbackWaitMs}ms fallback, ${config.usageLimit.maxWaitMs}ms cap`);
	out(`  files            ${sources.length ? sources.map((file) => dim(file)).join(", ") : dim("(defaults only)")}`);
	out(`  logs             ${dim(paths.logDir)}`);
	for (const warning of warnings) out(`  ${warn(warning)}`);
	return 0;
}

function commandDoctor(args) {
	const checks = [];
	const add = (name, passed, detail, optional = false) => checks.push({ name, passed, detail, optional });

	const major = Number(process.versions.node.split(".")[0]);
	add("node >= 18", major >= 18, `v${process.versions.node}`);

	const omp = detectOmp();
	add("omp on PATH", Boolean(omp), omp ? omp.version : "install from https://omp.sh");

	const agentDir = resolveOmpAgentDir();
	add("agent dir", existsSync(agentDir), existsSync(agentDir) ? agentDir : `${agentDir} (created on first install)`);

	const installed = listInstalled();
	add("extension installed", installed.length > 0, installed.map((entry) => `${entry.scope}: ${entry.path}`).join(", ") || "run: omp-auto-retry install");

	for (const entry of installed) {
		const manifest = join(entry.path, "package.json");
		let manifestOk = false;
		let detail = manifest;
		if (existsSync(manifest)) {
			try {
				const parsed = JSON.parse(readFileSync(manifest, "utf8"));
				const declared = parsed.omp?.extensions ?? parsed.pi?.extensions;
				manifestOk = Array.isArray(declared) && declared.length > 0;
				detail = manifestOk ? `omp.extensions = ${JSON.stringify(declared)}` : "manifest lacks omp.extensions";
			} catch (error) {
				detail = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
			}
		} else {
			detail = "package.json missing";
		}
		add(`manifest (${entry.scope})`, manifestOk, detail);

		const entryFile = join(entry.path, "index.js");
		const syntax = spawnSync(process.execPath, ["--check", entryFile], { encoding: "utf8" });
		add(`syntax (${entry.scope})`, syntax.status === 0, syntax.status === 0 ? entryFile : (syntax.stderr ?? "").trim());
	}

	const { warnings, sources, paths } = loadConfig();
	add("config parses", warnings.length === 0, warnings.length ? warnings.join("; ") : sources.join(", ") || "defaults");

	try {
		mkdirSync(paths.logDir, { recursive: true });
		add("log dir writable", true, paths.logDir);
	} catch (error) {
		add("log dir writable", false, error instanceof Error ? error.message : String(error));
	}

	const today = todayLogPath(paths);
	// Informational only: a fresh install has nothing to log yet.
	add("log exists", existsSync(today), existsSync(today) ? `${today} (${statSync(today).size} bytes)` : "no entries yet", true);

	if (args.flags.has("json")) {
		out(JSON.stringify({ version: pkg.version, checks }, null, 2));
	} else {
		out(`${bold("omp-auto-retry doctor")} ${dim(`v${pkg.version}`)}`);
		out();
		for (const check of checks) {
			const mark = check.passed ? ok(check.name.padEnd(22)) : check.optional ? warn(check.name.padEnd(22)) : bad(check.name.padEnd(22));
			out(`${mark} ${dim(check.detail ?? "")}`);
		}
		out();
		const failed = checks.filter((check) => !check.passed && !check.optional);
		out(failed.length === 0 ? green("all checks passed") : yellow(`${failed.length} check(s) need attention`));
	}

	return checks.every((check) => check.passed || check.optional) ? 0 : 1;
}

function commandLogs(args) {
	const paths = resolveConfigPaths();
	if (!existsSync(paths.logDir)) {
		out(warn(`no logs yet at ${paths.logDir}`));
		return 0;
	}

	const explicit = args.options.get("file");
	const file = explicit ? resolve(explicit) : todayLogPath(paths);

	if (!existsSync(file)) {
		out(warn(`no log for today (${file})`));
		const available = readdirSync(paths.logDir).filter((entry) => entry.endsWith(".log")).sort();
		if (available.length > 0) out(info(`available: ${available.slice(-5).join(", ")}`));
		return 0;
	}

	const lines = Number(args.options.get("lines") ?? 200);
	const content = readFileSync(file, "utf8").split(/\r?\n/);
	const tail = content.slice(-Math.max(1, lines));
	out(dim(`# ${file}`));
	for (const line of tail) if (line.length > 0) out(line);

	if (!args.flags.has("follow") && !args.flags.has("f")) return 0;

	out(dim("# following — Ctrl+C to stop"));
	let offset = statSync(file).size;
	watchFile(file, { interval: 1000 }, (current) => {
		if (current.size < offset) {
			offset = current.size;
			return;
		}
		if (current.size === offset) return;
		const chunk = readFileSync(file, "utf8").slice(offset);
		offset = current.size;
		process.stdout.write(chunk);
	});
	const stop = () => {
		unwatchFile(file);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	return undefined;
}

function commandConfig(args) {
	const paths = resolveConfigPaths();

	if (args.flags.has("init")) {
		const target = paths.global;
		if (existsSync(target) && !args.flags.has("force")) {
			fail(`${target} already exists (use --force to overwrite)`);
		}
		const { config } = validateConfig(DEFAULTS);
		writeFileSyncSafe(target, `${JSON.stringify(config, null, 2)}\n`);
		out(`${ok("wrote starter config")} ${dim(target)}`);
		return 0;
	}

	const { config, warnings, sources, paths: resolved } = loadConfig();

	if (args.flags.has("path")) {
		out(JSON.stringify(resolved, null, 2));
		return 0;
	}

	out(JSON.stringify(config, null, 2));
	if (sources.length > 0) {
		out();
		out(dim(`# sources: ${sources.join(", ")}`));
	}
	for (const warning of warnings) out(warn(warning));
	return 0;
}

function writeFileSyncSafe(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

// --- arg parsing ------------------------------------------------------------

const COMMANDS = new Set(["install", "uninstall", "status", "doctor", "logs", "config", "version", "help"]);

function parseArgs(argv) {
	const flags = new Set();
	const options = new Map();
	const positional = [];

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--") {
			positional.push(...argv.slice(index + 1));
			break;
		}
		if (token.startsWith("--")) {
			const [name, inline] = token.slice(2).split("=");
			if (inline !== undefined) {
				options.set(name, inline);
			} else if (["lines", "file"].includes(name)) {
				options.set(name, argv[index + 1]);
				index += 1;
			} else {
				flags.add(name);
			}
			continue;
		}
		if (token.startsWith("-") && token.length > 1) {
			for (const letter of token.slice(1)) flags.add(letter);
			continue;
		}
		positional.push(token);
	}

	return { command: positional[0] ?? "status", rest: positional.slice(1), flags, options };
}

function usage() {
	out(`${bold("omp-auto-retry")} ${dim(`v${pkg.version}`)} — auto-resume oh-my-pi sessions after usage limits and provider failures`);
	out();
	out(`${bold("Usage")}`);
	out(`  omp-auto-retry <command> [options]`);
	out();
	out(`${bold("Commands")}`);
	out(`  install      Copy the extension into omp's extension directory`);
	out(`  uninstall    Remove the installed extension`);
	out(`  status       Show host, install and effective configuration`);
	out(`  doctor       Diagnose the setup (exit 1 when something is wrong)`);
	out(`  logs         Print today's log`);
	out(`  config       Print the effective config`);
	out(`  version      Print the version`);
	out();
	out(`${bold("Options")}`);
	out(`  --project        Install into ./.omp/extensions instead of the global agent dir`);
	out(`  --link           Symlink the sources instead of copying (development)`);
	out(`  --force          Overwrite an existing config or install`);
	out(`  --json           Machine-readable output (status, doctor)`);
	out(`  --lines <n>      How many log lines to print (default 200)`);
	out(`  --follow, -f     Keep streaming new log lines`);
	out(`  --init           (config) Write a starter ~/.omp-auto-retry.json`);
	out(`  --path           (config) Print the resolved config paths`);
	out();
	out(`${bold("Examples")}`);
	out(`  ${dim("$")} omp-auto-retry install`);
	out(`  ${dim("$")} omp-auto-retry doctor`);
	out(`  ${dim("$")} omp-auto-retry logs --follow`);
	out();
	out(dim("Extension runtime controls: /auto-retry status|on|off|now|reset|config inside omp."));
	out(dim("Config: ~/.omp-auto-retry.json (global) and ./.omp-auto-retry.json (project)."));
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	// Bare `-h` / `-v` arrive as flags, not positionals.
	const command =
		args.flags.has("v") || args.flags.has("version")
			? "version"
			: args.flags.has("h") || args.flags.has("help")
				? "help"
				: args.command;

	if (!COMMANDS.has(command)) {
		fail(`unknown command "${command}" — try: omp-auto-retry help`, 2);
	}

	try {
		switch (command) {
			case "install":
				return commandInstall(args);
			case "uninstall":
				return commandUninstall(args);
			case "status":
				return commandStatus(args);
			case "doctor":
				return commandDoctor(args);
			case "logs":
				return commandLogs(args);
			case "config":
				return commandConfig(args);
			case "version":
			case "--version":
			case "-v":
				out(pkg.version);
				return 0;
			case "help":
			case "--help":
			case "-h":
				usage();
				return 0;
			default:
				fail(`unknown command "${command}" — try: omp-auto-retry help`, 2);
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	return 0;
}

const exitCode = main();
if (typeof exitCode === "number") process.exitCode = exitCode;
