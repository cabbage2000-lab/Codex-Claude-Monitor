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
  status: " M src/a.js",
  recentCommits: "abc1234 fix bug",
};

test("buildHandoffPrompt embeds context percent, session file, and branch", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  assert.match(prompt, /85%/);
  assert.match(prompt, /session\.jsonl/);
  assert.match(prompt, /feature\/x/);
});

test("buildHandoffPrompt includes the compact skeleton labels", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  for (const label of ["Task:", "Done:", "Next:", "Constraints:"]) {
    assert.ok(prompt.includes(label), `missing skeleton label: ${label}`);
  }
});

test("buildHandoffPrompt drops verbose sections and per-token breakdown", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  // Removed the verbose promptify sections that the model can infer.
  for (const removed of [
    "Context to read first",
    "Progress so far",
    "Where it stopped",
    "Done when",
    "Stop if:",
  ]) {
    assert.ok(!prompt.includes(removed), `should not contain verbose section: ${removed}`);
  }
  // Per-token breakdown, cache hit, model, and git status/commits are noise for a handoff.
  assert.ok(!/cache read/.test(prompt));
  assert.ok(!/Cache hit/.test(prompt));
  assert.ok(!/Opus/.test(prompt));
  assert.ok(!/src\/a\.js/.test(prompt));
  assert.ok(!/abc1234/.test(prompt));
});

test("buildHandoffPrompt omits the branch line when gitInfo is null", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, null);
  assert.ok(!prompt.includes("Branch:"));
});

test("buildHandoffPrompt still produces a skeleton when usage is null", () => {
  const prompt = buildHandoffPrompt(null, null);
  assert.ok(prompt.includes("Task:"));
  assert.ok(prompt.includes("Next:"));
});

test("buildHandoffPrompt uses English only (no CJK)", () => {
  const prompt = buildHandoffPrompt(SAMPLE_USAGE, SAMPLE_GIT);
  assert.ok(!/[一-鿿]/.test(prompt));
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
