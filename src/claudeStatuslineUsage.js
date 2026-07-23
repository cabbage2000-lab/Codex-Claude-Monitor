const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The helper script scripts/usage-cache.sh writes this file under the Claude data
// directory. It mirrors the `rate_limits` block of Claude Code's statusline stdin
// (the only place the OAuth /api/oauth/usage subscription limits are exposed to a
// user script), plus a capturedAt timestamp. See docs/specs for the discovery trail.
const CACHE_FILE_NAME = ".usage-cache.json";

function getDefaultClaudeRoot() {
  return path.join(os.homedir(), ".claude");
}

// Statusline stdin uses `used_percentage` (0-100) and `resets_at` (Unix seconds).
// Both windows and the reset timestamp are optional. A present window with a
// non-numeric percent is treated as invalid input (whole read fails), matching the
// provider contract that a rate-limit window is either well-formed or absent.
function toWindow(source, windowMinutes) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const usedPercent = source.used_percentage;
  if (!Number.isFinite(usedPercent)) {
    return null;
  }
  const window = { used_percent: usedPercent, window_minutes: windowMinutes };
  if (Number.isFinite(source.resets_at)) {
    window.resets_at = source.resets_at;
  }
  return window;
}

// The status bar refreshes every few seconds; cache the parsed result by (mtime, size).
const cache = new Map();

function parseCache(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const rateLimitsSource = payload && payload.rate_limits;
  if (!rateLimitsSource || typeof rateLimitsSource !== "object") {
    return null;
  }

  const primary = toWindow(rateLimitsSource.five_hour, 300);
  const secondary = toWindow(rateLimitsSource.seven_day, 10080);
  // A present-but-malformed window (null) invalidates the whole read.
  if (primary === null || secondary === null) {
    return null;
  }

  const rateLimits = {};
  if (primary) {
    rateLimits.primary = primary;
  }
  if (secondary) {
    rateLimits.secondary = secondary;
  }
  if (!rateLimits.primary && !rateLimits.secondary) {
    return null;
  }

  return {
    rateLimits,
    capturedAt: Number.isFinite(payload.capturedAt) ? payload.capturedAt : null,
  };
}

// Read the statusline usage cache and map it to the unified rateLimits shape shared
// with Codex ({ primary, secondary } with used_percent / window_minutes / resets_at),
// plus capturedAt (Unix seconds). Returns null on any failure so callers can fall
// through to the previous value.
function readClaudeStatuslineUsage(claudeRoot = getDefaultClaudeRoot()) {
  const file = path.join(claudeRoot, CACHE_FILE_NAME);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(file);
  if (cached && cached.key === cacheKey) {
    return cached.result;
  }

  const result = parseCache(file);
  cache.set(file, { key: cacheKey, result });
  return result;
}

module.exports = {
  CACHE_FILE_NAME,
  getDefaultClaudeRoot,
  readClaudeStatuslineUsage,
};
