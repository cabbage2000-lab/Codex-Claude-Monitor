const { execSync } = require("node:child_process");
const {
  formatClaudeTokenDetail,
  formatCount,
  formatModelName,
} = require("./agentUsage");

// Indent every line of a (possibly multi-line) block by two spaces for nested readability.
function indentBlock(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

// Build the auto-collected metadata block from the latest usage + git info. Unknown fields are
// omitted so the prompt degrades gracefully when a provider lacks them or git is unavailable.
function buildMetadataRows(usage, gitInfo) {
  const rows = [];

  if (usage) {
    rows.push(`- Session: ${usage.provider || "Agent"}`);
    if (usage.sessionFile) {
      rows.push(`- Session file: ${usage.sessionFile}`);
    }
    const hasCtx =
      Number.isFinite(usage.contextTokens) && Number.isFinite(usage.contextWindow);
    if (hasCtx) {
      const pct = Number.isFinite(usage.contextPercent) ? ` (${usage.contextPercent}%)` : "";
      rows.push(
        `- Context: ${formatCount(usage.contextTokens)} / ${formatCount(usage.contextWindow)}${pct} ← near limit, consider handing off`,
      );
    } else if (Number.isFinite(usage.contextPercent)) {
      rows.push(`- Context: ${usage.contextPercent}% ← near limit, consider handing off`);
    }
    if (usage.model) {
      rows.push(`- Model: ${formatModelName(usage.model) || usage.model}`);
    }
    for (const tokenRow of formatClaudeTokenDetail(usage.usage)) {
      rows.push(`- ${tokenRow}`);
    }
  }

  if (gitInfo) {
    if (gitInfo.branch) {
      rows.push(`- Git branch: ${gitInfo.branch}`);
    }
    if (gitInfo.status) {
      rows.push("- Git status:", indentBlock(gitInfo.status));
    }
    if (gitInfo.recentCommits) {
      rows.push("- Recent commits:", indentBlock(gitInfo.recentCommits));
    }
  }

  return rows;
}

// The handoff skeleton, modeled on promptify's handoff.md. Section labels stay in English for
// host compatibility; placeholders are filled by the current session's Claude after paste.
const HANDOFF_SKELETON = `## Generate the handoff prompt using this skeleton (fill placeholders from session facts; stay truthful, do not invent unfinished progress)

Continue this work from the previous session. <One-line restatement of the task goal with a verifiable completion condition.>

Context to read first:
- <PLAN.md / CLAUDE.md / relevant files, plans, issues, or logs>
- Run \`git status\` and \`git diff\` to confirm the real current state

Progress so far (do not redo):
- <Completed item: which file changed / what decision was made / what verification passed>

Where it stopped:
- <The current breakpoint: what was being done last and why it stopped>

Next:
- <Next step>

Constraints:
- <Hard constraint: scope boundaries, code style, dependencies, compatibility, locked decisions>
- <Preserve unrelated user changes; keep edits surgical>

Done when:
1. <Verifiable artifact or behavior, citing specific files, commands, tests, or logs>
2. <Final report covers changes, verification, risks, and remaining items>

Stop if:
- <Stop and ask on scope-expanding changes, destructive operations, secret/production risk, or ambiguity>
- <Stop and present evidence when key verification fails repeatedly or product judgment is needed>`;

// Compose a paste-ready handoff prompt from the latest usage and git info.
function buildHandoffPrompt(usage, gitInfo) {
  const rows = buildMetadataRows(usage, gitInfo);
  const metadataSection =
    rows.length > 0
      ? ["## Current session (auto-collected by Codex-Claude-Monitor)", ...rows].join("\n")
      : "";

  const header =
    "Generate a paste-ready handoff (continuation) prompt for the current session, filling in the placeholders below.";

  return [header, metadataSection, HANDOFF_SKELETON].filter(Boolean).join("\n\n");
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
