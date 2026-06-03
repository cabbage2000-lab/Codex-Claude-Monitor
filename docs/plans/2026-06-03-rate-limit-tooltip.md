# 状态栏悬停/点击显示 5h 与周用量 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 状态栏悬停 tooltip 显示 Codex 的 5 小时/周用量与重置时间（Claude 显示模型名），点击时把同样的详情显示在信息提示中。

**Architecture:** 改动集中在格式化层（`src/agentUsage.js` 新增 `formatRateLimits`，tooltip 改多行）和入口层（`src/extension.js` 的 refresh 命令复用格式化结果）。Provider 契约不变——`codexUsage.js` 已返回 `rateLimits`。

**Tech Stack:** 纯 CommonJS + Node 内置 test runner（`node --test`），无依赖、无构建。

**注意:** 本项目不是 git 仓库，所有任务省略 commit 步骤。时间格式化用本地时区的 `Date` 组件方法（`getHours` 等）；测试中用本地时间构造 `new Date(year, month, day, hh, mm)` 再转 unix 秒，保证跨时区确定性。

设计文档：`docs/specs/2026-06-03-rate-limit-tooltip-design.md`

---

### Task 1: `formatRateLimits` —— 解析 Codex rate limits 为展示行

**Files:**
- Modify: `src/agentUsage.js`
- Test: `test/agentUsage.test.js`

Codex `rateLimits` 真实结构（来自 token_count 事件）：

```json
{
  "primary": { "used_percent": 21.0, "window_minutes": 300, "resets_at": 1780492366 },
  "secondary": { "used_percent": 10.0, "window_minutes": 10080, "resets_at": 1780874655 },
  "plan_type": "pro"
}
```

`resets_at` 为 unix 秒。规则：

- `window_minutes >= 7*24*60` → 标签 `周用量`；`<= 24*60` → `${小时}h 用量`；之间 → `${天}d 用量`。
- 窗口缺 `used_percent` 或 `window_minutes`（非有限数字）→ 跳过该行。
- `resets_at` 与 `now` 同一天（本地时区）→ `HH:mm`，跨天 → `M/D HH:mm`；缺失则省略 `· 重置于` 部分。
- `now` 作为第二个参数注入，默认 `Date.now()`。

- [ ] **Step 1: 写失败测试**

在 `test/agentUsage.test.js` 顶部 require 中加入 `formatRateLimits`：

```js
const {
  formatAgentUsage,
  formatRateLimits,
  getUsageSeverity,
  readLatestAgentUsage,
} = require("../src/agentUsage");
```

文件末尾追加测试：

```js
test("formatRateLimits formats 5h and weekly windows with reset times", () => {
  // 本地时间构造，保证跨时区确定性。
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const sameDayReset = Math.floor(new Date(2026, 5, 3, 14, 32).getTime() / 1000);
  const nextWeekReset = Math.floor(new Date(2026, 5, 8, 9, 24).getTime() / 1000);

  const lines = formatRateLimits(
    {
      primary: { used_percent: 21.0, window_minutes: 300, resets_at: sameDayReset },
      secondary: { used_percent: 10.0, window_minutes: 10080, resets_at: nextWeekReset },
    },
    now,
  );

  assert.deepEqual(lines, [
    "5h 用量: 21% · 重置于 14:32",
    "周用量: 10% · 重置于 6/8 09:24",
  ]);
});

test("formatRateLimits omits invalid windows and missing reset times", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();

  assert.deepEqual(formatRateLimits(null, now), []);
  assert.deepEqual(formatRateLimits({}, now), []);
  // 缺 used_percent → 跳过整行。
  assert.deepEqual(
    formatRateLimits({ primary: { window_minutes: 300, resets_at: 1780492366 } }, now),
    [],
  );
  // 缺 window_minutes → 跳过整行。
  assert.deepEqual(formatRateLimits({ primary: { used_percent: 21 } }, now), []);
  // 缺 resets_at → 省略重置时间部分。
  assert.deepEqual(
    formatRateLimits({ primary: { used_percent: 21, window_minutes: 300 } }, now),
    ["5h 用量: 21%"],
  );
});

test("formatRateLimits falls back to day label for mid-length windows", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const lines = formatRateLimits(
    { primary: { used_percent: 55.6, window_minutes: 2880 } },
    now,
  );
  assert.deepEqual(lines, ["2d 用量: 56%"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 新增 3 个测试 FAIL，报 `formatRateLimits is not a function`。

- [ ] **Step 3: 最小实现**

在 `src/agentUsage.js` 的 `getUsageSeverity` 之后加入：

```js
function pad2(value) {
  return String(value).padStart(2, "0");
}

// resets_at（unix 秒）→ 与 now 同一天显示 "HH:mm"，跨天显示 "M/D HH:mm"。
function formatResetTime(resetsAtSeconds, now) {
  if (!Number.isFinite(resetsAtSeconds)) {
    return null;
  }
  const resetDate = new Date(resetsAtSeconds * 1000);
  const nowDate = new Date(now);
  const sameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();
  const time = `${pad2(resetDate.getHours())}:${pad2(resetDate.getMinutes())}`;
  return sameDay ? time : `${resetDate.getMonth() + 1}/${resetDate.getDate()} ${time}`;
}

// 单个限额窗口 → 展示行；缺 used_percent / window_minutes 时返回 null（省略该行）。
function formatRateLimitWindow(window, now) {
  if (!window || !Number.isFinite(window.used_percent) || !Number.isFinite(window.window_minutes)) {
    return null;
  }
  const minutes = window.window_minutes;
  let label;
  if (minutes >= 7 * 24 * 60) {
    label = "周用量";
  } else if (minutes <= 24 * 60) {
    label = `${Math.round(minutes / 60)}h 用量`;
  } else {
    label = `${Math.round(minutes / (24 * 60))}d 用量`;
  }
  const percent = `${Math.round(window.used_percent)}%`;
  const reset = formatResetTime(window.resets_at, now);
  return reset ? `${label}: ${percent} · 重置于 ${reset}` : `${label}: ${percent}`;
}

// Codex rate_limits（primary=5h 窗口，secondary=周窗口）→ tooltip 展示行数组。
function formatRateLimits(rateLimits, now = Date.now()) {
  if (!rateLimits) {
    return [];
  }
  return [rateLimits.primary, rateLimits.secondary]
    .map((window) => formatRateLimitWindow(window, now))
    .filter(Boolean);
}
```

并在文件末尾 `module.exports` 中加入 `formatRateLimits`：

```js
module.exports = {
  formatAgentUsage,
  formatCount,
  formatRateLimits,
  getUsageSeverity,
  readLatestAgentUsage,
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/agentUsage.test.js`
Expected: 全部 PASS。

---

### Task 2: `formatAgentUsage` —— tooltip 改多行（rate limits + 模型名）

**Files:**
- Modify: `src/agentUsage.js`（`formatAgentUsage` 函数）
- Test: `test/agentUsage.test.js`（含更新 2 个既有断言）

tooltip 行序：上下文行 → 模型行（有 `usage.model` 时）→ rate limit 行（有 `usage.rateLimits` 时）。聚合层按字段是否存在判断，不写死 provider 名。

- [ ] **Step 1: 写失败测试**

在 `test/agentUsage.test.js` 末尾追加：

```js
test("formatAgentUsage renders multi-line tooltip with Codex rate limits", () => {
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

  assert.equal(
    formatted.tooltip,
    [
      "Codex: Context 8k / 258k (3%)",
      "5h 用量: 21% · 重置于 14:32",
      "周用量: 10% · 重置于 6/8 09:24",
    ].join("\n"),
  );
});

test("formatAgentUsage appends model line for Claude usage", () => {
  const formatted = formatAgentUsage({
    provider: "Claude",
    model: "claude-opus-4-8",
    contextTokens: 185000,
    contextWindow: 1000000,
    contextPercent: 18,
  });

  assert.equal(
    formatted.tooltip,
    ["Claude: Context 185k / 1m (18%)", "模型: claude-opus-4-8"].join("\n"),
  );
});
```

同时更新 2 个既有断言（Claude fixture 带 `model`，tooltip 变为两行；Codex fixture 不带 rate_limits，保持单行不用改）：

`readLatestAgentUsage selects Claude when Claude session is newer` 测试中：

```js
  assert.equal(
    formatted.tooltip,
    ["Claude: Context 185k / 1m (18%)", "模型: claude-opus-4-8"].join("\n"),
  );
```

（`readLatestAgentUsage selects Codex when Codex session is newer` 测试的 `assert.equal(formatted.tooltip, "Codex: Context 8k / 258k (3%)")` 不变——fixture 无 rate_limits。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 新增 2 个测试 FAIL（tooltip 仍为单行）；既有 Claude 测试因断言已更新也 FAIL。

- [ ] **Step 3: 修改 `formatAgentUsage`**

替换 `src/agentUsage.js` 中的 `formatAgentUsage`：

```js
function formatAgentUsage(usage, now = Date.now()) {
  if (!usage) {
    return {
      text: "n/a",
      tooltip: "No Codex or Claude Code token usage found yet.",
      severity: null,
    };
  }

  const provider = usage.provider || "Agent";
  const contextPercent = Number.isFinite(usage.contextPercent) ? `${usage.contextPercent}%` : "n/a";
  const lines = [
    `${provider}: Context ${formatCount(usage.contextTokens)} / ${formatCount(usage.contextWindow)} (${contextPercent})`,
  ];
  if (usage.model) {
    lines.push(`模型: ${usage.model}`);
  }
  lines.push(...formatRateLimits(usage.rateLimits, now));

  return {
    text: `${provider} ${contextPercent}`,
    tooltip: lines.join("\n"),
    severity: getUsageSeverity(usage.contextPercent),
  };
}
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `npm test`
Expected: 全部 PASS（包括 codexUsage / claudeUsage / sessionFiles 等其他测试文件）。

---

### Task 3: `extension.js` —— 点击显示详情

**Files:**
- Modify: `src/extension.js`

`refreshStatus` 返回格式化结果；refresh 命令复用它，把多行 tooltip 用 ` · ` 拼接为单行显示在信息提示中。该文件依赖 `vscode` API，无自动化测试，靠手动验证。

- [ ] **Step 1: `refreshStatus` 返回格式化结果**

修改 `src/extension.js` 的 `refreshStatus`（仅增加两处 `return`）：

```js
function refreshStatus() {
  if (!statusItem) {
    return null;
  }

  try {
    const usage = readLatestAgentUsage({
      codexSessionsRoot: getConfiguredPath("sessionsRoot", getDefaultSessionsRoot),
      claudeRoot: getConfiguredPath("claudeRoot", getDefaultClaudeRoot),
      workspaceFolders: getWorkspaceFolders(),
    });
    const formatted = formatAgentUsage(usage);
    statusItem.text = formatted.text;
    statusItem.tooltip = formatted.tooltip;
    statusItem.color = SEVERITY_COLORS[formatted.severity] || undefined;
    statusItem.show();
    return formatted;
  } catch (error) {
    statusItem.text = "$(pulse) Agent tokens: error";
    statusItem.tooltip = `Agent Token Status failed to read usage.\n${error.message}`;
    statusItem.color = undefined;
    statusItem.show();
    return null;
  }
}
```

- [ ] **Step 2: refresh 命令显示详情**

替换 refresh 命令注册：

```js
  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.refresh", () => {
      const formatted = refreshStatus();
      const message = formatted
        ? formatted.tooltip.split("\n").join(" · ")
        : "Agent token status refreshed.";
      vscode.window.showInformationMessage(message);
    }),
  );
```

- [ ] **Step 3: 运行全部测试确认无回归**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 4: 手动验证**

在 VS Code 中执行 `Developer: Reload Window`，然后：

1. 悬停状态栏项 → tooltip 多行显示（Codex 活跃时含 `5h 用量` / `周用量` 行；Claude 活跃时含 `模型:` 行）。
2. 点击状态栏项 → 信息提示显示同样内容的单行版本（` · ` 分隔），不再是 "refreshed"。
3. 无会话数据时（可临时把 `agentTokenStatus.claudeRoot` / `sessionsRoot` 指到空目录验证）→ 提示 `No Codex or Claude Code token usage found yet.` 的单行版本。
