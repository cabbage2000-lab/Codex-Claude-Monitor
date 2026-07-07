# 状态栏图标化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把状态栏单行的 emoji `⚡` 与字母缩写段(`5h`/`w`/`Nd`)替换为 codicon 图标(`$(comment)`/`$(history)`/`$(calendar)`),provider 品牌文字保留。

**Architecture:** 改动全部集中在聚合层 `src/agentUsage.js`:新增内部函数 `rateLimitWindowIcon`(窗口分钟数 → 图标)、删除 `formatRateLimitShortLabel`、改造 `formatRateLimitsStatusBar`(段格式由 `5h 45%` 变 `$(history) 45%`)、改造 `formatAgentUsage`(上下文段 `⚡` 变 `$(comment)`)。tooltip、severity、error 态、`extension.js` 均不变。N 天中间档归入 `$(calendar)`,于是窗口图标只有两档:小时级 → `$(history)`,多日及以上 → `$(calendar)`。

**Tech Stack:** 纯 CommonJS + Node 内置 test runner(`npm test`),无依赖、无构建步骤。

**Spec:** `docs/specs/2026-07-07-statusbar-icons-design.md`

---

### Task 1: 窗口段图标化 — `formatRateLimitsStatusBar` 输出 codicon

**Files:**
- Modify: `src/agentUsage.js:138-166`(注释 + `formatRateLimitShortLabel` → `rateLimitWindowIcon` + `formatRateLimitsStatusBar` 段格式)
- Test: `test/agentUsage.test.js`

- [ ] **Step 1: 写失败测试**

`test/agentUsage.test.js` 中,把 `formatRateLimitsStatusBar renders compact segments for both windows` 的期望值改为图标:

```js
// old
  assert.deepEqual(segments, ["5h 45%", "w 23%"]);
// new
  assert.deepEqual(segments, ["$(history) 45%", "$(calendar) 23%"]);
```

把 `formatRateLimitsStatusBar falls back to day label for mid-length windows` 整个测试替换(测试名与期望值都改,N 天归 calendar):

```js
// old
test("formatRateLimitsStatusBar falls back to day label for mid-length windows", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 55.6, window_minutes: 2880 },
  });
  assert.deepEqual(segments, ["2d 56%"]);
});
// new
test("formatRateLimitsStatusBar maps mid-length windows to the calendar icon", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 55.6, window_minutes: 2880 },
  });
  assert.deepEqual(segments, ["$(calendar) 56%"]);
});
```

同步更新两条 `formatAgentUsage` 集成断言的**段部分**(`⚡` 暂留,Task 2 再改):

```js
// old (line 216)
  assert.equal(formatted.text, "Codex ⚡ 3% · 5h 21% · w 10%");
// new
  assert.equal(formatted.text, "Codex ⚡ 3% · $(history) 21% · $(calendar) 10%");
```

```js
// old (line 306)
  assert.match(formatAgentUsage(usage).text, /^Claude ⚡ \d+% · 5h 25% · w 8%$/);
// new
  assert.match(formatAgentUsage(usage).text, /^Claude ⚡ \d+% · \$\(history\) 25% · \$\(calendar\) 8%$/);
```

(正则里 `$` 与括号需转义:`$(history)` → `\$\(history\)`。)

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 上述 4 条断言 FAIL —— 单元测试仍输出 `5h 45%` / `w 23%` / `2d 56%`;两条集成断言的段部分不匹配。

- [ ] **Step 3: 最小实现**

`src/agentUsage.js` 中,把 `formatRateLimitShortLabel` 函数(含其上方注释)整体替换为新函数 `rateLimitWindowIcon`:

```js
// old
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
// new
// Status-bar codicon for a rate-limit window: hour-scale -> "$(history)" (clock), multi-day -> "$(calendar)".
function rateLimitWindowIcon(minutes) {
  if (minutes <= 24 * 60) {
    return "$(history)";
  }
  return "$(calendar)";
}
```

把 `formatRateLimitsStatusBar` 的注释行与 `map` 内的 `return` 改为使用新函数:

```js
// old (注释)
// Compact status-bar rate-limit segments, e.g. ["5h 45%", "w 23%"]. Missing fields omit the segment.
// new
// Compact status-bar rate-limit segments, e.g. ["$(history) 45%", "$(calendar) 23%"]. Missing fields omit the segment.
```

```js
// old (map 内 return)
      return `${formatRateLimitShortLabel(limitWindow.window_minutes)} ${Math.round(limitWindow.used_percent)}%`;
// new
      return `${rateLimitWindowIcon(limitWindow.window_minutes)} ${Math.round(limitWindow.used_percent)}%`;
```

(`formatRateLimitShortLabel` 无外部引用、未被导出,仅此一处调用,删除安全。)

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/agentUsage.js test/agentUsage.test.js
git commit -m 'feat: formatRateLimitsStatusBar 窗口段改用 codicon(history/calendar)'
```

---

### Task 2: 上下文图标化 — `formatAgentUsage` 的 `⚡` → `$(comment)`

**Files:**
- Modify: `src/agentUsage.js:193`(`formatAgentUsage` 的 `textParts` 首段)
- Test: `test/agentUsage.test.js`

- [ ] **Step 1: 写失败测试**

`test/agentUsage.test.js` 中,把所有 `⚡` text 断言改为 `$(comment)`(line 216、306 已在 Task 1 改过段部分,此处只动 `⚡`):

```js
// old (line 51)
  assert.equal(formatted.text, "Codex ⚡ 3%");
// new
  assert.equal(formatted.text, "Codex $(comment) 3%");
```

```js
// old (line 109)
  assert.equal(formatted.text, "Claude ⚡ 18%");
// new
  assert.equal(formatted.text, "Claude $(comment) 18%");
```

```js
// old (line 216, Task 1 后的状态)
  assert.equal(formatted.text, "Codex ⚡ 3% · $(history) 21% · $(calendar) 10%");
// new
  assert.equal(formatted.text, "Codex $(comment) 3% · $(history) 21% · $(calendar) 10%");
```

```js
// old (line 240)
  assert.equal(formatted.text, "Claude ⚡ 18%");
// new
  assert.equal(formatted.text, "Claude $(comment) 18%");
```

```js
// old (line 260)
  assert.equal(formatted.text, "Claude ⚡ 50%");
// new
  assert.equal(formatted.text, "Claude $(comment) 50%");
```

```js
// old (line 306, Task 1 后的状态)
  assert.match(formatAgentUsage(usage).text, /^Claude ⚡ \d+% · \$\(history\) 25% · \$\(calendar\) 8%$/);
// new
  assert.match(formatAgentUsage(usage).text, /^Claude \$\(comment\) \d+% · \$\(history\) 25% · \$\(calendar\) 8%$/);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 上述 6 条 text 断言 FAIL —— 实现仍输出 `⚡`。

- [ ] **Step 3: 最小实现**

`src/agentUsage.js` 的 `formatAgentUsage` 中:

```js
// old
  const textParts = [`${provider} ⚡ ${contextPercent}`];
// new
  const textParts = [`${provider} $(comment) ${contextPercent}`];
```

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/agentUsage.js test/agentUsage.test.js
git commit -m 'feat: 状态栏上下文占比用 $(comment) 替代 emoji'
```

---

### Task 3: 同步文档(CLAUDE.md / AGENTS.md / README.md)

**Files:**
- Modify: `CLAUDE.md`(`src/agentUsage.js` 条目中状态栏格式句)
- Modify: `AGENTS.md:53`
- Modify: `README.md:19`、`README.md:30-31`、`README.md:34-35`

- [ ] **Step 1: 更新 CLAUDE.md**

把:

> Status bar text is `{provider} ⚡ {percent}` plus compact rate-limit segments joined with ` · ` (e.g. `Codex ⚡ 3% · 5h 45% · w 23%`, `Claude ⚡ 50% · 5h 25% · w 8%`). Segments come from `formatRateLimitsStatusBar` with short labels `5h` / `w` / `Nd`.

替换为:

> Status bar text is `{provider} $(comment) {percent}` plus compact rate-limit segments joined with ` · ` (e.g. `Codex $(comment) 3% · $(history) 45% · $(calendar) 23%`, `Claude $(comment) 50% · $(history) 25% · $(calendar) 8%`). Segments come from `formatRateLimitsStatusBar` using codicon icons: `$(history)` for hour-scale windows (e.g. 5h) and `$(calendar)` for multi-day windows (weekly / Nd); `$(comment)` (a speech bubble) marks the context percent in place of an emoji so it renders consistently across themes and needs no translation.

- [ ] **Step 2: 更新 AGENTS.md(第 53 行)**

把:

> formats status bar text (provider, context percent, and compact rate-limit segments, e.g. `Codex ⚡ 3% · 5h 45% · w 23%` or `Claude ⚡ 50% · 5h 25% · w 8%`)

替换为:

> formats status bar text (provider, context percent, and compact rate-limit segments using codicon icons, e.g. `Codex $(comment) 3% · $(history) 45% · $(calendar) 23%` or `Claude $(comment) 50% · $(history) 25% · $(calendar) 8%`)

- [ ] **Step 3: 更新 README.md**

第 19 行,把:

> - **Minimal status bar** showing the active provider, context percentage, and (for Codex) compact 5h/weekly usage, so it stays compact.

替换为:

> - **Minimal, icon-based status bar** showing the active provider, context percentage, and (for Codex) compact 5h/weekly usage via codicon icons, so it stays compact and language-neutral.

第 30–31 行(代码块内两行示例,围栏保留):

```text
// old
Codex ⚡ 13% · 5h 45% · w 23%
Claude ⚡ 18% · 5h 25% · w 8%
// new
Codex $(comment) 13% · $(history) 45% · $(calendar) 23%
Claude $(comment) 18% · $(history) 25% · $(calendar) 8%
```

第 34 行(代码块后第一条 bullet),把:

> - The leading label is the active provider, followed by the ⚡ lightning bolt and the context usage percentage.

替换为:

> - The leading label is the active provider, followed by `$(comment)` (a speech-bubble icon marking the current session) and the context usage percentage.

第 35 行(第二条 bullet),把:

> - Both providers append compact rate-limit segments: `5h 45%` is the 5-hour window and `w 23%` is the weekly window. Codex reads them from its session files. For Claude they are probed by periodically running `claude -p "/usage"` in the background (every 5 minutes by default, configurable via `agentTokenStatus.claudeUsageProbeIntervalMs`; set `0` to disable). Until the first successful probe, the Claude segments are omitted.

替换为:

> - Both providers append compact rate-limit segments using codicon icons: `$(history)` is the 5-hour window and `$(calendar)` is the weekly window. Codex reads them from its session files. For Claude they are probed by periodically running `claude -p "/usage"` in the background (every 5 minutes by default, configurable via `agentTokenStatus.claudeUsageProbeIntervalMs`; set `0` to disable). Until the first successful probe, the Claude segments are omitted. Icons replace letter abbreviations (`5h`/`w`) so the bar reads the same in any language.

- [ ] **Step 4: 运行全量测试(兜底)**

Run: `npm test`
Expected: 全部 PASS(文档不影响测试,防手滑)。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m 'docs: 同步状态栏图标化格式说明(comment/history/calendar)'
```

---

### 收尾验证(可选,肉眼确认)

三个 Task 完成后,在本机 VS Code 里 `Developer: Reload Window`,确认状态栏图标实际渲染为对话气泡 / 时钟 / 日历(codicon 字体随 VS Code 内置,无需额外安装)。若某图标显示为空白方块,说明当前 VS Code 的 codicon 版本缺失该图标——`comment`/`history`/`calendar` 均为 codicon 老牌图标,兼容性风险极低。
