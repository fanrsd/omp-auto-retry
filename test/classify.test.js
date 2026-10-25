import assert from "node:assert/strict";
import { test } from "node:test";

import { Category, RESUMABLE_CATEGORIES, classifyError, matchesUsageLimitText } from "../extension/lib/classify.js";

test("a published quota wall is a usage limit", () => {
	assert.equal(classifyError({ status: 429, message: "You have hit your usage limit. Your limit will reset in 13 minutes" }), Category.USAGE_LIMIT);
	assert.equal(classifyError({ status: 400, message: "quota exceeded for this billing period" }), Category.USAGE_LIMIT);
	assert.equal(classifyError({ message: "You're out of extra usage" }), Category.USAGE_LIMIT);
	assert.equal(classifyError({ message: "Your credit balance is too low" }), Category.UNKNOWN);
	assert.equal(classifyError({ message: "insufficient credits" }), Category.USAGE_LIMIT);
});

test("a bare 402 is a billing wall", () => {
	assert.equal(classifyError({ status: 402, message: "" }), Category.USAGE_LIMIT);
});

test("Chinese quota exhaustion is recognised, per-minute caps are not", () => {
	assert.equal(classifyError({ status: 400, message: "您的额度已用完，请充值" }), Category.USAGE_LIMIT);
	assert.notEqual(classifyError({ status: 429, message: "每分钟请求数已达上限" }), Category.USAGE_LIMIT);
});

test("TPM/RPM throttles stay short backoffs", () => {
	assert.equal(matchesUsageLimitText("RateLimitExceeded.EndpointTPM"), false);
	assert.equal(classifyError({ status: 429, message: "Rate limit reached for gpt-4 in organization on tokens per min (TPM)" }), Category.OVERLOAD);
});

test("DashScope token-limit doc links are throttles, not walls", () => {
	const message = "You exceeded your current quota, please check your plan and billing details. See error-code#token-limit";
	assert.equal(matchesUsageLimitText(message), false);
});

test("digits inside annotations or request ids do not pick a category", () => {
	assert.equal(classifyError({ status: 529, message: "529 Overloaded retry-after-ms=4130" }), Category.OVERLOAD);
	assert.equal(classifyError({ message: "overloaded request_id=req_011CX4130abc" }), Category.OVERLOAD);
	assert.equal(classifyError({ message: "upstream failed id=15030" }), Category.UNKNOWN);
	assert.equal(classifyError({ status: 413, message: "too big" }), Category.CONTEXT);
	assert.equal(classifyError({ message: "413 Request Entity Too Large" }), Category.CONTEXT);
});

test("a bare RESOURCE_EXHAUSTED is capacity, not a quota wall", () => {
	assert.equal(classifyError({ status: 429, message: "RESOURCE_EXHAUSTED: please retry" }), Category.OVERLOAD);
	assert.equal(classifyError({ status: 429, message: "RESOURCE_EXHAUSTED: quota exceeded" }), Category.USAGE_LIMIT);
});

test("saturation is overload", () => {
	assert.equal(classifyError({ status: 529, message: "Overloaded" }), Category.OVERLOAD);
	assert.equal(classifyError({ status: 503, message: "" }), Category.OVERLOAD);
	assert.equal(classifyError({ message: "provider is at capacity, try again later" }), Category.OVERLOAD);
});

test("transport failures are transient", () => {
	assert.equal(classifyError({ message: "fetch failed" }), Category.TRANSIENT);
	assert.equal(classifyError({ message: "socket hang up" }), Category.TRANSIENT);
	assert.equal(classifyError({ message: "read ECONNRESET" }), Category.TRANSIENT);
	assert.equal(classifyError({ message: "stream ended prematurely" }), Category.TRANSIENT);
});

test("credentials and context walls need a human", () => {
	assert.equal(classifyError({ status: 401, message: "" }), Category.AUTH);
	assert.equal(classifyError({ status: 403, message: "forbidden" }), Category.AUTH);
	assert.equal(classifyError({ message: "Invalid API key provided" }), Category.AUTH);
	assert.equal(classifyError({ status: 400, message: "prompt is too long: 250000 tokens > 200000 maximum" }), Category.CONTEXT);
	assert.equal(RESUMABLE_CATEGORIES.has(Category.AUTH), false);
	assert.equal(RESUMABLE_CATEGORIES.has(Category.CONTEXT), false);
});

test("an aborted turn is never resumable", () => {
	assert.equal(classifyError({ stopReason: "aborted", message: "anything" }), Category.ABORTED);
	assert.equal(RESUMABLE_CATEGORIES.has(Category.ABORTED), false);
});

test("an empty message with no status is unknown but resumable", () => {
	assert.equal(classifyError({ status: 500, message: "" }), Category.OVERLOAD);
	assert.equal(classifyError({}), Category.UNKNOWN);
	assert.equal(RESUMABLE_CATEGORIES.has(Category.UNKNOWN), true);
});
