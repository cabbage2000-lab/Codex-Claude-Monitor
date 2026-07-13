# Rate-Limit Reset Countdown and Claude Reset Times Design

Date: 2026-07-13

## Background and Goal

The tooltip already showed Codex reset times as absolute clock times (`Reset at 14:32`) from the session JSONL `resets_at` field, but gave no sense of how long remains. Claude showed no reset times at all: `claude -p "/usage"` prints them, but `parseUsageOutput` only captured the percentages. The goal is to show, for both providers, when the 5-hour and weekly windows reset and how much time remains. Reset info stays tooltip-only; the status bar text is unchanged.

## Data Source Findings

- **Codex**: `rate_limits.primary/secondary.resets_at` is a Unix timestamp in seconds and already flows through `codexUsage.js` untouched. There is no `resets_in_seconds` field in real data. With an expired subscription both windows are `null` and the rows are omitted (existing behavior).
- **Claude**: `claude -p "/usage"` lines end with `· resets Jul 13 at 4:39pm (Asia/Shanghai)` — lowercase `resets`, month abbreviation, no year, 12-hour clock, optional minutes (`1am`), and the machine-local IANA zone name in parentheses.

## Design

### 1. `src/claudeRateLimits.js`: parse the reset suffix

- `parseUsageOutput(text, now = Date.now())` captures the line tail after `NN% used` and matches `resets <Mon> <D> at <h>[:mm]<am|pm>` (case-insensitive, no dependence on the `·` separator). A parsed tail adds `resets_at` (Unix seconds) to the window; an unparseable tail keeps the percent-only window. `resets_at` is attached conditionally, never as `undefined`, so strict deepEqual comparisons of percent-only output stay exact.
- 12-hour conversion is `h % 12 + (pm ? 12 : 0)`, covering `12am` -> 0:00 and `12pm` -> 12:00 in one expression.
- The wall clock is parsed as machine-local time and the zone suffix is ignored: the CLI prints machine-local times. Known limitation: if the CLI ever switches to a fixed zone, absolute times and countdowns shift together.
- **Year inference**: the year is whichever of {previous, current, next} lands the parsed date closest to `now`. Real resets are always <= 7 days ahead and probe output is at most minutes stale, so the safety margin is enormous. The rejected alternative — "current year; add one when more than 24h in the past" — breaks on Jan 1 when marginally stale output still says `resets Dec 31 …`: it would jump a year ahead and display `(in 364d …)`, while the nearest-year rule keeps it in the past (countdown omitted).

### 2. `src/agentUsage.js`: countdown suffix

- New `formatTimeLeft(resetsAtSeconds, now)` renders the remaining time; `formatRateLimitWindow` appends it after the absolute time: `5h usage: 21% · Reset at 14:32 (in 2h 13m)`.
- Unit rules: total minutes are rounded up (a countdown never reads `0m`), at most two units, zero minor unit omitted: `38m`, `1h`, `2h 13m`, `4d 21h`, `7d`. On the day scale leftover minutes are dropped; `23h59m30s` rounds up into `1d`.
- `resets_at` missing -> percent-only row; `resets_at` in the past (stale session data, just-reset windows) -> absolute time only, no countdown. Both preserve prior behavior.
- The countdown is recomputed against the current time on every refresh (default 10s). A visible tooltip does not live-update; re-hovering refreshes it (existing VS Code behavior).

### 3. Tests

- `formatTimeLeft` boundary matrix (30s, 59m30s, exact hour/day, day-scale minute drop, exact 7d, past/invalid inputs -> null).
- Claude parse: real-output fixture with reset timestamps, 12-hour edges, both New Year directions, unparseable tails, CRLF.
- Probe tests assert stable fields plus `Number.isFinite(resets_at)` because the probe parses with the real current time.

## Out of Scope

- Status bar text is unchanged: reset info remains tooltip-only.
- The `Current week (<model>)` line is still ignored.
- No `resets_in_seconds` support (the field does not exist in real data).
