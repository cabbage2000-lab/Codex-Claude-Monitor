const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
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
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 5000;

// Fallback path for accounts the usage endpoint refuses (team / enterprise).
//
// Subscription limits are also carried on the response *headers* of any
// /v1/messages call, and that channel works on every plan. Claude Code reads
// them the same way, and when it needs a refresh without a user turn it sends a
// deliberately minimal request purely to harvest the headers — its own
// `quota_check`: `max_tokens: 1` with the single word "quota" as the prompt,
// taking only `.asResponse()`. This mirrors that exactly.
//
// Note this is why a free endpoint cannot substitute: the unified rate-limit
// headers ride on inference responses, which is precisely why the official
// client spends a token instead of calling /v1/models.
const MESSAGES_PATH = "/v1/messages";
const QUOTA_PROBE_MODEL = "claude-haiku-4-5-20251001";
const QUOTA_PROBE_PROMPT = "quota";

// Unified rate-limit response headers. The abbreviations match Claude Code's own
// table; `utilization` here is a 0-1 fraction, unlike the 0-100 the usage
// endpoint returns, so it has to be scaled.
const RATE_LIMIT_HEADER_WINDOWS = [
  { key: "primary", abbr: "5h", windowMinutes: 300 },
  { key: "secondary", abbr: "7d", windowMinutes: 10080 },
];

// Poll interval floor. Matches the 5-minute write throttle Claude Code applies to
// its own persisted utilization cache, so we are no chattier than the official
// client. The status bar refresh (10s by default) must never drive a request.
const MIN_REFRESH_INTERVAL_MS = 300000;
// An explicit user refresh may bypass the throttle, but not without a floor.
const FORCED_REFRESH_INTERVAL_MS = 30000;
// Consecutive failures back off (offline, revoked token, endpoint change) so a
// broken setup does not retry every 5 minutes forever.
const MAX_BACKOFF_MS = 1800000;

// Proxy support, and why it is not optional here.
//
// `node:https` ignores the standard proxy environment variables, so a request
// from this module goes out direct even when the whole machine is behind a
// proxy. Anthropic refuses direct connections from some regions with
// `403 {"type":"forbidden","message":"Request not allowed"}` — the exact same
// status an account-level refusal produces. That collision is what made the
// endpoint look permanently unsupported when it was merely unreachable, so the
// tunnel below is what makes the 403 signal trustworthy at all.
//
// Order matches curl and reqwest: the scheme-specific variable wins, lowercase
// before uppercase. A VS Code `http.proxy` setting can be injected as an
// override, since an editor launched from Finder or the Dock inherits no shell
// environment and would otherwise see none of these.
const PROXY_ENV_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

function getDefaultClaudeRoot() {
  return path.join(os.homedir(), ".claude");
}

// `no_proxy` entries match a host suffix, with an optional leading dot and an
// optional `:port`, and a bare `*` disables proxying wholesale. IP literals only
// ever match exactly — no CIDR support, matching curl.
function isProxyBypassed(hostname, env) {
  const raw = env.no_proxy || env.NO_PROXY || "";
  if (!raw.trim()) {
    return false;
  }
  const host = hostname.toLowerCase();
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") {
        return true;
      }
      const bare = entry.split(":")[0].replace(/^\./, "");
      if (!bare) {
        return false;
      }
      if (net.isIP(bare)) {
        return host === bare;
      }
      return host === bare || host.endsWith(`.${bare}`);
    });
}

// Returns the proxy URL to tunnel through, or null for a direct connection.
// An explicit `override` (the editor's own setting) outranks the environment;
// `no_proxy` still applies to it, which is what lets a custom
// ANTHROPIC_BASE_URL on localhost stay direct.
function resolveProxyUrl(hostname, override, env = process.env) {
  if (isProxyBypassed(hostname, env)) {
    return null;
  }
  const candidate =
    (typeof override === "string" && override.trim()) ||
    PROXY_ENV_KEYS.map((key) => env[key]).find((value) => value && value.trim());
  if (!candidate) {
    return null;
  }
  const raw = candidate.trim();
  try {
    // A bare `host:port` is accepted by curl and common enough to be worth
    // tolerating; assume http, the only scheme a CONNECT proxy speaks here.
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Open a CONNECT tunnel and hand back the raw socket for TLS to run on top of.
// Rejecting on a non-200 matters: some proxies answer 403/407 with an HTML body,
// and treating that as a live socket would surface as an opaque TLS error.
function connectViaProxy(proxyUrl, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxyUrl.username || proxyUrl.password) {
      const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(
        proxyUrl.password,
      )}`;
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    const request = http.request({
      host: proxyUrl.hostname,
      port: Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      timeout: timeoutMs,
      headers,
    });

    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT returned ${response.statusCode}`));
        return;
      }
      resolve(socket);
    });
    request.on("timeout", () => request.destroy(new Error("proxy CONNECT timed out")));
    request.on("error", (error) => reject(error));
    request.end();
  });
}

// Honour the same override Claude Code respects, so custom gateways work.
function getApiBaseUrl() {
  return (process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function getUsageEndpoint() {
  return `${getApiBaseUrl()}${USAGE_PATH}`;
}

function getMessagesEndpoint() {
  return `${getApiBaseUrl()}${MESSAGES_PATH}`;
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
// Model-scoped weekly windows, carried alongside the two headline ones. They
// only hold a number on plans that meter Opus separately — every other account
// gets `null` — and they share the 7-day length with `seven_day`, so each needs
// an explicit label or the tooltip would render several identical
// "Weekly usage" rows.
//
// Only windows with a stated meaning are listed. The payload also carries keys
// like `tangelo` and `nimbus_quill`, which are internal experiment codenames:
// surfacing them verbatim would put noise in the tooltip under names that mean
// nothing to a user and can be renamed without notice.
const SCOPED_WINDOWS = [
  { key: "seven_day_opus", label: "Weekly usage (Opus)", windowMinutes: 10080 },
  { key: "seven_day_sonnet", label: "Weekly usage (Sonnet)", windowMinutes: 10080 },
];

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

  // Supplementary, so a malformed one is skipped rather than invalidating the
  // read the way a broken headline window does.
  const scoped = [];
  for (const { key, label, windowMinutes } of SCOPED_WINDOWS) {
    const window = toWindow(payload[key], windowMinutes);
    if (window) {
      scoped.push({ ...window, label });
    }
  }
  if (scoped.length) {
    rateLimits.scoped = scoped;
  }

  return { rateLimits, capturedAt: capturedAtSeconds };
}

// Pull only the fields we are allowed to use out of a credentials blob.
// `refreshToken` is intentionally not touched. Returns null unless a
// still-valid access token is present.
// Claude Code writes `expiresAt` as Unix milliseconds today, but the credential
// store is not ours and the field has no stated contract. Reading milliseconds
// as seconds (or the reverse) silently misjudges expiry by three orders of
// magnitude — in one direction every token looks expired and the source goes
// permanently dark, which is exactly the kind of quiet failure this module has
// already been bitten by. So: disambiguate by magnitude the way Claude Code's
// own credential parsers do, and accept an ISO string too.
// Returns undefined when the value carries no usable expiry.
function toExpiryMs(value) {
  if (Number.isFinite(value)) {
    // A seconds-based timestamp only reaches 1e12 in the year 33658; a
    // milliseconds-based one passed it in 2001. Anything below is seconds.
    return value >= 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    // A numeric string is still a timestamp; Date.parse would have read a bare
    // "1780000000000" as a year, so it is handled here rather than above.
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric >= 1e12 ? numeric : numeric * 1000;
    }
  }
  return undefined;
}

function extractAccessToken(blob, nowMs) {
  const oauth = blob && blob.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    return null;
  }
  // Treat a missing or unparseable expiry as usable and let the endpoint be the
  // judge; treat a genuinely expired one as no data rather than refreshing it
  // ourselves.
  const expiresAtMs = toExpiryMs(oauth.expiresAt);
  if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
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

// Minimal JSON request on node:https so the extension stays dependency-free.
// Resolves `{ data, headers }` on 2xx and rejects otherwise; the error message
// carries the endpoint label and status only, never the token or response body.
async function requestJson({ endpoint, label, method = "GET", body = null, accessToken, proxy }) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`invalid ${label} endpoint`);
  }

  const proxyUrl = resolveProxyUrl(url.hostname, proxy);
  const isTls = url.protocol === "https:";
  const port = Number(url.port) || (isTls ? 443 : 80);
  // An https target needs a CONNECT tunnel; a plaintext one is sent to the proxy
  // in absolute-URI form instead, which is how a forward proxy expects it.
  const tunnel =
    proxyUrl && isTls
      ? await connectViaProxy(proxyUrl, url.hostname, port, REQUEST_TIMEOUT_MS)
      : null;

  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const transport = isTls ? https : http;
    const plaintextViaProxy = Boolean(proxyUrl) && !isTls;
    const request = transport.request(
      {
        protocol: plaintextViaProxy ? proxyUrl.protocol : url.protocol,
        hostname: plaintextViaProxy ? proxyUrl.hostname : url.hostname,
        port: plaintextViaProxy ? Number(proxyUrl.port) || 80 : url.port || undefined,
        path: plaintextViaProxy ? url.href : `${url.pathname}${url.search}`,
        method,
        timeout: REQUEST_TIMEOUT_MS,
        ...(tunnel
          ? {
              createConnection: () => tls.connect({ socket: tunnel, servername: url.hostname }),
            }
          : {}),
        headers: {
          Host: url.host,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "anthropic-beta": OAUTH_BETA,
          "anthropic-version": ANTHROPIC_VERSION,
          Accept: "application/json",
          ...(payload === null ? {} : { "Content-Length": Buffer.byteLength(payload) }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const error = new Error(`${label} returned ${status}`);
            // 401/403 means this credential was turned away — which can be an
            // account the endpoint does not serve, but is just as often a
            // network-level refusal: Anthropic answers direct connections from
            // some regions with the very same `403 Request not allowed`. The
            // two are indistinguishable from here, so this only routes the
            // request to the fallback source; it never permanently gives up.
            if (status === 401 || status === 403) {
              error.refused = true;
            }
            reject(error);
            return;
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`${label} returned malformed JSON`));
            return;
          }
          resolve({ data, headers: response.headers });
        });
      },
    );

    request.on("timeout", () => request.destroy(new Error(`${label} request timed out`)));
    request.on("error", (error) => {
      // The tunnel socket is ours, not the agent's, so nothing else will close
      // it if the request dies before TLS takes ownership.
      if (tunnel) {
        tunnel.destroy();
      }
      reject(error);
    });
    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}

function requestUsage(accessToken, proxy) {
  return requestJson({
    endpoint: getUsageEndpoint(),
    label: "usage endpoint",
    accessToken,
    proxy,
  }).then((result) => result.data);
}

// The official quota_check, reproduced: the cheapest possible /v1/messages call,
// made only to read the rate-limit response headers. `max_tokens: 1` with a
// one-word prompt costs about a single output token plus a handful of input
// tokens. Resolves the response headers; the body is irrelevant and discarded.
function requestQuotaProbe(accessToken, proxy) {
  return requestJson({
    endpoint: getMessagesEndpoint(),
    label: "quota probe",
    method: "POST",
    accessToken,
    proxy,
    body: {
      model: QUOTA_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: QUOTA_PROBE_PROMPT }],
    },
  }).then((result) => result.headers);
}

// Map the unified rate-limit response headers to the shared rateLimits shape.
// The header utilization is a 0-1 fraction and is scaled to a percentage, which
// is exactly what Claude Code does when it builds its statusline input.
// Returns null when no window is present, so callers can treat it like a miss.
function mapRateLimitHeaders(headers, capturedAtSeconds) {
  if (!headers) {
    return null;
  }
  const read = (name) => {
    const value = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  // Number("") is 0, so an empty header would silently read as 0% used.
  const readNumber = (name) => {
    const raw = read(name);
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return null;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const rateLimits = {};
  for (const { key, abbr, windowMinutes } of RATE_LIMIT_HEADER_WINDOWS) {
    const utilization = readNumber(`anthropic-ratelimit-unified-${abbr}-utilization`);
    if (utilization === null) {
      continue;
    }
    const window = { used_percent: utilization * 100, window_minutes: windowMinutes };
    const resetsAt = readNumber(`anthropic-ratelimit-unified-${abbr}-reset`);
    if (resetsAt !== null) {
      window.resets_at = Math.round(resetsAt);
    }
    rateLimits[key] = window;
  }

  if (!rateLimits.primary && !rateLimits.secondary) {
    return null;
  }
  return { rateLimits, capturedAt: capturedAtSeconds };
}

// Module-level state. The status bar refresh is synchronous, so the network read
// happens in the background and callers pick up the result on a later tick.
const state = {
  snapshot: null,
  // Which source produced the current snapshot: "usage-endpoint" or "quota-probe".
  source: null,
  lastAttemptAt: 0,
  backoffMs: 0,
  inFlight: null,
  lastError: null,
  // Whether the usage endpoint turned the last request away (401/403). Enables
  // the fallback source, but is never a permanent verdict — the same status
  // comes back when the request simply could not reach Anthropic directly, so a
  // proxy appearing or a network changing has to be able to clear it.
  usageRefused: false,
  // Set only when the probe succeeds but carries no rate-limit headers. That is
  // a property of the plan, not the network, so there is no point spending
  // another token on it. A refused probe does not set this.
  probeUnsupported: false,
};

// Latest snapshot, or null when nothing has been fetched successfully yet.
// Synchronous by design: safe to call from the status bar refresh path.
function readClaudeOAuthUsage() {
  return state.snapshot;
}

function shouldAttempt(nowMs, force) {
  if (state.lastAttemptAt === 0) {
    return true;
  }
  const interval = force
    ? FORCED_REFRESH_INTERVAL_MS
    : MIN_REFRESH_INTERVAL_MS + state.backoffMs;
  return nowMs - state.lastAttemptAt >= interval;
}

function backOff() {
  state.backoffMs = Math.min(
    state.backoffMs ? state.backoffMs * 2 : MIN_REFRESH_INTERVAL_MS,
    MAX_BACKOFF_MS,
  );
}

function acceptSnapshot(snapshot, source) {
  state.snapshot = snapshot;
  state.source = source;
  state.backoffMs = 0;
  state.lastError = null;
  return snapshot;
}

// Fetch and cache the subscription rate limits. Throttled, never throws, and
// resolves to the current snapshot (possibly the previous one, or null) so a
// failure degrades to whatever was already known. `deps` exists for tests.
//
// Two sources, tried in order — the same order Claude Code itself uses:
//   1. the usage endpoint, which carries the richest data but turns some
//      requests away with a 403;
//   2. the quota probe, whose rate-limit response headers work wherever
//      inference does but cost a token, so it only runs after the endpoint has
//      actually refused and only when `allowQuotaProbe` is set by the caller.
//
// Source 1 is retried on every attempt even after a refusal. It has to be: a
// 403 can mean the network could not reach Anthropic directly rather than
// anything about the account, and that condition clears on its own.
async function refreshClaudeOAuthUsage(options = {}) {
  const {
    claudeRoot = getDefaultClaudeRoot(),
    force = false,
    now = Date.now(),
    allowQuotaProbe = false,
    proxy,
    deps = {},
  } = options;
  const getToken = deps.readAccessToken || readAccessToken;
  const fetchUsage = deps.requestUsage || requestUsage;
  const probeQuota = deps.requestQuotaProbe || requestQuotaProbe;

  if (state.inFlight) {
    return state.inFlight;
  }
  if (!shouldAttempt(now, force)) {
    return state.snapshot;
  }

  state.lastAttemptAt = now;
  state.inFlight = (async () => {
    const capturedAt = Math.floor(now / 1000);
    try {
      const accessToken = await getToken(claudeRoot, now);
      if (!accessToken) {
        // Not signed in, API-key auth, or the token expired and Claude Code has
        // not refreshed it yet. Keep the previous snapshot and back off.
        state.lastError = "no usable access token";
        backOff();
        return state.snapshot;
      }

      try {
        const snapshot = mapUsageResponse(await fetchUsage(accessToken, proxy), capturedAt);
        if (snapshot) {
          state.usageRefused = false;
          return acceptSnapshot(snapshot, "usage-endpoint");
        }
        // Reached the endpoint but it carried no usable window (API-key session,
        // or a plan without subscription limits).
        state.usageRefused = false;
        state.lastError = "usage payload had no rate-limit windows";
      } catch (error) {
        state.lastError = error && error.message ? error.message : "usage read failed";
        state.usageRefused = Boolean(error && error.refused);
      }

      if (!allowQuotaProbe || state.probeUnsupported || !state.usageRefused) {
        backOff();
        return state.snapshot;
      }

      // Source 2: harvest the rate-limit headers from a minimal inference call.
      try {
        const snapshot = mapRateLimitHeaders(await probeQuota(accessToken, proxy), capturedAt);
        if (snapshot) {
          return acceptSnapshot(snapshot, "quota-probe");
        }
        // Headers absent on an otherwise fine response: a property of the plan,
        // not the network. Spending a token per interval to relearn it is waste.
        state.lastError = "quota probe response carried no rate-limit headers";
        state.probeUnsupported = true;
      } catch (error) {
        state.lastError = error && error.message ? error.message : "quota probe failed";
      }
      backOff();
      return state.snapshot;
    } catch (error) {
      state.lastError = error && error.message ? error.message : "usage read failed";
      backOff();
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

// True when the usage endpoint turned the most recent request away. Diagnostic
// only: the next attempt still tries it, since the refusal may have been the
// network rather than the account.
function isClaudeOAuthUsageUnsupported() {
  return state.usageRefused;
}

// Which source produced the current snapshot, for diagnostics and the tooltip.
function getClaudeOAuthUsageSource() {
  return state.source;
}

// Test hook: drop all cached state so each case starts clean.
function resetClaudeOAuthUsageState() {
  state.snapshot = null;
  state.source = null;
  state.lastAttemptAt = 0;
  state.backoffMs = 0;
  state.inFlight = null;
  state.lastError = null;
  state.usageRefused = false;
  state.probeUnsupported = false;
}

module.exports = {
  FORCED_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  QUOTA_PROBE_MODEL,
  extractAccessToken,
  getClaudeOAuthUsageError,
  getClaudeOAuthUsageSource,
  getDefaultClaudeRoot,
  getMessagesEndpoint,
  getUsageEndpoint,
  isClaudeOAuthUsageUnsupported,
  mapRateLimitHeaders,
  mapUsageResponse,
  readClaudeOAuthUsage,
  refreshClaudeOAuthUsage,
  resetClaudeOAuthUsageState,
  resolveProxyUrl,
};
