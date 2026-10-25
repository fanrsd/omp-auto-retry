/**
 * omp-auto-retry — an oh-my-pi (omp) extension that resumes a session after a
 * usage limit, a quota reset window, or a transient provider failure.
 *
 * This is the omp-native equivalent of claude-auto-retry: same job (keep the
 * agent working while you are not watching), different mechanism. There is no
 * tmux pane to scrape and no shell rc to inject — omp emits structured events,
 * so detection is exact and resume is a plain `sendUserMessage`.
 *
 * Design notes that matter if you are editing this file:
 *
 *  - Nothing happens at load time except handler registration. Calling
 *    `pi.sendUserMessage()` during load throws `ExtensionRuntimeNotInitializedError`.
 *  - omp already retries internally (`retry.enabled`, 10 attempts). We only act
 *    on a *terminal* failure, and we stand down the moment `auto_retry_start`
 *    fires. Double-driving the same stall burns both budgets.
 *  - Timers come from `ctx.setTimeout`, which is extension-scoped: throws are
 *    contained and everything is cleared on `session_shutdown`.
 */

import { homedir } from "node:os";
import { loadConfig } from "./lib/config.js";
import { createEngine } from "./lib/engine.js";
import { createLogger } from "./lib/logger.js";
import { formatDuration } from "./lib/retry-hint.js";

const NOTIFY_TYPE = { info: "info", warn: "warning", error: "error" };

/**
 * @param {import("@oh-my-pi/pi-coding-agent/extensibility/extensions/types").ExtensionAPI} pi
 */
export default function ompAutoRetry(pi) {
	const { config, warnings, sources, paths } = loadConfig({ cwd: process.cwd(), home: homedir() });

	/** The most recent `ExtensionContext`; timers and notices go through it. */
	let ctx = undefined;

	const logger = createLogger({
		dir: paths.logDir,
		retentionDays: config.logRetentionDays,
		echo: (level, message) => {
			if (level === "warn" || level === "error") ctx?.ui?.notify?.(message, NOTIFY_TYPE[level]);
		},
	});

	const engine = createEngine({
		config,
		logger,
		setTimer: (fn, ms) => {
			const handle = ctx?.setTimeout ? ctx.setTimeout(fn, ms) : setTimeout(fn, ms);
			return { handle, viaCtx: Boolean(ctx?.setTimeout) };
		},
		clearTimer: (timer) => {
			if (!timer) return;
			if (timer.viaCtx) ctx?.clearTimer?.(timer.handle);
			else clearTimeout(timer.handle);
		},
		onResume: (prompt) => {
			// Idle: a plain prompt starts a turn. Streaming: queue as a follow-up
			// so we never cut into output that is still being produced.
			if (ctx?.isIdle?.()) pi.sendUserMessage(prompt);
			else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		},
		onNotify: (level, text) => {
			ctx?.ui?.notify?.(`[auto-retry] ${text}`, NOTIFY_TYPE[level] ?? "info");
		},
		isIdle: () => ctx?.isIdle?.() ?? true,
	});

	for (const warning of warnings) logger.warn("config", { warning });
	logger.info("extension loaded", {
		enabled: config.enabled,
		maxAttempts: config.maxAttempts,
		config: sources.length ? sources.join(",") : "defaults",
	});

	// CLI flag values are applied after extensions load, so `--no-auto-retry`
	// is only readable once events start flowing.
	let flagChecked = false;

	/** Capture the live context for use from timer callbacks. */
	const track = (next) => {
		ctx = next;
		if (!flagChecked) {
			flagChecked = true;
			if (pi.getFlag?.("no-auto-retry") === true) {
				engine.disable();
				logger.info("disabled by --no-auto-retry");
			}
		}
		return next;
	};

	pi.on("after_provider_response", (event, nextCtx) => {
		track(nextCtx);
		engine.handleProviderResponse(event);
	});

	pi.on("turn_start", (_event, nextCtx) => {
		track(nextCtx);
		engine.handleTurnStart();
	});

	pi.on("turn_end", (event, nextCtx) => {
		track(nextCtx);
		engine.handleTurnEnd(event);
	});

	pi.on("agent_end", (event, nextCtx) => {
		track(nextCtx);
		engine.handleAgentEnd(event);
	});

	pi.on("auto_retry_start", (event, nextCtx) => {
		track(nextCtx);
		engine.handleAutoRetryStart(event);
	});

	pi.on("auto_retry_end", (event, nextCtx) => {
		track(nextCtx);
		engine.handleAutoRetryEnd(event);
	});

	pi.on("session_shutdown", () => {
		engine.shutdown();
		logger.info("extension unloaded", { totalResumes: engine.status().totalResumes });
	});

	pi.registerFlag?.("no-auto-retry", {
		description: "Disable the omp-auto-retry extension for this run",
		type: "boolean",
		default: false,
	});

	pi.registerCommand?.("auto-retry", {
		description: "Inspect or control automatic session resume (status|on|off|now|reset|config)",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "on", "off", "now", "reset", "config"];
			const matches = options.filter((option) => option.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, commandCtx) => {
			track(commandCtx);
			const [sub = "status"] = String(args ?? "")
				.trim()
				.split(/\s+/)
				.filter(Boolean);

			switch (sub) {
				case "on": {
					engine.enable();
					commandCtx.ui.notify("[auto-retry] enabled", "info");
					logger.info("enabled via command");
					return;
				}
				case "off": {
					engine.disable();
					commandCtx.ui.notify("[auto-retry] disabled for this session", "info");
					logger.info("disabled via command");
					return;
				}
				case "now": {
					const status = engine.status();
					if (!status.pending) {
						commandCtx.ui.notify("[auto-retry] nothing is scheduled", "info");
						return;
					}
					engine.resumeNow();
					commandCtx.ui.notify("[auto-retry] resuming now", "info");
					return;
				}
				case "reset": {
					engine.reset("manual reset");
					commandCtx.ui.notify("[auto-retry] attempt budget reset", "info");
					return;
				}
				case "config": {
					const lines = [
						`enabled: ${config.enabled}`,
						`maxAttempts: ${config.maxAttempts}`,
						`resumePrompt: ${JSON.stringify(config.resumePrompt)}`,
						`respectHostRetries: ${config.respectHostRetries}`,
						`usageLimit: fallback ${formatDuration(config.usageLimit.fallbackWaitMs)}, cap ${formatDuration(config.usageLimit.maxWaitMs)}`,
						`overload: base ${formatDuration(config.overload.baseDelayMs)}, cap ${formatDuration(config.overload.maxDelayMs)}`,
						`transient: base ${formatDuration(config.transient.baseDelayMs)}, cap ${formatDuration(config.transient.maxDelayMs)}`,
						`files: ${sources.length ? sources.join(", ") : "(defaults only)"}`,
						`logs: ${logger.dir}`,
					];
					commandCtx.ui.notify(lines.join("\n"), "info");
					return;
				}
				case "status":
				default: {
					const status = engine.status();
					const lines = [
						`state: ${status.phase}`,
						`attempts: ${status.attempts}/${status.maxAttempts} (total resumes: ${status.totalResumes})`,
						`enabled: ${status.enabled}`,
						`host retrying: ${status.hostRetrying}`,
					];
					if (status.pending) {
						lines.push(
							`pending: ${status.pending.category} in ${formatDuration(status.pending.inMs)} (${status.pending.source})`,
						);
					}
					if (status.lastError) {
						lines.push(`last error: ${status.lastError.category}${status.lastError.status ? ` (HTTP ${status.lastError.status})` : ""}`);
					}
					if (status.gaveUpReason) lines.push(`gave up: ${status.gaveUpReason}`);
					commandCtx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});
}
