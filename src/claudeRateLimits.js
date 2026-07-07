const { execFile } = require("node:child_process");
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
