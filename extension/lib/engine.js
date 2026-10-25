/**
 * The resume state machine.
 *
 * One engine instance per session. It never talks to omp directly — every side
 * effect is injected (`setTimer`, `clearTimer`, `onResume`, `onNotify`) — so the
 * whole policy is testable against a fake clock without a live agent.
 *
 * Lifecycle of a stall:
 *
 *   turn_end(error) ──▶ classify ──▶ schedule(delay) ──▶ fire ──▶ resume sent
 *          ▲                              │                        │
 *          │                              │                        ▼
 *          │                    auto_retry_start (host)      turn_start (ours)
 *          │                              │                        │
 *          └──────────── healthy turn ◀───┴──── error turn ◀────────┘
 *
 * Invariants this file exists to protect:
 *
 *   1. Never resume while omp's own retry saga is live (`respectHostRetries`).
 *   2. Never resume twice for the same stall (a scheduled resume is cancelled
 *      the moment the host or the user takes over).
 *   3. Never resume after an aborted turn, an auth failure, or a context
 *      overflow — those need a human, not a timer.
 *   4. Never sleep through a window the provider told us about.
 */

import { Category, RESUMABLE_CATEGORIES, classifyError } from "./classify.js";
import { extractRetryHint, formatDuration } from "./retry-hint.js";

/** Engine states, exposed for tests and `/auto-retry status`. */
export const EngineState = Object.freeze({
	/** Nothing pending: the session is healthy or untouched. */
	IDLE: "idle",
	/** A resume is armed for `pending.at`. */
	SCHEDULED: "scheduled",
	/** A resume was sent; waiting for the resulting turn to prove it worked. */
	RESUMING: "resuming",
	/** Gave up: attempt budget spent, or the failure is not resumable. */
	GAVE_UP: "gave-up",
});

/** Delay before re-sending a resume that produced no turn at all. */
const RESUME_VERIFY_MS = 90_000;

function jitter(ms, ratio, random) {
	if (!(ratio > 0)) return ms;
	const spread = ms * ratio;
	const offset = (random() * 2 - 1) * spread;
	return Math.max(0, ms + offset);
}

/**
 * @param {{
 *   config: Record<string, any>,
 *   logger: { debug: Function, info: Function, warn: Function, error: Function },
 *   now?: () => number,
 *   random?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   onResume?: (prompt: string) => void,
 *   onNotify?: (level: "info" | "warn" | "error", text: string) => void,
 *   isIdle?: () => boolean,
 * }} options
 */
export function createEngine(options) {
	const config = options.config;
	const logger = options.logger;
	const now = options.now ?? (() => Date.now());
	const random = options.random ?? Math.random;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
	const onResume = options.onResume ?? (() => {});
	const onNotify = options.onNotify ?? (() => {});
	const isIdle = options.isIdle ?? (() => true);

	const state = {
		phase: EngineState.IDLE,
		/** Resume attempts used in the current stall streak. */
		attempts: 0,
		/** Total resumes sent this session. */
		totalResumes: 0,
		/** Armed resume: `{ at, delayMs, category, source, message }`. */
		pending: null,
		timer: null,
		verifyTimer: null,
		/** True while omp's own retry saga is running. */
		hostRetrying: false,
		/** True between "we sent a resume" and "a turn started". */
		resumeSent: false,
		/** Last non-2xx provider response, consumed by the next classification. */
		lastErrorResponse: null,
		lastError: null,
		gaveUpReason: null,
	};

	function notify(level, text) {
		if (!config.notify) return;
		try {
			onNotify(level, text);
		} catch {
			// A broken UI channel must not stop the engine.
		}
	}

	function clearTimerHandle() {
		if (state.timer !== null) {
			try {
				clearTimer(state.timer);
			} catch {
				// Ignore: the host may have already dropped the timer.
			}
			state.timer = null;
		}
	}

	function clearVerifyTimer() {
		if (state.verifyTimer !== null) {
			try {
				clearTimer(state.verifyTimer);
			} catch {
				// Ignore.
			}
			state.verifyTimer = null;
		}
	}

	/**
	 * Cancel an armed resume. Leaves the attempt counter alone so a user
	 * takeover followed by a fresh stall does not inherit the old budget —
	 * callers that want a clean slate use {@link reset}.
	 */
	function cancel(reason) {
		clearTimerHandle();
		clearVerifyTimer();
		if (state.pending) {
			logger.debug("resume cancelled", { reason, category: state.pending.category });
			state.pending = null;
		}
		if (state.phase === EngineState.SCHEDULED) state.phase = EngineState.IDLE;
	}

	function reset(reason) {
		cancel(reason);
		if (state.attempts !== 0 || state.gaveUpReason) {
			logger.debug("attempt budget reset", { reason, attempts: state.attempts });
		}
		state.attempts = 0;
		state.gaveUpReason = null;
		state.lastError = null;
		state.lastErrorResponse = null;
		state.resumeSent = false;
		if (state.phase !== EngineState.RESUMING) state.phase = EngineState.IDLE;
	}

	function giveUp(category, reason, message) {
		state.gaveUpReason = reason;
		state.phase = EngineState.GAVE_UP;
		cancel("gave up");
		logger.warn("giving up", { category, reason, attempts: state.attempts, message });
		notify("warn", `auto-retry stopped (${category}): ${reason}`);
	}

	/**
	 * Delay for the next resume.
	 *
	 * A provider-published reset time always wins. Without one, the wait is a
	 * guess and escalates per category: usage walls climb from the fallback
	 * towards `maxWaitMs`, saturation and transport failures back off
	 * exponentially from their base.
	 */
	function computeDelay(category, attemptIndex) {
		const hint = extractRetryHint({
			headers: state.lastErrorResponse?.headers,
			message: state.lastError?.message,
			now: now(),
		});

		if (category === Category.USAGE_LIMIT) {
			const cfg = config.usageLimit;
			if (hint && hint.delayMs > 0) {
				const wait = Math.min(hint.delayMs + cfg.marginMs, cfg.maxWaitMs);
				// Late-only jitter: waking before a published reset re-hits the wall.
				const late = cfg.jitterRatio > 0 ? random() * wait * cfg.jitterRatio : 0;
				return { delayMs: wait + late, source: hint.source, capped: wait < hint.delayMs + cfg.marginMs };
			}
			if (hint && hint.delayMs === 0) {
				return { delayMs: config.minDelayMs, source: `${hint.source}:retry-now`, capped: false };
			}
			const escalated = cfg.fallbackWaitMs * cfg.backoffFactor ** attemptIndex;
			const wait = Math.min(escalated, cfg.maxWaitMs);
			return { delayMs: jitter(wait, cfg.jitterRatio, random), source: "fallback:no-reset-time", capped: escalated > cfg.maxWaitMs };
		}

		const section =
			category === Category.OVERLOAD
				? config.overload
				: category === Category.TRANSIENT
					? config.transient
					: config.unknown;

		// A short, authoritative hint (429 + `retry-after: 3`) still beats the
		// exponential schedule; a long one is treated as a wall and capped.
		if (hint && hint.authoritative && hint.delayMs > 0) {
			const wait = Math.min(hint.delayMs, section.maxDelayMs);
			return { delayMs: jitter(wait, section.jitterRatio, random), source: hint.source, capped: wait < hint.delayMs };
		}

		const escalated = section.baseDelayMs * 2 ** Math.min(attemptIndex, 16);
		const wait = Math.min(escalated, section.maxDelayMs);
		return {
			delayMs: jitter(wait, section.jitterRatio, random),
			source: attemptIndex === 0 ? "backoff:base" : `backoff:x${2 ** Math.min(attemptIndex, 16)}`,
			capped: escalated > section.maxDelayMs,
		};
	}

	function arm(category, message, extra) {
		if (!config.enabled) {
			logger.debug("auto-retry disabled — not scheduling", { category });
			return;
		}
		if (state.hostRetrying && config.respectHostRetries) {
			logger.debug("omp is retrying on its own — standing down", { category });
			return;
		}
		if (state.attempts >= config.maxAttempts) {
			giveUp(category, `attempt budget exhausted (${state.attempts}/${config.maxAttempts})`, message);
			return;
		}

		const { delayMs, source, capped } = computeDelay(category, state.attempts);
		const at = now() + Math.max(delayMs, config.minDelayMs);

		clearTimerHandle();
		state.phase = EngineState.SCHEDULED;
		state.pending = { at, delayMs: Math.max(delayMs, config.minDelayMs), category, source, message };
		state.lastError = { category, message, status: state.lastErrorResponse?.status, ...extra };

		const handle = setTimer(() => fire(), state.pending.delayMs);
		state.timer = handle ?? null;

		logger.info("resume scheduled", {
			category,
			in: formatDuration(state.pending.delayMs),
			source,
			attempt: `${state.attempts + 1}/${config.maxAttempts}`,
			capped,
			message: message?.slice(0, 240),
		});
		notify(
			"info",
			`${category}: resuming in ${formatDuration(state.pending.delayMs)} ` +
				`(attempt ${state.attempts + 1}/${config.maxAttempts})`,
		);
	}

	function fire() {
		state.timer = null;
		const pending = state.pending;
		state.pending = null;
		if (!pending) {
			state.phase = EngineState.IDLE;
			return;
		}
		if (!config.enabled) {
			state.phase = EngineState.IDLE;
			return;
		}
		if (state.hostRetrying && config.respectHostRetries) {
			logger.debug("host took over before the timer fired");
			state.phase = EngineState.IDLE;
			return;
		}

		state.attempts += 1;
		state.totalResumes += 1;
		state.resumeSent = true;
		state.phase = EngineState.RESUMING;

		logger.info("sending resume", {
			attempt: `${state.attempts}/${config.maxAttempts}`,
			category: pending.category,
			prompt: config.resumePrompt,
		});

		try {
			onResume(config.resumePrompt);
		} catch (error) {
			// The send never reached the session, so it must not consume an
			// attempt: roll the counters back and arm the same step again.
			state.resumeSent = false;
			state.attempts = Math.max(0, state.attempts - 1);
			state.totalResumes = Math.max(0, state.totalResumes - 1);
			logger.error("resume send failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			arm(pending.category, pending.message, { afterSendError: true });
			return;
		}

		armVerify(pending);
	}

	function armVerify(pending) {
		clearVerifyTimer();
		state.verifyTimer =
			setTimer(() => {
				state.verifyTimer = null;
				if (!state.resumeSent) return;
				// Still streaming: our resume is queued as a follow-up behind it.
				if (!isIdle()) return armVerify(pending);
				// No turn started at all: the message never landed (queued into a
				// queue that got cleared, or a delivery that silently dropped).
				// The re-send consumes an attempt so a dropping host stays bounded.
				logger.warn("resume produced no turn — re-sending", {
					afterMs: RESUME_VERIFY_MS,
					category: pending.category,
				});
				state.resumeSent = false;
				state.phase = EngineState.IDLE;
				arm(pending.category, pending.message, { verifyFailed: true });
			}, RESUME_VERIFY_MS) ?? null;
	}

	function handleErrorTurn(message) {
		const category = classifyError({
			status: message.errorStatus ?? state.lastErrorResponse?.status,
			message: message.errorMessage ?? message.errorClassificationMessage ?? "",
			stopReason: message.stopReason,
		});

		state.lastError = {
			category,
			message: message.errorMessage ?? message.errorClassificationMessage ?? "",
			status: message.errorStatus ?? state.lastErrorResponse?.status,
		};

		if (category === Category.ABORTED) {
			logger.debug("turn aborted — not resuming");
			cancel("aborted turn");
			state.phase = EngineState.IDLE;
			return;
		}
		if (!RESUMABLE_CATEGORIES.has(category)) {
			giveUp(category, `${category} failures need a human (not a timer)`, state.lastError.message);
			return;
		}

		arm(category, state.lastError.message, { status: state.lastError.status });
	}

	function handleHealthyTurn() {
		if (state.attempts > 0 || state.phase === EngineState.RESUMING) {
			logger.info("session recovered", { afterAttempts: state.attempts, total: state.totalResumes });
			if (state.attempts > 0) notify("info", "resumed — session is healthy again");
		}
		state.phase = EngineState.IDLE;
		state.resumeSent = false;
		clearVerifyTimer();
		reset("healthy turn");
	}

	const engine = {
		state,

		/** `after_provider_response` — keep the last failing response for its headers. */
		handleProviderResponse(event) {
			const status = typeof event?.status === "number" ? event.status : undefined;
			if (status === undefined) return;
			if (status >= 400) {
				state.lastErrorResponse = { status, headers: event.headers ?? null, at: now() };
			} else {
				state.lastErrorResponse = null;
			}
		},

		/** `turn_end` */
		handleTurnEnd(event) {
			const message = event?.message;
			if (!message || message.role !== "assistant") return;
			if (message.stopReason === "error") handleErrorTurn(message);
			else if (message.stopReason === "aborted") {
				// Esc is not recovery: drop what is armed, keep the budget, say nothing.
				cancel("aborted turn");
				state.resumeSent = false;
				clearVerifyTimer();
				state.phase = EngineState.IDLE;
			} else handleHealthyTurn();
		},

		/** `agent_end` — the terminal settle. Safety net for a missed `turn_end`. */
		handleAgentEnd(event) {
			if (event?.willContinue || event?.awaitingAsyncWork) {
				logger.debug("agent_end is not terminal — waiting for the host");
				return;
			}
			const messages = Array.isArray(event?.messages) ? event.messages : [];
			for (let i = messages.length - 1; i >= 0; i -= 1) {
				const message = messages[i];
				if (message?.role !== "assistant") continue;
				if (message.stopReason === "error" && !state.pending) handleErrorTurn(message);
				return;
			}
		},

		/** `auto_retry_start` — omp owns the wait now. */
		handleAutoRetryStart(event) {
			state.hostRetrying = true;
			if (config.respectHostRetries) cancel("host retry started");
			logger.debug("host retry started", {
				attempt: event?.attempt,
				max: event?.maxAttempts,
				delay: event?.delayMs,
			});
		},

		/** `auto_retry_end` — omp either recovered or handed the failure back. */
		handleAutoRetryEnd(event) {
			state.hostRetrying = false;
			if (event?.success) {
				logger.info("host retry succeeded", { attempt: event.attempt });
				handleHealthyTurn();
				return;
			}
			const message = event?.finalError ?? state.lastError?.message ?? "";
			const category = classifyError({
				status: state.lastErrorResponse?.status,
				message,
				stopReason: "error",
			});
			logger.info("host retries exhausted", {
				attempt: event?.attempt,
				category,
				message: message?.slice(0, 240),
			});
			if (category === Category.ABORTED) return;
			if (!RESUMABLE_CATEGORIES.has(category)) {
				giveUp(category, `${category} failures need a human (not a timer)`, message);
				return;
			}
			state.lastError = { category, message, status: state.lastErrorResponse?.status };
			arm(category, message, { afterHostRetries: true });
		},

		/** `turn_start` — distinguishes our resume from a human taking over. */
		handleTurnStart() {
			if (state.resumeSent) {
				state.resumeSent = false;
				clearVerifyTimer();
				logger.debug("resume consumed — awaiting the turn outcome");
				return;
			}
			if (state.pending || state.phase === EngineState.SCHEDULED) {
				logger.info("user took over — dropping the scheduled resume");
				reset("user activity");
			}
		},

		/** `session_shutdown` */
		shutdown() {
			cancel("session shutdown");
			state.phase = EngineState.IDLE;
		},

		/** `/auto-retry off` — disarm without losing the config file. */
		disable() {
			config.enabled = false;
			cancel("disabled");
			state.phase = EngineState.IDLE;
		},

		enable() {
			config.enabled = true;
			state.phase = EngineState.IDLE;
		},

		reset,

		/** `/auto-retry now` — fire the armed resume immediately. */
		resumeNow() {
			if (!state.pending) return false;
			clearTimerHandle();
			clearVerifyTimer();
			logger.info("resume forced by command", { category: state.pending.category });
			fire();
			return true;
		},

		/** Snapshot for `/auto-retry status`. */
		status() {
			const pending = state.pending;
			return {
				phase: state.phase,
				attempts: state.attempts,
				maxAttempts: config.maxAttempts,
				totalResumes: state.totalResumes,
				hostRetrying: state.hostRetrying,
				enabled: config.enabled,
				lastError: state.lastError,
				gaveUpReason: state.gaveUpReason,
				pending: pending
					? {
							category: pending.category,
							inMs: Math.max(0, pending.at - now()),
							source: pending.source,
						}
					: null,
			};
		},
	};

	return engine;
}
