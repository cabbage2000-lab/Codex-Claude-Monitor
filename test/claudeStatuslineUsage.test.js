const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  CACHE_FILE_NAME,
  readClaudeStatuslineUsage,
} = require("../src/claudeStatuslineUsage");
const { makeTempDir } = require("./testUtils");

// Write the statusline usage cache file the helper script produces.
function writeCache(claudeRoot, payload) {
  const file = path.join(claudeRoot, CACHE_FILE_NAME);
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

test("maps five_hour to primary (300 min) and seven_day to secondary (10080 min)", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, {
    capturedAt: 1780000000,
    rate_limits: {
      five_hour: { used_percentage: 21, resets_at: 1780001111 },
      seven_day: { used_percentage: 45, resets_at: 1780002222 },
    },
  });

  const result = readClaudeStatuslineUsage(root);

  assert.deepEqual(result.rateLimits.primary, {
    used_percent: 21,
    window_minutes: 300,
    resets_at: 1780001111,
  });
  assert.deepEqual(result.rateLimits.secondary, {
    used_percent: 45,
    window_minutes: 10080,
    resets_at: 1780002222,
  });
  assert.equal(result.capturedAt, 1780000000);
});

test("returns null when the cache file does not exist", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  assert.equal(readClaudeStatuslineUsage(root), null);
});

test("returns null when the cache file is not valid JSON", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  const file = path.join(root, CACHE_FILE_NAME);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.equal(readClaudeStatuslineUsage(root), null);
});

test("returns null when rate_limits is absent (subscriber before first API response)", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, { capturedAt: 1780000000 });
  assert.equal(readClaudeStatuslineUsage(root), null);
});

test("includes only the window that is present when the other is absent", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, {
    capturedAt: 1780000000,
    rate_limits: {
      five_hour: { used_percentage: 10, resets_at: 1780001111 },
    },
  });

  const result = readClaudeStatuslineUsage(root);

  assert.deepEqual(result.rateLimits.primary, {
    used_percent: 10,
    window_minutes: 300,
    resets_at: 1780001111,
  });
  assert.equal(result.rateLimits.secondary, undefined);
});

test("omits resets_at when the window has no reset timestamp", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, {
    capturedAt: 1780000000,
    rate_limits: {
      five_hour: { used_percentage: 33 },
    },
  });

  const result = readClaudeStatuslineUsage(root);

  assert.deepEqual(result.rateLimits.primary, {
    used_percent: 33,
    window_minutes: 300,
  });
});

test("returns null when a present window has a non-numeric used_percentage", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, {
    capturedAt: 1780000000,
    rate_limits: {
      five_hour: { used_percentage: "n/a", resets_at: 1780001111 },
    },
  });

  assert.equal(readClaudeStatuslineUsage(root), null);
});

test("re-reads after the cache file changes (mtime+size cache invalidation)", () => {
  const root = makeTempDir("codex-claude-monitor-statusline-");
  writeCache(root, {
    capturedAt: 1780000000,
    rate_limits: { five_hour: { used_percentage: 10, resets_at: 1 } },
  });
  assert.equal(readClaudeStatuslineUsage(root).rateLimits.primary.used_percent, 10);

  // Overwrite with a different percent and bump mtime so the cache key changes.
  const file = path.join(root, CACHE_FILE_NAME);
  fs.writeFileSync(
    file,
    JSON.stringify({
      capturedAt: 1780000500,
      rate_limits: { five_hour: { used_percentage: 88, resets_at: 1 } },
    }),
    "utf8",
  );
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(file, future, future);

  assert.equal(readClaudeStatuslineUsage(root).rateLimits.primary.used_percent, 88);
});
