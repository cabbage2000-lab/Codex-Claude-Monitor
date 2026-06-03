const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { readLatestUsage } = require("../src/codexUsage");
const { mungeClaudeProjectPath, readLatestClaudeUsage } = require("../src/claudeUsage");
const { readLatestAgentUsage } = require("../src/agentUsage");
const { makeTempDir, setMtime, writeJsonl } = require("./testUtils");

function codexEntries(cwd, inputTokens, contextWindow) {
  return [
    {
      type: "session_meta",
      payload: { id: "x", cwd, source: "cli" },
    },
    {
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: inputTokens },
          last_token_usage: { input_tokens: inputTokens },
          model_context_window: contextWindow,
        },
      },
    },
  ];
}

function claudeEntries(timestamp, inputTokens) {
  return [
    {
      type: "assistant",
      timestamp,
      message: {
        model: "claude-opus-4-8[1m]",
        usage: { input_tokens: inputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
}

test("codex readLatestUsage skips newer sessions outside the workspace", () => {
  const sessionsRoot = makeTempDir();
  const workspace = makeTempDir();
  const insideFile = path.join(sessionsRoot, "2026", "06", "01", "rollout-inside.jsonl");
  const outsideFile = path.join(sessionsRoot, "2026", "06", "03", "rollout-outside.jsonl");

  writeJsonl(insideFile, codexEntries(workspace, 5000, 100000));
  writeJsonl(outsideFile, codexEntries("/somewhere/else", 9000, 100000));
  setMtime(insideFile, 1000);
  setMtime(outsideFile, 2000);

  const usage = readLatestUsage(sessionsRoot, [workspace]);
  assert.ok(usage);
  assert.equal(usage.sessionFile, insideFile);
  assert.equal(usage.contextTokens, 5000);
});

test("codex readLatestUsage matches sessions in a subdirectory of the workspace", () => {
  const sessionsRoot = makeTempDir();
  const workspace = makeTempDir();
  const file = path.join(sessionsRoot, "2026", "06", "03", "rollout-sub.jsonl");

  writeJsonl(file, codexEntries(path.join(workspace, "packages", "app"), 4000, 100000));

  const usage = readLatestUsage(sessionsRoot, [workspace]);
  assert.ok(usage);
  assert.equal(usage.sessionFile, file);
});

test("codex readLatestUsage returns null when no session matches the workspace", () => {
  const sessionsRoot = makeTempDir();
  const file = path.join(sessionsRoot, "2026", "06", "03", "rollout-x.jsonl");
  writeJsonl(file, codexEntries("/somewhere/else", 4000, 100000));

  assert.equal(readLatestUsage(sessionsRoot, ["/my/workspace"]), null);
});

test("codex readLatestUsage keeps global behavior without workspaceFolders", () => {
  const sessionsRoot = makeTempDir();
  const file = path.join(sessionsRoot, "2026", "06", "03", "rollout-x.jsonl");
  writeJsonl(file, codexEntries("/somewhere/else", 4000, 100000));

  const usage = readLatestUsage(sessionsRoot);
  assert.ok(usage);
  assert.equal(usage.sessionFile, file);
});

test("claude readLatestClaudeUsage only scans project dirs matching the workspace", () => {
  const claudeRoot = makeTempDir();
  const workspace = makeTempDir();
  const matchingDir = mungeClaudeProjectPath(workspace);
  const insideFile = path.join(claudeRoot, "projects", matchingDir, "inside.jsonl");
  const outsideFile = path.join(claudeRoot, "projects", "-somewhere-else", "outside.jsonl");

  writeJsonl(insideFile, claudeEntries("2026-06-01T00:00:00Z", 5000));
  writeJsonl(outsideFile, claudeEntries("2026-06-03T00:00:00Z", 9000));
  setMtime(insideFile, 1000);
  setMtime(outsideFile, 2000);

  const usage = readLatestClaudeUsage(claudeRoot, [workspace]);
  assert.ok(usage);
  assert.equal(usage.sessionFile, insideFile);
  assert.equal(usage.contextTokens, 5000);
});

test("claude filter matches munged subdirectory project dirs", () => {
  const claudeRoot = makeTempDir();
  const workspace = makeTempDir();
  const subDir = `${mungeClaudeProjectPath(workspace)}-packages-app`;
  const file = path.join(claudeRoot, "projects", subDir, "s.jsonl");

  writeJsonl(file, claudeEntries("2026-06-03T00:00:00Z", 4000));

  const usage = readLatestClaudeUsage(claudeRoot, [workspace]);
  assert.ok(usage);
  assert.equal(usage.sessionFile, file);
});

test("claude filter does not match sibling dirs sharing a name prefix", () => {
  const claudeRoot = makeTempDir();
  const workspace = makeTempDir();
  const siblingDir = `${mungeClaudeProjectPath(workspace)}x`;
  const file = path.join(claudeRoot, "projects", siblingDir, "s.jsonl");

  writeJsonl(file, claudeEntries("2026-06-03T00:00:00Z", 4000));

  assert.equal(readLatestClaudeUsage(claudeRoot, [workspace]), null);
});

test("readLatestAgentUsage forwards workspaceFolders to both providers", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const workspace = makeTempDir();

  const codexOutside = path.join(codexRoot, "2026", "06", "03", "rollout-out.jsonl");
  writeJsonl(codexOutside, codexEntries("/somewhere/else", 9000, 100000));
  setMtime(codexOutside, 2000);

  const claudeInside = path.join(
    claudeRoot,
    "projects",
    mungeClaudeProjectPath(workspace),
    "s.jsonl",
  );
  writeJsonl(claudeInside, claudeEntries("2026-06-01T00:00:00Z", 50000));
  setMtime(claudeInside, 1000);

  const usage = readLatestAgentUsage({
    codexSessionsRoot: codexRoot,
    claudeRoot,
    workspaceFolders: [workspace],
  });

  assert.ok(usage);
  assert.equal(usage.provider, "Claude");
  assert.equal(usage.sessionFile, claudeInside);
});

test("readLatestAgentUsage with multi-root workspace matches any folder", () => {
  const codexRoot = makeTempDir();
  const claudeRoot = makeTempDir();
  const workspaceA = makeTempDir();
  const workspaceB = makeTempDir();

  const file = path.join(codexRoot, "2026", "06", "03", "rollout-b.jsonl");
  writeJsonl(file, codexEntries(workspaceB, 4000, 100000));

  const usage = readLatestAgentUsage({
    codexSessionsRoot: codexRoot,
    claudeRoot,
    workspaceFolders: [workspaceA, workspaceB],
  });

  assert.ok(usage);
  assert.equal(usage.provider, "Codex");
  assert.equal(usage.sessionFile, file);
});
