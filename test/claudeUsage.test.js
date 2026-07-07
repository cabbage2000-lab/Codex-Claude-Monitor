const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  findLatestClaudeSessionFile,
  inferClaudeContextWindow,
  readLatestClaudeUsage,
} = require("../src/claudeUsage");
const { makeTempDir, setMtime, writeJsonl } = require("./testUtils");

test("findLatestClaudeSessionFile returns the newest Claude project jsonl", () => {
  const root = makeTempDir("codex-claude-monitor-claude-");
  const older = path.join(root, "projects", "-old", "older.jsonl");
  const newer = path.join(root, "projects", "-new", "newer.jsonl");

  writeJsonl(older, []);
  writeJsonl(newer, []);
  setMtime(older, new Date("2026-06-02T00:00:00Z"));
  setMtime(newer, new Date("2026-06-03T00:00:00Z"));

  assert.equal(findLatestClaudeSessionFile(root), newer);
});

test("readLatestClaudeUsage extracts context tokens from the last assistant usage", () => {
  const root = makeTempDir("codex-claude-monitor-claude-");
  const session = path.join(root, "projects", "-workspace", "session.jsonl");
  writeJsonl(session, [
    { type: "user", message: { role: "user", content: "hello" } },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 184794,
          cache_creation_input_tokens: 155,
          output_tokens: 487,
        },
      },
      timestamp: "2026-06-03T10:00:00.000Z",
    },
  ]);

  const usage = readLatestClaudeUsage(root);

  assert.equal(usage.provider, "Claude");
  assert.equal(usage.sessionFile, session);
  assert.equal(usage.contextTokens, 184951);
  assert.equal(usage.contextWindow, 1000000);
  assert.equal(usage.contextPercent, 18);
  assert.equal(usage.updatedAt, new Date("2026-06-03T10:00:00.000Z").getTime());
});

test("inferClaudeContextWindow uses 1m for Opus 4.8 and 200k fallback otherwise", () => {
  assert.equal(inferClaudeContextWindow("claude-opus-4-8"), 1000000);
  assert.equal(inferClaudeContextWindow("claude-opus-4-7"), 1000000);
  assert.equal(inferClaudeContextWindow("claude-sonnet-4"), 200000);
});

test("readLatestClaudeUsage falls back past files without assistant usage", () => {
  const root = makeTempDir("codex-claude-monitor-claude-");
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
