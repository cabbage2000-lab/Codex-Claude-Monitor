const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  parseUsageOutput,
  probeClaudeRateLimits,
  resolveClaudeCliPath,
} = require("../src/claudeRateLimits");

// Real output captured from `claude -p "/usage"` (Claude Code 2.1.202).
const REAL_OUTPUT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 25% used · resets Jul 7 at 8:20pm (Asia/Shanghai)",
  "Current week (all models): 8% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "Current week (Fable): 15% used · resets Jul 14 at 1am (Asia/Shanghai)",
  "",
  "What's contributing to your limits usage?",
].join("\n");

test("parseUsageOutput extracts 5h and weekly windows from real output", () => {
  assert.deepEqual(parseUsageOutput(REAL_OUTPUT), {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
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
  assert.deepEqual(result, {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  });
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
  assert.deepEqual(result, {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
  });
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
  assert.deepEqual(parseUsageOutput(REAL_OUTPUT.replace(/\n/g, "\r\n")), {
    primary: { used_percent: 25, window_minutes: 300 },
    secondary: { used_percent: 8, window_minutes: 10080 },
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
