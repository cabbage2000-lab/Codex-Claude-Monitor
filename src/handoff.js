const { execSync } = require("node:child_process");

// One-line context summary, e.g. "at 85%". Returns null when percent is unknown.
function contextSummary(usage) {
  if (!usage || !Number.isFinite(usage.contextPercent)) {
    return null;
  }
  return `at ${usage.contextPercent}%`;
}

// Compose a compact, paste-ready handoff prompt. Only facts the model cannot infer from the
// session itself are included (why hand off, where to continue); the skeleton trusts the model
// to fill each one-line placeholder from context instead of spelling out every section.
function buildHandoffPrompt(usage, gitInfo) {
  const summary = contextSummary(usage);
  const header = summary
    ? `Continue this work in a fresh context (previous session ${summary}).`
    : "Continue this work in a fresh context.";

  const lines = [header, ""];

  if (usage && usage.sessionFile) {
    lines.push(`Session: ${usage.sessionFile}`);
  }
  if (gitInfo && gitInfo.branch) {
    lines.push(`Branch: ${gitInfo.branch}`);
  }
  if (lines.length > 2) {
    lines.push("");
  }

  lines.push(
    "Task: <one-line goal>",
    "Done: <completed work — do not redo>",
    "Next: <where it stopped + immediate next step>",
    "Constraints: <locked decisions / scope>",
  );

  return lines.join("\n");
}

// Run a git command in cwd and return trimmed stdout, or null if git/cwd is not a repo.
function runGit(args, cwd) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Collect branch, short status, and recent oneline commits for cwd. Returns null when cwd is not
// inside a git repo (or git is unavailable) so callers can omit the git rows cleanly.
function collectGitInfo(cwd) {
  const branch = runGit("rev-parse --abbrev-ref HEAD", cwd);
  if (branch === null) {
    return null;
  }
  return {
    branch,
    status: runGit("status --short", cwd) || "",
    recentCommits: runGit("log -n 5 --oneline", cwd) || "",
  };
}

module.exports = {
  buildHandoffPrompt,
  collectGitInfo,
};
