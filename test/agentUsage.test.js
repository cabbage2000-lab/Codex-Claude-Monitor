const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { formatAgentUsage, readLatestAgentUsage } = require("../src/agentUsage");
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
  assert.equal(formatted.text, "Codex 3%");
  assert.equal(formatted.tooltip, "Codex: Context 8k / 258k (3%)");
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
  assert.equal(formatted.text, "Claude 18%");
  assert.equal(formatted.tooltip, "Claude: Context 185k / 1m (18%)");
});
