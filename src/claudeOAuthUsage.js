const { execFile } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { URL } = require("node:url");

// Reads Claude subscription rate limits straight from the OAuth usage endpoint —
// the same call the Claude Code VS Code extension makes for its own usage panel
// (`fetchUsageData` -> `GET {BASE_API_URL}/api/oauth/usage`).
//
// Why this exists alongside claudeStatuslineUsage.js: the statusline command is
// part of Claude Code's ink TUI render path, so it only runs in a terminal
// session. When Claude Code is used purely through the VS Code panel (webview UI,
// no ink), the statusline never executes and the bridged cache goes stale. This
// module is the only channel that keeps working in that mode.
//
// Deliberate safety boundary, do not relax without a good reason:
//   * Only `accessToken` is read. `refreshToken` is never read or used — OAuth
//     refresh tokens usually rotate, so refreshing here could invalidate Claude
//     Code's own session and sign the user out.
//   * An expired access token is treated as "no data" and the read is skipped.
//     Claude Code refreshes it on its own schedule; we just wait.
//   * The token is held in a local variable for the duration of one request and
//     never logged, cached on disk, or included in error messages.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE_NAME = ".credentials.json";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";
// Claude Code sends this beta header on OAuth-authenticated calls (CLI constant
// `oauth-2025-04-20`); the endpoint rejects the request without it.
const OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5000;

// Poll interval floor. Matches the 5-minute write throttle Claude Code applies to
// its own persisted utilization cache, so we are no chattier than the official
// client. The status bar refresh (10s by default) must never drive a request.
const MIN_REFRESH_INTERVAL_MS = 300000;
// An explicit user refresh may bypass the throttle, but not without a floor.
const FORCED_REFRESH_INTERVAL_MS = 30000;
// Consecutive failures back off (offline, revoked token, endpoint change) so a
// broken setup does not retry every 5 minutes forever.
const MAX_BACKOFF_MS = 1800000;

function getDefaultClaudeRoot() {
  return path.join(os.homedir(), ".claude");
}

function getUsageEndpoint() {
  // Honour the same override Claude Code respects, so custom gateways work.
  const base = (process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return `${base}${USAGE_PATH}`;
}

// Accepts the ISO 8601 string the usage endpoint returns, and tolerates a raw
// Unix-seconds number in case the payload shape shifts. Returns Unix seconds to
// match the unified rateLimits contract shared with Codex.
function toUnixSeconds(value) {
  if (Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return Math.round(ms / 1000);
    }
  }
  return undefined;
}

// One window of the usage payload -> unified window shape. Unlike the statusline
// bridge, `utilization` here is already 0-100 and needs no scaling.
// Returns undefined when the window is absent or carries no number (the endpoint
// sends `utilization: null` for windows that do not apply), and null when it is
// present but malformed, which invalidates the whole read.
function toWindow(source, windowMinutes) {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  if (source.utilization === null || source.utilization === undefined) {
    return undefined;
  }
  if (!Number.isFinite(source.utilization)) {
    return null;
  }
  const window = { used_percent: source.utilization, window_minutes: windowMinutes };
  const resetsAt = toUnixSeconds(source.resets_at);
  if (resetsAt !== undefined) {
    window.resets_at = resetsAt;
  }
  return window;
}

// Map the /api/oauth/usage payload to { rateLimits, capturedAt }, the same shape
// readClaudeStatuslineUsage returns, so callers can treat the two sources
// interchangeably. `capturedAt` is our own read time: the payload carries no
// timestamp, and the value is what drives staleness hiding downstream.
function mapUsageResponse(payload, capturedAtSeconds) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const primary = toWindow(payload.five_hour, 300);
  const secondary = toWindow(payload.seven_day, 10080);
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

  return { rateLimits, capturedAt: capturedAtSeconds };
}

// Pull only the fields we are allowed to use out of a credentials blob.
// `refreshToken` is intentionally not touched. Returns null unless a
// still-valid access token is present.
function extractAccessToken(blob, nowMs) {
  const oauth = blob && blob.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    return null;
  }
  // expiresAt is Unix milliseconds in Claude Code's credential store. Treat a
  // missing value as usable and let the endpoint be the judge; treat an expired
  // one as no data rather than refreshing it ourselves.
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= nowMs) {
    return null;
  }
  return oauth.accessToken;
}

function readCredentialsFile(claudeRoot, nowMs) {
  try {
    const raw = fs.readFileSync(path.join(claudeRoot, CREDENTIALS_FILE_NAME), "utf8");
    return extractAccessToken(JSON.parse(raw), nowMs);
  } catch {
    return null;
  }
}

function readKeychainAccessToken(nowMs) {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: REQUEST_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null);
          return;
        }
        try {
          resolve(extractAccessToken(JSON.parse(stdout.trim()), nowMs));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

// Claude Code stores credentials in the macOS Keychain, and in a file on other
// platforms. Try the file first (cheap, no permission prompt) and fall back to
// the Keychain on darwin. The first Keychain read from this extension may raise a
// system authorization prompt, since the item's ACL only lists the claude binary.
async function readAccessToken(claudeRoot, nowMs) {
  const fromFile = readCredentialsFile(claudeRoot, nowMs);
  if (fromFile) {
    return fromFile;
  }
  if (process.platform === "darwin") {
    return readKeychainAccessToken(nowMs);
  }
  return null;
}

// Minimal JSON GET on node:https so the extension stays dependency-free.
// Resolves the parsed body on 2xx and rejects otherwise; the error message
// carries the status only, never the token or response body.
function requestUsage(accessToken) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(getUsageEndpoint());
    } catch {
      reject(new Error("invalid usage endpoint"));
      return;
    }

    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "anthropic-beta": OAUTH_BETA,
          Accept: "application/json",
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const error = new Error(`usage endpoint returned ${status}`);
            // 401/403 is a standing decision about this account, not a blip:
            // team and enterprise subscriptions are not served by this endpoint
            // (Claude Code gates the call client-side for the same reason).
            // Retrying on a timer would never succeed, so stop asking.
            if (status === 401 || status === 403) {
              error.unsupported = true;
            }
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("usage endpoint returned malformed JSON"));
          }
        });
      },
    );

    request.on("timeout", () => request.destroy(new Error("usage request timed out")));
    request.on("error", (error) => reject(error));
    request.end();
  });
}

// Module-level state. The status bar refresh is synchronous, so the network read
// happens in the background and callers pick up the result on a later tick.
const state = {
  snapshot: null,
  lastAttemptAt: 0,
  backoffMs: 0,
  inFlight: null,
  lastError: null,
  // Set once the endpoint says this account may not use it, which stops all
  // further attempts for the lifetime of the extension host.
  unsupported: false,
};

// Latest snapshot, or null when nothing has been fetched successfully yet.
// Synchronous by design: safe to call from the status bar refresh path.
function readClaudeOAuthUsage() {
  return state.snapshot;
}

function shouldAttempt(nowMs, force) {
  if (state.unsupported) {
    return false;
  }
  if (state.lastAttemptAt === 0) {
    return true;
  }
  const interval = force
    ? FORCED_REFRESH_INTERVAL_MS
    : MIN_REFRESH_INTERVAL_MS + state.backoffMs;
  return nowMs - state.lastAttemptAt >= interval;
}

// Fetch and cache the subscription rate limits. Throttled, never throws, and
// resolves to the current snapshot (possibly the previous one, or null) so a
// failure degrades to whatever was already known. `deps` exists for tests.
async function refreshClaudeOAuthUsage(options = {}) {
  const {
    claudeRoot = getDefaultClaudeRoot(),
    force = false,
    now = Date.now(),
    deps = {},
  } = options;
  const getToken = deps.readAccessToken || readAccessToken;
  const fetchUsage = deps.requestUsage || requestUsage;

  if (state.inFlight) {
    return state.inFlight;
  }
  if (!shouldAttempt(now, force)) {
    return state.snapshot;
  }

  state.lastAttemptAt = now;
  state.inFlight = (async () => {
    try {
      const accessToken = await getToken(claudeRoot, now);
      if (!accessToken) {
        // Not signed in, API-key auth, or the token expired and Claude Code has
        // not refreshed it yet. Keep the previous snapshot and back off.
        state.lastError = "no usable access token";
        state.backoffMs = Math.min(
          state.backoffMs ? state.backoffMs * 2 : MIN_REFRESH_INTERVAL_MS,
          MAX_BACKOFF_MS,
        );
        return state.snapshot;
      }
      const payload = await fetchUsage(accessToken);
      const snapshot = mapUsageResponse(payload, Math.floor(now / 1000));
      if (snapshot) {
        state.snapshot = snapshot;
        state.backoffMs = 0;
        state.lastError = null;
      } else {
        // Reached the endpoint but it carried no usable window (API-key session,
        // or a plan without subscription limits). Not worth retrying quickly.
        state.lastError = "usage payload had no rate-limit windows";
        state.backoffMs = Math.min(
          state.backoffMs ? state.backoffMs * 2 : MIN_REFRESH_INTERVAL_MS,
          MAX_BACKOFF_MS,
        );
      }
      return state.snapshot;
    } catch (error) {
      state.lastError = error && error.message ? error.message : "usage read failed";
      if (error && error.unsupported) {
        state.unsupported = true;
      }
      state.backoffMs = Math.min(
        state.backoffMs ? state.backoffMs * 2 : MIN_REFRESH_INTERVAL_MS,
        MAX_BACKOFF_MS,
      );
      return state.snapshot;
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

function getClaudeOAuthUsageError() {
  return state.lastError;
}

// True once the endpoint has refused this account outright (team/enterprise
// subscriptions), meaning only the statusline bridge can supply rate limits.
function isClaudeOAuthUsageUnsupported() {
  return state.unsupported;
}

// Test hook: drop all cached state so each case starts clean.
function resetClaudeOAuthUsageState() {
  state.snapshot = null;
  state.lastAttemptAt = 0;
  state.backoffMs = 0;
  state.inFlight = null;
  state.lastError = null;
  state.unsupported = false;
}

module.exports = {
  FORCED_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  extractAccessToken,
  getClaudeOAuthUsageError,
  getDefaultClaudeRoot,
  getUsageEndpoint,
  isClaudeOAuthUsageUnsupported,
  mapUsageResponse,
  readClaudeOAuthUsage,
  refreshClaudeOAuthUsage,
  resetClaudeOAuthUsageState,
};
