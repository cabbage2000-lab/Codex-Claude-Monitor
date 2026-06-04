const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  formatAgentUsage,
  formatClaudeTokenDetail,
  formatModelName,
  formatRateLimits,
  getUsageSeverity,
  readLatestAgentUsage,
} = require("../src/agentUsage");
const { makeTempDir, setMtime, writeJsonl } = require("./testUtils");

test("readLatestAgentUsage selects Codex when Codex session is newer", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const codexFile = path.join(codexRoot, "2026", "06", "03", "rollout-new.jsonl");
  const claudeFile = path.join(claudeRoot, "projects", "-workspace", "old.jsonl");

  writeJsonl(codexFile, [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 34000 },
          last_token_usage: { input_tokens: 8200, total_tokens: 9000 },
          model_context_window: 258400,
        },
      },
    },
  ]);
  writeJsonl(claudeFile, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      },
    },
  ]);
  setMtime(codexFile, new Date("2026-06-03T00:00:00Z"));
  setMtime(claudeFile, new Date("2026-06-02T00:00:00Z"));

  const usage = readLatestAgentUsage({ codexSessionsRoot: codexRoot, claudeRoot });
  const formatted = formatAgentUsage(usage);

  assert.equal(usage.provider, "Codex");
  assert.equal(formatted.text, "Codex ⚡ 3%");
  assert.equal(formatted.tooltip, "Codex: ctx 8k / 258k (3%)");
  assert.equal(formatted.severity, "low");
});

test("getUsageSeverity maps percent to low/medium/high thresholds", () => {
  assert.equal(getUsageSeverity(0), "low");
  assert.equal(getUsageSeverity(49), "low");
  assert.equal(getUsageSeverity(50), "medium");
  assert.equal(getUsageSeverity(79), "medium");
  assert.equal(getUsageSeverity(80), "high");
  assert.equal(getUsageSeverity(100), "high");
});

test("getUsageSeverity returns null for non-finite values", () => {
  assert.equal(getUsageSeverity(NaN), null);
  assert.equal(getUsageSeverity(undefined), null);
});

test("formatAgentUsage returns null severity when usage is missing", () => {
  assert.equal(formatAgentUsage(null).severity, null);
});

test("readLatestAgentUsage selects Claude when Claude session is newer", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const codexFile = path.join(codexRoot, "2026", "06", "02", "rollout-old.jsonl");
  const claudeFile = path.join(claudeRoot, "projects", "-workspace", "new.jsonl");

  writeJsonl(codexFile, [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 34000 },
          last_token_usage: { input_tokens: 8200, total_tokens: 9000 },
          model_context_window: 258400,
        },
      },
    },
  ]);
  writeJsonl(claudeFile, [
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 2, cache_read_input_tokens: 184794, cache_creation_input_tokens: 155 },
      },
    },
  ]);
  setMtime(codexFile, new Date("2026-06-02T00:00:00Z"));
  setMtime(claudeFile, new Date("2026-06-03T00:00:00Z"));

  const usage = readLatestAgentUsage({ codexSessionsRoot: codexRoot, claudeRoot });
  const formatted = formatAgentUsage(usage);

  assert.equal(usage.provider, "Claude");
  assert.equal(formatted.text, "Claude ⚡ 18% | Opus 4.8 (1M)");
  assert.equal(
    formatted.tooltip,
    [
      "Claude: ctx 185k / 1m (18%)",
      "Model: Opus 4.8 (1M context)",
      "Tokens: input 2 · cache read 185k · cache create 155",
      "Cache hit: 100%",
    ].join("\n"),
  );
  assert.equal(formatted.severity, "low");
});

test("formatRateLimits formats 5h and weekly windows with reset times", () => {
  // Use local time construction so the assertions stay deterministic across time zones.
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
    "5h usage: 21% · Reset at 14:32",
    "Weekly usage: 10% · Reset at 6/8 09:24",
  ]);
});

test("formatRateLimits omits invalid windows and missing reset times", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();

  assert.deepEqual(formatRateLimits(null, now), []);
  assert.deepEqual(formatRateLimits({}, now), []);
  // Missing used_percent omits the entire row.
  assert.deepEqual(
    formatRateLimits({ primary: { window_minutes: 300, resets_at: 1780492366 } }, now),
    [],
  );
  // Missing window_minutes omits the entire row.
  assert.deepEqual(formatRateLimits({ primary: { used_percent: 21 } }, now), []);
  // Missing resets_at omits the reset-time suffix.
  assert.deepEqual(
    formatRateLimits({ primary: { used_percent: 21, window_minutes: 300 } }, now),
    ["5h usage: 21%"],
  );
});

test("formatRateLimits falls back to day label for mid-length windows", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const lines = formatRateLimits(
    { primary: { used_percent: 55.6, window_minutes: 2880 } },
    now,
  );
  assert.deepEqual(lines, ["2d usage: 56%"]);
});

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

  assert.equal(formatted.text, "Codex ⚡ 3% | 5H: 21% | Weekly: 10%");
  assert.equal(
    formatted.tooltip,
    [
      "Codex: ctx 8k / 258k (3%)",
      "5h usage: 21% · Reset at 14:32",
      "Weekly usage: 10% · Reset at 6/8 09:24",
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
    ["Claude: ctx 185k / 1m (18%)", "Model: Opus 4.8 (1M context)"].join("\n"),
  );
  assert.equal(formatted.text, "Claude ⚡ 18% | Opus 4.8 (1M)");
});

test("formatModelName maps Claude model ids to friendly names and ignores others", () => {
  assert.equal(formatModelName("claude-opus-4-8"), "Opus 4.8");
  assert.equal(formatModelName("claude-sonnet-4-6"), "Sonnet 4.6");
  assert.equal(formatModelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(formatModelName("gpt-5"), null);
  assert.equal(formatModelName(undefined), null);
});

test("formatAgentUsage drops the 1M marker for 200k Claude models", () => {
  const formatted = formatAgentUsage({
    provider: "Claude",
    model: "claude-sonnet-4-6",
    contextTokens: 100000,
    contextWindow: 200000,
    contextPercent: 50,
  });

  assert.equal(formatted.text, "Claude ⚡ 50% | Sonnet 4.6");
  assert.match(formatted.tooltip, /Model: Sonnet 4\.6\n?/);
});

test("formatClaudeTokenDetail renders composition and cache-hit rows", () => {
  const rows = formatClaudeTokenDetail({
    input_tokens: 2,
    cache_read_input_tokens: 48913,
    cache_creation_input_tokens: 361,
  });

  assert.deepEqual(rows, [
    "Tokens: input 2 · cache read 49k · cache create 361",
    "Cache hit: 99%",
  ]);
  assert.deepEqual(formatClaudeTokenDetail(undefined), []);
  assert.deepEqual(formatClaudeTokenDetail({ output_tokens: 5 }), []);
});
