# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a local VS Code extension, not intended for marketplace publishing. It shows token/context usage percentages for the current Codex or Claude Code session in the status bar. The project is plain CommonJS with no build step and no dependencies beyond Node built-ins and the `vscode` API.

## Commands

```bash
# Run all tests with Node's built-in test runner. No npm install is required.
npm test

# Run one test file.
node --test test/claudeUsage.test.js
```

For local installation, symlink the project directory to `~/.vscode/extensions/codex-claude-monitor`, then run `Developer: Reload Window` in VS Code. See `README.md`.

## Architecture

Data flow: local session JSONL files -> provider parsers with workspace filtering -> latest active provider selection -> status bar.

Workspace filtering: `readLatestAgentUsage` accepts optional `workspaceFolders` as absolute paths. Only sessions whose cwd is inside a workspace folder, including subdirectories, are counted. Empty arrays disable filtering. Claude is filtered by munged directory names, where non-alphanumeric characters are replaced with `-` and prefix matching supports subdirectories, so files do not need to be opened. Codex candidates are sorted by descending mtime, then each first line is read until `session_meta.payload.cwd` matches. See `docs/specs/2026-06-03-workspace-filter-design.md`.

- `src/sessionFiles.js`: shared provider utility layer for recursive scanning with `walkFiles`, descending mtime sorting, `parseJsonLine`, `calculateContextPercent`, and `readLastMatchingEvent`, which parses JSONL line by line, returns the last matched entry, and caches by mtime plus size.
- `src/codexUsage.js`: recursively scans `~/.codex/sessions` for `rollout-*.jsonl`, picks the newest file by mtime, and reads the last `token_count` event. Percentage = `last_token_usage.input_tokens / model_context_window`.
- `src/claudeUsage.js`: recursively scans `~/.claude/projects` for `.jsonl`, picks the newest file, and reads the last `type: "assistant"` entry with `message.usage`. Context tokens = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`; the context window is inferred from the model name by `inferClaudeContextWindow`: model names containing `1m` or `claude-opus-4-7` / `claude-opus-4-8` use 1M, otherwise 200k.
- `src/agentUsage.js`: aggregation layer. It reads both providers, selects the most recently active one by `updatedAt`, and formats status bar text and tooltip text. Status bar text is just `{provider} ⚡ {percent}` (e.g. `Claude ⚡ 9%` or `Codex ⚡ 3%`); the friendly Claude model name (with `(1M)` marker) and the compact Codex rate-limit segments are intentionally kept out of the status bar and surfaced only in the tooltip. `getUsageSeverity` maps context percent to `low` (<50%), `medium` (50–79%), or `high` (>=80%) for status bar coloring. Tooltip rows are ordered as context row, model row (friendly name with `(1M context)` marker), Claude token-composition rows from `formatClaudeTokenDetail` (input/cache-read/cache-create plus a cache-hit percent; empty for providers like Codex without this breakdown), then rate-limit rows. Codex 5-hour and weekly usage rows are formatted by `formatRateLimits`.
- `src/extension.js`: VS Code entry point and the only file that depends on the `vscode` API. It owns the status bar item, refresh timer with default 10s interval, configuration reads for `agentTokenStatus.sessionsRoot`, `claudeRoot`, and `refreshIntervalMs`, and the `agentTokenStatus.refresh` command. It maps the formatted severity to a theme color via `SEVERITY_COLORS` (`charts.green` / `charts.yellow` / `charts.red`). Clicking the status bar item refreshes status only; detailed usage remains in the hover tooltip.

Provider contract: every provider's `readLatestXxxUsage(root, workspaceFolders)` returns the unified shape `{ provider, sessionFile, updatedAt, contextTokens, contextWindow, contextPercent, ... }`. Codex uses file mtime for `updatedAt`; Claude uses message timestamp. To add a provider, implement this contract and append it to the candidates array in `agentUsage.js`. Formatting belongs only in the aggregation layer through `formatAgentUsage`, `formatCount`, and `formatRateLimits`.

Key design: parsing logic in `sessionFiles`, `codexUsage`, `claudeUsage`, and `agentUsage` is fully decoupled from the `vscode` API, so it can be tested directly with Node's built-in test runner without a VS Code test environment. Tests use `test/testUtils.js` helpers such as `makeTempDir`, `writeJsonl`, and `setMtime` to create temporary JSONL fixtures for parser and selection behavior.

When adding support for a new model context window, update `inferClaudeContextWindow` in `claudeUsage.js`.
