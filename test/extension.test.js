const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const extensionPath = path.resolve(__dirname, "../src/extension.js");

// Load extension.js with a fake `vscode`, a stubbed ./agentUsage, and a stubbed ./handoff. The
// returned `state` lets each test inspect registered commands, copied clipboard text, and
// notifications without touching the real VS Code API, git, or JSONL files.
function loadExtension({ usage }) {
  delete require.cache[extensionPath];

  const state = {
    commands: {},
    clipboardTexts: [],
    informationMessages: [],
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
          get(_key, defaultValue) {
            return defaultValue;
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
          readLatestAgentUsage() {
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
