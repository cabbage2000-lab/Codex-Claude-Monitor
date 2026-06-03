# 状态栏悬停/点击显示 5h 与周用量 — 设计文档

日期：2026-06-03

## 背景与目标

状态栏目前只显示 `Provider NN%`，悬停 tooltip 为单行上下文信息，点击仅刷新并弹 "refreshed" 提示。目标：悬停和点击时能看到类似 Claude Code `/status` 的更多信息——**最近 5 小时用量**和**周用量**。

## 数据来源调研结论

- **Codex**：session JSONL 的 `token_count` 事件已包含 `rate_limits`：
  - `primary`：`{ used_percent, window_minutes: 300, resets_at }` — 5 小时窗口
  - `secondary`：`{ used_percent, window_minutes: 10080, resets_at }` — 7 天窗口
  - `resets_at` 为 unix 秒时间戳。`codexUsage.js` 已将其作为 `rateLimits` 返回，无需改 provider。
- **Claude**：session JSONL 与 `~/.claude` 本地缓存中**没有** 5h/周用量数据（`/status` 是实时调 OAuth usage API 取得）。本期不引入网络请求与 Keychain 访问（方案 A），Claude 不显示 5h/周用量。

## 设计

### 1. `src/agentUsage.js` — 格式化扩展

- `formatAgentUsage` 的 tooltip 从单行改为多行字符串（状态栏 tooltip 原生支持 `\n`，无需 MarkdownString）：

  ```
  Codex: Context 45k / 258k (17%)
  5h 用量: 21% · 重置于 14:32
  周用量: 10% · 重置于 6/8 09:24
  ```

- 新增 `formatRateLimits(rateLimits, now)`：
  - `primary` 窗口：`window_minutes` ≤ 24×60 → 标签 `${小时数}h 用量`（300 分钟 → `5h 用量`）；
  - `secondary` 窗口：`window_minutes` ≥ 7×24×60 → 标签 `周用量`；其他时长按 `${天数}d 用量` 兜底；
  - `resets_at`（unix 秒）：与 `now` 同一天显示 `HH:mm`，跨天显示 `M/D HH:mm`；
  - `now` 参数可注入，便于测试确定性。
- Claude tooltip：保持现有上下文行，外加一行模型名（`模型: claude-opus-4-8`），不显示 5h/周。
- 解析/格式化层继续零 `vscode` 依赖。

### 2. `src/extension.js` — 点击行为

- `agentTokenStatus.refresh` 命令：刷新后将 tooltip 同样的详情内容（单行拼接，` · ` 分隔换行）显示在 `showInformationMessage` 中，替代 "refreshed" 文案；无数据时提示未找到会话。

### 3. 错误处理

- `rateLimits` 为空对象、缺 `used_percent` 或缺对应窗口时，直接省略对应行，不显示 "n/a" 噪音。

### 4. 测试

`test/agentUsage.test.js` 新增：

- `formatRateLimits`：5h 窗口、周窗口、空/缺字段省略、未知窗口时长兜底、当天与跨天的重置时间格式。
- 带 `rateLimits` 的 Codex usage → tooltip 多行断言。
- Claude usage → tooltip 含模型名、不含用量行断言。

## 不做的事（YAGNI）

- 不调 Anthropic OAuth usage API（方案 B），Claude 的 5h/周用量留待将来需要时再加。
- 不引入 MarkdownString / QuickPick 菜单。
- 不改 provider 契约。
