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
