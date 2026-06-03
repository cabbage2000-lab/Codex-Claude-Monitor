const { readLatestUsage: readLatestCodexUsage } = require("./codexUsage");
const { readLatestClaudeUsage } = require("./claudeUsage");

// Each provider returns the same shape: { provider, sessionFile, updatedAt, contextTokens,
// contextWindow, contextPercent, ... }. Add new providers to candidates.
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

// Usage severity: <50% is low, 50-79% is medium, >=80% is high; invalid percentages return null.
function getUsageSeverity(contextPercent) {
  if (!Number.isFinite(contextPercent)) {
    return null;
  }
  if (contextPercent < 50) {
    return "low";
  }
  if (contextPercent < 80) {
    return "medium";
  }
  return "high";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// Convert resets_at in Unix seconds. Same day uses "HH:mm"; other days use "M/D HH:mm".
function formatResetTime(resetsAtSeconds, now) {
  if (!Number.isFinite(resetsAtSeconds)) {
    return null;
  }
  const resetDate = new Date(resetsAtSeconds * 1000);
  const nowDate = new Date(now);
  const sameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();
  const time = `${pad2(resetDate.getHours())}:${pad2(resetDate.getMinutes())}`;
  return sameDay ? time : `${resetDate.getMonth() + 1}/${resetDate.getDate()} ${time}`;
}

// Convert one rate-limit window into a display row. Missing fields omit the row.
function formatRateLimitWindow(limitWindow, now) {
  if (
    !limitWindow ||
    !Number.isFinite(limitWindow.used_percent) ||
    !Number.isFinite(limitWindow.window_minutes)
  ) {
    return null;
  }
  const minutes = limitWindow.window_minutes;
  let label;
  if (minutes >= 7 * 24 * 60) {
    label = "Weekly usage";
  } else if (minutes <= 24 * 60) {
    label = `${Math.round(minutes / 60)}h usage`;
  } else {
    label = `${Math.round(minutes / (24 * 60))}d usage`;
  }
  const percent = `${Math.round(limitWindow.used_percent)}%`;
  const reset = formatResetTime(limitWindow.resets_at, now);
  return reset ? `${label}: ${percent} · Reset at ${reset}` : `${label}: ${percent}`;
}

// Convert Codex rate_limits into tooltip rows. primary is usually 5h; secondary is weekly.
function formatRateLimits(rateLimits, now = Date.now()) {
  if (!rateLimits) {
    return [];
  }
  return [rateLimits.primary, rateLimits.secondary]
    .map((limitWindow) => formatRateLimitWindow(limitWindow, now))
    .filter(Boolean);
}

function formatAgentUsage(usage, now = Date.now()) {
  if (!usage) {
    return {
      text: "n/a",
      tooltip: "No Codex or Claude Code token usage found yet.",
      severity: null,
    };
  }

  const provider = usage.provider || "Agent";
  const contextPercent = Number.isFinite(usage.contextPercent) ? `${usage.contextPercent}%` : "n/a";
  const lines = [
    `${provider}: Context ${formatCount(usage.contextTokens)} / ${formatCount(usage.contextWindow)} (${contextPercent})`,
  ];
  if (usage.model) {
    lines.push(`Model: ${usage.model}`);
  }
  lines.push(...formatRateLimits(usage.rateLimits, now));

  return {
    text: `${provider} ${contextPercent}`,
    tooltip: lines.join("\n"),
    severity: getUsageSeverity(usage.contextPercent),
  };
}

module.exports = {
  formatAgentUsage,
  formatCount,
  formatRateLimits,
  getUsageSeverity,
  readLatestAgentUsage,
};
