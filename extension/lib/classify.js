/**
 * Error classification for omp-auto-retry.
 *
 * The usage-limit / quota / throttle patterns below intentionally mirror the
 * ones omp itself uses (`@oh-my-pi/pi-ai/error/rate-limit`), so this extension
 * agrees with the host about what counts as a usage limit. If omp classifies an
 * error as a quota wall, we must too — otherwise we would either fight omp's
 * own retry engine or give up on a wall that omp refuses to wait out
 * (`retry.waitForUsageReset` defaults to `false`).
 */

/** What kind of failure a finished turn represents. */
export const Category = {
	/** Account/plan quota wall that only clears when the provider's window resets. */
	USAGE_LIMIT: "usage-limit",
	/** Provider is up but saturated: 429 without quota wording, 5xx, "overloaded". */
	OVERLOAD: "overload",
	/** Transport-level failure: socket reset, DNS, timeout, premature close. */
	TRANSIENT: "transient",
	/** Bad or missing credential — retrying cannot help. */
	AUTH: "auth",
	/** Context window / payload size — retrying cannot help without compaction. */
	CONTEXT: "context",
	/** Turn was aborted (user interrupt or host abort), not failed. */
	ABORTED: "aborted",
	/** Something failed and we do not know what. */
	UNKNOWN: "unknown",
};

// --- usage limit ------------------------------------------------------------

const USAGE_LIMIT_PATTERN =
	/usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|out of (?:extra )?usage|spending[- _]?limit|personal-team-blocked|clinepass limit|free limit reached on model|access_terminated_error/i;

const ANTHROPIC_CREDITS_REQUIRED_PATTERN = /\busage credits are required\b|\bcredits_required\b/i;

const PREPAID_BALANCE_EXHAUSTED_PATTERN =
	/\busage_pricing_required\b|\bprepaid balance\b[^\n]{0,40}\b(?:used up|exhausted|depleted)\b/i;

const CREDITS_EXHAUSTED_PATTERN =
	/\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;

const SPEND_LIMIT_PATTERN = /spend(?:ing)?[\s_-]?(?:limit|cap)\b/i;

const ACCOUNT_RATE_LIMIT_PATTERN =
	/\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;

const SUBSCRIPTION_CAP_PATTERN =
	/\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;

const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;

// omp's `parseRateLimitReason` treats any remaining mention of `quota` as an
// account wall once the per-minute/rate-limit arms above have been excluded
// ("You have exceeded your quota", "Free allocated quota exceeded"). Keeping
// that fallback means we wait out the same walls omp refuses to wait out.
const BARE_QUOTA_PATTERN = /\bquota\b/i;

const CLINE_PASS_QUOTA_PATTERN = /clinepass limit|free limit reached on model/i;

// Simplified Chinese quota exhaustion (Zhipu / MiniMax CN and friends).
const CN_QUOTA_EXHAUSTED_PATTERN =
	/(?:使用|用量).{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
const CN_TRANSIENT_CAP_PATTERN =
	/速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;

// Rolling TPM/RPM windows self-heal within the minute; they are throttles, not
// account quota walls.
const TPM_RPM_THROTTLE_PATTERN =
	/\b(?:tpm|rpm)\b[^\n]{0,40}\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b|\b(?:exhaust\w*|exceed\w*|limit\w*|throttl\w*|reach\w*)\b[^\n]{0,40}\b(?:tpm|rpm)\b|\bRateLimitExceeded\.(?:Endpoint)?(?:TPM|RPM)\w*/i;

const DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN = /error-code[^()\s]*#token-limit/i;
const DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN =
	/\byou exceeded your current quota, please check your plan and billing details\b/i;

// Account-scoped cap phrasing that arrives on a 403 (or a statusless trailer).
const ACCOUNT_SCOPED_CAP_PATTERN =
	/\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;

const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;

// --- context ----------------------------------------------------------------

const CONTEXT_PATTERN =
	/prompt is too long|context.?(?:window|length).?(?:exceeded|limit|overflow)|maximum context length|too many tokens|exceeds? the (?:maximum|model'?s) (?:context|token)|request too large|(?:payload|entity) too large|^413\b|string too long|input is too long/i;

// --- auth -------------------------------------------------------------------

const AUTH_PATTERN =
	/invalid.?api.?key|incorrect api key|unauthorized|authentication.?failed|invalid.?token|token (?:is )?expired|permission.?denied|forbidden|no api key|missing api key|oauth token has expired|please run \/login|not logged in/i;

// --- overload ---------------------------------------------------------------

const OVERLOAD_PATTERN =
	/overloaded|capacity|service unavailable|server (?:error|busy)|internal server error|bad gateway|gateway time-?out|too many requests|rate.?limit|throttl|temporarily unavailable|try again later|at capacity|\b(?:529|503|502|504)\b/i;

// --- transient --------------------------------------------------------------

const TRANSIENT_PATTERN =
	/fetch failed|socket hang ?up|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|network ?error|connection (?:reset|closed|aborted|lost)|premature close|stream (?:ended|closed) (?:unexpectedly|prematurely)|terminated|und_err|other side closed|tls|dns|timeout|timed out/i;

// --- status-code helpers ----------------------------------------------------

/** Statuses that mean "the provider is saturated", not "your account is out". */
const OVERLOAD_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

function isDashScopeTokenLimitText(message) {
	return DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN.test(message) && DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN.test(message);
}

/**
 * True when the text names an account/plan quota wall.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function matchesUsageLimitText(message) {
	if (typeof message !== "string" || message.length === 0) return false;
	// DashScope/Bailian TPM throttle is billed-worded like a quota but clears
	// inside the minute window, so it must not become a long wait.
	if (isDashScopeTokenLimitText(message)) return false;
	if (TPM_RPM_THROTTLE_PATTERN.test(message) && !CN_QUOTA_EXHAUSTED_PATTERN.test(message)) {
		// A per-minute window still resolves as a short overload backoff.
		if (USAGE_LIMIT_PATTERN.test(message) && !SPEND_LIMIT_PATTERN.test(message)) {
			// fall through: the quota wording wins only for account-scoped arms below
		} else {
			return false;
		}
	}
	if (USAGE_LIMIT_PATTERN.test(message)) return true;
	if (ANTHROPIC_CREDITS_REQUIRED_PATTERN.test(message)) return true;
	if (PREPAID_BALANCE_EXHAUSTED_PATTERN.test(message)) return true;
	if (CREDITS_EXHAUSTED_PATTERN.test(message)) return true;
	if (CN_QUOTA_EXHAUSTED_PATTERN.test(message) && !CN_TRANSIENT_CAP_PATTERN.test(message)) return true;
	if (SPEND_LIMIT_PATTERN.test(message)) return true;
	if (ACCOUNT_RATE_LIMIT_PATTERN.test(message)) return true;
	if (SUBSCRIPTION_CAP_PATTERN.test(message) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(message)) return true;
	if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(message)) return true;
	if (CLINE_PASS_QUOTA_PATTERN.test(message)) return true;
	if (BARE_QUOTA_PATTERN.test(message) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(message)) return true;
	return false;
}

/**
 * True when the text describes an account-scoped cap that is only unambiguous
 * alongside a 403 or a statusless stream trailer.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isAccountScopedCapText(message) {
	return typeof message === "string" && ACCOUNT_SCOPED_CAP_PATTERN.test(message);
}

/**
 * Classify a failed turn.
 *
 * Order matters and matches omp's own precedence: an explicit quota wall beats
 * a status code, a status code beats generic wording, and the transport lane is
 * last because network errors are the most generically worded.
 *
 * @param {{ status?: number | undefined, message?: string | undefined, stopReason?: string | undefined }} input
 * @returns {string} one of {@link Category}
 */
export function classifyError(input) {
	const status = typeof input?.status === "number" ? input.status : undefined;
	const raw = typeof input?.message === "string" ? input.message : "";
	// Some providers echo the whole body including framing; normalise nothing but
	// strip `resource_exhausted` so it does not read as a quota wall by itself.
	const message = raw.replace(RESOURCE_EXHAUSTED_PATTERN, " ");
	const hadResourceExhausted = message !== raw;

	if (input?.stopReason === "aborted") return Category.ABORTED;

	// 1. Explicit account quota wall, independent of status code.
	if (matchesUsageLimitText(message)) return Category.USAGE_LIMIT;
	if ((status === 403 || status === undefined) && isAccountScopedCapText(raw)) return Category.USAGE_LIMIT;

	// 2. 402 is a billing cap. A bare 402 is still an account wall.
	if (status === 402) return Category.USAGE_LIMIT;

	// 3. Context/payload walls: retrying the same request cannot help.
	if (status === 413 || CONTEXT_PATTERN.test(raw)) return Category.CONTEXT;

	// 4. Credential problems: retrying cannot help either.
	if (status === 401 || status === 403) return Category.AUTH;
	if (AUTH_PATTERN.test(raw)) return Category.AUTH;

	// 5. Saturation.
	if (status !== undefined && OVERLOAD_STATUS.has(status)) return Category.OVERLOAD;
	if (OVERLOAD_PATTERN.test(raw)) return Category.OVERLOAD;

	// 6. Transport.
	if (TRANSIENT_PATTERN.test(raw)) return Category.TRANSIENT;

	// A bare `resource_exhausted` with no quota wording is transient capacity.
	if (hadResourceExhausted) return Category.OVERLOAD;

	return Category.UNKNOWN;
}

/** Categories this extension is willing to resume after. */
export const RESUMABLE_CATEGORIES = new Set([
	Category.USAGE_LIMIT,
	Category.OVERLOAD,
	Category.TRANSIENT,
	Category.UNKNOWN,
]);
