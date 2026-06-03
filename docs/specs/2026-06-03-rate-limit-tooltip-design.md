# Status Bar Hover and Click Rate Limit Details Design

Date: 2026-06-03

## Background and Goal

The status bar currently shows only `Provider NN%`, the hover tooltip is a single context line, and clicking refreshes the item. The goal is to show more detail similar to Claude Code `/status`: recent 5-hour usage and weekly usage where that local data is available. Detailed usage should live in the hover tooltip; clicking should not open a notification.

## Data Source Findings

- **Codex**: session JSONL `token_count` events already include `rate_limits`:
  - `primary`: `{ used_percent, window_minutes: 300, resets_at }`, the 5-hour window.
  - `secondary`: `{ used_percent, window_minutes: 10080, resets_at }`, the 7-day window.
  - `resets_at` is a Unix timestamp in seconds. `codexUsage.js` already returns it as `rateLimits`, so provider logic does not need to change.
- **Claude**: session JSONL files and local `~/.claude` cache files do not contain 5-hour or weekly usage. Claude Code `/status` fetches that from the OAuth usage API in real time. This version does not add network requests or Keychain access, so Claude does not show 5-hour or weekly usage.

## Design

### 1. `src/agentUsage.js`: Formatting Extension

- `formatAgentUsage` changes the tooltip from one line to a multi-line string. VS Code status bar tooltips support `\n`, so `MarkdownString` is not required:

  ```text
  Codex: Context 45k / 258k (17%)
  5h usage: 21% · Reset at 14:32
  Weekly usage: 10% · Reset at 6/8 09:24
  ```

- Add `formatRateLimits(rateLimits, now)`:
  - `primary` windows with `window_minutes <= 24 * 60` use the label `${hours}h usage`, such as `5h usage` for 300 minutes.
  - `secondary` windows with `window_minutes >= 7 * 24 * 60` use `Weekly usage`.
  - Other durations fall back to `${days}d usage`.
  - `resets_at` on the same local day as `now` is formatted as `HH:mm`; other days use `M/D HH:mm`.
  - `now` is injectable for deterministic tests.
- Claude tooltip keeps the context row and appends a model row, such as `Model: claude-opus-4-8`. It does not show 5-hour or weekly usage.
- Parser and formatting layers remain free of `vscode` dependencies.

### 2. `src/extension.js`: Click Behavior

- `agentTokenStatus.refresh` refreshes status only. It does not call `showInformationMessage`, so clicking the status bar item does not open a notification. Detailed usage remains available from the hover tooltip.

### 3. Error Handling

- Empty `rateLimits`, missing `used_percent`, or missing `window_minutes` omit the corresponding row instead of showing noisy `n/a` text.

### 4. Tests

`test/agentUsage.test.js` adds coverage for:

- `formatRateLimits`: 5-hour windows, weekly windows, omitted invalid or incomplete fields, unknown window-duration fallback, same-day reset time, and cross-day reset time.
- Codex usage with `rateLimits`, producing a multi-line tooltip.
- Claude usage with a model row and no rate-limit rows.

## Out of Scope

- No Anthropic OAuth usage API calls.
- No `MarkdownString` or `QuickPick` menu.
- No provider contract changes.
