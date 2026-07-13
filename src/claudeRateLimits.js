const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Reset suffix in usage lines: "resets Jul 7 at 8:20pm" / "resets Jul 14 at 1am".
// Minutes are optional, the clock is 12-hour, and there is no year. The trailing
// zone name (e.g. "(Asia/Shanghai)") is not consumed: the CLI prints machine-local
// times, so the wall clock is parsed as local time.
const RESET_RE = /resets\s+([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// Yearless reset text plus `now` -> Unix seconds. Picks the year among {prev,
// current, next} landing closest to now: real resets are always <= 7 days ahead,
// and a just-passed reset in marginally stale output must stay in the past --
// including across New Year in both directions. Null when the text does not parse.
function parseResetTimestamp(lineTail, now) {
  const match = String(lineTail || "").match(RESET_RE);
  if (!match) {
    return null;
  }
  const monthIndex = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
  if (monthIndex === -1) {
    return null;
  }
  const day = Number(match[2]);
  const hour = (Number(match[3]) % 12) + (match[5].toLowerCase() === "pm" ? 12 : 0);
  const minute = match[4] ? Number(match[4]) : 0;
  const baseYear = new Date(now).getFullYear();
  let best = null;
  for (const year of [baseYear - 1, baseYear, baseYear + 1]) {
    const candidate = new Date(year, monthIndex, day, hour, minute).getTime();
    if (best === null || Math.abs(candidate - now) < Math.abs(best - now)) {
      best = candidate;
    }
  }
  return Math.floor(best / 1000);
}

// One matched usage line -> the unified window shape. resets_at is attached only
// when the line tail parses so percent-only output keeps its exact shape.
function buildRateLimitWindow(match, windowMinutes, now) {
  if (!match) {
    return undefined;
  }
  const limitWindow = { used_percent: Number(match[1]), window_minutes: windowMinutes };
  const resetsAt = parseResetTimestamp(match[2], now);
  if (resetsAt !== null) {
    limitWindow.resets_at = resetsAt;
  }
  return limitWindow;
}

// Parse the plain-text output of `claude -p "/usage"` into the unified rateLimits
// shape shared with Codex. Unmatched windows are omitted; null when nothing matches.
// `.` never matches \r or \n, so the tail capture stays line-scoped under CRLF too.
function parseUsageOutput(text, now = Date.now()) {
  if (!text) {
    return null;
  }
  const primaryMatch = String(text).match(/^Current session:\s*(\d+(?:\.\d+)?)%\s*used(.*)/m);
  const secondaryMatch = String(text).match(
    /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used(.*)/m,
  );
  const rateLimits = {};
  const primary = buildRateLimitWindow(primaryMatch, 300, now);
  const secondary = buildRateLimitWindow(secondaryMatch, 10080, now);
  if (primary) {
    rateLimits.primary = primary;
  }
  if (secondary) {
    rateLimits.secondary = secondary;
  }
  return rateLimits.primary || rateLimits.secondary ? rateLimits : null;
}

// Known per-platform install locations. On Windows the native installer ships
// claude.exe under ~/.local/bin and npm global installs ship a claude.cmd shim
// under %APPDATA%\npm; the Unix names never match there.
function getKnownInstallLocations(platform, env) {
  if (platform === "win32") {
    return [
      path.join(os.homedir(), ".local", "bin", "claude.exe"),
      env.APPDATA && path.join(env.APPDATA, "npm", "claude.cmd"),
    ];
  }
  return [
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

// The VS Code extension host PATH usually lacks shell-profile additions, so try the
// configured path first, then known install locations, then bare "claude" via PATH.
function resolveClaudeCliPath(
  configuredPath,
  existsSyncImpl = fs.existsSync,
  platform = process.platform,
  env = process.env,
) {
  const candidates = [
    configuredPath && configuredPath.trim(),
    ...getKnownInstallLocations(platform, env),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSyncImpl(candidate)) {
      return candidate;
    }
  }
  return "claude";
}

// Batch shims cannot be spawned without a shell since the Node CVE-2024-27980 fix
// (EINVAL), and a bare name needs cmd.exe's PATHEXT lookup to find claude.cmd on
// PATH; .exe files and POSIX binaries run directly.
function needsWindowsShell(cliPath, platform) {
  if (platform !== "win32") {
    return false;
  }
  return /\.(cmd|bat)$/i.test(cliPath) || !/[\\/]/.test(cliPath);
}

// Run `claude -p "/usage"` and parse its output. Resolves null on any failure
// (missing CLI, timeout, unparseable output) so callers keep the previous value.
// cwd defaults to the OS temp dir so the probe session never matches a workspace.
function probeClaudeRateLimits(options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const platform = options.platform || process.platform;
  const cliPath = options.cliPath || resolveClaudeCliPath("", undefined, platform);
  const useShell = needsWindowsShell(cliPath, platform);
  return new Promise((resolve) => {
    execFileImpl(
      // Quoted for the shell: npm paths can contain spaces (C:\Users\First Last\...).
      useShell ? `"${cliPath}"` : cliPath,
      ["-p", "/usage"],
      {
        timeout: options.timeoutMs || 30000,
        cwd: options.cwd || os.tmpdir(),
        windowsHide: true,
        shell: useShell,
      },
      (error, stdout) => {
        resolve(error ? null : parseUsageOutput(String(stdout)));
      },
    );
  });
}

module.exports = {
  parseUsageOutput,
  probeClaudeRateLimits,
  resolveClaudeCliPath,
};
