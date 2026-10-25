/**
 * Configuration loading for omp-auto-retry.
 *
 * Two files are read, shallow-then-deep merged, project last:
 *
 *   ~/.omp-auto-retry.json          global
 *   <cwd>/.omp-auto-retry.json      project (wins)
 *
 * `OMP_AUTO_RETRY_CONFIG` points at an explicit file instead of the two above
 * (useful for tests and for per-shell experiments). `OMP_AUTO_RETRY_DISABLED=1`
 * forces `enabled: false` without touching any file, and
 * `OMP_AUTO_RETRY_LOG_DIR` relocates the log directory.
 *
 * Every value is validated and clamped: a typo in a hand-written JSON file must
 * degrade to a sane default with a warning, never to a 0ms hot loop.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Defaults mirror omp's own retry settings where an equivalent exists. */
export const DEFAULTS = Object.freeze({
	/** Master switch. `/auto-retry off` writes this, not a separate state file. */
	enabled: true,
	/** Prompt injected to resume the session. */
	resumePrompt: "continue",
	/** Total resume attempts per stall before giving up. */
	maxAttempts: 20,
	/** Never act while omp's own retry saga is running. */
	respectHostRetries: true,
	/** Floor for any scheduled resume: the run must finish unwinding first. */
	minDelayMs: 1500,
	/** Show a notice in the TUI for each scheduled/resumed/given-up event. */
	notify: true,
	/** How many days of logs to keep. */
	logRetentionDays: 7,

	usageLimit: {
		/** Wait when the provider names a quota wall but publishes no reset time. */
		fallbackWaitMs: 900_000,
		/** Ceiling for a single wait; a longer published window re-probes at the cap. */
		maxWaitMs: 43_200_000,
		/** Added to a published reset time so we do not arrive a second early. */
		marginMs: 5_000,
		/** Multiplier applied to the fallback wait on each repeated unhinted wall. */
		backoffFactor: 1.5,
		jitterRatio: 0.05,
	},

	overload: {
		baseDelayMs: 2_000,
		maxDelayMs: 300_000,
		jitterRatio: 0.2,
	},

	transient: {
		baseDelayMs: 1_000,
		maxDelayMs: 120_000,
		jitterRatio: 0.2,
	},

	unknown: {
		baseDelayMs: 5_000,
		maxDelayMs: 60_000,
		jitterRatio: 0.2,
	},
});

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge `override` onto `base` without mutating either.
 *
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown>} override
 * @returns {Record<string, unknown>}
 */
export function mergeConfig(base, override) {
	const out = clone(base);
	if (!isPlainObject(override)) return out;
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		const current = out[key];
		if (isPlainObject(value) && isPlainObject(current)) {
			out[key] = mergeConfig(current, value);
		} else {
			out[key] = clone(value);
		}
	}
	return out;
}

function num(value, fallback, { min, max, integer = false }, path, warnings) {
	if (value === undefined || value === null) return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		warnings.push(`${path}: expected a number, got ${JSON.stringify(value)} — using ${fallback}`);
		return fallback;
	}
	let out = integer ? Math.trunc(parsed) : parsed;
	if (min !== undefined && out < min) {
		warnings.push(`${path}: ${out} is below the minimum ${min} — clamped`);
		out = min;
	}
	if (max !== undefined && out > max) {
		warnings.push(`${path}: ${out} is above the maximum ${max} — clamped`);
		out = max;
	}
	return out;
}

function bool(value, fallback, path, warnings) {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	if (value === "true" || value === 1) return true;
	if (value === "false" || value === 0) return false;
	warnings.push(`${path}: expected a boolean, got ${JSON.stringify(value)} — using ${fallback}`);
	return fallback;
}

function str(value, fallback, path, warnings) {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "string") {
		warnings.push(`${path}: expected a string, got ${JSON.stringify(value)} — using the default`);
		return fallback;
	}
	if (value.trim().length === 0) {
		warnings.push(`${path}: empty string — using the default`);
		return fallback;
	}
	return value;
}

const TOP_LEVEL_KEYS = new Set(Object.keys(DEFAULTS));

/**
 * Validate and clamp a raw (already merged) config object.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ config: ReturnType<typeof clone>, warnings: string[] }}
 */
export function validateConfig(raw) {
	const warnings = [];
	const source = isPlainObject(raw) ? raw : {};

	for (const key of Object.keys(source)) {
		if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown key "${key}" — ignored`);
	}

	const config = clone(DEFAULTS);
	config.enabled = bool(source.enabled, DEFAULTS.enabled, "enabled", warnings);
	config.resumePrompt = str(source.resumePrompt, DEFAULTS.resumePrompt, "resumePrompt", warnings);
	config.maxAttempts = num(source.maxAttempts, DEFAULTS.maxAttempts, { min: 1, max: 500, integer: true }, "maxAttempts", warnings);
	config.respectHostRetries = bool(
		source.respectHostRetries,
		DEFAULTS.respectHostRetries,
		"respectHostRetries",
		warnings,
	);
	config.minDelayMs = num(source.minDelayMs, DEFAULTS.minDelayMs, { min: 0, max: 600_000 }, "minDelayMs", warnings);
	config.notify = bool(source.notify, DEFAULTS.notify, "notify", warnings);
	config.logRetentionDays = num(
		source.logRetentionDays,
		DEFAULTS.logRetentionDays,
		{ min: 1, max: 365, integer: true },
		"logRetentionDays",
		warnings,
	);

	const sections = [
		[
			"usageLimit",
			{
				fallbackWaitMs: { min: 5_000, max: 86_400_000 },
				maxWaitMs: { min: 60_000, max: 604_800_000 },
				marginMs: { min: 0, max: 300_000 },
				backoffFactor: { min: 1, max: 10 },
				jitterRatio: { min: 0, max: 1 },
			},
		],
		[
			"overload",
			{
				baseDelayMs: { min: 100, max: 600_000 },
				maxDelayMs: { min: 1_000, max: 3_600_000 },
				jitterRatio: { min: 0, max: 1 },
			},
		],
		[
			"transient",
			{
				baseDelayMs: { min: 100, max: 600_000 },
				maxDelayMs: { min: 1_000, max: 3_600_000 },
				jitterRatio: { min: 0, max: 1 },
			},
		],
		[
			"unknown",
			{
				baseDelayMs: { min: 100, max: 600_000 },
				maxDelayMs: { min: 1_000, max: 3_600_000 },
				jitterRatio: { min: 0, max: 1 },
			},
		],
	];

	for (const [section, rules] of sections) {
		const provided = source[section];
		if (provided !== undefined && !isPlainObject(provided)) {
			warnings.push(`${section}: expected an object — using defaults`);
			continue;
		}
		for (const [key, bounds] of Object.entries(rules)) {
			const fallback = DEFAULTS[section][key];
			config[section][key] = num(provided?.[key], fallback, bounds, `${section}.${key}`, warnings);
		}
		for (const key of Object.keys(provided ?? {})) {
			if (!(key in rules)) warnings.push(`unknown key "${section}.${key}" — ignored`);
		}
	}

	// A section max below its base would make every backoff flat; lift it.
	for (const section of ["overload", "transient", "unknown"]) {
		if (config[section].maxDelayMs < config[section].baseDelayMs) {
			warnings.push(`${section}.maxDelayMs is below baseDelayMs — raised to match`);
			config[section].maxDelayMs = config[section].baseDelayMs;
		}
	}
	if (config.usageLimit.maxWaitMs < config.usageLimit.fallbackWaitMs) {
		warnings.push("usageLimit.maxWaitMs is below fallbackWaitMs — raised to match");
		config.usageLimit.maxWaitMs = config.usageLimit.fallbackWaitMs;
	}

	return { config, warnings };
}

/**
 * Where the config files live for this run.
 *
 * @param {{ cwd?: string, home?: string, env?: Record<string, string | undefined> }} [options]
 */
export function resolveConfigPaths(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const explicit = env.OMP_AUTO_RETRY_CONFIG;
	const logDir = env.OMP_AUTO_RETRY_LOG_DIR;
	return {
		explicit: explicit ? resolve(explicit) : undefined,
		global: join(home, ".omp-auto-retry.json"),
		project: join(cwd, ".omp-auto-retry.json"),
		logDir: logDir ? resolve(logDir) : join(home, ".omp-auto-retry", "logs"),
	};
}

function readJsonFile(path, warnings) {
	if (!existsSync(path)) return undefined;
	try {
		const text = readFileSync(path, "utf8");
		if (text.trim().length === 0) return undefined;
		const parsed = JSON.parse(text);
		if (!isPlainObject(parsed)) {
			warnings.push(`${path}: expected a JSON object — ignored`);
			return undefined;
		}
		return parsed;
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)} — ignored`);
		return undefined;
	}
}

/**
 * Load, merge and validate configuration.
 *
 * Never throws: a broken config file yields defaults plus a warning, because a
 * session that hits a quota wall must not also fail because of a stray comma.
 *
 * @param {{ cwd?: string, home?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ config: Record<string, any>, warnings: string[], sources: string[], paths: ReturnType<typeof resolveConfigPaths> }}
 */
export function loadConfig(options = {}) {
	const env = options.env ?? process.env;
	const paths = resolveConfigPaths({ cwd: options.cwd, home: options.home, env });
	const warnings = [];
	const sources = [];

	let merged = clone(DEFAULTS);
	if (paths.explicit) {
		const explicit = readJsonFile(paths.explicit, warnings);
		if (explicit) {
			merged = mergeConfig(merged, explicit);
			sources.push(paths.explicit);
		}
	} else {
		const global = readJsonFile(paths.global, warnings);
		if (global) {
			merged = mergeConfig(merged, global);
			sources.push(paths.global);
		}
		const project = readJsonFile(paths.project, warnings);
		if (project) {
			merged = mergeConfig(merged, project);
			sources.push(paths.project);
		}
	}

	const { config, warnings: validationWarnings } = validateConfig(merged);
	warnings.push(...validationWarnings);

	if (env.OMP_AUTO_RETRY_DISABLED === "1" || env.OMP_AUTO_RETRY_DISABLED === "true") {
		config.enabled = false;
		sources.push("env:OMP_AUTO_RETRY_DISABLED");
	}

	return { config, warnings, sources, paths };
}
