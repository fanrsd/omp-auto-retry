/**
 * Engine policy tests.
 *
 * The engine never touches a real timer or the real clock: every test drives a
 * fake clock so a 12-hour quota wall is asserted in microseconds, and the whole
 * resume saga can be replayed step by step.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULTS, mergeConfig, validateConfig } from "../extension/lib/config.js";
import { EngineState, createEngine } from "../extension/lib/engine.js";

const RESUME_VERIFY_MS = 90_000;

/** Deterministic harness: fake clock, fake timers, recorded side effects. */
function createHarness(overrides = {}, options = {}) {
	let clock = 1_000_000;
	let nextTimerId = 1;
	const timers = new Map();

	const resumes = [];
	const notifies = [];
	const logs = [];
	const random = options.random ?? (() => 0.5);

	const setTimer = (fn, ms) => {
		const id = nextTimerId++;
		timers.set(id, { id, at: clock + ms, fn });
		return id;
	};
	const clearTimer = (id) => {
		timers.delete(id);
	};

	const logger = {
		debug: (msg, meta) => logs.push({ level: "debug", msg, meta }),
		info: (msg, meta) => logs.push({ level: "info", msg, meta }),
		warn: (msg, meta) => logs.push({ level: "warn", msg, meta }),
		error: (msg, meta) => logs.push({ level: "error", msg, meta }),
	};

	const { config } = validateConfig(mergeConfig(DEFAULTS, overrides));

	const engine = createEngine({
		config,
		logger,
		now: () => clock,
		random,
		setTimer,
		clearTimer,
		onResume: (prompt) => {
			if (options.onResume) return options.onResume(prompt);
			resumes.push({ at: clock, prompt });
		},
		onNotify: (level, text) => notifies.push({ level, text }),
		isIdle: () => (options.isIdle ? options.isIdle() : true),
	});

	/** Advance the fake clock, firing every due timer in order. */
	function advance(ms) {
		const target = clock + ms;
		for (;;) {
			let due = null;
			for (const timer of timers.values()) {
				if (timer.at > target) continue;
				if (!due || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) due = timer;
			}
			if (!due) break;
			timers.delete(due.id);
			clock = due.at;
			due.fn();
		}
		clock = target;
		return clock;
	}

	const now = () => clock;
	const timerCount = () => timers.size;

	return { engine, advance, now, timerCount, resumes, notifies, logs, config, timers };
}

/** A `turn_end` payload for a failed assistant turn. */
function errorTurn({ status, message = "", stopReason = "error" } = {}) {
	return {
		turnIndex: 0,
		message: { role: "assistant", stopReason, errorStatus: status, errorMessage: message },
		toolResults: [],
	};
}

/** A `turn_end` payload for a healthy assistant turn. */
function okTurn() {
	return { turnIndex: 0, message: { role: "assistant", stopReason: "end_turn" }, toolResults: [] };
}

// --- happy path -------------------------------------------------------------

test("schedules a resume after an error turn and sends the configured prompt", () => {
	const h = createHarness({ resumePrompt: "keep going" });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));

	const status = h.engine.status();
	assert.equal(status.phase, EngineState.SCHEDULED);
	assert.equal(status.pending.category, "overload");
	assert.equal(status.attempts, 0);
	assert.equal(h.timerCount(), 1);

	h.advance(1_999);
	assert.equal(h.resumes.length, 0, "must not fire before the delay elapses");

	h.advance(1);
	assert.equal(h.resumes.length, 1);
	assert.equal(h.resumes[0].prompt, "keep going");
	assert.equal(h.engine.status().phase, EngineState.RESUMING);
	assert.equal(h.engine.status().totalResumes, 1);
});

test("a healthy turn clears the pending resume and the attempt budget", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.handleTurnEnd(okTurn());

	assert.equal(h.engine.status().phase, EngineState.IDLE);
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.engine.status().attempts, 0);
	assert.equal(h.timerCount(), 0);

	h.advance(60_000);
	assert.equal(h.resumes.length, 0);
});

test("ignores turn_end payloads that are not assistant messages", () => {
	const h = createHarness();
	h.engine.handleTurnEnd({ turnIndex: 0, message: { role: "user", stopReason: "error" }, toolResults: [] });
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 0);
});

// --- never resume these -----------------------------------------------------

test("an aborted turn is not a failure and is never resumed", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ stopReason: "aborted", message: "Request was aborted" }));

	assert.equal(h.engine.status().phase, EngineState.IDLE);
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 0);
});

test("auth failures give up immediately instead of sleeping on a timer", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ status: 401, message: "invalid api key" }));

	const status = h.engine.status();
	assert.equal(status.phase, EngineState.GAVE_UP);
	assert.equal(status.lastError.category, "auth");
	assert.match(status.gaveUpReason, /need a human/);
	assert.equal(h.timerCount(), 0);
	assert.equal(h.notifies.at(-1).level, "warn");
});

test("context overflow gives up instead of replaying an oversized prompt", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ message: "prompt is too long: 300000 tokens" }));

	assert.equal(h.engine.status().phase, EngineState.GAVE_UP);
	assert.equal(h.engine.status().lastError.category, "context");
	assert.equal(h.timerCount(), 0);
});

// --- host retries -----------------------------------------------------------

test("stands down while omp's own retry saga is running", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(h.timerCount(), 1);

	h.engine.handleAutoRetryStart({ attempt: 1, maxAttempts: 10, delayMs: 500 });
	assert.equal(h.timerCount(), 0, "host retry must cancel our armed resume");
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.engine.status().hostRetrying, true);

	h.advance(600_000);
	assert.equal(h.resumes.length, 0);
});

test("does not arm at all while the host is retrying", () => {
	const h = createHarness();
	h.engine.handleAutoRetryStart({ attempt: 1, maxAttempts: 10, delayMs: 500 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));

	assert.equal(h.timerCount(), 0);
	assert.equal(h.engine.status().phase, EngineState.IDLE);
});

test("respectHostRetries:false keeps our own schedule alive", () => {
	const h = createHarness({ respectHostRetries: false });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.handleAutoRetryStart({ attempt: 1, maxAttempts: 10, delayMs: 500 });

	assert.equal(h.timerCount(), 1);
	h.advance(2_000);
	assert.equal(h.resumes.length, 1);
});

test("re-arms after the host exhausts its retries", () => {
	const h = createHarness();
	h.engine.handleAutoRetryStart({ attempt: 10, maxAttempts: 10, delayMs: 500 });
	h.engine.handleAutoRetryEnd({ success: false, attempt: 10, finalError: "503 Service Unavailable" });

	const status = h.engine.status();
	assert.equal(status.hostRetrying, false);
	assert.equal(status.phase, EngineState.SCHEDULED);
	assert.equal(status.pending.category, "overload");
	assert.equal(h.timerCount(), 1);
});

test("a successful host retry counts as recovery", () => {
	const h = createHarness();
	h.engine.handleAutoRetryStart({ attempt: 2, maxAttempts: 10, delayMs: 500 });
	h.engine.handleAutoRetryEnd({ success: true, attempt: 2 });

	assert.equal(h.engine.status().phase, EngineState.IDLE);
	assert.equal(h.engine.status().hostRetrying, false);
	assert.equal(h.timerCount(), 0);
});

// --- backoff ----------------------------------------------------------------

test("overload backoff doubles per attempt and is capped by maxDelayMs", () => {
	const h = createHarness({ maxAttempts: 10, minDelayMs: 0, overload: { baseDelayMs: 2_000, maxDelayMs: 8_000, jitterRatio: 0 } });

	const delays = [];
	for (let i = 0; i < 4; i += 1) {
		h.engine.handleTurnEnd(errorTurn({ status: 503 }));
		delays.push(h.engine.status().pending.inMs);
		h.engine.resumeNow();
		h.engine.handleTurnStart();
	}

	assert.deepEqual(delays, [2_000, 4_000, 8_000, 8_000]);
});

test("transient failures use the transient schedule and respect the minDelayMs floor", () => {
	const h = createHarness({ transient: { baseDelayMs: 500, maxDelayMs: 120_000, jitterRatio: 0 } });
	h.engine.handleTurnEnd(errorTurn({ message: "socket hang up" }));

	assert.equal(h.engine.status().pending.category, "transient");
	assert.equal(h.engine.status().pending.inMs, 1_500, "minDelayMs floors a sub-second backoff");
});

test("jitter widens the delay symmetrically", () => {
	const low = createHarness({ overload: { baseDelayMs: 10_000, maxDelayMs: 300_000, jitterRatio: 0.2 } }, { random: () => 0 });
	low.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(low.engine.status().pending.inMs, 8_000);

	const high = createHarness({ overload: { baseDelayMs: 10_000, maxDelayMs: 300_000, jitterRatio: 0.2 } }, { random: () => 1 });
	high.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(high.engine.status().pending.inMs, 12_000);
});

// --- attempt budget ---------------------------------------------------------

test("gives up once the attempt budget is spent", () => {
	const h = createHarness({ maxAttempts: 2, minDelayMs: 0 });

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.resumeNow();
	h.engine.handleTurnStart();
	assert.equal(h.engine.status().attempts, 1);

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.resumeNow();
	h.engine.handleTurnStart();
	assert.equal(h.engine.status().attempts, 2);

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	const status = h.engine.status();
	assert.equal(status.phase, EngineState.GAVE_UP);
	assert.match(status.gaveUpReason, /attempt budget exhausted \(2\/2\)/);
	assert.equal(h.timerCount(), 0);
	assert.equal(h.resumes.length, 2);
});

// --- resume verification ----------------------------------------------------

test("re-sends when a resume produced no turn at all", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);
	assert.equal(h.resumes.length, 1);

	h.advance(RESUME_VERIFY_MS - 1);
	assert.equal(h.resumes.length, 1, "no re-send before the verify window closes");

	h.advance(1);
	assert.equal(h.logs.filter((l) => l.msg === "resume produced no turn — re-sending").length, 1);
	assert.equal(h.timerCount(), 1, "a fresh resume is armed");

	h.advance(4_000); // second step of the backoff: the re-send spent an attempt
	assert.equal(h.resumes.length, 2);
});

test("a resume queued behind a running stream is not re-sent", () => {
	let idle = false;
	const h = createHarness({ minDelayMs: 0 }, { isIdle: () => idle });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);
	h.advance(RESUME_VERIFY_MS * 3);
	assert.equal(h.resumes.length, 1, "still streaming: keep waiting");

	idle = true;
	h.advance(RESUME_VERIFY_MS + 4_000);
	assert.equal(h.resumes.length, 2, "idle and nothing started: re-send");
	assert.equal(h.engine.status().attempts, 2, "the re-send spends budget");
});

test("an aborted turn cancels quietly without claiming recovery", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);
	h.engine.handleTurnStart();
	h.engine.handleTurnEnd({ message: { role: "assistant", stopReason: "aborted" } });
	assert.equal(h.notifies.filter((n) => n.text.includes("healthy")).length, 0);
	assert.equal(h.timerCount(), 0);
	assert.equal(h.engine.status().attempts, 1);
});

test("a turn that starts after our resume cancels the verify timer", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);
	h.engine.handleTurnStart();

	h.advance(RESUME_VERIFY_MS * 2);
	assert.equal(h.resumes.length, 1, "the resume was consumed, not re-sent");
});

test("a throwing resume sender re-arms instead of dying", () => {
	const h = createHarness(
		{ minDelayMs: 0 },
		{
			onResume: () => {
				throw new Error("session is shutting down");
			},
		},
	);
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);

	assert.equal(h.engine.status().totalResumes, 0, "a failed send does not count as an attempt");
	assert.equal(h.engine.status().pending?.category, "overload");
	assert.equal(h.logs.filter((l) => l.msg === "resume send failed").length, 1);
	assert.equal(h.timerCount(), 1);
});

// --- user takeover ----------------------------------------------------------

test("a user turn cancels the scheduled resume", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(h.timerCount(), 1);

	h.engine.handleTurnStart();
	assert.equal(h.engine.status().phase, EngineState.IDLE);
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 0);

	h.advance(600_000);
	assert.equal(h.resumes.length, 0);
});

test("disable() disarms without losing the loaded config", () => {
	const h = createHarness();
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.disable();

	assert.equal(h.timerCount(), 0);
	assert.equal(h.engine.status().enabled, false);

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(h.timerCount(), 0, "nothing is scheduled while disabled");

	h.engine.enable();
	assert.equal(h.engine.status().enabled, true);
});

test("shutdown() cancels every pending timer", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.advance(2_000);
	assert.equal(h.resumes.length, 1);

	h.engine.shutdown();
	assert.equal(h.timerCount(), 0);
	h.advance(600_000);
	assert.equal(h.resumes.length, 1);
});

// --- usage limits -----------------------------------------------------------

test("honours a provider-published reset window for a quota wall, never waking early", () => {
	for (const [random, expected] of [[() => 0, 65_000], [() => 1, 68_250]]) {
		const h = createHarness({ minDelayMs: 0 }, { random });
		h.engine.handleProviderResponse({ status: 429, headers: { "retry-after": "60" } });
		h.engine.handleTurnEnd(errorTurn({ status: 429, message: "usage limit reached" }));

		const status = h.engine.status();
		assert.equal(status.pending.category, "usage-limit");
		assert.equal(status.pending.source, "header:retry-after");
		assert.equal(status.pending.inMs, expected, "60s + 5s margin, jitter only adds");
		assert.equal(status.attempts, 0);
	}
});

test("falls back to a long wait when a quota wall publishes no reset time", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 429, message: "You have exceeded your quota" }));

	const status = h.engine.status();
	assert.equal(status.pending.category, "usage-limit");
	assert.equal(status.pending.source, "fallback:no-reset-time");
	assert.equal(status.pending.inMs, 900_000);
});

test("escalates repeated unhinted quota walls", () => {
	const h = createHarness({ minDelayMs: 0, usageLimit: { fallbackWaitMs: 100_000, backoffFactor: 2, maxWaitMs: 1_000_000, marginMs: 0, jitterRatio: 0 } });

	const waits = [];
	for (let i = 0; i < 3; i += 1) {
		h.engine.handleTurnEnd(errorTurn({ status: 429, message: "quota exceeded" }));
		waits.push(h.engine.status().pending.inMs);
		h.engine.resumeNow();
		h.engine.handleTurnStart();
	}

	assert.deepEqual(waits, [100_000, 200_000, 400_000]);
});

test("clamps a published reset window to maxWaitMs", () => {
	const h = createHarness({
		minDelayMs: 0,
		usageLimit: { maxWaitMs: 600_000, marginMs: 0, fallbackWaitMs: 300_000, backoffFactor: 1.5, jitterRatio: 0 },
	});
	h.engine.handleProviderResponse({ status: 429, headers: { "retry-after": "86400" } });
	h.engine.handleTurnEnd(errorTurn({ status: 429, message: "usage limit reached" }));

	assert.equal(h.engine.status().pending.inMs, 600_000);
});

test("an explicit 'retry now' hint collapses to minDelayMs", () => {
	const h = createHarness({ minDelayMs: 1_500 });
	h.engine.handleProviderResponse({ status: 429, headers: { "retry-after": "0" } });
	h.engine.handleTurnEnd(errorTurn({ status: 429, message: "usage limit reached" }));

	assert.equal(h.engine.status().pending.source, "header:retry-after:retry-now");
	assert.equal(h.engine.status().pending.inMs, 1_500);
});

test("a stale error response is dropped once the provider answers 2xx", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleProviderResponse({ status: 429, headers: { "retry-after": "3600" } });
	h.engine.handleProviderResponse({ status: 200, headers: {} });
	h.engine.handleTurnEnd(errorTurn({ status: 429, message: "usage limit reached" }));

	assert.equal(h.engine.status().pending.source, "fallback:no-reset-time");
});

// --- agent_end safety net ---------------------------------------------------

test("agent_end resumes when turn_end never reported the failure", () => {
	const h = createHarness();
	h.engine.handleAgentEnd({
		messages: [{ role: "user", content: "hi" }, { role: "assistant", stopReason: "error", errorStatus: 502 }],
	});

	assert.equal(h.engine.status().phase, EngineState.SCHEDULED);
	assert.equal(h.engine.status().pending.category, "overload");
});

test("agent_end that will continue is not treated as terminal", () => {
	const h = createHarness();
	h.engine.handleAgentEnd({
		messages: [{ role: "assistant", stopReason: "error", errorStatus: 502 }],
		willContinue: true,
	});

	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 0);
});

test("agent_end with async work pending is not treated as terminal", () => {
	const h = createHarness();
	h.engine.handleAgentEnd({
		messages: [{ role: "assistant", stopReason: "error", errorStatus: 502 }],
		awaitingAsyncWork: true,
	});

	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 0);
});

test("agent_end does not double-arm a resume that is already scheduled", () => {
	const h = createHarness();
	const event = { messages: [{ role: "assistant", stopReason: "error", errorStatus: 502 }] };
	h.engine.handleTurnEnd(errorTurn({ status: 502 }));
	const first = h.engine.status().pending.inMs;
	h.advance(1_000);
	h.engine.handleAgentEnd(event);

	assert.equal(h.engine.status().pending.inMs, first - 1_000, "the original deadline is preserved");
	assert.equal(h.timerCount(), 1);
});

// --- command surface --------------------------------------------------------

test("resumeNow() fires immediately and reports whether it had anything to do", () => {
	const h = createHarness();
	assert.equal(h.engine.resumeNow(), false, "nothing armed yet");

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(h.engine.resumeNow(), true);
	assert.equal(h.resumes.length, 1);
	assert.equal(h.engine.status().totalResumes, 1);
	assert.equal(h.engine.status().pending, null);
	assert.equal(h.timerCount(), 1, "only the verify timer remains");
});

test("status() reports a live countdown", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	assert.equal(h.engine.status().pending.inMs, 2_000);
	h.advance(1_500);
	assert.equal(h.engine.status().pending.inMs, 500);
});

test("reset() clears the budget and any armed resume", () => {
	const h = createHarness({ minDelayMs: 0 });
	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.resumeNow();
	h.engine.handleTurnStart();
	assert.equal(h.engine.status().attempts, 1);

	h.engine.handleTurnEnd(errorTurn({ status: 503 }));
	h.engine.reset("manual");

	const status = h.engine.status();
	assert.equal(status.attempts, 0);
	assert.equal(status.pending, null);
	assert.equal(h.timerCount(), 0);
});
