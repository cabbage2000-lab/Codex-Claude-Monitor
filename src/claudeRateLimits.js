const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Parse the plain-text output of `claude -p "/usage"` into the unified rateLimits
// shape shared with Codex. Unmatched windows are omitted; null when nothing matches.
function parseUsageOutput(text) {
  if (!text) {
    return null;
  }
  const primaryMatch = String(text).match(/^Current session:\s*(\d+(?:\.\d+)?)%\s*used/m);
  const secondaryMatch = String(text).match(
    /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used/m,
  );
  const rateLimits = {};
  if (primaryMatch) {
    rateLimits.primary = { used_percent: Number(primaryMatch[1]), window_minutes: 300 };
  }
  if (secondaryMatch) {
    rateLimits.secondary = { used_percent: Number(secondaryMatch[1]), window_minutes: 10080 };
  }
  return rateLimits.primary || rateLimits.secondary ? rateLimits : null;
}

// The VS Code extension host PATH usually lacks shell-profile additions, so try the
// configured path first, then known install locations, then bare "claude" via PATH.
function resolveClaudeCliPath(configuredPath, existsSyncImpl = fs.existsSync) {
  const candidates = [
    configuredPath && configuredPath.trim(),
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  }
  return "claude";
}

module.exports = {
  parseUsageOutput,
  resolveClaudeCliPath,
};
