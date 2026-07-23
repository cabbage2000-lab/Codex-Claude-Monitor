# Codex Claude Context Monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-node%20--test-success.svg)](test/)

Codex-Claude-Monitor is a VS Code extension that tracks context usage for the current Codex **or** Claude Code session right in the status bar.

The extension reads local session files for both Codex and Claude Code, then displays whichever tool was active most recently. It makes **no network requests** — everything is computed from files already on your machine.

## Features

- **Unified status bar item** for both Codex and Claude Code. The provider whose session file was updated most recently wins, so you never have to switch anything manually.
- **Color-coded warnings** that adapt to your theme as context fills up:
  - 🟢 green below 50%
  - 🟡 yellow at 50–79%
  - 🔴 red at 80% and above
- **Minimal, icon-based status bar** showing the active provider, context percentage, and (for Codex) compact 5h/weekly usage via codicon icons, so it stays compact and language-neutral.
- **Detailed hover tooltip** with exact token counts, the friendly model name, Claude token composition and cache-hit rate, and 5-hour / weekly rate-limit usage for both providers with the reset time and a relative countdown.
- **Workspace-aware filtering** — only sessions whose working directory lives inside your current VS Code workspace are counted, so CLI sessions from other projects are ignored.
- **Click to refresh** immediately, plus automatic refresh on a configurable interval.
- **Handoff above 50%** — when context exceeds 50%, a `Handoff` entry appears beside the status bar. Click it to copy a compact continuation prompt (context %, session file, branch, plus a minimal Task/Done/Next/Constraints skeleton) to the clipboard, so a fresh session can pick up where this one left off.

## Display

The status bar shows compact text such as:

```text
Codex $(comment) 13% · $(history) 45% · $(calendar) 23%
Claude $(comment) 18% · $(history) 25% · $(calendar) 8%
```

- The leading label is the active provider, followed by `$(comment)` (a speech-bubble icon marking the current session) and the context usage percentage.
- Both providers append compact rate-limit segments using codicon icons: `$(history)` is the 5-hour window and `$(calendar)` is the weekly window. Codex reads them from its session files. For Claude they come from the statusline usage cache written by `scripts/usage-cache.sh` (see [Claude subscription limits](#claude-subscription-limits) below). Until that cache exists, the Claude segments are omitted. Icons replace letter abbreviations (`5h`/`w`) so the bar reads the same in any language.
- The friendly model name (e.g. `Opus 4.8`) and rate-limit reset times (with a relative countdown) stay in the hover tooltip.
- The item color reflects context-usage severity (green / yellow / red, see above).
- Codex percentages come from `input_tokens / model_context_window` for the latest request.
- Claude Code percentages come from `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, divided by the inferred context window.

Hover the status bar item to see full detail. Both providers show 5-hour and weekly usage with the reset time and how long remains; Claude adds the friendly model name plus token composition and cache-hit rate:

```text
Codex: ctx 136k / 258k (53%)
5h usage: 21% · Reset at 14:32 (in 2h 32m)
Weekly usage: 10% · Reset at 6/8 09:24 (in 4d 21h)
```

```text
Claude: ctx 36k / 1m (18%)
Model: Opus 4.8 (1M context)
Tokens: input 2 · cache read 36k · cache create 411
Cache hit: 100%
5h usage: 32% · Reset at 16:39 (in 38m)
Weekly usage: 10% · Reset at 7/14 00:59 (in 8h 58m)
```

Once a reset time has passed (stale session data), the countdown is omitted and only the absolute time remains.

Click the status bar item to refresh immediately without opening a notification. Detailed usage always stays in the hover tooltip.

### Handoff (context above 50%)

When context usage exceeds 50%, a second status bar item appears just beside the main one:

```text
$(export) Handoff
```

Click it to copy a paste-ready **handoff (continuation) prompt** to the clipboard. It keeps only what a fresh session can't infer — why you're handing off and where to continue — and trusts the model to fill in the rest:

```text
Continue this work in a fresh context (previous session at 85%).

Session: /home/u/.claude/projects/proj/abc.jsonl
Branch: main

Task: <one-line goal>
Done: <completed work — do not redo>
Next: <where it stopped + immediate next step>
Constraints: <locked decisions / scope>
```

Paste it into a fresh (or the current) session and the Claude there fills in each placeholder from the session history. Surfacing the suffix is the only automatic behavior; **generating and copying the prompt is strictly user-triggered** — nothing is copied or sent until you click.

## Installation

**From the Marketplace.** Search for "Codex-Claude-Monitor" in the Extensions view, or run this in the Command Palette (`Ctrl/Cmd+Shift+P`):

```text
ext install jialei2005.codex-claude-ctx-monitor
```

**From source (development).** Link this directory into the VS Code extensions directory:

```bash
ln -s /path/to/codex-claude-monitor ~/.vscode/extensions/codex-claude-monitor
```

Then reload the window via the Command Palette (`Developer: Reload Window`). After reload, Codex or Claude Code context usage appears on the right side of the status bar. You can also trigger commands manually at any time:

```text
Codex-Claude-Monitor: Refresh
Codex-Claude-Monitor: Handoff
```

`Refresh` re-reads usage immediately. `Handoff` copies the handoff prompt to the clipboard whether or not context has exceeded 50%, so you can generate one on demand.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `agentTokenStatus.sessionsRoot` | `~/.codex/sessions` | Optional absolute path to the Codex sessions directory. Leave empty to use the default. |
| `agentTokenStatus.claudeRoot` | `~/.claude` | Optional absolute path to the Claude Code home directory. Leave empty to use the default. |
| `agentTokenStatus.refreshIntervalMs` | `10000` | How often (in milliseconds, minimum `1000`) to re-read usage from local session files. |

Changing any of these settings refreshes the status bar and restarts the refresh timer immediately.

## Claude subscription limits

The Claude 5-hour and weekly rate-limit segments come from Claude Code's **status line** input, not from any CLI probe. Claude Code passes a JSON blob (including a `rate_limits` block for subscribers) on stdin to the configured status line command; the bundled helper `scripts/usage-cache.sh` snapshots that block to `~/.claude/.usage-cache.json`, and the extension reads it on each refresh.

To enable the segments, pipe your status line input through the helper. If you have no status line yet, set one in `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "~/.claude/statusline-command.sh" }
}
```

Then in that script, pass stdin through the helper (adjust the path to where this extension lives):

```bash
#!/bin/bash
input=$(cat)

# Snapshot subscription rate limits for the status bar (background, best-effort).
HELPER="$HOME/.vscode/extensions/codex-claude-monitor/scripts/usage-cache.sh"
[ -x "$HELPER" ] && printf '%s' "$input" | "$HELPER" >/dev/null 2>&1 &

# ... your existing status line rendering, reusing "$input" ...
```

Notes:

- The `rate_limits` block is only present for Claude.ai subscribers, and only after the first API response of a session — so the segments appear once you have sent at least one message.
- The cache updates only while a Claude Code session is running its status line. The tooltip shows a `Usage updated …` line so you can see how fresh the numbers are.
- The helper never fails your status line: a missing `jq`, absent `rate_limits`, or unwritable directory just skips the snapshot.

## How It Works

Data flows from local session JSONL files → provider parsers (with workspace filtering) → most recently active provider → status bar.

**Codex.** The extension recursively scans `~/.codex/sessions` for `rollout-*.jsonl`, picks the newest file by modification time, and reads the last `token_count` event. Files are matched to your workspace by reading each candidate's `session_meta.payload.cwd`.

```text
~/.codex/sessions
```

**Claude Code.** The extension recursively scans `~/.claude/projects` for `.jsonl` files, tries the newest ones (skipping files without an assistant entry, such as usage-probe sessions), and reads the last `type: "assistant"` entry that carries `message.usage`. The context window is inferred from the model name (model names containing `1m` or `fable`, or `claude-opus-4-7` / `claude-opus-4-8`, use 1M; everything else uses 200k). If the observed context tokens already exceed the inferred window, the window upgrades to 1M so the percentage stays meaningful for unlisted big-window models. Workspace filtering uses Claude's munged directory names, so files don't even need to be open.

```text
~/.claude/projects
```

Sessions whose working directory is outside the current workspace are ignored. An empty window disables workspace filtering and shows the latest global session.

## Privacy

The extension **only reads local session files**. It does not make network requests, upload data, or collect telemetry.
