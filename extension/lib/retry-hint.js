/**
 * Retry-timing extraction for omp-auto-retry.
 *
 * This is a faithful port of `extractRetryHint()` from
 * `@oh-my-pi/pi-utils/src/fetch-retry.ts` so that this extension reads a
 * provider's reset window exactly the way omp itself does. Two differences:
 *
 *   1. Headers arrive as the plain lowercased `Record<string, string>` that
 *      `after_provider_response` hands to extensions, not as a `Headers`
 *      instance, so both shapes are accepted.
 *   2. Every reading also reports its *source*, because the engine needs to
 *      distinguish an authoritative provider signal (`retry-after: 3600`)
 *      from a wall-clock guess that happened to parse.
 *
 * Grammar supported (kept in lockstep with omp):
 *
 *   Headers
 *     - `retry-after-ms`            milliseconds
 *     - `retry-after`               seconds, or an HTTP date
 *     - `x-ratelimit-reset-ms`      delta ms, or Unix epoch ms/s for large values
 *     - `x-ratelimit-reset`         Unix epoch seconds
 *     - `x-ratelimit-reset-after`   seconds
 *
 *   Bodies
 *     - `retry-after-ms=98497000`   (omp's own annotation — see below)
 *     - "Your quota will reset after 18h31m10s" / "10m15s" / "39s"
 *     - "Please retry in 250ms" / "Please retry in 12s"
 *     - `"retryDelay": "34.074824224s"`
 *     - "try again in ~158 min" / "try again in 2h"
 *     - "Resets in 2hr 15min" / "Resets in 3 days"
 *     - "retry-after-ms=98497000" / "retry-after: 60"
 *     - "Your limit will reset at 2026-09-01 09:44:51"
 *     - "将在 2026-09-01 09:44:51 重置"
 *
 * One omp-specific detail drives the precedence order. A failing response never
 * reaches `after_provider_response` — the provider layer throws before the
 * response callback runs — so the failing headers are normally unavailable to an
 * extension. omp compensates by appending `retry-after-ms=<n>` to the error
 * message (`formatErrorMessageWithRetryAfter`), computed from `retry-after`,
 * `retry-after-ms`, `x-ratelimit-reset*` exactly like `extractRetryHint()` does.
 * That annotation is therefore the most authoritative signal we can actually
 * see, and it outranks every prose pattern below.
 *
 * A timezone-naive `reset at` stamp resolves only when no unambiguous relative
 * signal is present (same precedence as omp): guessing a zone from prose is how
 * sessions end up sleeping through a window that already reopened.
 */

// "reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// JSON field: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// "try again in 250ms" / "try again in 5 min" / "try again in ~158 min."
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// "Your limit will reset in 13 minutes" / "Resets in 2hr 15min"
const WILL_RESET_IN_PATTERN =
	/(?:will\s+)?resets?\s+in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
// OpenCode Go compound remainder: "Resets in 2hr 15min".
const RESET_IN_HR_MIN_PATTERN = /resets?\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*hr\s*(\d+(?:\.\d+)?)\s*min\b/i;
// "will reset at 2026-09-01 09:44:51" / "reset at 2026-09-01T09:44:51Z"
const WILL_RESET_AT_PATTERN =
	/(?:will\s+)?reset at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;
const CN_RESET_AT_PATTERN = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/;
const RESET_AT_PATTERNS = [WILL_RESET_AT_PATTERN, CN_RESET_AT_PATTERN];
// omp's own annotation on a failed request: `... retry-after-ms=98497000`
// Boundaries reject longer header names (`x-retry-after-ms=`) while still
// accepting the token when omp's suffix lands inside punctuation, e.g. `(retry-after-ms=2000)`.
const OMP_ANNOTATED_MS_PATTERN = /(?:^|[^A-Za-z0-9_-])retry-after-ms=([0-9]+(?:\.[0-9]+)?)(?![0-9A-Za-z_])/i;
// "retry-after-ms=98497000" / "retry-after-ms: 7200000"
const RETRY_AFTER_MS_BODY_PATTERN = /\bretry-after-ms\s*[:=]\s*([0-9]+)\b/i;
const RETRY_AFTER_BODY_PATTERN = /retry-after\s*[:=]\s*([^\s,;]+)/i;
const RATELIMIT_RESET_MS_BODY_PATTERN = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i;
const RATELIMIT_RESET_BODY_PATTERN = /x-ratelimit-reset\s*[:=]\s*(\d+)/i;

/** Header names we read, in the same precedence omp uses. */
export const HINT_HEADERS = Object.freeze([
	"retry-after-ms",
	"retry-after",
	"x-ratelimit-reset-ms",
	"x-ratelimit-reset",
	"x-ratelimit-reset-after",
]);

/**
 * Read one header from either a `Headers` instance or a plain lowercased
 * record (the shape `after_provider_response` provides).
 *
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {string} name lowercase header name
 * @returns {string | null}
 */
export function headerGet(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === "function") return headers.get(name);
	const value = headers[name] ?? headers[name.toUpperCase()];
	if (value === undefined || value === null) return null;
	return String(value);
}

function unitToMs(unit) {
	switch (String(unit).toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 60 * 60_000;
		case "d":
		case "day":
		case "days":
			return 24 * 60 * 60_000;
		default:
			return undefined;
	}
}

/**
 * Header-only reading.
 *
 * @returns {{ delayMs: number, source: string } | undefined}
 */
function readHeaderHint(headers, now) {
	if (!headers) return undefined;

	const retryAfterMs = headerGet(headers, "retry-after-ms");
	if (retryAfterMs) {
		const ms = Number(retryAfterMs);
		if (Number.isFinite(ms) && ms >= 0) return { delayMs: ms, source: "header:retry-after-ms" };
	}

	const retryAfter = headerGet(headers, "retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return { delayMs: Math.max(0, seconds * 1000), source: "header:retry-after" };
		const parsedDate = Date.parse(retryAfter);
		if (!Number.isNaN(parsedDate)) {
			return { delayMs: Math.max(0, parsedDate - now), source: "header:retry-after-date" };
		}
	}

	const resetMsRaw = headerGet(headers, "x-ratelimit-reset-ms");
	if (resetMsRaw) {
		const value = Number(resetMsRaw);
		if (Number.isFinite(value) && value > 0) {
			// > 1e12 → epoch ms; > 1e9 → epoch s; otherwise a delta in ms.
			const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
			if (targetMs === undefined) return { delayMs: value, source: "header:x-ratelimit-reset-ms" };
			const delta = targetMs - now;
			if (delta > 0) return { delayMs: delta, source: "header:x-ratelimit-reset-ms" };
			return { delayMs: 0, source: "header:x-ratelimit-reset-ms" };
		}
	}

	const resetRaw = headerGet(headers, "x-ratelimit-reset");
	if (resetRaw) {
		const resetSeconds = Number.parseInt(resetRaw, 10);
		if (!Number.isNaN(resetSeconds)) {
			const delta = resetSeconds * 1000 - now;
			return { delayMs: Math.max(0, delta), source: "header:x-ratelimit-reset" };
		}
	}

	const resetAfterRaw = headerGet(headers, "x-ratelimit-reset-after");
	if (resetAfterRaw) {
		const seconds = Number(resetAfterRaw);
		if (Number.isFinite(seconds) && seconds > 0) {
			return { delayMs: seconds * 1000, source: "header:x-ratelimit-reset-after" };
		}
	}

	return undefined;
}

/**
 * omp's header-derived annotation on a failed request. Authoritative by
 * construction: it is the same value the transport layer used to decide whether
 * to retry, so agreeing with it keeps us from sleeping through a window omp
 * already computed.
 *
 * @returns {{ delayMs: number, source: string } | undefined}
 */
function readOmpAnnotation(message) {
	if (typeof message !== "string" || message.length === 0) return undefined;
	const match = OMP_ANNOTATED_MS_PATTERN.exec(message);
	if (!match?.[1]) return undefined;
	const ms = Number.parseFloat(match[1]);
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	return { delayMs: ms, source: "message:retry-after-ms" };
}

/**
 * Body reading. Longest unambiguous signal wins; naive wall clocks only apply
 * when nothing else was found; a parsed-but-non-positive reading is an explicit
 * "retry now" and must survive as `0`.
 *
 * @returns {{ delayMs: number, source: string } | undefined}
 */
function readBodyHint(body, now, options) {
	if (typeof body !== "string" || body.length === 0) return undefined;

	let longestMs;
	let longestSource = "";
	let longestNaiveMs;
	let retryNow = false;
	let retryNowSource = "";

	const consider = (ms, source) => {
		if (ms === undefined || !(ms > 0)) return;
		if (longestMs === undefined || ms > longestMs) {
			longestMs = ms;
			longestSource = source;
		}
	};
	const considerNaive = (ms, source) => {
		if (ms === undefined || !(ms > 0)) return;
		if (longestNaiveMs === undefined || ms > longestNaiveMs) {
			longestNaiveMs = ms;
			longestSource = source;
		}
	};
	const considerClamped = (ms, source) => {
		if (ms === undefined) return;
		if (ms > 0) consider(ms, source);
		else if (!retryNow) {
			retryNow = true;
			retryNowSource = source;
		}
	};

	const quotaMatch = QUOTA_RESET_PATTERN.exec(body);
	if (quotaMatch) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			consider(totalMs > 0 ? totalMs : undefined, "body:reset-after");
		}
	}

	for (const pattern of RESET_AT_PATTERNS) {
		const match = pattern.exec(body);
		if (!match?.[1]) continue;
		const normalized = match[1].replace(" ", "T");
		const hasOffset = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized);
		const configuredOffset = options?.naiveResetTimezoneOffset;
		const parsed = Date.parse(hasOffset ? normalized : `${normalized}${configuredOffset ?? "Z"}`);
		if (!Number.isNaN(parsed) && parsed > now) {
			if (hasOffset || configuredOffset !== undefined) consider(parsed - now, "body:reset-at");
			else considerNaive(parsed - now, "body:reset-at-naive");
		}
	}

	// "Resets in 2hr 15min": the generic pattern only captures the leading "2hr".
	const compoundResetMatch = RESET_IN_HR_MIN_PATTERN.exec(body);
	if (compoundResetMatch?.[1] && compoundResetMatch[2]) {
		const hours = Number.parseFloat(compoundResetMatch[1]);
		const minutes = Number.parseFloat(compoundResetMatch[2]);
		if (Number.isFinite(hours) && Number.isFinite(minutes) && hours >= 0 && minutes > 0) {
			consider(hours * 3_600_000 + minutes * 60_000, "body:resets-in");
		}
	}

	const accountResetMatch = WILL_RESET_IN_PATTERN.exec(body);
	if (accountResetMatch?.[1]) {
		const value = Number.parseFloat(accountResetMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const unitMs = unitToMs(accountResetMatch[2]);
			if (unitMs !== undefined) consider(value * unitMs, "body:resets-in");
		}
	}

	const retryAfterMsMatch = RETRY_AFTER_MS_BODY_PATTERN.exec(body);
	if (retryAfterMsMatch?.[1]) {
		const ms = Number(retryAfterMsMatch[1]);
		if (Number.isFinite(ms)) considerClamped(ms, "body:retry-after-ms");
	}

	for (const [pattern, source] of [
		[PLEASE_RETRY_PATTERN, "body:please-retry"],
		[RETRY_DELAY_FIELD_PATTERN, "body:retryDelay"],
		[TRY_AGAIN_PATTERN, "body:try-again"],
	]) {
		const match = pattern.exec(body);
		if (match?.[1]) {
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]);
				if (unitMs !== undefined) consider(value * unitMs, source);
			}
		}
	}

	// Legacy text forms: `retry-after: 60` / `retry-after: <http-date>`.
	const retryAfterMatch = RETRY_AFTER_BODY_PATTERN.exec(body);
	if (retryAfterMatch?.[1]) {
		const value = retryAfterMatch[1];
		const seconds = Number(value);
		if (Number.isFinite(seconds)) {
			considerClamped(seconds * 1000, "body:retry-after");
		} else {
			const dateMs = Date.parse(value);
			if (!Number.isNaN(dateMs)) considerClamped(dateMs - now, "body:retry-after");
		}
	}

	const resetMsMatch = RATELIMIT_RESET_MS_BODY_PATTERN.exec(body);
	if (resetMsMatch?.[1]) {
		const resetMs = Number(resetMsMatch[1]);
		if (!Number.isNaN(resetMs)) {
			considerClamped(resetMs > 1_000_000_000_000 ? resetMs - now : resetMs, "body:x-ratelimit-reset-ms");
		}
	}

	const resetMatch = RATELIMIT_RESET_BODY_PATTERN.exec(body);
	if (resetMatch?.[1]) {
		const resetSeconds = Number(resetMatch[1]);
		if (!Number.isNaN(resetSeconds)) {
			considerClamped(
				resetSeconds > 1_000_000_000 ? resetSeconds * 1000 - now : resetSeconds * 1000,
				"body:x-ratelimit-reset",
			);
		}
	}

	if (longestMs !== undefined) return { delayMs: longestMs, source: longestSource };
	if (longestNaiveMs !== undefined) return { delayMs: longestNaiveMs, source: longestSource };
	if (retryNow) return { delayMs: 0, source: retryNowSource };
	return undefined;
}

/**
 * Extract a provider-suggested retry delay, with provenance.
 *
 * @param {{
 *   headers?: Headers | Record<string, string> | null,
 *   message?: string | null,
 *   now?: number,
 *   naiveResetTimezoneOffset?: string,
 * }} input
 * @returns {{ delayMs: number, source: string, authoritative: boolean } | undefined}
 *   `delayMs: 0` means "the provider explicitly said retry now".
 */
export function extractRetryHint(input = {}) {
	const now = typeof input.now === "number" ? input.now : Date.now();

	// omp's own annotation is the header-derived value, already normalised to
	// milliseconds, and it is the only signal that survives a failing response.
	// It outranks everything else — including headers, which cannot normally be
	// present on a failure and would agree anyway.
	const annotatedHint = readOmpAnnotation(input.message ?? null);
	if (annotatedHint) {
		return { ...annotatedHint, authoritative: true };
	}

	const headerHint = readHeaderHint(input.headers ?? null, now);
	if (headerHint) {
		return { ...headerHint, authoritative: true };
	}
	const bodyHint = readBodyHint(input.message ?? null, now, input);
	if (!bodyHint) return undefined;
	return {
		...bodyHint,
		// A naive wall clock is a guess; every other grammar is the provider
		// telling us a duration it controls.
		authoritative: bodyHint.source !== "body:reset-at-naive",
	};
}

/** Human-readable duration, e.g. `1h 23m`, `45s`, `2.5s`. */
export function formatDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** Parse `18h31m10s`, `10m15s`, `45s`, `2h` into milliseconds. */
export function parseDuration(text) {
	if (typeof text !== "string") return undefined;
	const match = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(text.trim());
	if (!match || (!match[1] && !match[2] && !match[3] && !match[4])) return undefined;
	const days = match[1] ? Number.parseFloat(match[1]) : 0;
	const hours = match[2] ? Number.parseFloat(match[2]) : 0;
	const minutes = match[3] ? Number.parseFloat(match[3]) : 0;
	const seconds = match[4] ? Number.parseFloat(match[4]) : 0;
	return ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
}
