# Workspace 过滤设计

日期：2026-06-03

## 目标

状态栏只显示工作目录（cwd）落在当前 VS Code workspace 内的 agent 会话，避免外部 CLI 在其他目录开的会话干扰显示。

## 匹配规则

- session 的 cwd 等于某个 workspace 文件夹，或是其子目录（路径前缀匹配，按路径分隔符边界）即算匹配。
- 多 root workspace：任一文件夹匹配即可。

## 实现

### 接口变化

`readLatestAgentUsage({ codexSessionsRoot, claudeRoot, workspaceFolders })` 新增可选 `workspaceFolders`（绝对路径数组）：

- 不传 / 空数组 → 不过滤，保持现有全局行为。
- 解析层（codexUsage / claudeUsage / agentUsage）继续不依赖 `vscode` API。
- `extension.js` 从 `vscode.workspace.workspaceFolders` 取路径传入。

### Claude Code（claudeUsage.js）

session 按 cwd 分目录存储于 `~/.claude/projects/<munged-cwd>/`（路径中非字母数字字符替换为 `-`）。把 workspace 路径做同样 munge，只扫描目录名等于 munged 路径或以 `<munged>-` 为前缀的 project 文件夹。无需读文件内容即可过滤。

### Codex（codexUsage.js）

rollout 文件按日期目录存储，cwd 在文件第一行 `session_meta.payload.cwd`。候选文件按 mtime 降序排列后，逐个只读第一行解析 cwd，命中即停。

## 边界情况

- 空窗口（无 workspace 文件夹）→ 不过滤，保持现状。
- workspace 内无匹配 session → 显示现有 `n/a`。
- session_meta 缺失或解析失败的 Codex 文件 → 视为不匹配（过滤模式下跳过）。

## 测试

- cwd 在 workspace 内 / 外的过滤行为（Codex、Claude 各自）。
- munged 目录名前缀匹配（含子目录会话）。
- 多 root workspace 任一匹配。
- 不传 workspaceFolders 时行为不变（已有用例回归）。
