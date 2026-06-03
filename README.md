# Context Meter

Context Meter is a VS Code extension that tracks context usage for the current Codex or Claude Code session in the status bar.

The extension checks local session files for both Codex and Claude Code. It displays the tool whose session file was updated most recently.

## Display

The status bar shows compact text like:

```text
Codex 13%
Claude 18%
```

- The status bar only shows the provider and context usage percentage to stay unobtrusive.
- Only sessions whose working directory is inside the current VS Code workspace are counted. CLI sessions from other directories are ignored. Empty windows do not filter by workspace and show the latest global session.
- Codex percentages come from `input_tokens / model_context_window` for the latest request.
- Claude Code percentages come from `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, divided by the inferred context window.
- Hover the status bar item to see more detail. Codex shows 5-hour and weekly usage with reset times; Claude shows the model name:

  ```text
  Codex: Context 136k / 258k (53%)
  5h usage: 21% · Reset at 14:32
  Weekly usage: 10% · Reset at 6/8 09:24
  ```

- Click the status bar item to refresh immediately. Detailed usage remains available from the hover tooltip.

## Local Installation

Link this directory into the VS Code extensions directory:

```bash
ln -s /path/to/context-meter ~/.vscode/extensions/context-meter
```

Then run this command from the VS Code command palette:

```text
Developer: Reload Window
```

After reload, Codex or Claude Code token usage appears on the right side of the status bar. You can also run:

```text
Context Meter: Refresh
```

to refresh manually.

## Settings

- `agentTokenStatus.sessionsRoot`: optional Codex sessions directory. Defaults to `~/.codex/sessions`.
- `agentTokenStatus.claudeRoot`: optional Claude Code home directory. Defaults to `~/.claude`.
- `agentTokenStatus.refreshIntervalMs`: automatic refresh interval. Defaults to `5000` milliseconds.

## Data Sources

The extension reads Codex session JSONL files, usually under:

```text
~/.codex/sessions
```

It reads the last `token_count` event from the latest `rollout-*.jsonl` file.

The extension also reads Claude Code session JSONL files, usually under:

```text
~/.claude/projects
```

It reads the last assistant `message.usage` entry from the latest Claude Code session file.

## Privacy

The extension **only reads local session files**. It does not make network requests, upload data, or collect data.
