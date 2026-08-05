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

test("returns null when no window carries data", () => {
  assert.equal(mapUsageResponse({}, 1), null);
  assert.equal(mapUsageResponse({ seven_day: { utilization: null } }, 1), null);
  assert.equal(mapUsageResponse(null, 1), null);
});

test("extractAccessToken reads only the access token, never the refresh token", () => {
  const blob = {
    claudeAiOauth: {
      accessToken: "at-123",
      refreshToken: "rt-should-never-be-used",
      expiresAt: 2000,
    },
  };
  assert.equal(extractAccessToken(blob, 1000), "at-123");
});

test("extractAccessToken skips an expired token instead of refreshing it", () => {
  const blob = { claudeAiOauth: { accessToken: "at-123", expiresAt: 1000 } };
  assert.equal(extractAccessToken(blob, 1000), null);
  assert.equal(extractAccessToken(blob, 5000), null);
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

// A team or enterprise subscription is not served by this endpoint: it answers
// 403 no matter how often we ask, so the module must stop asking entirely.
test("a 403 marks the endpoint unsupported and stops all further attempts", async () => {
  resetClaudeOAuthUsageState();
  const calls = { usageRequests: 0 };
  const deps = {
    readAccessToken: async () => "at-123",
    requestUsage: async () => {
      calls.usageRequests += 1;
      const error = new Error("usage endpoint returned 403");
      error.unsupported = true;
      throw error;
    },
  };
  const now = 10_000_000;

  await refreshClaudeOAuthUsage({ now, deps });
  assert.equal(calls.usageRequests, 1);
  assert.equal(isClaudeOAuthUsageUnsupported(), true);

  // Neither the timer nor an explicit forced refresh may retry.
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 10, deps });
  await refreshClaudeOAuthUsage({ now: now + MIN_REFRESH_INTERVAL_MS * 20, force: true, deps });
  assert.equal(calls.usageRequests, 1);
});

test("an ordinary failure does not mark the endpoint unsupported", async () => {
  resetClaudeOAuthUsageState();
  const { deps } = makeDeps({ fail: true });

  await refreshClaudeOAuthUsage({ now: 10_000_000, deps });

  assert.equal(isClaudeOAuthUsageUnsupported(), false);
});
