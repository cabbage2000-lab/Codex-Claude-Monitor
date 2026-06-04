# Codex-Claude-Monitor

Codex-Claude-Monitor is a VS Code extension that tracks context usage for the current Codex **or** Claude Code session right in the status bar.

The extension reads local session files for both Codex and Claude Code, then displays whichever tool was active most recently. It makes **no network requests** — everything is computed from files already on your machine.

## Features

- **Unified status bar item** for both Codex and Claude Code. The provider whose session file was updated most recently wins, so you never have to switch anything manually.
- **Color-coded warnings** that adapt to your theme as context fills up:
  - 🟢 green below 50%
  - 🟡 yellow at 50–79%
  - 🔴 red at 80% and above
- **Codex rate-limit segments** in the status bar. When Codex reports usage, the 5-hour and weekly windows are shown alongside the context percentage.
- **Detailed hover tooltip** with exact token counts, the model name, and rate-limit reset times.
- **Workspace-aware filtering** — only sessions whose working directory lives inside your current VS Code workspace are counted, so CLI sessions from other projects are ignored.
- **Click to refresh** immediately, plus automatic refresh on a configurable interval.

## Display

The status bar shows compact text such as:

```text
Codex ⚡ Context 13% | 5H: 45% | Weekly: 23%
Claude ⚡ Context 18%
```

- The leading label is the active provider, followed by the context usage percentage.
- For Codex, the 5-hour (`5H`) and weekly (`Weekly`) rate-limit windows are appended when available.
- The item color reflects context-usage severity (green / yellow / red, see above).
- Codex percentages come from `input_tokens / model_context_window` for the latest request.
- Claude Code percentages come from `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, divided by the inferred context window.

Hover the status bar item to see full detail. Codex shows 5-hour and weekly usage with reset times; Claude shows the model name:

```text
Codex: Context 136k / 258k (53%)
5h usage: 21% · Reset at 14:32
Weekly usage: 10% · Reset at 6/8 09:24
```

```text
Claude: Context 36k / 200k (18%)
Model: claude-opus-4-8
```

Click the status bar item to refresh immediately without opening a notification. Detailed usage always stays in the hover tooltip.

## Local Installation

This extension is meant for local use and is not published to the marketplace. Link this directory into the VS Code extensions directory:

```bash
ln -s /path/to/codex-claude-monitor ~/.vscode/extensions/codex-claude-monitor
```

Then run this command from the VS Code command palette:

```text
Developer: Reload Window
```

After reload, Codex or Claude Code context usage appears on the right side of the status bar. You can also trigger a manual refresh at any time:

```text
Codex-Claude-Monitor: Refresh
```

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `agentTokenStatus.sessionsRoot` | `~/.codex/sessions` | Optional absolute path to the Codex sessions directory. Leave empty to use the default. |
| `agentTokenStatus.claudeRoot` | `~/.claude` | Optional absolute path to the Claude Code home directory. Leave empty to use the default. |
| `agentTokenStatus.refreshIntervalMs` | `10000` | How often (in milliseconds, minimum `1000`) to re-read usage from local session files. |

Changing any of these settings refreshes the status bar and restarts the refresh timer immediately.

## How It Works

Data flows from local session JSONL files → provider parsers (with workspace filtering) → most recently active provider → status bar.

**Codex.** The extension recursively scans `~/.codex/sessions` for `rollout-*.jsonl`, picks the newest file by modification time, and reads the last `token_count` event. Files are matched to your workspace by reading each candidate's `session_meta.payload.cwd`.

```text
~/.codex/sessions
```

**Claude Code.** The extension recursively scans `~/.claude/projects` for `.jsonl` files, picks the newest, and reads the last `type: "assistant"` entry that carries `message.usage`. The context window is inferred from the model name (model names containing `1m`, or `claude-opus-4-7` / `claude-opus-4-8`, use 1M; everything else uses 200k). Workspace filtering uses Claude's munged directory names, so files don't even need to be open.

```text
~/.claude/projects
```

Sessions whose working directory is outside the current workspace are ignored. An empty window disables workspace filtering and shows the latest global session.

## Privacy

The extension **only reads local session files**. It does not make network requests, upload data, or collect telemetry.
