const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  formatAgentUsage,
  formatClaudeTokenDetail,
  formatModelName,
  formatRateLimits,
  formatRateLimitsStatusBar,
  formatTimeLeft,
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
  assert.equal(formatted.text, "Codex $(comment) 3%");
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
  assert.equal(formatted.text, "Claude $(comment) 18%");
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
    "5h usage: 21% · Reset at 14:32 (in 2h 32m)",
    "Weekly usage: 10% · Reset at 6/8 09:24 (in 4d 21h)",
  ]);
});

// The fixture dates sit in early June / early July, away from any DST switch, so
// the relative durations stay deterministic across time zones.
test("formatTimeLeft renders compact countdowns and rejects past times", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const at = (seconds) => now / 1000 + seconds;

  assert.equal(formatTimeLeft(at(30), now), "1m");
  assert.equal(formatTimeLeft(at(59 * 60 + 30), now), "1h");
  assert.equal(formatTimeLeft(at(60 * 60), now), "1h");
  assert.equal(formatTimeLeft(at(2 * 3600 + 13 * 60), now), "2h 13m");
  assert.equal(formatTimeLeft(at(24 * 3600), now), "1d");
  // The day scale keeps at most two units: leftover minutes are dropped.
  assert.equal(formatTimeLeft(at(24 * 3600 + 25 * 60), now), "1d");
  assert.equal(formatTimeLeft(at(4 * 86400 + 21 * 3600 + 24 * 60), now), "4d 21h");
  assert.equal(formatTimeLeft(at(7 * 86400), now), "7d");

  assert.equal(formatTimeLeft(at(0), now), null);
  assert.equal(formatTimeLeft(at(-60), now), null);
  assert.equal(formatTimeLeft(undefined, now), null);
  assert.equal(formatTimeLeft(NaN, now), null);
  assert.equal(formatTimeLeft("soon", now), null);
});

test("formatRateLimits keeps the absolute reset time without countdown once passed", () => {
  const now = new Date(2026, 5, 3, 12, 0).getTime();
  const pastReset = Math.floor(new Date(2026, 5, 3, 11, 59).getTime() / 1000);

  assert.deepEqual(
    formatRateLimits(
      { primary: { used_percent: 21, window_minutes: 300, resets_at: pastReset } },
      now,
    ),
    ["5h usage: 21% · Reset at 11:59"],
  );
  // A reset exactly at `now` also omits the countdown.
  assert.deepEqual(
    formatRateLimits(
      { primary: { used_percent: 21, window_minutes: 300, resets_at: now / 1000 } },
      now,
    ),
    ["5h usage: 21% · Reset at 12:00"],
  );
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

test("formatRateLimitsStatusBar renders compact segments for both windows", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 45.4, window_minutes: 300 },
    secondary: { used_percent: 23.0, window_minutes: 10080 },
  });
  assert.deepEqual(segments, ["$(history) 45%", "$(calendar) 23%"]);
});

test("formatRateLimitsStatusBar maps mid-length windows to the calendar icon", () => {
  const segments = formatRateLimitsStatusBar({
    primary: { used_percent: 55.6, window_minutes: 2880 },
  });
  assert.deepEqual(segments, ["$(calendar) 56%"]);
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

  assert.equal(formatted.text, "Codex $(comment) 3% · $(history) 21% · $(calendar) 10%");
  assert.equal(
    formatted.tooltip,
    [
      "Codex: ctx 8k / 258k (3%)",
      "5h usage: 21% · Reset at 14:32 (in 2h 32m)",
      "Weekly usage: 10% · Reset at 6/8 09:24 (in 4d 21h)",
    ].join("\n"),
  );
});

test("formatAgentUsage appends countdown rows for Claude probe rate limits", () => {
  const now = new Date(2026, 6, 7, 12, 0).getTime();
  const sessionReset = Math.floor(new Date(2026, 6, 7, 20, 20).getTime() / 1000);
  const weekReset = Math.floor(new Date(2026, 6, 14, 1, 0).getTime() / 1000);

  const formatted = formatAgentUsage(
    {
      provider: "Claude",
      model: "claude-opus-4-8",
      contextTokens: 185000,
      contextWindow: 1000000,
      contextPercent: 18,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 185000,
        cache_creation_input_tokens: 155,
      },
      rateLimits: {
        primary: { used_percent: 25, window_minutes: 300, resets_at: sessionReset },
        secondary: { used_percent: 8, window_minutes: 10080, resets_at: weekReset },
      },
    },
    now,
  );

  assert.equal(
    formatted.tooltip,
    [
      "Claude: ctx 185k / 1m (18%)",
      "Model: Opus 4.8 (1M context)",
      "Tokens: input 2 · cache read 185k · cache create 155",
      "Cache hit: 100%",
      "5h usage: 25% · Reset at 20:20 (in 8h 20m)",
      "Weekly usage: 8% · Reset at 7/14 01:00 (in 6d 13h)",
    ].join("\n"),
  );
});

test("formatAgentUsage keeps Claude model details in the tooltip only", () => {
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
  assert.equal(formatted.text, "Claude $(comment) 18%");
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

  assert.equal(formatted.text, "Claude $(comment) 50%");
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
  assert.match(formatAgentUsage(usage).text, /^Claude \$\(comment\) \d+% · \$\(history\) 25% · \$\(calendar\) 8%$/);
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
