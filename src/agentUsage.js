const { readLatestUsage: readLatestCodexUsage } = require("./codexUsage");
const { readLatestClaudeUsage } = require("./claudeUsage");

// Claude rate-limit snapshots older than this are hidden instead of being shown
// as current fact. Matches the 1-hour TTL Claude Code applies to its own
// persisted utilization cache. Only snapshots that carry a capture time are
// subject to this — Codex limits come from live session JSONL and never expire.
const RATE_LIMITS_MAX_AGE_MS = 3600000;

// Pick the freshest of several rate-limit snapshots, each { rateLimits, capturedAt }.
// Used to reconcile the OAuth read with the statusline bridge: whichever observed
// the limits most recently wins, so terminal and VS Code-only workflows both work.
function pickFreshestRateLimitSnapshot(candidates) {
  return (candidates || [])
    .filter((candidate) => candidate && candidate.rateLimits)
    .sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0))[0] || null;
}

// True when a snapshot's capture time is older than maxAgeMs. A snapshot without
// a capture time is never stale, keeping provider-supplied limits (Codex) as-is.
function isRateLimitSnapshotStale(capturedAtSeconds, now, maxAgeMs = RATE_LIMITS_MAX_AGE_MS) {
  if (!Number.isFinite(capturedAtSeconds)) {
    return false;
  }
  return now - capturedAtSeconds * 1000 > maxAgeMs;
}

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

  const usage = candidates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  // Claude JSONL carries no rate-limit data; attach the value read from the
  // statusline cache by the caller. Never overwrite provider-supplied rateLimits
  // (future-proofing). capturedAt rides along so the tooltip can note its age.
  if (usage.provider === "Claude" && options.claudeRateLimits && !usage.rateLimits) {
    usage.rateLimits = options.claudeRateLimits;
    if (Number.isFinite(options.claudeRateLimitsCapturedAt)) {
      usage.rateLimitsCapturedAt = options.claudeRateLimitsCapturedAt;
    }
  }
  return usage;
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

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Friendly Claude model label, e.g. "claude-opus-4-8" -> "Opus 4.8",
// "claude-opus-5[1m]" -> "Opus 5", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5".
// Returns null for unrecognized models (Codex, third-party providers).
//
// The version is matched as one or two digits followed by a non-digit, which is
// what keeps a trailing release date out of the label: in "haiku-4-5-20251001"
// the minor group can only take "5", and in the legacy "sonnet-20241022" form
// nothing matches at all, so it falls through to the legacy pattern below.
function formatModelName(model) {
  const value = String(model || "").toLowerCase();

  // Current ids lead with the family: claude-opus-4-8, claude-opus-5, claude-sonnet-5,
  // claude-fable-5, claude-haiku-4-5-20251001. The minor version is optional.
  const current = value.match(/(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/);
  if (current) {
    const version = current[3] ? `${current[2]}.${current[3]}` : current[2];
    return `${capitalize(current[1])} ${version}`;
  }

  // Claude 3.x ids lead with the version instead: claude-3-5-sonnet-20241022, claude-3-opus-20240229.
  const legacy = value.match(/claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)/);
  if (legacy) {
    const version = legacy[2] ? `${legacy[1]}.${legacy[2]}` : legacy[1];
    return `${capitalize(legacy[3])} ${version}`;
  }

  return null;
}

// Claude token-composition rows for the tooltip. Empty for providers without this breakdown (e.g. Codex).
function formatClaudeTokenDetail(usage) {
  if (!usage) {
    return [];
  }
  const input = usage.input_tokens;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheCreate = usage.cache_creation_input_tokens;
  if (![input, cacheRead, cacheCreate].some(Number.isFinite)) {
    return [];
  }
  const rows = [
    `Tokens: input ${formatCount(input || 0)} · cache read ${formatCount(cacheRead || 0)} · cache create ${formatCount(cacheCreate || 0)}`,
  ];
  const total = (input || 0) + (cacheRead || 0) + (cacheCreate || 0);
  if (total > 0) {
    rows.push(`Cache hit: ${Math.round(((cacheRead || 0) / total) * 100)}%`);
  }
  return rows;
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

// Relative time until reset, e.g. "38m", "2h 13m", "4d 21h". Total minutes are
// rounded up so the countdown never reads "0m"; at most two units, with a zero
// minor unit omitted. Returns null when resets_at is invalid or not in the future.
function formatTimeLeft(resetsAtSeconds, now) {
  if (!Number.isFinite(resetsAtSeconds)) {
    return null;
  }
  const deltaMs = resetsAtSeconds * 1000 - now;
  if (deltaMs <= 0) {
    return null;
  }
  const totalMinutes = Math.ceil(deltaMs / 60000);
  if (totalMinutes >= 24 * 60) {
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}

// Relative elapsed time since a past timestamp, e.g. "just now", "2m ago",
// "3h ago", "1d ago". Under a minute reads "just now"; a future timestamp (clock
// skew) also reads "just now". At most one unit. Null for invalid input.
function formatTimeAgo(sinceSeconds, now) {
  if (!Number.isFinite(sinceSeconds)) {
    return null;
  }
  const deltaMs = now - sinceSeconds * 1000;
  if (deltaMs < 60000) {
    return "just now";
  }
  const totalMinutes = Math.floor(deltaMs / 60000);
  if (totalMinutes >= 24 * 60) {
    return `${Math.floor(totalMinutes / (24 * 60))}d ago`;
  }
  if (totalMinutes >= 60) {
    return `${Math.floor(totalMinutes / 60)}h ago`;
  }
  return `${totalMinutes}m ago`;
}

// Tooltip row noting when the statusline rate-limit snapshot was captured, e.g.
// "Usage updated 2m ago (11:58)". Null when capturedAt is missing/invalid.
function formatUsageCaptureRow(capturedAtSeconds, now) {
  const ago = formatTimeAgo(capturedAtSeconds, now);
  if (!ago) {
    return null;
  }
  const at = formatResetTime(capturedAtSeconds, now);
  return at ? `Usage updated ${ago} (${at})` : `Usage updated ${ago}`;
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
  if (typeof limitWindow.label === "string" && limitWindow.label) {
    // Model-scoped windows carry their own label: several share one window
    // length, so the duration alone cannot tell them apart.
    label = limitWindow.label;
  } else if (minutes >= 7 * 24 * 60) {
    label = "Weekly usage";
  } else if (minutes <= 24 * 60) {
    label = `${Math.round(minutes / 60)}h usage`;
  } else {
    label = `${Math.round(minutes / (24 * 60))}d usage`;
  }
  const percent = `${Math.round(limitWindow.used_percent)}%`;
  const reset = formatResetTime(limitWindow.resets_at, now);
  if (!reset) {
    return `${label}: ${percent}`;
  }
  // A reset already in the past (stale session data) keeps the absolute time only.
  const timeLeft = formatTimeLeft(limitWindow.resets_at, now);
  return timeLeft
    ? `${label}: ${percent} · Reset at ${reset} (in ${timeLeft})`
    : `${label}: ${percent} · Reset at ${reset}`;
}

// Convert rate_limits into tooltip rows. primary is usually 5h; secondary is
// weekly. `scoped` holds optional model-scoped windows (Claude only) and is
// tooltip-only — the status bar keeps just the two headline percentages.
function formatRateLimits(rateLimits, now = Date.now()) {
  if (!rateLimits) {
    return [];
  }
  const scoped = Array.isArray(rateLimits.scoped) ? rateLimits.scoped : [];
  return [rateLimits.primary, rateLimits.secondary, ...scoped]
    .map((limitWindow) => formatRateLimitWindow(limitWindow, now))
    .filter(Boolean);
}

// Status-bar codicon for a rate-limit window: hour-scale -> "$(history)" (clock), multi-day -> "$(calendar)".
function rateLimitWindowIcon(minutes) {
  if (minutes <= 24 * 60) {
    return "$(history)";
  }
  return "$(calendar)";
}

// Compact status-bar rate-limit segments, e.g. ["$(history) 45%", "$(calendar) 23%"]. Missing fields omit the segment.
function formatRateLimitsStatusBar(rateLimits) {
  if (!rateLimits) {
    return [];
  }
  return [rateLimits.primary, rateLimits.secondary]
    .map((limitWindow) => {
      if (
        !limitWindow ||
        !Number.isFinite(limitWindow.used_percent) ||
        !Number.isFinite(limitWindow.window_minutes)
      ) {
        return null;
      }
      return `${rateLimitWindowIcon(limitWindow.window_minutes)} ${Math.round(limitWindow.used_percent)}%`;
    })
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
  const modelName = formatModelName(usage.model);
  const isOneMillion = usage.contextWindow >= 1000000;
  const lines = [
    `${provider}: ctx ${formatCount(usage.contextTokens)} / ${formatCount(usage.contextWindow)} (${contextPercent})`,
  ];
  if (usage.model) {
    const modelDisplay = modelName
      ? `${modelName}${isOneMillion ? " (1M context)" : ""}`
      : usage.model;
    lines.push(`Model: ${modelDisplay}`);
  }
  lines.push(...formatClaudeTokenDetail(usage.usage));
  // A snapshot we can no longer vouch for is dropped rather than displayed:
  // a wrong limit percentage is worse than no limit percentage.
  const stale = isRateLimitSnapshotStale(usage.rateLimitsCapturedAt, now);
  const availableRateLimitRows = formatRateLimits(usage.rateLimits, now);
  const rateLimitRows = stale ? [] : availableRateLimitRows;
  lines.push(...rateLimitRows);
  // The capture-time row only makes sense next to snapshot-sourced rate limits.
  if (rateLimitRows.length > 0) {
    const captureRow = formatUsageCaptureRow(usage.rateLimitsCapturedAt, now);
    if (captureRow) {
      lines.push(captureRow);
    }
  } else if (availableRateLimitRows.length > 0) {
    // Only say something was hidden when there really was something to hide.
    const ago = formatTimeAgo(usage.rateLimitsCapturedAt, now);
    lines.push(`Rate limits hidden — last snapshot ${ago} (stale)`);
  }

  const textParts = [`${provider} $(comment) ${contextPercent}`];
  textParts.push(...formatRateLimitsStatusBar(stale ? null : usage.rateLimits));

  return {
    text: textParts.join(" · "),
    tooltip: lines.join("\n"),
    severity: getUsageSeverity(usage.contextPercent),
  };
}

module.exports = {
  RATE_LIMITS_MAX_AGE_MS,
  formatAgentUsage,
  formatClaudeTokenDetail,
  formatCount,
  formatModelName,
  formatRateLimits,
  formatRateLimitsStatusBar,
  formatTimeAgo,
  formatTimeLeft,
  getUsageSeverity,
  isRateLimitSnapshotStale,
  pickFreshestRateLimitSnapshot,
  readLatestAgentUsage,
};
