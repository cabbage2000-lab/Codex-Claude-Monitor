# Claude 5h/weekly 用量探测 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定期异步执行 `claude -p "/usage"`,把 Claude 订阅的 5h/weekly 用量并入统一 `rateLimits` 契约,状态栏显示 `Claude ⚡ 50% · 5h 25% · w 8%`。

**Architecture:** 新纯逻辑模块 `src/claudeRateLimits.js`(解析 + 异步探测,与 vscode 解耦);`claudeUsage.js` 文件选择加回退(探测产生的无 assistant 会话文件不再顶掉真实会话);`agentUsage.js` 聚合层注入 `claudeRateLimits`;`extension.js` 持有 5 分钟探测定时器与缓存。格式化层零改动。

**Tech Stack:** 纯 CommonJS + Node 内置 test runner(`npm test`),无依赖、无构建步骤。

**Spec:** `docs/specs/2026-07-07-claude-rate-limits-probe-design.md`

---

### Task 1: `claudeRateLimits.js` — parseUsageOutput 与 resolveClaudeCliPath

**Files:**
- Create: `src/claudeRateLimits.js`
- Create: `test/claudeRateLimits.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/claudeRateLimits.test.js`:

```js
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  parseUsageOutput,
  probeClaudeRateLimits,
  resolveClaudeCliPath,
} = require("../src/claudeRateLimits");

// Real output captured from `claude -p "/usage"` (Claude Code 2.1.202).
const REAL_OUTPUT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 25% used · resets Jul 7 at 8:20pm (Asia/Shanghai)",
  "Current week (all models): 8% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "Current week (Fable): 15% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "",
  "What's contributing to your limits usage?",
].join("\n");

test("parseUsageOutput extracts 5h and weekly windows from real output", () => {
  assert.deepEqual(parseUsageOutput(REAL_OUTPUT), {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  });
});

test("parseUsageOutput returns partial result when weekly line is missing", () => {
  assert.deepEqual(parseUsageOutput("Current session: 91% used · resets soon"), {
    primary: { used_percent: 91, window_minutes: 300 },
  });
});

test("parseUsageOutput returns null for unrelated or empty text", () => {
  assert.equal(parseUsageOutput("error: not logged in"), null);
  assert.equal(parseUsageOutput(""), null);
  assert.equal(parseUsageOutput(null), null);
});

test("resolveClaudeCliPath prefers configured path, then known locations, then PATH", () => {
  const home = require("node:os").homedir();
  const localBin = path.join(home, ".local", "bin", "claude");

  assert.equal(
    resolveClaudeCliPath("/custom/claude", () => true),
    "/custom/claude",
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === localBin),
    localBin,
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === "/opt/homebrew/bin/claude"),
    "/opt/homebrew/bin/claude",
  );
  assert.equal(resolveClaudeCliPath("", () => false), "claude");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/claudeRateLimits.test.js`
Expected: FAIL —— `Cannot find module '../src/claudeRateLimits'`。

- [ ] **Step 3: 最小实现**

创建 `src/claudeRateLimits.js`(本步先实现 parse 与 resolve;probe 在 Task 2 补上,这里先导出占位以免 require 报错——直接写完整骨架但 probe 留到 Task 2 实现的做法会让本步测试无法圈定,因此本步就把三个函数一起写完也可以;为保持小步,这里只写 parse/resolve,probe 的 require 在 Task 2 的测试里才引用):

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Parse the plain-text output of `claude -p "/usage"` into the unified rateLimits
// shape shared with Codex. Unmatched windows are omitted; null when nothing matches.
function parseUsageOutput(text) {
  if (!text) {
    return null;
  }
  const primaryMatch = String(text).match(/^Current session:\s*(\d+(?:\.\d+)?)%\s*used/m);
  const secondaryMatch = String(text).match(
    /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used/m,
  );
  const rateLimits = {};
  if (primaryMatch) {
    rateLimits.primary = { used_percent: Number(primaryMatch[1]), window_minutes: 300 };
  }
  if (secondaryMatch) {
    rateLimits.secondary = { used_percent: Number(secondaryMatch[1]), window_minutes: 10080 };
  }
  return rateLimits.primary || rateLimits.secondary ? rateLimits : null;
}

// The VS Code extension host PATH usually lacks shell-profile additions, so try the
// configured path first, then known install locations, then bare "claude" via PATH.
function resolveClaudeCliPath(configuredPath, existsSyncImpl = fs.existsSync) {
  const candidates = [
    configuredPath && configuredPath.trim(),
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  }
  return "claude";
}

module.exports = {
  parseUsageOutput,
  resolveClaudeCliPath,
};
```

注意:Step 1 的测试文件顶部 require 了 `probeClaudeRateLimits`(此时为 undefined),但本步测试均不调用它,不影响本步通过;Task 2 再导出。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/claudeRateLimits.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claudeRateLimits.js test/claudeRateLimits.test.js
git commit -m "feat: 解析 claude -p /usage 输出与 CLI 路径探测"
```

---

### Task 2: `claudeRateLimits.js` — probeClaudeRateLimits 异步探测

**Files:**
- Modify: `src/claudeRateLimits.js`
- Modify: `test/claudeRateLimits.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/claudeRateLimits.test.js` 末尾追加:

```js
test("probeClaudeRateLimits parses stdout from the injected exec", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, REAL_OUTPUT, "");
  };
  const result = await probeClaudeRateLimits({
    cliPath: "/fake/claude",
    execFileImpl: fakeExec,
  });
  assert.deepEqual(result, {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/fake/claude");
  assert.deepEqual(calls[0].args, ["-p", "/usage"]);
  assert.equal(calls[0].options.timeout, 30000);
  assert.ok(calls[0].options.cwd);
});

test("probeClaudeRateLimits resolves null on exec error", async () => {
  const fakeExec = (file, args, options, callback) => {
    callback(new Error("ENOENT"), "", "");
  };
  assert.equal(await probeClaudeRateLimits({ execFileImpl: fakeExec }), null);
});

test("probeClaudeRateLimits resolves null on unparseable stdout", async () => {
  const fakeExec = (file, args, options, callback) => {
    callback(null, "unexpected", "");
  };
  assert.equal(await probeClaudeRateLimits({ execFileImpl: fakeExec }), null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/claudeRateLimits.test.js`
Expected: 三个新测试 FAIL —— `probeClaudeRateLimits is not a function`。

- [ ] **Step 3: 最小实现**

`src/claudeRateLimits.js` 顶部 require 增加 `child_process`:

```js
const { execFile } = require("node:child_process");
```

在 `resolveClaudeCliPath` 之后新增:

```js
// Run `claude -p "/usage"` and parse its output. Resolves null on any failure
// (missing CLI, timeout, unparseable output) so callers keep the previous value.
// cwd defaults to the OS temp dir so the probe session never matches a workspace.
function probeClaudeRateLimits(options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const cliPath = options.cliPath || resolveClaudeCliPath("");
  return new Promise((resolve) => {
    execFileImpl(
      cliPath,
      ["-p", "/usage"],
      {
        timeout: options.timeoutMs || 30000,
        cwd: options.cwd || os.tmpdir(),
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error ? null : parseUsageOutput(String(stdout)));
      },
    );
  });
}
```

`module.exports` 增加 `probeClaudeRateLimits`。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/claudeRateLimits.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/claudeRateLimits.js test/claudeRateLimits.test.js
git commit -m "feat: 异步探测 claude -p /usage 用量"
```

---

### Task 3: `claudeUsage.js` 文件选择回退

**Files:**
- Modify: `src/claudeUsage.js:42-54, 92-112`
- Modify: `test/claudeUsage.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/claudeUsage.test.js` 末尾追加(`makeTempDir`/`writeJsonl`/`setMtime` 已由该文件的既有 import 提供;若无则从 `./testUtils` 引入):

```js
test("readLatestClaudeUsage falls back past files without assistant usage", () => {
  const root = makeTempDir();
  const probeFile = path.join(root, "projects", "-tmp-probe", "probe.jsonl");
  const realFile = path.join(root, "projects", "-workspace", "real.jsonl");

  // Newest file: a `claude -p "/usage"` probe session with no assistant entry.
  writeJsonl(probeFile, [
    { type: "user", message: { content: "/usage" } },
    { type: "system", subtype: "usage" },
  ]);
  writeJsonl(realFile, [
    {
      type: "assistant",
      timestamp: "2026-07-07T10:00:00Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 5, cache_read_input_tokens: 995, cache_creation_input_tokens: 0 },
      },
    },
  ]);
  setMtime(realFile, new Date("2026-07-07T10:00:00Z"));
  setMtime(probeFile, new Date("2026-07-07T11:00:00Z"));

  const usage = readLatestClaudeUsage(root);
  assert.ok(usage, "should fall back to the older file with assistant usage");
  assert.equal(usage.sessionFile, realFile);
  assert.equal(usage.contextTokens, 1000);
});
```

若该测试文件尚未 import `readLatestClaudeUsage` 或 `path`,在顶部补齐。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/claudeUsage.test.js`
Expected: 新测试 FAIL —— `usage` 为 null(现实现只读最新的 probe 文件)。

- [ ] **Step 3: 最小实现**

`src/claudeUsage.js` 把 `findLatestClaudeSessionFile` 重构为列表函数的薄封装,`readLatestClaudeUsage` 遍历候选:

```js
// Probe sessions (`claude -p "/usage"`) and freshly started sessions have no assistant
// entry yet; try a few newest files instead of only the very newest.
const MAX_SESSION_FILE_CANDIDATES = 10;

function listClaudeSessionFilesByMtime(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  const projectsRoot = path.join(claudeRoot, "projects");
  const filterByWorkspace = Array.isArray(workspaceFolders) && workspaceFolders.length > 0;
  const roots = filterByWorkspace
    ? listMatchingProjectDirs(projectsRoot, workspaceFolders)
    : [projectsRoot];
  const files = roots.flatMap((root) => walkFiles(root, (name) => name.endsWith(".jsonl")));
  return sortByMtimeDesc(files);
}

function findLatestClaudeSessionFile(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  return listClaudeSessionFilesByMtime(claudeRoot, workspaceFolders)[0] || null;
}
```

`readLatestClaudeUsage` 替换为:

```js
function readLatestClaudeUsage(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  const candidates = listClaudeSessionFilesByMtime(claudeRoot, workspaceFolders).slice(
    0,
    MAX_SESSION_FILE_CANDIDATES,
  );

  for (const sessionFile of candidates) {
    const event = readLastClaudeUsageEvent(sessionFile);
    if (!event) {
      continue;
    }
    const contextTokens = getUsageContextTokens(event.usage);
    const contextWindow = inferClaudeContextWindow(event.model);
    return {
      provider: "Claude",
      sessionFile,
      updatedAt: event.timestamp
        ? new Date(event.timestamp).getTime()
        : fs.statSync(sessionFile).mtimeMs,
      model: event.model,
      contextTokens,
      contextWindow,
      contextPercent: calculateContextPercent(contextTokens, contextWindow),
      usage: event.usage,
    };
  }
  return null;
}
```

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test`
Expected: 全部 PASS(既有 `findLatestClaudeSessionFile` 测试不受影响)。

- [ ] **Step 5: 提交**

```bash
git add src/claudeUsage.js test/claudeUsage.test.js
git commit -m "fix: Claude 会话选择跳过无 assistant 条目的文件"
```

---

### Task 4: `agentUsage.js` 聚合层注入 claudeRateLimits

**Files:**
- Modify: `src/agentUsage.js:6-18`
- Modify: `test/agentUsage.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/agentUsage.test.js` 末尾追加:

```js
test("readLatestAgentUsage attaches claudeRateLimits when Claude wins", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const claudeFile = path.join(claudeRoot, "projects", "-workspace", "new.jsonl");
  writeJsonl(claudeFile, [
    {
      type: "assistant",
      timestamp: "2026-07-07T12:00:00Z",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ]);

  const claudeRateLimits = {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  };
  const usage = readLatestAgentUsage({
    codexSessionsRoot: codexRoot,
    claudeRoot,
    claudeRateLimits,
  });

  assert.equal(usage.provider, "Claude");
  assert.deepEqual(usage.rateLimits, claudeRateLimits);
  assert.match(formatAgentUsage(usage).text, /^Claude ⚡ \d+% · 5h 25% · w 8%$/);
});

test("readLatestAgentUsage does not attach claudeRateLimits to Codex", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const codexFile = path.join(codexRoot, "2026", "07", "07", "rollout-x.jsonl");
  writeJsonl(codexFile, [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1000 },
          last_token_usage: { input_tokens: 500 },
          model_context_window: 10000,
        },
      },
    },
  ]);

  const usage = readLatestAgentUsage({
    codexSessionsRoot: codexRoot,
    claudeRoot,
    claudeRateLimits: { primary: { used_percent: 25, window_minutes: 300 } },
  });

  assert.equal(usage.provider, "Codex");
  assert.deepEqual(usage.rateLimits, {});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/agentUsage.test.js`
Expected: 第一个新测试 FAIL(`usage.rateLimits` 为 undefined);第二个本就满足,PASS。

- [ ] **Step 3: 最小实现**

`src/agentUsage.js` 的 `readLatestAgentUsage` 中,把

```js
  return candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
```

替换为:

```js
  const usage = candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  // Claude JSONL carries no rate-limit data; attach the probed value from the caller.
  // Never overwrite provider-supplied rateLimits (future-proofing).
  if (usage.provider === "Claude" && options.claudeRateLimits && !usage.rateLimits) {
    usage.rateLimits = options.claudeRateLimits;
  }
  return usage;
```

- [ ] **Step 4: 运行全量测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/agentUsage.js test/agentUsage.test.js
git commit -m "feat: 聚合层为 Claude 附加探测到的 rateLimits"
```

---

### Task 5: `extension.js` 探测定时器 + `package.json` 配置

**Files:**
- Modify: `src/extension.js`
- Modify: `package.json`

本任务是 vscode 接线层,无法用 Node test runner 直接测试;以 `npm test` 回归 + Task 6 的手动验证兜底。

- [ ] **Step 1: package.json 新增配置声明**

`contributes.configuration.properties` 追加:

```json
"agentTokenStatus.claudeUsageProbeIntervalMs": {
  "type": "number",
  "default": 300000,
  "description": "How often to probe Claude subscription usage by running `claude -p \"/usage\"`. Minimum 60000; set 0 to disable."
},
"agentTokenStatus.claudeCliPath": {
  "type": "string",
  "default": "",
  "description": "Optional absolute path to the claude CLI. Leave empty to auto-detect (~/.local/bin, Homebrew, /usr/local/bin, then PATH)."
}
```

- [ ] **Step 2: extension.js 接线**

顶部 require 增加:

```js
const { probeClaudeRateLimits, resolveClaudeCliPath } = require("./claudeRateLimits");
```

`WATCHED_SETTINGS` 增加两项:

```js
const WATCHED_SETTINGS = [
  "sessionsRoot",
  "claudeRoot",
  "refreshIntervalMs",
  "claudeUsageProbeIntervalMs",
  "claudeCliPath",
];
```

模块级状态与常量(`let latestUsage = null;` 附近):

```js
const DEFAULT_PROBE_INTERVAL_MS = 300000;
const MIN_PROBE_INTERVAL_MS = 60000;

let probeTimer;
let latestClaudeRateLimits = null;
```

新函数(放在 `getRefreshIntervalMs` 之后):

```js
// <= 0 disables probing; positive values are clamped to at least 1 minute so a
// mis-set config cannot spawn `claude` processes in a tight loop.
function getProbeIntervalMs() {
  const configured = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get("claudeUsageProbeIntervalMs", DEFAULT_PROBE_INTERVAL_MS);
  const value = Number(configured);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(MIN_PROBE_INTERVAL_MS, value);
}

// Probe failures keep the previous value: subscription usage moves slowly, so a
// slightly stale percent beats a flickering status bar segment.
async function probeClaude() {
  const configuredCliPath = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get("claudeCliPath", "");
  const result = await probeClaudeRateLimits({
    cliPath: resolveClaudeCliPath(configuredCliPath),
  });
  if (result) {
    latestClaudeRateLimits = result;
    refreshStatus();
  }
}

function startProbeTimer() {
  clearInterval(probeTimer);
  const interval = getProbeIntervalMs();
  if (interval <= 0) {
    return;
  }
  probeTimer = setInterval(probeClaude, interval);
}
```

`readUsage()` 增加透传:

```js
function readUsage() {
  return readLatestAgentUsage({
    codexSessionsRoot: getConfiguredPath("sessionsRoot", getDefaultSessionsRoot),
    claudeRoot: getConfiguredPath("claudeRoot", getDefaultClaudeRoot),
    workspaceFolders: getWorkspaceFolders(),
    claudeRateLimits: latestClaudeRateLimits,
  });
}
```

`activate` 中:

- `context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });` 改为同时清理两个定时器:

```js
  context.subscriptions.push({
    dispose: () => {
      clearInterval(refreshTimer);
      clearInterval(probeTimer);
    },
  });
```

- `onDidChangeConfiguration` 回调内 `startRefreshTimer();` 之后追加 `startProbeTimer();`
- 末尾 `refreshStatus(); startRefreshTimer();` 之后追加:

```js
  if (getProbeIntervalMs() > 0) {
    probeClaude();
  }
  startProbeTimer();
```

`deactivate` 改为:

```js
function deactivate() {
  clearInterval(refreshTimer);
  clearInterval(probeTimer);
}
```

- [ ] **Step 3: 运行全量测试(回归)+ 语法检查**

Run: `npm test && node --check src/extension.js`
Expected: 测试全部 PASS;extension.js 语法通过。

- [ ] **Step 4: 提交**

```bash
git add src/extension.js package.json
git commit -m "feat: 定期探测 Claude 订阅用量并接入状态栏"
```

---

### Task 6: 端到端验证 + 文档同步

**Files:**
- Modify: `CLAUDE.md`、`AGENTS.md`、`README.md`

- [ ] **Step 1: 纯 Node 端到端烟雾测试(真实数据)**

Run:

```bash
node -e "
const { probeClaudeRateLimits } = require('./src/claudeRateLimits');
const { readLatestAgentUsage, formatAgentUsage } = require('./src/agentUsage');
probeClaudeRateLimits().then((rl) => {
  console.log('probed:', JSON.stringify(rl));
  const usage = readLatestAgentUsage({ claudeRateLimits: rl });
  console.log('text:', formatAgentUsage(usage).text);
});
"
```

Expected: `probed:` 输出非 null 的 primary/secondary;若最新活跃 provider 是 Claude,`text:` 形如 `Claude ⚡ 50% · 5h 25% · w 8%`。

- [ ] **Step 2: 更新 CLAUDE.md**

`src/agentUsage.js` 条目中 "Claude has no rate-limit data, so it shows just `Claude ⚡ 9%`" 的表述改为说明 Claude 的 rateLimits 来自探测注入,例如将该句改写为:

> Status bar text is `{provider} ⚡ {percent}` plus compact rate-limit segments joined with ` · ` (e.g. `Codex ⚡ 3% · 5h 45% · w 23%`, `Claude ⚡ 50% · 5h 25% · w 8%`). Codex segments come from session JSONL `rate_limits`; Claude segments come from `options.claudeRateLimits` injected by `extension.js` (probed via `claude -p "/usage"`), attached only when Claude wins and never overwriting provider-supplied data.

并在 Architecture 文件列表新增一条(放在 `src/claudeUsage.js` 之后):

> - `src/claudeRateLimits.js`: probes Claude subscription usage by running `claude -p "/usage"` (async `execFile`, 30s timeout, cwd = OS temp dir so the probe session never matches a workspace). `parseUsageOutput` maps "Current session" / "Current week (all models)" lines to the Codex-shaped `rateLimits` object; `resolveClaudeCliPath` tries the configured path, `~/.local/bin/claude`, Homebrew, `/usr/local/bin`, then bare `claude` (the extension host PATH usually lacks shell-profile dirs). Probing lives on a separate timer in `extension.js` (`claudeUsageProbeIntervalMs`, default 5 min, 0 disables, min 60s); failures keep the last good value. Because probe sessions have no assistant entry, `readLatestClaudeUsage` tries the newest 10 files instead of only the newest.

`src/extension.js` 条目补一句探测定时器与配置;`src/claudeUsage.js` 条目补一句回退行为。

- [ ] **Step 3: 更新 AGENTS.md**

第 52 行附近 `src/agentUsage.js` 条目的状态栏示例补 Claude 段(`Claude ⚡ 50% · 5h 25% · w 8%`);在模块列表里新增 `src/claudeRateLimits.js` 一行(探测 + 解析,一句话);配置列表(若有)补两个新键。

- [ ] **Step 4: 更新 README.md**

- 状态栏示例块改为:

```
Codex ⚡ 13% · 5h 45% · w 23%
Claude ⚡ 18% · 5h 25% · w 8%
```

- "Claude session files carry no rate-limit data, so those segments are omitted." 一句替换为:

> For Claude, the 5h/weekly percentages are probed by periodically running `claude -p "/usage"` in the background (every 5 minutes by default, configurable via `agentTokenStatus.claudeUsageProbeIntervalMs`; set 0 to disable). Until the first successful probe, the segments are omitted.

- Settings 表格/列表补 `claudeUsageProbeIntervalMs` 与 `claudeCliPath` 两行。

- [ ] **Step 5: 全量测试 + 提交**

```bash
npm test
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: 同步 Claude 用量探测说明与新配置项"
```
