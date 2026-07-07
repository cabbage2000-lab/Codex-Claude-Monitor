# 状态栏极简显示 Codex 5h/weekly 用量 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 状态栏文本在 Codex 会话时追加紧凑的 5h / weekly 用量段:`Codex ⚡ 3% · 5h 45% · w 23%`。

**Architecture:** 全部逻辑改动集中在聚合层 `src/agentUsage.js`:改造现有 dead code `formatRateLimitShortLabel`(短标签改为 `5h`/`w`/`Nd`)与 `formatRateLimitsStatusBar`(段格式 `5h 45%`),`formatAgentUsage` 用 ` · ` 把段拼进状态栏文本。Claude 无 `rateLimits` 数据,自然不显示;tooltip、severity、`extension.js` 均不变。

**Tech Stack:** 纯 CommonJS + Node 内置 test runner(`npm test`),无依赖、无构建步骤。

**Spec:** `docs/specs/2026-07-07-statusbar-rate-limits-design.md`

---

### Task 1: `formatRateLimitsStatusBar` 输出紧凑短标签段

**Files:**
- Modify: `src/agentUsage.js:132-160`(`formatRateLimitShortLabel` + `formatRateLimitsStatusBar`)
- Test: `test/agentUsage.test.js`

- [ ] **Step 1: 写失败测试**

`test/agentUsage.test.js` 顶部 import 增加 `formatRateLimitsStatusBar`:

```js
const {
  formatAgentUsage,
  formatClaudeTokenDetail,
  formatModelName,
  formatRateLimits,
  formatRateLimitsStatusBar,
  getUsageSeverity,
  readLatestAgentUsage,
} = require("../src/agentUsage");
```

在 `test("formatRateLimits falls back to day label for mid-length windows", ...)` 之后新增三个测试:

```js
test("formatRateLimitsStatusBar renders compact segments for both windows", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 45.4, window_minutes: 300 },
    secondary: { used_percent: 23.0, window_minutes: 10080 },
  });
  assert.deepEqual(segments, ["5h 45%", "w 23%"]);
});

test("formatRateLimitsStatusBar falls back to day label for mid-length windows", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 55.6, window_minutes: 2880 },
  });
  assert.deepEqual(segments, ["2d 56%"]);
});

test("formatRateLimitsStatusBar omits missing or invalid windows", () => {
  assert.deepEqual(formatRateLimitsStatusBar(null), []);
  assert.deepEqual(formatRateLimitsStatusBar({}), []);
  assert.deepEqual(
    formatRateLimitsStatusBar({
      primary: { used_percent: NaN, window_minutes: 300 },
      secondary: { used_percent: 10, window_minutes: undefined },
    }),
    [],
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 前两个新测试 FAIL(现实现输出 `["5H: 45%", "Weekly: 23%"]` / `["2d: 56%"]`);第三个(空值省略)本就满足,PASS。

- [ ] **Step 3: 最小实现**

`src/agentUsage.js` 中替换这两个函数(仅标签与段格式变化,判空逻辑不变):

```js
// Short status-bar label for a rate-limit window: 5h -> "5h", weekly -> "w", else "Nd".
function formatRateLimitShortLabel(minutes) {
  if (minutes >= 7 * 24 * 60) {
    return "w";
  }
  if (minutes <= 24 * 60) {
    return `${Math.round(minutes / 60)}h`;
  }
  return `${Math.round(minutes / (24 * 60))}d`;
}

// Compact status-bar rate-limit segments, e.g. ["5h 45%", "w 23%"]. Missing fields omit the segment.
function formatRateLimitsStatusBar(rateLimits) {
  if (!rateLimits) {
    return [];
  }
  return [rateLimits.primary, rateLimits.secondary]
    .map((limitWindow) => {
      if (
        !limitWindow ||
        !Number.isFinite(limitWindow.used_percent) ||
        !Number.isFinite(limitWindow.window_minutes)
      ) {
        return null;
      }
      return `${formatRateLimitShortLabel(limitWindow.window_minutes)} ${Math.round(limitWindow.used_percent)}%`;
    })
    .filter(Boolean);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agentUsage.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/agentUsage.js test/agentUsage.test.js
git commit -m "feat: formatRateLimitsStatusBar 输出紧凑短标签段(5h 45% / w 23%)"
```

---

### Task 2: `formatAgentUsage` 把 rate-limit 段拼进状态栏文本

**Files:**
- Modify: `src/agentUsage.js:187-190`(`formatAgentUsage` 的 `textParts` 组装)
- Test: `test/agentUsage.test.js:169-198`

- [ ] **Step 1: 反转既有测试**

把 `test("formatAgentUsage keeps Codex rate limits out of the status bar", ...)` 整体替换为(测试名与 `formatted.text` 断言变化,tooltip 断言不变):

```js
test("formatAgentUsage shows compact Codex rate limits in the status bar", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const sameDayReset = Math.floor(new Date(2026, 5, 3, 14, 32).getTime() / 1000);
  const nextWeekReset = Math.floor(new Date(2026, 5, 8, 9, 24).getTime() / 1000);

  const formatted = formatAgentUsage(
    {
      provider: "Codex",
      contextTokens: 8200,
      contextWindow: 258400,
      contextPercent: 3,
      rateLimits: {
        primary: { used_percent: 21.0, window_minutes: 300, resets_at: sameDayReset },
        secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: nextWeekReset },
      },
    },
    now,
  );

  assert.equal(formatted.text, "Codex ⚡ 3% · 5h 21% · w 10%");
  assert.equal(
    formatted.tooltip,
    [
      "Codex: ctx 8k / 258k (3%)",
      "5h usage: 21% · Reset at 14:32",
      "Weekly usage: 10% · Reset at 6/8 09:24",
    ].join("\n"),
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 该测试 FAIL —— `formatted.text` 实际仍为 `Codex ⚡ 3%`。

- [ ] **Step 3: 最小实现**

`src/agentUsage.js` 的 `formatAgentUsage` 中,把

```js
  const textParts = [`${provider} ⚡ ${contextPercent}`];

  return {
    text: textParts.join(" | "),
```

替换为:

```js
  const textParts = [`${provider} ⚡ ${contextPercent}`];
  textParts.push(...formatRateLimitsStatusBar(usage.rateLimits));

  return {
    text: textParts.join(" · "),
```

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test`
Expected: 全部 PASS。特别确认既有测试不回归:`readLatestAgentUsage selects Codex ...`(Codex 的 `rateLimits` 为 `{}` → 段为空 → text 仍 `Codex ⚡ 3%`)与两个 Claude 测试(无 `rateLimits` 字段 → text 不变)。

- [ ] **Step 5: 提交**

```bash
git add src/agentUsage.js test/agentUsage.test.js
git commit -m "feat: 状态栏追加 Codex 5h/weekly 紧凑用量段"
```

---

### Task 3: 同步文档(CLAUDE.md / AGENTS.md / README.md)

**Files:**
- Modify: `CLAUDE.md`(`src/agentUsage.js` 条目)
- Modify: `AGENTS.md:52`
- Modify: `README.md:19`、`README.md:27-35`

- [ ] **Step 1: 更新 CLAUDE.md**

`src/agentUsage.js` 条目中,把

> Status bar text is just `{provider} ⚡ {percent}` (e.g. `Claude ⚡ 9%` or `Codex ⚡ 3%`); the friendly Claude model name (with `(1M)` marker) and the compact Codex rate-limit segments are intentionally kept out of the status bar and surfaced only in the tooltip.

替换为:

> Status bar text is `{provider} ⚡ {percent}` plus compact Codex rate-limit segments joined with ` · ` (e.g. `Codex ⚡ 3% · 5h 45% · w 23%`; Claude has no rate-limit data, so it shows just `Claude ⚡ 9%`). Segments come from `formatRateLimitsStatusBar` with short labels `5h` / `w` / `Nd`; the friendly Claude model name (with `(1M)` marker) and rate-limit reset times are intentionally kept out of the status bar and surfaced only in the tooltip.

- [ ] **Step 2: 更新 AGENTS.md**

第 52 行,把

> formats status bar text (just provider and context percent, e.g. `Claude ⚡ 9%`), tooltip text, usage severity (`low`/`medium`/`high`, used by `extension.js` for status bar coloring), model details, and Codex rate-limit rows. The friendly model name and Codex 5h/weekly rate-limit segments are kept out of the status bar and surfaced only in the tooltip.

替换为:

> formats status bar text (provider, context percent, and compact Codex rate-limit segments, e.g. `Codex ⚡ 3% · 5h 45% · w 23%`; Claude shows just `Claude ⚡ 9%`), tooltip text, usage severity (`low`/`medium`/`high`, used by `extension.js` for status bar coloring), model details, and Codex rate-limit rows. The friendly model name and rate-limit reset times are kept out of the status bar and surfaced only in the tooltip.

- [ ] **Step 3: 更新 README.md**

第 19 行替换为:

```markdown
- **Minimal status bar** showing the active provider, context percentage, and (for Codex) compact 5h/weekly usage, so it stays compact.
```

第 27-35 行:示例代码块内的两行示例替换为下面两行(代码块围栏本身保留):

    Codex ⚡ 13% · 5h 45% · w 23%
    Claude ⚡ 18%

代码块后的两条列表项(第 34-35 行)替换为下面三条:

    - The leading label is the active provider, followed by the ⚡ lightning bolt and the context usage percentage.
    - Codex sessions append compact rate-limit segments: `5h 45%` is the 5-hour window and `w 23%` is the weekly window. Claude session files carry no rate-limit data, so those segments are omitted.
    - The friendly model name (e.g. `Opus 4.8`) and rate-limit reset times stay in the hover tooltip.

- [ ] **Step 4: 运行全量测试**

Run: `npm test`
Expected: 全部 PASS(文档改动不影响测试,防手滑兜底)。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: 同步状态栏 5h/weekly 用量段格式说明"
```
