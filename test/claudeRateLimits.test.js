const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  parseUsageOutput,
  probeClaudeRateLimits,
  resolveClaudeCliPath,
} = require("../src/claudeRateLimits");

// Real output captured from `claude -p "/usage"` (Claude Code 2.1.202; 2.1.207
// output has the same shape). Covers both reset-time forms: with minutes
// ("8:20pm") and without ("1am").
const REAL_OUTPUT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 25% used · resets Jul 7 at 8:20pm (Asia/Shanghai)",
  "Current week (all models): 8% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "Current week (Fable): 15% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "",
  "What's contributing to your limits usage?",
].join("\n");

// Same week as the Jul 7 / Jul 14 resets in REAL_OUTPUT. Local time construction
// keeps the assertions deterministic across time zones.
const NOW = new Date(2026, 6, 7, 12, 0).getTime();
const SESSION_RESETS_AT = Math.floor(new Date(2026, 6, 7, 20, 20).getTime() / 1000);
const WEEK_RESETS_AT = Math.floor(new Date(2026, 6, 14, 1, 0).getTime() / 1000);

test("parseUsageOutput extracts 5h and weekly windows with reset times", () => {
  assert.deepEqual(parseUsageOutput(REAL_OUTPUT, NOW), {
    primary: { used_percent: 25, window_minutes: 300, resets_at: SESSION_RESETS_AT },
    secondary: { used_percent: 8, window_minutes: 10080, resets_at: WEEK_RESETS_AT },
  });
});

test("parseUsageOutput handles 12-hour clock edges", () => {
  const resetsAt = (line) => parseUsageOutput(line, NOW).primary.resets_at;

  assert.equal(
    resetsAt("Current session: 5% used · resets Jul 14 at 12am (Asia/Shanghai)"),
    Math.floor(new Date(2026, 6, 14, 0, 0).getTime() / 1000),
  );
  assert.equal(
    resetsAt("Current session: 5% used · resets Jul 14 at 12pm (Asia/Shanghai)"),
    Math.floor(new Date(2026, 6, 14, 12, 0).getTime() / 1000),
  );
  assert.equal(
    resetsAt("Current session: 5% used · resets Jul 14 at 12:59am (Asia/Shanghai)"),
    Math.floor(new Date(2026, 6, 14, 0, 59).getTime() / 1000),
  );
  // The zone suffix is ignored: the wall clock is always parsed as local time.
  assert.equal(
    resetsAt("Current session: 5% used · resets Jul 14 at 1am (America/New_York)"),
    Math.floor(new Date(2026, 6, 14, 1, 0).getTime() / 1000),
  );
});

test("parseUsageOutput infers the year across the New Year boundary", () => {
  const decemberNow = new Date(2026, 11, 30, 12, 0).getTime();
  const forward = parseUsageOutput(
    "Current session: 5% used · resets Jan 2 at 1am (Asia/Shanghai)",
    decemberNow,
  );
  assert.equal(forward.primary.resets_at, Math.floor(new Date(2027, 0, 2, 1, 0).getTime() / 1000));

  // A just-passed reset in marginally stale output must stay in the past, not
  // jump a year ahead (the nearest-year rule beats "current year, else +1").
  const januaryNow = new Date(2027, 0, 1, 0, 30).getTime();
  const backward = parseUsageOutput(
    "Current session: 5% used · resets Dec 31 at 11:55pm (Asia/Shanghai)",
    januaryNow,
  );
  assert.equal(
    backward.primary.resets_at,
    Math.floor(new Date(2026, 11, 31, 23, 55).getTime() / 1000),
  );
});

test("parseUsageOutput omits resets_at when the reset text does not parse", () => {
  assert.deepEqual(parseUsageOutput("Current session: 91% used · resets Xyz 5 at 1pm", NOW), {
    primary: { used_percent: 91, window_minutes: 300 },
  });
  assert.deepEqual(parseUsageOutput("Current session: 91% used · resets tomorrow", NOW), {
    primary: { used_percent: 91, window_minutes: 300 },
  });
});

test("parseUsageOutput returns partial result when weekly line is missing", () => {
  assert.deepEqual(parseUsageOutput("Current session: 91% used · resets soon"), {
    primary: { used_percent: 91, window_minutes: 300 },
  });
});

test("parseUsageOutput returns null for unrelated or empty text", () => {
  assert.equal(parseUsageOutput("error: not logged in"), null);
  assert.equal(parseUsageOutput(""), null);
  assert.equal(parseUsageOutput(null), null);
});

test("resolveClaudeCliPath prefers configured path, then known locations, then PATH", () => {
  const home = require("node:os").homedir();
  const localBin = path.join(home, ".local", "bin", "claude");

  assert.equal(
    resolveClaudeCliPath("/custom/claude", () => true, "darwin"),
    "/custom/claude",
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === localBin, "darwin"),
    localBin,
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === "/opt/homebrew/bin/claude", "darwin"),
    "/opt/homebrew/bin/claude",
  );
  assert.equal(resolveClaudeCliPath("", () => false, "darwin"), "claude");
});

// Windows installs use different names and locations: the native installer ships
// claude.exe under ~/.local/bin, npm global installs ship a claude.cmd shim under
// %APPDATA%\npm. The Unix candidates never match there.
test("resolveClaudeCliPath finds Windows install locations", () => {
  const home = require("node:os").homedir();
  const nativeExe = path.join(home, ".local", "bin", "claude.exe");
  const appData = "C:\\Users\\dev\\AppData\\Roaming";
  const npmCmd = path.join(appData, "npm", "claude.cmd");
  const env = { APPDATA: appData };

  assert.equal(
    resolveClaudeCliPath("C:\\tools\\claude.cmd", () => true, "win32", env),
    "C:\\tools\\claude.cmd",
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === nativeExe, "win32", env),
    nativeExe,
  );
  assert.equal(
    resolveClaudeCliPath("", (p) => p === npmCmd, "win32", env),
    npmCmd,
  );
  assert.equal(resolveClaudeCliPath("", () => false, "win32", env), "claude");
});

test("resolveClaudeCliPath tolerates a missing APPDATA on Windows", () => {
  assert.equal(resolveClaudeCliPath("", () => false, "win32", {}), "claude");
});

test("probeClaudeRateLimits parses stdout from the injected exec", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, REAL_OUTPUT, "");
  };
  const result = await probeClaudeRateLimits({
    cliPath: "/fake/claude",
    execFileImpl: fakeExec,
  });
  // The probe parses with the real current time, so resets_at depends on the test
  // run date; assert the stable fields and the presence of the timestamps.
  assert.equal(result.primary.used_percent, 25);
  assert.equal(result.primary.window_minutes, 300);
  assert.ok(Number.isFinite(result.primary.resets_at));
  assert.equal(result.secondary.used_percent, 8);
  assert.equal(result.secondary.window_minutes, 10080);
  assert.ok(Number.isFinite(result.secondary.resets_at));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/fake/claude");
  assert.deepEqual(calls[0].args, ["-p", "/usage"]);
  assert.equal(calls[0].options.timeout, 30000);
  assert.ok(calls[0].options.cwd);
});

// Since the Node CVE-2024-27980 fix, spawning a .cmd/.bat without a shell throws
// EINVAL, so the npm shim must run through cmd.exe (with the path quoted because
// npm paths can contain spaces).
test("probeClaudeRateLimits runs .cmd shims through a shell on Windows", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, REAL_OUTPUT, "");
  };
  const cmdPath = "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd";
  const result = await probeClaudeRateLimits({
    cliPath: cmdPath,
    platform: "win32",
    execFileImpl: fakeExec,
  });
  assert.equal(result.primary.used_percent, 25);
  assert.equal(result.secondary.used_percent, 8);
  assert.equal(calls[0].file, `"${cmdPath}"`);
  assert.equal(calls[0].options.shell, true);
  assert.deepEqual(calls[0].args, ["-p", "/usage"]);
});

// A bare "claude" needs cmd.exe's PATHEXT lookup: execFile alone only resolves
// .com/.exe on PATH and would miss an npm claude.cmd shim.
test("probeClaudeRateLimits uses a shell for bare command names on Windows", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, options });
    callback(null, REAL_OUTPUT, "");
  };
  await probeClaudeRateLimits({
    cliPath: "claude",
    platform: "win32",
    execFileImpl: fakeExec,
  });
  assert.equal(calls[0].file, '"claude"');
  assert.equal(calls[0].options.shell, true);
});

test("probeClaudeRateLimits runs .exe and POSIX paths directly", async () => {
  const calls = [];
  const fakeExec = (file, args, options, callback) => {
    calls.push({ file, options });
    callback(null, REAL_OUTPUT, "");
  };
  await probeClaudeRateLimits({
    cliPath: "C:\\Users\\dev\\.local\\bin\\claude.exe",
    platform: "win32",
    execFileImpl: fakeExec,
  });
  await probeClaudeRateLimits({
    cliPath: "/usr/local/bin/claude",
    platform: "darwin",
    execFileImpl: fakeExec,
  });
  assert.equal(calls[0].file, "C:\\Users\\dev\\.local\\bin\\claude.exe");
  assert.ok(!calls[0].options.shell);
  assert.equal(calls[1].file, "/usr/local/bin/claude");
  assert.ok(!calls[1].options.shell);
});

test("parseUsageOutput handles CRLF output from Windows", () => {
  assert.deepEqual(parseUsageOutput(REAL_OUTPUT.replace(/\n/g, "\r\n"), NOW), {
    primary: { used_percent: 25, window_minutes: 300, resets_at: SESSION_RESETS_AT },
    secondary: { used_percent: 8, window_minutes: 10080, resets_at: WEEK_RESETS_AT },
  });
});

test("probeClaudeRateLimits resolves null on exec error", async () => {
  const fakeExec = (file, args, options, callback) => {
    callback(new Error("ENOENT"), "", "");
  };
  assert.equal(await probeClaudeRateLimits({ execFileImpl: fakeExec }), null);
});

test("probeClaudeRateLimits resolves null on unparseable stdout", async () => {
  const fakeExec = (file, args, options, callback) => {
    callback(null, "unexpected", "");
  };
  assert.equal(await probeClaudeRateLimits({ execFileImpl: fakeExec }), null);
});
