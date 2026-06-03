const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { findLatestSessionFile, readLatestUsage } = require("../src/codexUsage");
const { makeTempDir, setMtime, writeJsonl } = require("./testUtils");

test("findLatestSessionFile returns the most recently modified rollout file", () => {
  const root = makeTempDir("agent-token-status-codex-");
  const older = path.join(root, "2026", "06", "02", "rollout-old.jsonl");
  const newer = path.join(root, "2026", "06", "03", "rollout-new.jsonl");

  writeJsonl(older, []);
  writeJsonl(newer, []);
  setMtime(older, new Date("2026-06-02T00:00:00Z"));
  setMtime(newer, new Date("2026-06-03T00:00:00Z"));

  assert.equal(findLatestSessionFile(root), newer);
});

test("readLatestUsage extracts the last token_count event from a session", () => {
  const root = makeTempDir("agent-token-status-codex-");
  const session = path.join(root, "2026", "06", "03", "rollout-test.jsonl");
  writeJsonl(session, [
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: 1000, input_tokens: 800, output_tokens: 200 },
          last_token_usage: { total_tokens: 1000 },
          model_context_window: 10000,
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 34000,
            input_tokens: 31000,
            cached_input_tokens: 12000,
            output_tokens: 3000,
            reasoning_output_tokens: 200,
          },
          last_token_usage: {
            total_tokens: 9000,
            input_tokens: 8200,
            output_tokens: 800,
            reasoning_output_tokens: 100,
          },
          model_context_window: 258400,
        },
      },
      rate_limits: {
        primary: { used_percent: 2, window_minutes: 300 },
        secondary: { used_percent: 8, window_minutes: 10080 },
      },
    },
  ]);

  const usage = readLatestUsage(root);

  assert.equal(usage.provider, "Codex");
  assert.equal(usage.sessionFile, session);
  assert.equal(usage.total.total_tokens, 34000);
  assert.equal(usage.last.total_tokens, 9000);
  assert.equal(usage.contextWindow, 258400);
  assert.equal(usage.contextTokens, 8200);
  assert.equal(usage.contextPercent, 3);
  assert.equal(usage.rateLimits.primary.used_percent, 2);
});

test("readLatestUsage returns null when no token_count event exists", () => {
  const root = makeTempDir("agent-token-status-codex-");
  const session = path.join(root, "2026", "06", "03", "rollout-empty.jsonl");
  writeJsonl(session, [{ type: "session_meta", payload: { id: "abc" } }]);

  assert.equal(readLatestUsage(root), null);
});
