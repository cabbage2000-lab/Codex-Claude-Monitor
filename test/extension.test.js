const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const extensionPath = path.resolve(__dirname, "../src/extension.js");
// The rate-limit source selection is exercised for real; only I/O is stubbed.
const { pickFreshestRateLimitSnapshot } = require("../src/agentUsage");

// Load extension.js with a fake `vscode`, a stubbed ./agentUsage, and a stubbed ./handoff. The
// returned `state` lets each test inspect registered commands, copied clipboard text, and
// notifications without touching the real VS Code API, git, or JSONL files.
// `statuslineUsage` / `oauthUsage` stand in for the two rate-limit sources, and
// `config` overrides individual agentTokenStatus settings.
function loadExtension({ usage, statuslineUsage = null, oauthUsage = null, config = {} }) {
  delete require.cache[extensionPath];

  const state = {
    commands: {},
    clipboardTexts: [],
    informationMessages: [],
    readOptions: [],
    oauthRefreshCalls: [],
  };

  const fakeVscode = {
    StatusBarAlignment: { Right: 1 },
    ThemeColor: function ThemeColor(id) {
      this.id = id;
    },
    env: {
      clipboard: {
        writeText(text) {
          state.clipboardTexts.push(text);
          return Promise.resolve();
        },
      },
    },
    commands: {
      registerCommand(command, callback) {
        state.commands[command] = callback;
        return { dispose() {} };
      },
    },
    window: {
      createStatusBarItem() {
        return { show() {}, hide() {} };
      },
      showInformationMessage(message) {
        state.informationMessages.push(message);
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get(key, defaultValue) {
            return Object.prototype.hasOwnProperty.call(config, key)
              ? config[key]
              : defaultValue;
          },
        };
      },
      onDidChangeConfiguration() {
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders() {
        return { dispose() {} };
      },
      workspaceFolders: [],
    },
  };

  const originalLoad = Module._load;
  Module._load = function load(request, parent) {
    if (request === "vscode") {
      return fakeVscode;
    }
    if (parent && parent.filename === extensionPath) {
      if (request === "./agentUsage") {
        return {
          formatAgentUsage() {
            return { text: "Codex 3%", tooltip: "Codex: ctx", severity: "low" };
          },
          pickFreshestRateLimitSnapshot,
          readLatestAgentUsage(options) {
            state.readOptions.push(options);
            return usage;
          },
        };
      }
      if (request === "./handoff") {
        return {
          buildHandoffPrompt: () => "HANDOFF_PROMPT",
          collectGitInfo: () => ({ branch: "main", status: "", recentCommits: "abc x" }),
        };
      }
      if (request === "./claudeStatuslineUsage") {
        return {
          readClaudeStatuslineUsage: () => statuslineUsage,
        };
      }
      if (request === "./claudeOAuthUsage") {
        return {
          readClaudeOAuthUsage: () => oauthUsage,
          refreshClaudeOAuthUsage: (options) => {
            state.oauthRefreshCalls.push(options);
            return Promise.resolve(oauthUsage);
          },
        };
      }
    }
    return originalLoad.call(this, request, parent);
  };

  const subscriptions = [];
  const extension = require(extensionPath);
  extension.activate({ subscriptions });

  const restore = () => {
    extension.deactivate();
    subscriptions.forEach((subscription) => subscription.dispose && subscription.dispose());
    Module._load = originalLoad;
    delete require.cache[extensionPath];
  };

  return { state, extension, restore };
}

test("status bar click refreshes without showing a notification", () => {
  const { state, restore } = loadExtension({ usage: { provider: "Codex" } });
  try {
    assert.equal(typeof state.commands["agentTokenStatus.refresh"], "function");
    state.commands["agentTokenStatus.refresh"]();

    assert.equal(state.informationMessages.length, 0);
  } finally {
    restore();
  }
});

test("handoff command copies prompt to clipboard and notifies above threshold", async () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 55 },
  });
  try {
    assert.equal(typeof state.commands["agentTokenStatus.handoff"], "function");
    await state.commands["agentTokenStatus.handoff"]();

    assert.deepEqual(state.clipboardTexts, ["HANDOFF_PROMPT"]);
    assert.equal(state.informationMessages.length, 1);
    assert.match(state.informationMessages[0], /paste it into the session/i);
  } finally {
    restore();
  }
});

test("handoff command does not trigger at the threshold, with a different message", async () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 50 },
  });
  try {
    await state.commands["agentTokenStatus.handoff"]();

    assert.deepEqual(state.clipboardTexts, ["HANDOFF_PROMPT"]);
    assert.match(state.informationMessages[0], /below the .* threshold/i);
  } finally {
    restore();
  }
});

// The OAuth read is the only rate-limit source that works when Claude Code runs
// solely in the VS Code panel, where the status line never executes.
test("prefers the OAuth snapshot when it is newer than the statusline bridge", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
    statuslineUsage: {
      rateLimits: { primary: { used_percent: 6, window_minutes: 300 } },
      capturedAt: 1780000000,
    },
    oauthUsage: {
      rateLimits: { primary: { used_percent: 42, window_minutes: 300 } },
      capturedAt: 1780009999,
    },
  });
  try {
    const options = state.readOptions[state.readOptions.length - 1];
    assert.equal(options.claudeRateLimits.primary.used_percent, 42);
    assert.equal(options.claudeRateLimitsCapturedAt, 1780009999);
  } finally {
    restore();
  }
});

test("keeps the statusline snapshot when it is the newer of the two", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
    statuslineUsage: {
      rateLimits: { primary: { used_percent: 6, window_minutes: 300 } },
      capturedAt: 1780009999,
    },
    oauthUsage: {
      rateLimits: { primary: { used_percent: 42, window_minutes: 300 } },
      capturedAt: 1780000000,
    },
  });
  try {
    const options = state.readOptions[state.readOptions.length - 1];
    assert.equal(options.claudeRateLimits.primary.used_percent, 6);
    assert.equal(options.claudeRateLimitsCapturedAt, 1780009999);
  } finally {
    restore();
  }
});

test("passes null rate limits when neither source has data", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
  });
  try {
    const options = state.readOptions[state.readOptions.length - 1];
    assert.equal(options.claudeRateLimits, null);
    assert.equal(options.claudeRateLimitsCapturedAt, null);
  } finally {
    restore();
  }
});

test("activation kicks off an unforced OAuth read", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
  });
  try {
    assert.equal(state.oauthRefreshCalls.length, 1);
    assert.equal(state.oauthRefreshCalls[0].force, false);
  } finally {
    restore();
  }
});

test("explicit refresh forces the OAuth read past its throttle", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
  });
  try {
    state.commands["agentTokenStatus.refresh"]();

    const last = state.oauthRefreshCalls[state.oauthRefreshCalls.length - 1];
    assert.equal(last.force, true);
  } finally {
    restore();
  }
});

// Opting out must stop both the credential read and the use of any cached value.
test("disabling enableClaudeOAuthUsage skips the read and ignores its snapshot", () => {
  const { state, restore } = loadExtension({
    usage: { provider: "Claude", contextPercent: 10 },
    oauthUsage: {
      rateLimits: { primary: { used_percent: 42, window_minutes: 300 } },
      capturedAt: 1780009999,
    },
    config: { enableClaudeOAuthUsage: false },
  });
  try {
    state.commands["agentTokenStatus.refresh"]();

    assert.equal(state.oauthRefreshCalls.length, 0);
    const options = state.readOptions[state.readOptions.length - 1];
    assert.equal(options.claudeRateLimits, null);
  } finally {
    restore();
  }
});
