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

// 用量等级：<50% → "low"，50–79% → "medium"，≥80% → "high"；无有效百分比 → null。
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

// resets_at（unix 秒）→ 与 now 同一天显示 "HH:mm"，跨天显示 "M/D HH:mm"。
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

// 单个限额窗口 → 展示行；缺 used_percent / window_minutes 时返回 null（省略该行）。
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
    label = "周用量";
  } else if (minutes <= 24 * 60) {
    label = `${Math.round(minutes / 60)}h 用量`;
  } else {
    label = `${Math.round(minutes / (24 * 60))}d 用量`;
  }
  const percent = `${Math.round(limitWindow.used_percent)}%`;
  const reset = formatResetTime(limitWindow.resets_at, now);
  return reset ? `${label}: ${percent} · 重置于 ${reset}` : `${label}: ${percent}`;
}

// Codex rate_limits（primary=5h 窗口，secondary=周窗口）→ tooltip 展示行数组。
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
    lines.push(`模型: ${usage.model}`);
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
