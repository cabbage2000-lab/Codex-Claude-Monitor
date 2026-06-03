# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

本地 VS Code 扩展（不发布到市场），在状态栏显示 Codex 或 Claude Code 当前会话的 token/上下文使用百分比。纯 CommonJS，无构建步骤、无依赖（仅用 Node 内置模块和 `vscode` API）。

## 常用命令

```bash
# 运行所有测试（Node 内置 test runner，无需 npm install）
npm test

# 运行单个测试文件
node --test test/claudeUsage.test.js
```

本地安装方式：把项目目录软链接到 `~/.vscode/extensions/agent-token-status`，然后在 VS Code 执行 `Developer: Reload Window`（见 README.md）。

## 架构

数据流：本地 session JSONL 文件 → 各 provider 解析模块（按 workspace 过滤）→ 聚合选最新 → 状态栏。

Workspace 过滤：`readLatestAgentUsage` 接受可选 `workspaceFolders`（绝对路径数组），只统计 cwd 落在 workspace 内（含子目录）的会话；空数组则不过滤。Claude 通过 munged 目录名（非字母数字字符替换为 `-`，前缀匹配）过滤，无需读文件；Codex 按 mtime 降序逐个读文件第一行的 `session_meta.payload.cwd` 判断，命中即停。设计文档见 `docs/specs/2026-06-03-workspace-filter-design.md`。

- `src/sessionFiles.js` — provider 共享的工具层：递归扫描（`walkFiles`，传入文件名过滤函数）、mtime 降序排序、`parseJsonLine`、`calculateContextPercent`、`readLastMatchingEvent`（逐行解析 JSONL 取最后一条命中记录，按 mtime+size 缓存避免每次刷新重读未变化的文件）。
- `src/codexUsage.js` — 递归扫描 `~/.codex/sessions` 下的 `rollout-*.jsonl`，取 mtime 最新的文件，读取最后一个 `token_count` 事件。百分比 = `last_token_usage.input_tokens / model_context_window`。
- `src/claudeUsage.js` — 递归扫描 `~/.claude/projects` 下的 `.jsonl`，取最新文件，读取最后一条 `type: "assistant"` 且带 `message.usage` 的记录。上下文 token = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`；上下文窗口由模型名推断（`inferClaudeContextWindow`：含 "1m" 或 claude-opus-4-7/4-8 → 1M，否则 200k）。
- `src/agentUsage.js` — 聚合层：同时读取两个 provider，按 `updatedAt` 选最近活跃的一个，并格式化状态栏文本/tooltip（多行：上下文行 → 模型行 → rate limit 行；Codex 的 5h/周用量由 `formatRateLimits` 格式化）。
- `src/extension.js` — VS Code 入口：唯一依赖 `vscode` API 的文件。负责状态栏项、定时刷新（默认 5s）、配置读取（`agentTokenStatus.sessionsRoot` / `claudeRoot` / `refreshIntervalMs`）和 `agentTokenStatus.refresh` 命令（点击状态栏项时刷新，并把 tooltip 多行内容以 ` · ` 拼接显示在信息提示中）。

Provider 契约：每个 provider 的 `readLatestXxxUsage(root, workspaceFolders)` 返回统一结构 `{ provider, sessionFile, updatedAt, contextTokens, contextWindow, contextPercent, ... }`（Codex 的 `updatedAt` 用文件 mtime，Claude 用消息 timestamp）。新增 provider 时实现该契约，并在 `agentUsage.js` 的 candidates 数组里追加一项；格式化只发生在聚合层（`formatAgentUsage` / `formatCount` / `formatRateLimits`）。

关键设计：解析逻辑（sessionFiles / codexUsage / claudeUsage / agentUsage）与 `vscode` API 完全解耦，因此可以直接用 Node test runner 测试，无需 VS Code 测试环境。测试通过 `test/testUtils.js`（`makeTempDir` / `writeJsonl` / `setMtime`）写临时 JSONL fixture 来验证解析与选择逻辑。

新增模型的上下文窗口支持时，修改 `claudeUsage.js` 的 `inferClaudeContextWindow`。
