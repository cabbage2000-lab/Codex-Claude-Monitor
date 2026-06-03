const { readLatestUsage: readLatestCodexUsage } = require("./codexUsage");
const { readLatestClaudeUsage } = require("./claudeUsage");

// 每个 provider 返回统一结构：{ provider, sessionFile, updatedAt, contextTokens,
// contextWindow, contextPercent, ... }。新增 provider 时在 candidates 里追加一项即可。
function readLatestAgentUsage(options = {}) {
  const workspaceFolders = options.workspaceFolders || [];
  const candidates = [
    readLatestCodexUsage(options.codexSessionsRoot, workspaceFolders),
    readLatestClaudeUsage(options.claudeRoot, workspaceFolders),
  ].filter(Boolean);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
}

function formatCount(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  if (Math.abs(value) >= 1000000) {
    return `${Number((value / 1000000).toFixed(1))}m`;
  }
  if (Math.abs(value) >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

function formatAgentUsage(usage) {
  if (!usage) {
    return {
      text: "n/a",
      tooltip: "No Codex or Claude Code token usage found yet.",
    };
  }

  const provider = usage.provider || "Agent";
  const contextPercent = Number.isFinite(usage.contextPercent) ? `${usage.contextPercent}%` : "n/a";
  const tooltip = `${provider}: Context ${formatCount(usage.contextTokens)} / ${formatCount(usage.contextWindow)} (${contextPercent})`;

  return {
    text: `${provider} ${contextPercent}`,
    tooltip,
  };
}

module.exports = {
  formatAgentUsage,
  formatCount,
  readLatestAgentUsage,
};
