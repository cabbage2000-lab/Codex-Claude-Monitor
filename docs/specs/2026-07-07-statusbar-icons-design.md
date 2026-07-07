# 状态栏图标化 — 设计

日期:2026-07-07

## 背景

状态栏当前文本为 `{provider} ⚡ {ctx}% · 5h {p}% · w {p}%`(如 `Codex ⚡ 3% · 5h 45% · w 23%`,格式定义见 [2026-07-07-statusbar-rate-limits-design.md](./2026-07-07-statusbar-rate-limits-design.md))。其中:

- `⚡` 是 emoji,在不同操作系统 / 主题下渲染不一致;
- `5h` / `w` / `Nd` 是字母缩写,跨语言可读性差(非英文用户未必理解 `w` = week)。

VS Code 状态栏原生支持 codicon `$(name)` 语法,不支持自定义 SVG。图标语义跨语言,优于字母缩写。

## 目标

把状态栏**单行**的三类标签从「emoji + 字母缩写」改为「codicon 图标」,提升跨语言一致性与主题适配。设计理念:**图标语义 > 字母缩写**。

## 图标映射

| 段 | 现状 | 图标 | 语义 |
|---|---|---|---|
| 会话上下文占比 | emoji `⚡` | `$(comment)` | 对话气泡 = 当前会话 |
| 小时级窗口(≤24h,如 5h) | `5h` | `$(history)` | 时钟 = 近期时间窗 |
| 多日及以上窗口(>24h,含周、Nd) | `w` / `Nd` | `$(calendar)` | 日历 = 多日窗 |

**provider 标识(`Codex` / `Claude`)保留品牌文字**:品牌名是中英文通用写法,不属于「字母缩写」,不违背跨语言目标;同时避免依赖 `claude` / `openai` 这两个 codicon 较新加入的图标(老版 VS Code 渲染不出会变空白方块)。

**N 天中间档**(原 `Nd`,窗口在 24h–7d 之间)归入 `$(calendar)`:「多日」语义上更接近日历,避免为罕见档位引入第三种图标。于是窗口图标只有两档:小时级 → `$(history)`,多日及以上 → `$(calendar)`。

## 目标效果

| 场景 | 状态栏文本 |
|------|-----------|
| Codex 双窗口齐全 | `Codex $(comment) 3% · $(history) 45% · $(calendar) 23%` |
| 仅 primary 有数据 | `Codex $(comment) 3% · $(history) 45%` |
| 无 rate-limit 数据 | `Codex $(comment) 3%` |
| Claude(probe 注入) | `Claude $(comment) 50% · $(history) 25% · $(calendar) 8%` |

段省略规则不变:缺数据即省略对应段。

## 详细设计

全部改动位于 `src/agentUsage.js`(聚合层),`extension.js` 零改动:

1. **新增内部函数** `rateLimitWindowIcon(minutes)`:返回 `$(history)`(`minutes <= 24*60`)或 `$(calendar)`(其余)。替代原 `formatRateLimitShortLabel` 的字母逻辑。
2. **删除内部函数** `formatRateLimitShortLabel`:字母缩写不再需要;它未被导出,仅 `formatRateLimitsStatusBar` 内部调用。
3. **`formatRateLimitsStatusBar(rateLimits)`**:段格式由 `` `${label} ${p}%` `` 改为 `` `${icon} ${p}%` ``,即 `$(history) 45%` / `$(calendar) 23%`。函数签名、导出名、段省略规则(`rateLimits` 为空或 `used_percent` / `window_minutes` 非有限数时省略对应段、整体可返回 `[]`)不变。
4. **`formatAgentUsage`**:`textParts` 首段由 `` `${provider} ⚡ ${contextPercent}` `` 改为 `` `${provider} $(comment) ${contextPercent}` ``;` · ` 分隔保留。

## 不变的部分

- **Tooltip**:保持纯文字多行,含完整词(`5h usage` / `Weekly usage`)与重置时间。图标化只针对状态栏单行;tooltip 空间足,完整词跨语言性可接受。
- **状态栏颜色 / `getUsageSeverity`**:仍只由 context percent 决定。
- **Error 态** `$(pulse) ctx: error`(`extension.js`):不涉及上述三图标,无冲突,不动。
- **Handoff 项** `$(export) Handoff`:不动。
- **tooltip 函数** `formatRateLimits` / `formatRateLimitWindow` / `formatResetTime`:不动。
- **Provider 契约**不变。

## 测试

`test/agentUsage.test.js` 期望值更新(字母/emoji → 图标),tooltip 断言不变:

- `formatAgentUsage` 各 text 断言:
  - `"Codex ⚡ 3%"` → `"Codex $(comment) 3%"`
  - `"Claude ⚡ 18%"` → `"Claude $(comment) 18%"`
  - `"Codex ⚡ 3% · 5h 21% · w 10%"` → `"Codex $(comment) 3% · $(history) 21% · $(calendar) 10%"`
  - `"Claude ⚡ 50%"` → `"Claude $(comment) 50%"`
  - Claude rate-limits 正则 `/^Claude ⚡ \d+% · 5h 25% · w 8%$/` → `/^Claude \$\(comment\) \d+% · \$\(history\) 25% · \$\(calendar\) 8%$/`(正则中 `$` 转义)
- `formatRateLimitsStatusBar` 断言:
  - `["5h 45%", "w 23%"]` → `["$(history) 45%", "$(calendar) 23%"]`
  - `["2d 56%"]`(N 天档)→ `["$(calendar) 56%"]`
  - `null` / `{}` / 字段非法 → `[]`:不变
- tooltip 断言(如 `5h usage: 21% · Reset at 14:32`):不变

## 文档同步

`CLAUDE.md` / `AGENTS.md` / `README.md` 中状态栏格式描述(当前 `Codex ⚡ 3% · 5h 45% · w 23%` 等)同步为图标版。延续此前每次状态栏格式变更同步文档的惯例(见 `45f84f1`、`f130ee7`、`1f94af9`、以及本日的 rate-limits 设计)。
