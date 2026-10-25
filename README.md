# omp-auto-retry

Automatic session resume for **oh-my-pi** (`omp`) when you hit a usage limit, a
quota reset window, or a transient provider failure.

`omp` already retries — 10 times, exponential, capped at 5 minutes
(`retry.enabled`). It stops there. When a provider says *"your quota resets in
18h31m10s"*, `omp` gives the turn back to you and waits for a human, because
`retry.waitForUsageReset` defaults to `false`.

This extension is the human. It reads the reset time the provider published,
sleeps exactly that long, and sends `continue` so the session keeps going while
you are asleep, commuting, or in a meeting.

```
[auto-retry] usage-limit: resuming in 18h 31m 15s (attempt 1/20)
[auto-retry] resumed — session is healthy again
```

---

## Why this exists

This is the omp-native counterpart of
[`claude-auto-retry`](https://github.com/cheapestinference/claude-auto-retry).
Same job, different mechanism — and the difference is the point:

| | claude-auto-retry | omp-auto-retry |
|---|---|---|
| **Detection** | scrapes a tmux pane | structured omp events (`turn_end`, `auto_retry_end`) |
| **Resume** | types into a PTY | `pi.sendUserMessage()` |
| **Process model** | external wrapper + background monitor | in-process extension |
| **Needs tmux** | yes | **no** |
| **Needs a shell rc hook** | yes | no |
| **Native Windows** | **not supported** | **yes** — first-class |
| **Reset time source** | regex over terminal text | provider headers *and* body, same grammar omp uses |
| **Config** | `~/.claude-auto-retry.json` | `~/.omp-auto-retry.json` (+ per-project) |
| **Logs** | `~/.claude-auto-retry/logs/YYYY-MM-DD.log` | `~/.omp-auto-retry/logs/YYYY-MM-DD.log` |
| **Dependencies** | zero | zero |

The tmux approach is clever but fragile: it re-parses rendered text, cannot tell
an error message from the user *quoting* an error message, and dies with the
pane. `omp` emits typed events, so detection here is exact and the resume is a
function call. That is also what makes native Windows possible.

---

## How it decides

A stall is a finished turn whose assistant message has `stopReason: "error"`.
The extension classifies it, picks a delay, and arms a timer.

| Category | Trigger | Delay |
|---|---|---|
| `usage-limit` | quota/credit/plan wording, HTTP 402, account-scoped cap | **published reset time** + 5s margin; else 15 min escalating ×1.5, capped at 12h |
| `overload` | 429 without quota wording, 5xx, `overloaded`, `capacity` | `retry-after` if present, else 2s × 2ⁿ, capped at 5 min |
| `transient` | ECONNRESET, socket hang up, DNS, TLS, premature close, timeout | 1s × 2ⁿ, capped at 2 min |
| `unknown` | failed, unrecognised | 5s × 2ⁿ, capped at 1 min |
| `auth` | 401/403, invalid key, expired OAuth | **never** — needs a human |
| `context` | context window / payload too large | **never** — needs compaction |
| `aborted` | you pressed Esc | **never** — that was you |

Everything is jittered (±20% on short waits; a published reset only ever gets
0–5% *later*, never earlier, because waking before the window opens re-hits the
wall) so a fleet of sessions does not stampede the provider when it reopens.

### Reset-time extraction

The grammar is a faithful port of omp's own `extractRetryHint()`, so this
extension and the host never disagree about what the provider said:

- **Headers** — `retry-after-ms`, `retry-after` (seconds *or* HTTP date),
  `x-ratelimit-reset-ms`, `x-ratelimit-reset`, `x-ratelimit-reset-after`
- **Bodies** — `reset after 18h31m10s`, `Please retry in 250ms`,
  `"retryDelay": "34.07s"`, `try again in ~158 min`, `Resets in 2hr 15min`,
  `Resets in 3 days`, `Your limit will reset at 2026-09-01 09:44:51`,
  `将在 2026-09-01 09:44:51 重置`

One omp detail decides the precedence order. `after_provider_response` only
fires on **2xx** — the provider layer throws before the response callback runs on
a failure — so a failing response's headers never reach an extension. omp
compensates by appending `retry-after-ms=<n>` to the error message
(`formatErrorMessageWithRetryAfter`), computed from `retry-after`,
`retry-after-ms`, and `x-ratelimit-reset*` exactly the way `extractRetryHint()`
does.

That annotation is therefore the most authoritative signal actually visible
here, and it outranks everything else:

1. `retry-after-ms=<n>` in the error message — the value the transport layer
   itself acted on
2. Response headers — reachable only on a 2xx, so mostly a safety net
3. Body prose — the provider telling us a duration, in any of the grammars above
4. A timezone-naive `reset at` stamp — treated as a *guess*, not an authority,
   because guessing a zone is how sessions sleep through a window that already
   reopened

Long waits are only honoured when the timing is authoritative (tiers 1–3, or a
`reset at` stamp with a known offset). A guess is never allowed to park a
session for hours.

---

## Install

Requires **Node ≥ 18** and `omp` on `PATH`.

```bash
npm install -g omp-auto-retry
omp-auto-retry install
```

`install` copies the extension into omp's agent directory:

| Platform | Default location |
|---|---|
| all | `~/.omp/agent/extensions/omp-auto-retry/` |
| profile | `~/.omp/profiles/<OMP_PROFILE>/agent/extensions/omp-auto-retry/` |
| override | `$PI_CODING_AGENT_DIR/extensions/omp-auto-retry/` |

It resolves the path the same way omp does (`PI_CODING_AGENT_DIR` →
`~/$PI_CONFIG_DIR/.omp` → profile subdir), so the files land where the host
actually looks. Then just start `omp` — nothing else to wire up.

```bash
omp-auto-retry install --project   # into ./.omp/extensions (this repo only)
omp-auto-retry install --link      # symlink instead of copy (development)
omp-auto-retry uninstall           # leaves config and logs in place
```

### Verify

```bash
omp-auto-retry doctor
```

```
omp-auto-retry doctor v1.0.0

✓ node >= 18            v24.11.1
✓ omp on PATH           omp/18.12.5
✓ agent dir             C:\Users\you\.omp\agent
✓ extension installed   global: ...\.omp\agent\extensions\omp-auto-retry
✓ manifest (global)     omp.extensions = ["./index.js"]
✓ syntax (global)       ...\extensions\omp-auto-retry\index.js
✓ config parses         defaults
✓ log dir writable      C:\Users\you\.omp-auto-retry\logs
! log exists            no entries yet

all checks passed
```

Then in a session:

```
/auto-retry status
```

```
state: idle
attempts: 0/20 (total resumes: 0)
enabled: true
host retrying: false
```

---

## Runtime controls

All inside `omp`, no restart:

| Command | Effect |
|---|---|
| `/auto-retry status` | phase, attempt budget, what is armed and when |
| `/auto-retry now` | fire the armed resume immediately (skip the wait) |
| `/auto-retry off` | disarm for this session |
| `/auto-retry on` | re-arm |
| `/auto-retry reset` | clear the attempt budget and give-up state |
| `/auto-retry config` | effective settings and which files produced them |

And one flag, for the run where you want the default omp behaviour back:

```bash
omp --no-auto-retry
```

---

## Configuration

```bash
omp-auto-retry config --init      # write ~/.omp-auto-retry.json with defaults
omp-auto-retry config             # print the effective, merged, validated config
omp-auto-retry config --path      # where the files are
```

Files, lowest precedence first:

1. built-in defaults
2. `~/.omp-auto-retry.json` — global
3. `./.omp-auto-retry.json` — project (wins)

`OMP_AUTO_RETRY_CONFIG=/path/to/file.json` replaces both. `OMP_AUTO_RETRY_DISABLED=1`
forces `enabled: false` without touching a file.

```jsonc
{
  "enabled": true,
  "resumePrompt": "continue",     // what gets sent to resume
  "maxAttempts": 20,              // resumes per stall before giving up
  "respectHostRetries": true,     // never fight omp's own retry loop
  "minDelayMs": 1500,             // floor: let the failed run unwind first
  "notify": true,                 // TUI notices
  "logRetentionDays": 7,

  "usageLimit": {
    "fallbackWaitMs": 900000,     // 15m — no reset time published
    "maxWaitMs": 43200000,        // 12h — cap for a single wait
    "marginMs": 5000,             // land 5s after the window opens
    "backoffFactor": 1.5,         // escalation across repeated unhinted walls
    "jitterRatio": 0.05
  },

  "overload":  { "baseDelayMs": 2000,  "maxDelayMs": 300000, "jitterRatio": 0.2 },
  "transient": { "baseDelayMs": 1000,  "maxDelayMs": 120000, "jitterRatio": 0.2 },
  "unknown":   { "baseDelayMs": 5000,  "maxDelayMs": 60000,  "jitterRatio": 0.2 }
}
```

Every value is validated and clamped, and unknown keys warn. A stray comma in a
hand-edited file degrades to defaults with a notice — never to a 0 ms hot loop,
and never to a session that dies because its *retry helper* threw.

---

## Logs

```bash
omp-auto-retry logs              # today, last 200 lines
omp-auto-retry logs -f           # follow
omp-auto-retry logs --lines 500
```

`~/.omp-auto-retry/logs/YYYY-MM-DD.log`, daily rotation, 7-day retention:

```
2026-10-21 02:14:09.881 INFO  resume scheduled category=usage-limit in=18h 31m 15s source=message:retry-after-ms attempt=1/20 capped=false
2026-10-21 20:45:30.104 INFO  sending resume attempt=1/20 category=usage-limit prompt=continue
2026-10-21 20:45:31.772 INFO  session recovered afterAttempts=1 total=1
```

The log is the audit trail: every schedule names its `source`, so you can see
whether the wait came from omp's own annotation, a response header, a parsed
body, or the fallback.

---

## Design guarantees

These are the invariants the engine exists to protect. Each one has a test.

1. **Never double-drive.** The moment `auto_retry_start` fires, any armed resume
   is cancelled. Two retry loops on one stall burn both budgets.
2. **Never resume twice for the same stall.** A scheduled resume is dropped if a
   turn starts without us — that means you took over.
3. **Never sleep through a published window.** A provider reset time beats every
   heuristic. Heuristics only fill the gap where the provider said nothing.
4. **Never retry what a timer cannot fix.** Auth and context failures stop
   immediately with a reason instead of burning 20 attempts.
5. **Never lose the budget to a failed send.** If `sendUserMessage` throws, the
   attempt counter rolls back and the same step re-arms.
6. **Never act during an aborted turn.** Esc means you wanted it to stop.
7. **Never let logging break a resume.** Every write is best-effort and silent
   on failure; the disk is not on the critical path.

There is also a verification pass: if a resume produces no turn within 90
seconds while the session is idle (a delivery that silently dropped), it
re-sends. While omp is still streaming the resume is just queued, so it keeps
waiting instead. Each re-send spends an attempt, so a host that keeps dropping
messages still hits `maxAttempts`.

---

## CLI reference

```
omp-auto-retry <command> [options]

  install      Copy the extension into omp's extension directory
  uninstall    Remove the installed extension
  status       Show host, install and effective configuration
  doctor       Diagnose the setup (exit 1 when something is wrong)
  logs         Print today's log
  config       Print the effective config
  version      Print the version

  --project        Install into ./.omp/extensions instead of the global agent dir
  --link           Symlink the sources instead of copying (development)
  --force          Overwrite an existing config or install
  --json           Machine-readable output (status, doctor)
  --lines <n>      How many log lines to print (default 200)
  --follow, -f     Keep streaming new log lines
  --init           (config) Write a starter ~/.omp-auto-retry.json
  --path           (config) Print the resolved config paths
```

`status --json` and `doctor --json` are stable shapes, safe to script against.

---

## Troubleshooting

**Nothing happens on a usage limit.**
Run `/auto-retry status`. If `host retrying: true`, omp is still inside its own
10-attempt loop — this extension deliberately stands down until that finishes.
Check `omp-auto-retry logs` for `standing down`.

**It gave up immediately.**
Read the `gave up:` line in `/auto-retry status`. `auth` and `context` are
refusals by design: no timer fixes a bad key or an overflowing context window.

**The wait was 15 minutes, not the 3 hours the provider announced.**
The reset time was not parseable from what arrived. Check the `source=` field in
the log — `fallback:no-reset-time` means no header or body grammar matched.
That is a bug worth reporting with the provider's raw error text.

**Extension does not load at all.**
`omp-auto-retry doctor` checks the manifest, the entry-point syntax, and the
directory omp reads. A stale copy after editing sources is the usual cause:
re-run `omp-auto-retry install`.

**It fights my own typing.**
It does not. Any turn that starts while a resume is armed cancels it — that is
invariant #2.

---

## Development

Zero dependencies, plain ESM, no build step.

```bash
npm test        # 78 tests, node --test
npm run lint    # node --check over every source file
npm run e2e     # end-to-end, needs a real `omp` on PATH
```

`npm run e2e` stands up a mock OpenAI-compatible provider on `127.0.0.1:8791`
that answers with a real `429` quota wall, drives `omp --mode rpc` against it in
a throwaway sandbox (`%TEMP%\omp-e2e`), and asserts that the extension scheduled
a resume, sent it, and recovered the session. It writes nothing outside that
sandbox and prints the extension log and RPC frames it observed.

```
bin/omp-auto-retry.js       CLI: install / status / doctor / logs / config
extension/index.js          omp extension factory — event wiring, /auto-retry
extension/lib/classify.js   error → category (mirrors omp's rate-limit rules)
extension/lib/retry-hint.js reset-time extraction (port of omp's fetch-retry)
extension/lib/engine.js     the resume state machine
extension/lib/config.js     load / merge / validate / clamp
extension/lib/logger.js     daily-rotated logging
test/                       classify, retry-hint, config, engine (fake clock)
```

`engine.js` never touches omp directly — timers, resume, and notify are all
injected. That is why the whole policy is testable against a fake clock without
a live agent, and why `npm test` is instant.

`--link` makes the installed extension a symlink to this checkout, so edits are
live on the next `omp` start.

---

## License

MIT
