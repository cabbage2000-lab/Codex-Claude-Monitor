# 状态栏显示 Codex 5h / weekly 用量 — 设计

日期:2026-07-07

## 背景

状态栏当前只显示 `{provider} ⚡ {contextPercent}`(如 `Codex ⚡ 3%`)。Codex 的 5h / weekly
rate-limit 用量只在 tooltip 中可见。历史上状态栏曾带完整 rate-limit 段(`5H: 45% | Weekly: 23%`),
在 commit `5a248f4` 中被精简掉;`formatRateLimitsStatusBar` / `formatRateLimitShortLabel`
自此成为无调用、无测试的 dead code。

本次需求:把 5h / weekly 用量百分比以最极简形式加回状态栏。

## 目标效果

| 场景 | 状态栏文本 |
|------|-----------|
| Codex 活跃,双窗口数据齐全 | `Codex ⚡ 3% · 5h 45% · w 23%` |
| Codex 活跃,仅 primary 有数据 | `Codex ⚡ 3% · 5h 45%` |
| Codex 活跃,无 rate-limit 数据 | `Codex ⚡ 3%` |
| Claude 活跃(JSONL 无此数据) | `Claude ⚡ 18%`(不变) |

## 方案选择

- **A(采用)**:改造现有 dead code。`formatRateLimitShortLabel` 输出小写短标签,
  `formatRateLimitsStatusBar` 输出 `["5h 45%", "w 23%"]`,`formatAgentUsage` 用 ` · `
  拼接进状态栏文本。改动集中在 `src/agentUsage.js`,复用既有导出。
- B(否决):保留旧函数另写新函数——留下两份相似逻辑外加 dead code。

## 详细设计

全部改动位于 `src/agentUsage.js`:

1. `formatRateLimitShortLabel(minutes)`:
   - `>= 7*24*60` → `"w"`
   - `<= 24*60` → `` `${Math.round(minutes / 60)}h` ``(如 `5h`)
   - 其余 → `` `${Math.round(minutes / (24*60))}d` ``(如 `3d`)
2. `formatRateLimitsStatusBar(rateLimits)`:对 `[primary, secondary]` 逐个转换为
   `` `${label} ${Math.round(used_percent)}%` ``;`rateLimits` 为空或字段非法(`used_percent` /
   `window_minutes` 非有限数)时省略对应段,整体可返回 `[]`。
3. `formatAgentUsage`:状态栏文本改为
   `[`${provider} ⚡ ${contextPercent}`, ...formatRateLimitsStatusBar(usage.rateLimits)].join(" · ")`。

## 不变的部分

- Tooltip 保持现状(仍含带重置时间的完整行,如 `5h usage: 45% · Reset at 18:30`)。
- 状态栏颜色 / `getUsageSeverity` 仍只由 context percent 决定。
- `src/extension.js` 零改动(格式化只属于聚合层)。
- Provider 契约不变;Claude 侧无 `rateLimits` 字段,自然不显示。

## 测试

`test/agentUsage.test.js`:

- 反转 `"formatAgentUsage keeps Codex rate limits out of the status bar"` → 断言
  `Codex ⚡ 3% · 5h 45% · w 23%`,同时 tooltip 行为不变。
- 新增 `formatRateLimitsStatusBar` 单测:双窗口齐全、仅 primary、`null` / `{}`、字段非法。
- 既有 Claude 断言(text 不含 rate-limit 段)保持通过。

## 文档同步

- `CLAUDE.md` / `AGENTS.md` / `README.md` 中状态栏格式描述同步为新格式(此前每次状态栏
  格式变更均同步过:`45f84f1`、`f130ee7`、`1f94af9`)。
