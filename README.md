# Agent Token Status

一个本地 VS Code 扩展，用来在状态栏显示 Codex 或 Claude Code 当前会话的 token 和上下文使用情况。

扩展会同时检查 Codex 与 Claude Code 的本地 session 文件。哪个 session 文件最近更新，就显示哪个工具的上下文占用。

## 显示内容

状态栏会显示类似下面的内容：

```text
Codex 13%
Claude 18%
```

- 状态栏只显示来源和上下文占用百分比，尽量减少干扰。
- 只统计工作目录落在当前 VS Code workspace 内的会话；在其他目录开的 CLI 会话不会被显示。没有打开文件夹（空窗口）时不过滤，显示全局最新会话。
- Codex 的百分比来自最近一次请求的 `input_tokens / model_context_window`。
- Claude Code 的百分比来自最近一次 assistant usage 的 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，再除以推断出的上下文窗口。
- 鼠标悬停在状态栏项上，可以看到一行 context 明细，例如 `Codex: Context 136k / 258k (53%)` 或 `Claude: Context 185k / 1m (18%)`。

## 本地安装

把这个目录链接到 VS Code 的扩展目录：

```bash
ln -s /Users/blingabc/PycharmProjects/agent-token-status ~/.vscode/extensions/agent-token-status
```

然后在 VS Code 命令面板执行：

```text
Developer: Reload Window
```

重载后，状态栏右侧会出现 Codex 或 Claude Code token 使用情况。也可以在命令面板执行：

```text
Agent Token Status: Refresh
```

手动刷新一次。

## 设置项

- `agentTokenStatus.sessionsRoot`：可选的 Codex sessions 目录。默认读取 `~/.codex/sessions`。
- `agentTokenStatus.claudeRoot`：可选的 Claude Code home 目录。默认读取 `~/.claude`。
- `agentTokenStatus.refreshIntervalMs`：自动刷新间隔，默认 `5000` 毫秒。

## 数据来源

扩展会读取 Codex 生成的 session JSONL 文件，路径通常在：

```text
~/.codex/sessions
```

它会从最新的 `rollout-*.jsonl` 文件中读取最后一个 `token_count` 事件。

扩展也会读取 Claude Code 生成的 session JSONL 文件，路径通常在：

```text
~/.claude/projects
```

它会从最新的 Claude Code session 文件中读取最后一条 assistant `message.usage`。
