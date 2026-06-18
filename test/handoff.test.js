const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const test = require("node:test");

const { buildHandoffPrompt, collectGitInfo } = require("../src/handoff");
const { makeTempDir } = require("./testUtils");

const SAMPLE_USAGE = {
  provider: "Claude",
  sessionFile: "/home/u/.claude/projects/proj/session.jsonl",
  contextTokens: 850000,
  contextWindow: 1000000,
  contextPercent: 85,
  model: "claude-opus-4-8",
  usage: { input_tokens: 2, cache_read_input_tokens: 849000, cache_creation_input_tokens: 998 },
};

const SAMPLE_GIT = {
  branch: "feature/x",
  status: " M src/a.js\n?? src/b.js",
  recentCommits: "abc1234 fix bug\ndef5678 init",
};

test("buildHandoffPrompt embeds session metadata", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, null);
  assert.match(prompt, /Claude/);
  assert.match(prompt, /session\.jsonl/);
  assert.match(prompt, /85%/);
  assert.match(prompt, /850k/);
});

test("buildHandoffPrompt includes all promptify section labels", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, null);
  for (const label of [
    "Context to read first",
    "Progress so far",
    "Where it stopped",
    "Next:",
    "Constraints:",
    "Done when:",
    "Stop if:",
  ]) {
    assert.ok(prompt.includes(label), `missing section label: ${label}`);
  }
});

test("buildHandoffPrompt embeds Claude token composition", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, null);
  assert.match(prompt, /cache read/);
});

test("buildHandoffPrompt embeds git branch, status, and recent commits", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  assert.match(prompt, /feature\/x/);
  assert.match(prompt, /src\/a\.js/);
  assert.match(prompt, /abc1234 fix bug/);
});

test("buildHandoffPrompt omits git rows when gitInfo is null", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, null);
  assert.ok(!prompt.includes("Git branch:"));
});

test("buildHandoffPrompt uses English labels and guidance", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  for (const label of [
    "Session:",
    "Context:",
    "Model:",
    "Git branch:",
    "Git status:",
    "Recent commits:",
  ]) {
    assert.ok(prompt.includes(label), `missing English label: ${label}`);
  }
  // Header and skeleton guidance are English, not Chinese.
  assert.ok(!/[一-鿿]/.test(prompt));
});

test("buildHandoffPrompt omits token composition when usage breakdown is missing", () => {
  const prompt = buildHandoffPrompt(
    { ...SAMPLE_USAGE, usage: undefined },
    null,
  );
  assert.ok(!/cache read/.test(prompt));
});

test("buildHandoffPrompt still produces a skeleton when usage is null", () => {
  const prompt = buildHandoffPrompt(null, null);
  assert.ok(prompt.includes("Progress so far"));
  assert.ok(prompt.includes("Stop if:"));
});

test("collectGitInfo reads branch, status, and commits from a git repo", () => {
  const dir = makeTempDir();
  const opts = { cwd: dir };
  execSync("git init -q", opts);
  execSync("git config user.email t@t.com", opts);
  execSync("git config user.name t", opts);
  execSync('git commit --allow-empty -q -m "first commit"', opts);
  execSync("git checkout -q -b feature/y", opts);

  const info = collectGitInfo(dir);
  assert.equal(info.branch, "feature/y");
  assert.match(info.recentCommits, /first commit/);
  assert.equal(info.status, "");
});

test("collectGitInfo returns null in a non-git directory", () => {
  const dir = makeTempDir();
  const info = collectGitInfo(dir);
  assert.equal(info, null);
});
