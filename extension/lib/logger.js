/**
 * Daily-rotated file logging for omp-auto-retry.
 *
 * Logs land in `~/.omp-auto-retry/logs/YYYY-MM-DD.log`, the same layout the
 * claude-auto-retry tool uses, so `omp-auto-retry logs` / `tail` behave the way
 * people already expect. Every write is best-effort: logging must never be the
 * reason a session fails to resume.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LEVELS = ["debug", "info", "warn", "error"];

function stamp(date) {
	const pad = (value, width = 2) => String(value).padStart(width, "0");
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
	);
}

function dayStamp(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * @param {{
 *   dir: string,
 *   retentionDays?: number,
 *   echo?: (level: string, message: string) => void,
 *   now?: () => Date,
 *   maxBytes?: number,
 * }} options
 */
export function createLogger(options) {
	const dir = options.dir;
	const retentionDays = options.retentionDays ?? 7;
	const echo = options.echo;
	const now = options.now ?? (() => new Date());
	const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;

	let ready = false;
	let currentDay = "";
	let currentBytes = 0;

	function ensureDir() {
		if (ready) return true;
		try {
			mkdirSync(dir, { recursive: true });
			ready = true;
			return true;
		} catch {
			return false;
		}
	}

	function prune(today) {
		try {
			const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
			for (const entry of readdirSync(dir)) {
				if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(entry)) continue;
				if (entry === `${today}.log`) continue;
				const path = join(dir, entry);
				try {
					if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
				} catch {
					// A file locked by another omp process is not worth reporting.
				}
			}
		} catch {
			// Pruning is opportunistic.
		}
	}

	function fileFor(date) {
		const day = dayStamp(date);
		if (day !== currentDay) {
			currentDay = day;
			currentBytes = 0;
			prune(day);
		}
		return join(dir, `${day}.log`);
	}

	/**
	 * @param {string} level one of debug/info/warn/error
	 * @param {string} message
	 * @param {Record<string, unknown>} [fields] appended as `key=value` pairs
	 */
	function log(level, message, fields) {
		const line = [`${stamp(now())} ${level.toUpperCase().padEnd(5)} ${message}`];
		if (fields) {
			for (const [key, value] of Object.entries(fields)) {
				if (value === undefined || value === null || value === "") continue;
				const rendered =
					typeof value === "string" ? (/\s/.test(value) ? JSON.stringify(value) : value) : JSON.stringify(value);
				line.push(`${key}=${rendered}`);
			}
		}
		const text = `${line.join(" ")}\n`;

		if (echo && level !== "debug") {
			try {
				echo(level, line.join(" ").slice(26));
			} catch {
				// The UI channel is optional.
			}
		}

		if (!ensureDir()) return;
		try {
			const date = now();
			const path = fileFor(date);
			if (currentBytes > maxBytes) return;
			appendFileSync(path, text, "utf8");
			currentBytes += text.length;
		} catch {
			// Disk full / permission denied: keep running, stay silent.
		}
	}

	const api = {
		path: () => join(dir, `${currentDay || dayStamp(now())}.log`),
		dir,
		debug: (message, fields) => log("debug", message, fields),
		info: (message, fields) => log("info", message, fields),
		warn: (message, fields) => log("warn", message, fields),
		error: (message, fields) => log("error", message, fields),
	};
	api.levels = LEVELS;
	return api;
}

/** A logger that writes nowhere, for tests and `--dry-run` paths. */
export function createNullLogger() {
	const noop = () => {};
	return { path: () => "", dir: "", debug: noop, info: noop, warn: noop, error: noop, levels: LEVELS };
}
