const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MIN_REFRESH_INTERVAL_MS,
  extractAccessToken,
  getUsageEndpoint,
  isClaudeOAuthUsageUnsupported,
  mapUsageResponse,
  readClaudeOAuthUsage,
  refreshClaudeOAuthUsage,
  resetClaudeOAuthUsageState,
  resolveProxyUrl,
} = require("../src/claudeOAuthUsage");

// Shape of the /api/oauth/usage payload: `utilization` is already 0-100 and
// `resets_at` is an ISO 8601 string (unlike the statusline bridge, which reports
// a 0-1 utilization scaled to a percentage and Unix-seconds timestamps).
const RESET_ISO = "2026-06-01T12:00:00.000Z";
const RESET_UNIX = Math.round(Date.parse(RESET_ISO) / 1000);

test("maps five_hour to primary (300 min) and seven_day to secondary (10080 min)", () => {
  const result = mapUsageResponse(
    {
      five_hour: { utilization: 21, resets_at: RESET_ISO },
      seven_day: { utilization: 45.4, resets_at: RESET_ISO },
    },
    1780000000,
  );

  assert.deepEqual(result.rateLimits.primary, {
    used_percent: 21,
    window_minutes: 300,
    resets_at: RESET_UNIX,
  });
  assert.deepEqual(result.rateLimits.secondary, {
    used_percent: 45.4,
    window_minutes: 10080,
    resets_at: RESET_UNIX,
  });
  assert.equal(result.capturedAt, 1780000000);
});

test("accepts a raw Unix-seconds resets_at in case the payload shape shifts", () => {
  const result = mapUsageResponse({ five_hour: { utilization: 5, resets_at: 1780001111 } }, 1);
  assert.equal(result.rateLimits.primary.resets_at, 1780001111);
});

test("omits resets_at when it is missing or unparseable", () => {
  const missing = mapUsageResponse({ five_hour: { utilization: 5 } }, 1);
  assert.deepEqual(missing.rateLimits.primary, { used_percent: 5, window_minutes: 300 });

  const garbage = mapUsageResponse({ five_hour: { utilization: 5, resets_at: "soon" } }, 1);
  assert.deepEqual(garbage.rateLimits.primary, { used_percent: 5, window_minutes: 300 });
});

// The endpoint reports utilization: null for windows that do not apply to the plan.
test("treats a null utilization as an absent window, not an error", () => {
  const result = mapUsageResponse(
    { five_hour: { utilization: 12, resets_at: RESET_ISO }, seven_day: { utilization: null } },
    1,
  );
  assert.equal(result.rateLimits.primary.used_percent, 12);
  assert.equal(result.rateLimits.secondary, undefined);
});

test("returns null when a present window has a non-numeric utilization", () => {
  assert.equal(mapUsageResponse({ five_hour: { utilization: "n/a" } }, 1), null);
});

// Model-scoped weekly windows share the 7-day length with `seven_day`, so each
// carries an explicit label the tooltip uses instead of the inferred duration.
test("collects model-scoped weekly windows with their own labels", () => {
  const result = mapUsageResponse(
    {
      five_hour: { utilization: 11 },
      seven_day: { utilization: 14 },
      seven_day_opus: { utilization: 62, resets_at: RESET_ISO },
      seven_day_sonnet: { utilization: 3 },
    },
    1,
  );

  assert.deepEqual(result.rateLimits.scoped, [
    {
      used_percent: 62,
      window_minutes: 10080,
      resets_at: RESET_UNIX,
      label: "Weekly usage (Opus)",
    },
    { used_percent: 3, window_minutes: 10080, label: "Weekly usage (Sonnet)" },
  ]);
});

// Every account that does not meter Opus separately gets null for these.
test("omits scoped windows entirely when none carry data", () => {
  const result = mapUsageResponse(
    { five_hour: { utilization: 11 }, seven_day_opus: null, seven_day_sonnet: { utilization: null } },
    1,
  );
  assert.equal(result.rateLimits.scoped, undefined);
});

// A headline window invalidates the read when malformed; a supplementary one is
// only dropped, since losing it is better than losing the whole snapshot.
test("skips a malformed scoped window without invalidating the read", () => {
  const result = mapUsageResponse(
    { five_hour: { utilization: 11 }, seven_day_opus: { utilization: "n/a" } },
    1,
  );
  assert.equal(result.rateLimits.primary.used_percent, 11);
  assert.equal(result.rateLimits.scoped, undefined);
});

// Reading milliseconds as seconds would make every token look expired and take
// the whole source dark, so each accepted shape is pinned down.
test("accepts expiresAt as milliseconds, seconds, or an ISO string", () => {
  const nowMs = Date.parse("2026-08-05T00:00:00.000Z");
  const future = "2026-08-06T00:00:00.000Z";
  const past = "2026-08-04T00:00:00.000Z";
  const token = (expiresAt) => extractAccessToken({ claudeAiOauth: { accessToken: "at", expiresAt } }, nowMs);

  assert.equal(token(Date.parse(future)), "at", "future milliseconds");
  assert.equal(token(Date.parse(past)), null, "past milliseconds");
  assert.equal(token(Math.floor(Date.parse(future) / 1000)), "at", "future seconds");
  assert.equal(token(Math.floor(Date.parse(past) / 1000)), null, "past seconds");
  assert.equal(token(future), "at", "future ISO string");
  assert.equal(token(past), null, "past ISO string");
  assert.equal(token(String(Date.parse(future))), "at", "future numeric string");
  assert.equal(token(String(Date.parse(past))), null, "past numeric string");
});

test("treats a missing or unparseable expiresAt as usable", () => {
  const nowMs = Date.parse("2026-08-05T00:00:00.000Z");
  const token = (expiresAt) => extractAccessToken({ claudeAiOauth: { accessToken: "at", expiresAt } }, nowMs);

  assert.equal(token(undefined), "at");
  assert.equal(token(null), "at");
  assert.equal(token("whenever"), "at");
});

test("returns null when no window carries data", () => {
  assert.equal(mapUsageResponse({}, 1), null);
  assert.equal(mapUsageResponse({ seven_day: { utilization: null } }, 1), null);
  assert.equal(mapUsageResponse(null, 1), null);
});

// Timestamps here are real-magnitude on purpose: expiry is disambiguated by
// magnitude, so toy values like 1000 would silently exercise the seconds branch.
const NOW_MS = Date.parse("2026-08-05T00:00:00.000Z");
const EXPIRY_FUTURE_MS = Date.parse("2026-08-05T01:00:00.000Z");
const EXPIRY_PAST_MS = Date.parse("2026-08-04T23:00:00.000Z");

test("extractAccessToken reads only the access token, never the refresh token", () => {
  const blob = {
    claudeAiOauth: {
      accessToken: "at-123",
      refreshToken: "rt-should-never-be-used",
      expiresAt: EXPIRY_FUTURE_MS,
    },
  };
  assert.equal(extractAccessToken(blob, NOW_MS), "at-123");
});

test("extractAccessToken skips an expired token instead of refreshing it", () => {
  const blob = { claudeAiOauth: { accessToken: "at-123", expiresAt: EXPIRY_PAST_MS } };
  assert.equal(extractAccessToken(blob, NOW_MS), null);
  assert.equal(extractAccessToken(blob, NOW_MS + 5000), null);
});

test("extractAccessToken accepts a credential blob without an expiry", () => {
  const blob = { claudeAiOauth: { accessToken: "at-123" } };
  assert.equal(extractAccessToken(blob, 1000), "at-123");
});

test("extractAccessToken returns null for API-key-only or malformed blobs", () => {
  assert.equal(extractAccessToken(null, 1), null);
  assert.equal(extractAccessToken({}, 1), null);
  assert.equal(extractAccessToken({ claudeAiOauth: {} }, 1), null);
  assert.equal(extractAccessToken({ claudeAiOauth: { accessToken: "" } }, 1), null);
});

test("getUsageEndpoint honours ANTHROPIC_BASE_URL and strips a trailing slash", () => {
  const original = process.env.ANTHROPIC_BASE_URL;
  try {
    delete process.env.ANTHROPIC_BASE_URL;
    assert.equal(getUsageEndpoint(), "https://api.anthropic.com/api/oauth/usage");

    process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com/";
    assert.equal(getUsageEndpoint(), "https://gateway.example.com/api/oauth/usage");
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = original;
    }
  }
});

// --- refresh orchestration -------------------------------------------------

function makeDeps({ token = "at-123", payload, fail } = {}) {
  const calls = { tokenReads: 0, usageRequests: 0, tokensSeen: [] };
  return {
    calls,
    deps: {
      readAccessToken: async () => {
        calls.tokenReads += 1;
        return token;
      },
      requestUsage: async (accessToken) => {
        calls.usageRequests += 1;
        calls.tokensSeen.push(accessToken);
        if (fail) {
          throw new Error("boom");
        }
        return payload;
      },
    },
  };
}

test("a successful refresh caches a snapshot readable synchronously", async () => {
  resetClaudeOAuthUsageState();
  const { deps, calls } = makeDeps({
    payload: { five_hour: { utilization: 33, resets_at: RESET_ISO } },
  });

  assert.equal(readClaudeOAuthUsage(), null);
  await refreshClaudeOAuthUsage({ now: 1000, deps });

  assert.equal(calls.usageRequests, 1);
  assert.equal(calls.tokensSeen[0], "at-123");
  assert.equal(readClaudeOAuthUsage().rateLimits.primary.used_percent, 33);
  assert.equal(readClaudeOAuthUsage().capturedAt, 1);
});

test("throttles repeated reads so the status bar tick cannot drive requests", async () => {
  resetClaudeOAuthUsageState();
  const { deps, calls } = makeDeps({ payload: { five_hour: { utilization: 33 } } });
  const now = 10_000_000;

  await refreshClaudeOAuthUsage({ now, deps });
  await refreshClaudeOAuthUsage({ now: now + 10000, deps });
  await refreshClaudeOAuthUsage({ now: now + 60000, deps });

  assert.equal(calls.usageRequests, 1);

  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS, deps });
  assert.equal(calls.usageRequests, 2);
});

test("force relaxes the throttle to its floor without removing it", async () => {
  resetClaudeOAuthUsageState();
  const { deps, calls } = makeDeps({ payload: { five_hour: { utilization: 33 } } });
  const now = 10_000_000;

  await refreshClaudeOAuthUsage({ now, deps });
  await refreshClaudeOAuthUsage({ now: now + 5000, force: true, deps });
  assert.equal(calls.usageRequests, 1, "still inside the forced floor");

  await refreshClaudeOAuthUsage({ now: now + 30000, force: true, deps });
  assert.equal(calls.usageRequests, 2);
});

test("a failed refresh keeps the previous snapshot and backs off", async () => {
  resetClaudeOAuthUsageState();
  const ok = makeDeps({ payload: { five_hour: { utilization: 33 } } });
  const now = 10_000_000;
  await refreshClaudeOAuthUsage({ now, deps: ok.deps });
  assert.equal(readClaudeOAuthUsage().rateLimits.primary.used_percent, 33);

  const bad = makeDeps({ fail: true });
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS, deps: bad.deps });

  assert.equal(bad.calls.usageRequests, 1);
  assert.equal(readClaudeOAuthUsage().rateLimits.primary.used_percent, 33, "stale value retained");

  // Backoff doubles the interval, so the next attempt at exactly one interval is skipped.
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 2, deps: bad.deps });
  assert.equal(bad.calls.usageRequests, 1);
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 3, deps: bad.deps });
  assert.equal(bad.calls.usageRequests, 2);
});

test("skips the request entirely when no usable access token is available", async () => {
  resetClaudeOAuthUsageState();
  const { deps, calls } = makeDeps({ token: null });

  const result = await refreshClaudeOAuthUsage({ now: 1000, deps });

  assert.equal(calls.tokenReads, 1);
  assert.equal(calls.usageRequests, 0, "never call the endpoint without a token");
  assert.equal(result, null);
});

test("concurrent refreshes share a single in-flight request", async () => {
  resetClaudeOAuthUsageState();
  const { deps, calls } = makeDeps({ payload: { five_hour: { utilization: 33 } } });

  await Promise.all([
    refreshClaudeOAuthUsage({ now: 1000, deps }),
    refreshClaudeOAuthUsage({ now: 1000, deps }),
    refreshClaudeOAuthUsage({ now: 1000, deps }),
  ]);

  assert.equal(calls.usageRequests, 1);
});

// A 403 is ambiguous and must never be a permanent verdict. The endpoint
// refusing an account is indistinguishable from Anthropic refusing the
// connection: a direct request from certain regions gets the very same
// `403 Request not allowed`. Giving up for good would mean a proxy coming up
// later — or the user simply moving networks — never recovers.
test("a 403 flags the refusal but still retries on the next interval", async () => {
  resetClaudeOAuthUsageState();
  const calls = { usageRequests: 0 };
  const deps = {
    readAccessToken: async () => "at-123",
    requestUsage: async () => {
      calls.usageRequests += 1;
      const error = new Error("usage endpoint returned 403");
      error.refused = true;
      throw error;
    },
  };
  const now = 10_000_000;

  await refreshClaudeOAuthUsage({ now, deps });
  assert.equal(calls.usageRequests, 1);
  assert.equal(isClaudeOAuthUsageUnsupported(), true, "refusal is visible for diagnostics");

  // Backoff applies, but the endpoint is asked again rather than written off.
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 3, deps });
  assert.equal(calls.usageRequests, 2);
});

test("a later success clears the refusal flag", async () => {
  resetClaudeOAuthUsageState();
  let refuse = true;
  const deps = {
    readAccessToken: async () => "at-123",
    requestUsage: async () => {
      if (refuse) {
        const error = new Error("usage endpoint returned 403");
        error.refused = true;
        throw error;
      }
      return { five_hour: { utilization: 7 } };
    },
  };
  const now = 10_000_000;

  await refreshClaudeOAuthUsage({ now, deps });
  assert.equal(isClaudeOAuthUsageUnsupported(), true);

  refuse = false;
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 3, deps });
  assert.equal(isClaudeOAuthUsageUnsupported(), false);
  assert.equal(readClaudeOAuthUsage().rateLimits.primary.used_percent, 7);
});

test("an ordinary failure does not flag a refusal", async () => {
  resetClaudeOAuthUsageState();
  const { deps } = makeDeps({ fail: true });

  await refreshClaudeOAuthUsage({ now: 10_000_000, deps });

  assert.equal(isClaudeOAuthUsageUnsupported(), false);
});

// node:https ignores the proxy environment entirely, so resolving it here is
// the only reason a proxied machine can reach the endpoint at all.
test("resolves the proxy from the environment, scheme-specific first", () => {
  assert.equal(
    resolveProxyUrl("api.anthropic.com", undefined, {
      https_proxy: "http://127.0.0.1:7897",
      http_proxy: "http://127.0.0.1:1111",
    }).href,
    "http://127.0.0.1:7897/",
  );
  assert.equal(
    resolveProxyUrl("api.anthropic.com", undefined, { HTTP_PROXY: "http://127.0.0.1:1111" }).href,
    "http://127.0.0.1:1111/",
  );
  assert.equal(resolveProxyUrl("api.anthropic.com", undefined, {}), null);
});

test("an explicit override outranks the environment", () => {
  assert.equal(
    resolveProxyUrl("api.anthropic.com", "http://proxy.local:8080", {
      https_proxy: "http://127.0.0.1:7897",
    }).href,
    "http://proxy.local:8080/",
  );
});

test("accepts a bare host:port the way curl does", () => {
  assert.equal(
    resolveProxyUrl("api.anthropic.com", undefined, { https_proxy: "127.0.0.1:7897" }).href,
    "http://127.0.0.1:7897/",
  );
});

test("honours no_proxy, including for an explicit override", () => {
  const env = { https_proxy: "http://127.0.0.1:7897", no_proxy: "localhost,127.0.0.1,.internal" };
  assert.equal(resolveProxyUrl("localhost", undefined, env), null);
  assert.equal(resolveProxyUrl("127.0.0.1", undefined, env), null);
  assert.equal(resolveProxyUrl("gw.internal", undefined, env), null);
  assert.equal(resolveProxyUrl("localhost", "http://proxy.local:8080", env), null);
  // A suffix entry must not match a host that merely ends with the same text.
  assert.equal(resolveProxyUrl("notinternal", undefined, env).href, "http://127.0.0.1:7897/");
  assert.equal(resolveProxyUrl("api.anthropic.com", undefined, env).href, "http://127.0.0.1:7897/");
});

test("a bare * in no_proxy disables proxying wholesale", () => {
  assert.equal(
    resolveProxyUrl("api.anthropic.com", undefined, {
      https_proxy: "http://127.0.0.1:7897",
      no_proxy: "*",
    }),
    null,
  );
});

test("ignores an unusable proxy value rather than throwing", () => {
  assert.equal(
    resolveProxyUrl("api.anthropic.com", undefined, { https_proxy: "socks5://127.0.0.1:1080" }),
    null,
    "CONNECT tunnelling cannot speak socks",
  );
  assert.equal(resolveProxyUrl("api.anthropic.com", undefined, { https_proxy: "   " }), null);
});
