import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { DEFAULTS, loadConfig, mergeConfig, validateConfig } from "../extension/lib/config.js";

const roots = [];
function sandbox() {
	const root = mkdtempSync(join(tmpdir(), "omp-auto-retry-config-"));
	roots.push(root);
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, home, cwd };
}

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("defaults apply when nothing is configured", () => {
	const { home, cwd } = sandbox();
	const { config, warnings, sources } = loadConfig({ home, cwd, env: {} });
	assert.deepEqual(warnings, []);
	assert.deepEqual(sources, []);
	assert.equal(config.enabled, true);
	assert.equal(config.maxAttempts, DEFAULTS.maxAttempts);
	assert.equal(config.usageLimit.fallbackWaitMs, DEFAULTS.usageLimit.fallbackWaitMs);
});

test("the global file is read and the project file wins", () => {
	const { home, cwd } = sandbox();
	writeFileSync(join(home, ".omp-auto-retry.json"), JSON.stringify({ maxAttempts: 5, overload: { baseDelayMs: 9000 } }));
	writeFileSync(join(cwd, ".omp-auto-retry.json"), JSON.stringify({ maxAttempts: 7 }));

	const { config, sources } = loadConfig({ home, cwd, env: {} });
	assert.equal(config.maxAttempts, 7);
	// Nested keys merge, they do not replace the whole section.
	assert.equal(config.overload.baseDelayMs, 9000);
	assert.equal(config.overload.maxDelayMs, DEFAULTS.overload.maxDelayMs);
	assert.equal(sources.length, 2);
});

test("an explicit config path replaces both default locations", () => {
	const { root, home, cwd } = sandbox();
	writeFileSync(join(home, ".omp-auto-retry.json"), JSON.stringify({ maxAttempts: 5 }));
	const explicit = join(root, "custom.json");
	writeFileSync(explicit, JSON.stringify({ maxAttempts: 11 }));

	const { config, sources } = loadConfig({ home, cwd, env: { OMP_AUTO_RETRY_CONFIG: explicit } });
	assert.equal(config.maxAttempts, 11);
	assert.deepEqual(sources, [explicit]);
});

test("broken JSON degrades to defaults with a warning", () => {
	const { home, cwd } = sandbox();
	writeFileSync(join(home, ".omp-auto-retry.json"), "{ not json");
	const { config, warnings } = loadConfig({ home, cwd, env: {} });
	assert.equal(config.maxAttempts, DEFAULTS.maxAttempts);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /ignored/);
});

test("out-of-range numbers are clamped, not accepted", () => {
	const { config, warnings } = validateConfig({
		maxAttempts: 0,
		minDelayMs: -5,
		usageLimit: { fallbackWaitMs: 10, maxWaitMs: 1 },
	});
	assert.equal(config.maxAttempts, 1);
	assert.equal(config.minDelayMs, 0);
	assert.equal(config.usageLimit.fallbackWaitMs, 5000);
	assert.equal(config.usageLimit.maxWaitMs >= config.usageLimit.fallbackWaitMs, true);
	assert.ok(warnings.length >= 2);
});

test("a max below base is raised so backoff still grows", () => {
	const { config, warnings } = validateConfig({ overload: { baseDelayMs: 10_000, maxDelayMs: 1_000 } });
	assert.equal(config.overload.maxDelayMs, 10_000);
	assert.ok(warnings.some((warning) => warning.includes("maxDelayMs")));
});

test("unknown keys are reported but ignored", () => {
	const { config, warnings } = validateConfig({ nope: 1, overload: { nonsense: 2 } });
	assert.equal("nope" in config, false);
	assert.equal(warnings.some((warning) => warning.includes('unknown key "nope"')), true);
	assert.equal(warnings.some((warning) => warning.includes('unknown key "overload.nonsense"')), true);
});

test("the environment can disable the extension", () => {
	const { home, cwd } = sandbox();
	const { config, sources } = loadConfig({ home, cwd, env: { OMP_AUTO_RETRY_DISABLED: "1" } });
	assert.equal(config.enabled, false);
	assert.ok(sources.includes("env:OMP_AUTO_RETRY_DISABLED"));
});

test("the log directory can be relocated for a hermetic run", () => {
	const { root, home, cwd } = sandbox();
	const logDir = join(root, "logs");
	const { paths } = loadConfig({ home, cwd, env: { OMP_AUTO_RETRY_LOG_DIR: logDir } });
	assert.equal(paths.logDir, resolve(logDir));
});

test("mergeConfig does not mutate its inputs", () => {
	const base = { a: 1, nested: { b: 2 } };
	const override = { nested: { c: 3 } };
	const merged = mergeConfig(base, override);
	assert.deepEqual(merged, { a: 1, nested: { b: 2, c: 3 } });
	assert.deepEqual(base, { a: 1, nested: { b: 2 } });
	assert.deepEqual(override, { nested: { c: 3 } });
});
