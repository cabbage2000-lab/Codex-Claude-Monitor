# BEGIN PROMPTIFY MANAGED BLOCK
# Promptify for Codex

Adapter skill: /Users/blingabc/.promptify/current/adapters/codex/skills/promptify/SKILL.md
Fallback instructions: /Users/blingabc/.promptify/current/adapters/codex/instructions/promptify.md
Shared rules: /Users/blingabc/.promptify/current/shared
# END PROMPTIFY MANAGED BLOCK

# Context Meter Repository Guide

## Project Overview

Context Meter is a local VS Code extension that shows the current Codex or Claude Code context usage percentage in the status bar.

The project uses CommonJS, Node built-in modules, and the `vscode` API. There is no build step and no runtime dependency beyond VS Code.

## Commands

Run all tests:

```bash
npm test
```

Run one test file:

```bash
node --test test/claudeUsage.test.js
```

Local development install:

```bash
ln -s /path/to/context-meter ~/.vscode/extensions/context-meter
```

Then run `Developer: Reload Window` in VS Code.

## Architecture

Data flow:

```text
local session JSONL files -> provider parsers -> latest active provider -> VS Code status bar
```

Workspace filtering is handled outside the VS Code entry point where possible. `readLatestAgentUsage` accepts optional `workspaceFolders` as absolute paths. Empty or missing `workspaceFolders` means no filtering.

- `src/sessionFiles.js`: shared provider utilities for recursive file scanning, mtime sorting, JSONL parsing, context percentage calculation, and cached last-matching-event reads.
- `src/codexUsage.js`: scans `~/.codex/sessions` for `rollout-*.jsonl`, reads the latest `token_count` event, and uses `last_token_usage.input_tokens / model_context_window`.
- `src/claudeUsage.js`: scans `~/.claude/projects` for `.jsonl`, reads the latest assistant `message.usage`, and infers the context window from the model name.
- `src/agentUsage.js`: aggregation and formatting layer. It reads provider candidates, selects the most recent `updatedAt`, and formats status bar text, tooltip text, severity, model details, and Codex rate-limit rows.
- `src/extension.js`: the only file that depends on the `vscode` API. It owns the status bar item, refresh timer, configuration reads, workspace folder extraction, and `agentTokenStatus.refresh`.

Provider contract:

```js
{
  provider,
  sessionFile,
  updatedAt,
  contextTokens,
  contextWindow,
  contextPercent,
  ...
}
```

New providers should implement that shape and be added to the candidate list in `src/agentUsage.js`. Formatting should remain in the aggregation layer.

## Coding Guidelines

- Keep parsing and formatting logic independent from the `vscode` API so it can be tested with Node's built-in test runner.
- Keep changes small and scoped to the requested behavior.
- Do not introduce a build system, bundler, or dependency unless the task explicitly requires it.
- Preserve public command ids and configuration keys such as `agentTokenStatus.refresh`, `agentTokenStatus.sessionsRoot`, `agentTokenStatus.claudeRoot`, and `agentTokenStatus.refreshIntervalMs`.
- When adding support for new Claude model context windows, update `inferClaudeContextWindow` in `src/claudeUsage.js`.
- Test fixtures should use `test/testUtils.js` helpers such as `makeTempDir`, `writeJsonl`, and `setMtime`.

## Verification

For behavior or parser changes, run:

```bash
npm test
```

For UI-facing text changes, update the matching expectations in `test/agentUsage.test.js` and verify the extension manually in VS Code when practical:

1. Run `Developer: Reload Window`.
2. Confirm the status bar shows the active provider and context percentage.
3. Hover the status bar item to inspect tooltip details.
4. Click the status bar item and confirm it refreshes without opening a notification.
