# Claude 5h/weekly 用量:改用 statusline 桥接 — 设计

日期:2026-07-23

## 背景

`docs/specs/2026-07-07-claude-rate-limits-probe-design.md` 的探测方案(定期跑
`claude -p "/usage"` 解析文本)已失效。Claude CLI(实测 v2.1.218)改了 `-p "/usage"`
的非交互输出契约:旧格式的余量文本没了,变成一份"使用行为分析报告"
(Last 24h / Last 7d + 请求数、会话数、top skills/subagents),不含任何订阅
限额百分比或重置时间。`parseUsageOutput` 的两个正则(`Current session:` /
`Current week (all models):`)永远匹配不到,`latestClaudeRateLimits` 恒为 null,
状态栏余量段完全消失。

关键反转:2026-07-07 那份 spec 的前提是"statusline 输入**不含**余量"(故选
`-p` 探测);2026-07-23 复查发现反过来了 —— `-p` 不再吐余量,而 statusline
stdin **现在含** `rate_limits` 块。VS Code 扩展里 `/usage` 能显示余量,是因为
Claude Code 后端走 `GET /api/oauth/usage`(内部 `fetchUtilization`,用本地 OAuth
凭据),并把结果透传到 statusline 输入 —— 而 `claude -p` 单次调用不打这个 API。

数据契约(从 CLI 二进制内嵌的 statusline 输入 schema 注释确认):

```jsonc
"rate_limits": {             // Optional: Claude.ai subscription usage limits.
                             // Only present for subscribers after first API response.
  "five_hour": { "used_percentage": 0-100, "resets_at": <Unix秒> },  // 可能缺失
  "seven_day": { "used_percentage": 0-100, "resets_at": <Unix秒> }   // 可能缺失
}
```

CLI 二进制里甚至内置了官方 statusline 示例脚本
(`jq -r '.rate_limits.five_hour.used_percentage'`),说明这是官方明牌支持的
稳定通道。

## 目标效果

- 与探测方案的显示完全一致:`Claude $(comment) 18% · $(history) 27% · $(calendar) 51%`;
  tooltip 多出 `5h usage: …`、`Weekly usage: …` 行(含 Reset 倒计时)。
- 额外增加一行 `Usage updated 2m ago (11:58)`,标注余量快照的采集时间(因为
  statusline 只在跑 Claude Code 会话时更新缓存,数据可能偏旧)。
- 缓存不存在(未接入脚本、非订阅、会话尚无首个 API 响应):余量段与 tooltip
  行省略,只显 context 百分比。绝不影响主显示。
- 不再有 `claude -p` 探测进程:数据由 Claude Code 主动喂过来,零额外进程、
  不触发 Anthropic 限流。

## 组件设计

### 1. 辅助脚本 `scripts/usage-cache.sh`(statusline 桥接)

从 statusline stdin 读 JSON,用 `jq` 抽 `.rate_limits`,连同 `capturedAt`
(`date +%s`)原子写入 `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.usage-cache.json`
(写临时文件再 `mv`)。随后把 stdin 原样透传到 stdout,使已有 statusline
命令可管道串接。任何失败(无 `jq`、无 `rate_limits`、目录不可写)都被吞掉,
绝不让 statusline 渲染失败。接入方式:主脚本里后台管道
`printf '%s' "$input" | usage-cache.sh >/dev/null 2>&1 &`。

### 2. 新模块 `src/claudeStatuslineUsage.js`(纯逻辑层,不依赖 vscode)

- `CACHE_FILE_NAME = ".usage-cache.json"`;`getDefaultClaudeRoot()` 同 claudeUsage。
- `readClaudeStatuslineUsage(claudeRoot)`:读缓存文件,映射为与 Codex 同构的
  `{ primary, secondary }`——`five_hour` → `primary`(`window_minutes: 300`)、
  `seven_day` → `secondary`(10080),`used_percentage` → `used_percent`,
  `resets_at`(Unix 秒)透传。返回 `{ rateLimits, capturedAt }` 或 `null`。
- 容错:文件不存在/JSON 损坏/`rate_limits` 缺失 → `null`;某窗口缺失 → 省略;
  某窗口存在但 `used_percentage` 非数字 → 整体作废(返回 `null`),对齐
  "窗口要么良构要么不存在"的 provider 契约;窗口无 `resets_at` → 省略该字段。
- 按 (mtime, size) 缓存解析结果,同 `readLastMatchingEvent`。

### 3. `src/agentUsage.js`:聚合层 + 采集时间行

- `readLatestAgentUsage` 保留 `options.claudeRateLimits`(语义不变),新增
  `options.claudeRateLimitsCapturedAt`;Claude 胜出且附上 rateLimits 时,把
  capturedAt 挂为 `usage.rateLimitsCapturedAt`。
- 新增 `formatTimeAgo(sinceSeconds, now)`:过去时间相对量,`"just now"`(不足
  1 分钟或未来/时钟偏移)、`"2m ago"`、`"3h ago"`、`"1d ago"`,至多一个单位。
- 新增 `formatUsageCaptureRow`:当有余量行且 capturedAt 有效时,追加
  `Usage updated 2m ago (11:58)`(绝对时间复用 `formatResetTime`)。
- `formatAgentUsage`:余量行之后、仅当余量行非空时追加采集时间行。

### 4. `src/extension.js`:读缓存替代探测

- 移除探测相关:`probeTimer`、`getProbeIntervalMs`、`probeClaude`、
  `startProbeTimer`、`latestClaudeRateLimits`,及 `claude -p` 首次探测调用。
- `readUsage()`:每次刷新调 `readClaudeStatuslineUsage(claudeRoot)`(轻量文件
  读,无需独立定时器),把 `rateLimits` / `capturedAt` 传给 `readLatestAgentUsage`。
- `WATCHED_SETTINGS` 移除 `claudeUsageProbeIntervalMs` / `claudeCliPath`。

### 5. 移除 `src/claudeRateLimits.js` 与配置项

删除该模块及 `test/claudeRateLimits.test.js`;`package.json` 移除
`agentTokenStatus.claudeUsageProbeIntervalMs` / `claudeCliPath` 两个配置项声明。

## 测试

- `test/claudeStatuslineUsage.test.js`(新):映射(five_hour/seven_day →
  primary/secondary + 窗口分钟数);容错(文件缺失、JSON 损坏、`rate_limits`
  缺失、单窗口缺失、无 resets_at、非数字 percent);mtime+size 缓存失效。
- `test/agentUsage.test.js`:`formatTimeAgo` 各档位与未来/非法值;有余量时追加
  采集时间行、无余量时不追加;`readLatestAgentUsage` 挂 capturedAt。
- `test/extension.test.js`:mock 由 `./claudeRateLimits` 改为 `./claudeStatuslineUsage`。

## 文档同步

CLAUDE.md:`claudeRateLimits.js` 条目替换为 `claudeStatuslineUsage.js` +
`scripts/usage-cache.sh`;agentUsage / extension 条目更新数据来源与采集时间行。
README.md:状态栏说明改为 statusline 来源;新增「Claude subscription limits」
章节讲接入;配置表移除两个废弃项。旧探测 spec/plan 保留作决策历史。
