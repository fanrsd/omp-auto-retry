import assert from "node:assert/strict";
import { test } from "node:test";

import { extractRetryHint, formatDuration, parseDuration } from "../extension/lib/retry-hint.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");

const hint = (input) => extractRetryHint({ now: NOW, ...input });

test("headers beat prose and are authoritative", () => {
	const result = hint({
		headers: { "retry-after": "3600" },
		message: "try again in 5 min",
	});
	assert.equal(result.delayMs, 3_600_000);
	assert.equal(result.authoritative, true);
	assert.equal(result.source, "header:retry-after");
});

test("retry-after-ms wins over retry-after", () => {
	assert.equal(hint({ headers: { "retry-after-ms": "1500", "retry-after": "99" } }).delayMs, 1500);
});

test("retry-after accepts an HTTP date", () => {
	const result = hint({ headers: { "retry-after": "Wed, 21 Oct 2026 13:00:00 GMT" } });
	assert.equal(result.delayMs, 3_600_000);
});

test("x-ratelimit-reset is epoch seconds, x-ratelimit-reset-after is a delta", () => {
	assert.equal(hint({ headers: { "x-ratelimit-reset": String(NOW / 1000 + 600) } }).delayMs, 600_000);
	assert.equal(hint({ headers: { "x-ratelimit-reset-after": "120" } }).delayMs, 120_000);
	assert.equal(hint({ headers: { "x-ratelimit-reset-ms": "2500" } }).delayMs, 2500);
});

test("an elapsed epoch is an explicit retry-now", () => {
	const result = hint({ headers: { "x-ratelimit-reset": String(NOW / 1000 - 600) } });
	assert.equal(result.delayMs, 0);
});

test("quota reset grammar", () => {
	assert.equal(hint({ message: "Your quota will reset after 18h31m10s" }).delayMs, ((18 * 60 + 31) * 60 + 10) * 1000);
	assert.equal(hint({ message: "reset after 10m15s" }).delayMs, (10 * 60 + 15) * 1000);
	assert.equal(hint({ message: "reset after 39s" }).delayMs, 39_000);
});

test("relative prose grammars", () => {
	assert.equal(hint({ message: "Please retry in 250ms" }).delayMs, 250);
	assert.equal(hint({ message: '{"error":{"retryDelay":"34.07s"}}' }).delayMs, 34_070);
	assert.equal(hint({ message: "try again in ~158 min." }).delayMs, 158 * 60_000);
	assert.equal(hint({ message: "Your limit will reset in 13 minutes" }).delayMs, 13 * 60_000);
	assert.equal(hint({ message: "Resets in 3 days" }).delayMs, 3 * 86_400_000);
});

test("a compound remainder beats its own leading hours", () => {
	// "2hr 15min" must be 135 minutes, not 120.
	assert.equal(hint({ message: "Resets in 2hr 15min" }).delayMs, 135 * 60_000);
});

test("body retry-after-ms", () => {
	assert.equal(hint({ message: "retry-after-ms=98497000" }).delayMs, 98_497_000);
	assert.equal(hint({ message: "retry-after-ms: 7200000" }).delayMs, 7_200_000);
});

test("omp's own annotation outranks prose in the same message", () => {
	// A real failing-response message: provider prose plus omp's suffix.
	const result = hint({
		message: "429 Your quota will reset after 18h31m10s (retry-after-ms=2000)",
	});
	assert.equal(result.delayMs, 2000);
	assert.equal(result.source, "message:retry-after-ms");
	assert.equal(result.authoritative, true);
});

test("omp's own annotation outranks headers", () => {
	// Both are header-derived, so they agree in practice; if they ever differ,
	// follow what the transport layer actually acted on.
	const result = hint({
		headers: { "retry-after": "3600" },
		message: "rate limited retry-after-ms=2000",
	});
	assert.equal(result.delayMs, 2000);
	assert.equal(result.source, "message:retry-after-ms");
});

test("prose still wins when there is no annotation", () => {
	const result = hint({ message: "Your quota will reset after 18h31m10s" });
	assert.equal(result.source, "body:reset-after");
	assert.equal(result.authoritative, true);
});

test("a zero annotation is an authoritative retry-now", () => {
	const result = hint({ message: "overloaded retry-after-ms=0" });
	assert.equal(result.delayMs, 0);
	assert.equal(result.authoritative, true);
});

test("a near-miss annotation is not treated as one", () => {
	// Only a standalone `key=value` token counts; prose like
	// "retry-after-ms=12abc" must fall through to the generic body grammar.
	const result = hint({ message: "retry-after-ms=12abc" });
	assert.notEqual(result?.source, "message:retry-after-ms");
});

test("the longest signal wins", () => {
	const result = hint({ message: "Please retry in 30s. Your limit will reset in 13 minutes." });
	assert.equal(result.delayMs, 13 * 60_000);
});

test("offset-bearing reset-at is authoritative", () => {
	const result = hint({ message: "Your limit will reset at 2026-10-21T14:30:00Z" });
	assert.equal(result.delayMs, 2.5 * 3_600_000);
	assert.equal(result.authoritative, true);
});

test("a naive reset-at loses to a relative signal", () => {
	const result = hint({ message: "reset at 2026-10-21 20:00:00 — try again in 5 min" });
	assert.equal(result.delayMs, 5 * 60_000);
	assert.equal(result.source, "body:try-again");
});

test("a naive reset-at is a fallback guess, not authoritative", () => {
	const result = hint({ message: "Your limit will reset at 2026-10-21 18:00:00" });
	assert.equal(result.delayMs, 6 * 3_600_000);
	assert.equal(result.authoritative, false);
});

test("a configured offset makes a naive stamp authoritative", () => {
	// 22:00+08:00 == 14:00Z, two hours after NOW.
	const result = hint({ message: "Your limit will reset at 2026-10-21 22:00:00", naiveResetTimezoneOffset: "+08:00" });
	assert.equal(result.delayMs, 2 * 3_600_000);
	assert.equal(result.authoritative, true);
});

test("an offset stamp that already elapsed yields no hint", () => {
	const result = hint({ message: "Your limit will reset at 2026-10-21 19:00:00", naiveResetTimezoneOffset: "+08:00" });
	assert.equal(result, undefined);
});

test("Chinese reset grammar", () => {
	assert.equal(hint({ message: "将在 2026-10-21 15:00:00 重置" }).delayMs, 3 * 3_600_000);
});

test("nothing to find yields undefined", () => {
	assert.equal(hint({}), undefined);
	assert.equal(hint({ headers: {}, message: "internal error" }), undefined);
});

test("Headers instances work like plain records", () => {
	const headers = new Headers({ "retry-after": "90" });
	assert.equal(hint({ headers }).delayMs, 90_000);
});

test("duration helpers round-trip", () => {
	assert.equal(parseDuration("18h31m10s"), ((18 * 60 + 31) * 60 + 10) * 1000);
	assert.equal(parseDuration("45s"), 45_000);
	assert.equal(parseDuration("nope"), undefined);
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(90_000), "1m 30s");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(5_400_000), "1h 30m");
	assert.equal(formatDuration(90_000_000), "1d 1h");
});
