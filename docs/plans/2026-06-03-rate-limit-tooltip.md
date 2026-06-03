# Status Bar Hover and Click Rate Limit Details Implementation Plan

## Overview

**Goal:** The status bar hover tooltip shows Codex 5-hour and weekly usage with reset times. Claude shows the model name. Clicking the status bar item refreshes status without opening a notification.

**Architecture:** Changes stay in the formatting layer and the VS Code entry point. `src/agentUsage.js` owns `formatRateLimits` and multi-line tooltip formatting. `src/extension.js` keeps click behavior to refresh only. The provider contract stays unchanged because `codexUsage.js` already returns `rateLimits`.

**Tech Stack:** Plain CommonJS, Node built-in test runner (`node --test`), no dependencies, no build step.

**Note:** This project may be used without a git remote or release workflow, so commit steps are omitted. Time formatting uses local-time `Date` component methods such as `getHours`. Tests construct local dates with `new Date(year, month, day, hh, mm)` and then convert to Unix seconds, which keeps assertions deterministic across time zones.

Design document: `docs/specs/2026-06-03-rate-limit-tooltip-design.md`

## Task 1: `formatRateLimits`

- Modify: `src/agentUsage.js`
- Test: `test/agentUsage.test.js`

Codex `rateLimits` shape from `token_count` events:

```js
{
  primary: { used_percent, window_minutes, resets_at },
  secondary: { used_percent, window_minutes, resets_at }
}
```

`resets_at` is Unix seconds.

Rules:

- `window_minutes >= 7 * 24 * 60` uses `Weekly usage`.
- `window_minutes <= 24 * 60` uses `${hours}h usage`.
- Durations between those ranges use `${days}d usage`.
- Missing or non-finite `used_percent` or `window_minutes` omits the row.
- Same-day reset times use `HH:mm`; cross-day reset times use `M/D HH:mm`.
- Missing `resets_at` omits the ` · Reset at ...` suffix.
- `now` is injectable as the second argument and defaults to `Date.now()`.

Steps:

1. Add failing tests for 5-hour, weekly, missing-field, missing-reset, and mid-length windows.
2. Run the target test file and confirm the new tests fail before implementation.
3. Implement `formatResetTime`, `formatRateLimitWindow`, and `formatRateLimits`.
4. Export `formatRateLimits`.
5. Run all tests and confirm they pass.

Expected UI rows:

```text
5h usage: 21% · Reset at 14:32
Weekly usage: 10% · Reset at 6/8 09:24
2d usage: 56%
```

## Task 2: `formatAgentUsage`

- Modify: `src/agentUsage.js`
- Test: `test/agentUsage.test.js`

Tooltip row order:

1. Context row.
2. Model row when `usage.model` exists.
3. Rate-limit rows when `usage.rateLimits` exists.

The aggregation layer should decide based on field presence instead of hard-coding provider names.

Steps:

1. Add tests for Codex usage with rate limits and Claude usage with a model row.
2. Update existing Claude tooltip assertions to include the model row.
3. Update `formatAgentUsage` to build a multi-line tooltip.
4. Run all tests and confirm they pass.

Expected examples:

```text
Codex: Context 8k / 258k (3%)
5h usage: 21% · Reset at 14:32
Weekly usage: 10% · Reset at 6/8 09:24
```

```text
Claude: Context 185k / 1m (18%)
Model: claude-opus-4-8
```

## Task 3: `extension.js`

- Modify: `src/extension.js`
- Test: manual VS Code verification.

The refresh command should call `refreshStatus` only. It should not call `showInformationMessage`, because click behavior should not open a notification. This file depends on the `vscode` API, so automated tests are not required.

Steps:

1. Return the formatted result from `refreshStatus`.
2. Update the `agentTokenStatus.refresh` command to refresh without showing a notification.
3. Run all tests and confirm there is no regression.
4. Manually verify in VS Code when practical.

Manual verification:

1. Run `Developer: Reload Window`.
2. Hover the status bar item. Codex should show `5h usage` and `Weekly usage`; Claude should show `Model: ...`.
3. Click the status bar item. It should refresh without opening a notification.
4. Point `agentTokenStatus.claudeRoot` or `agentTokenStatus.sessionsRoot` to an empty directory to verify the no-session message.
