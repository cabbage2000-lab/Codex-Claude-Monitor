const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("status bar click refreshes without showing a notification", () => {
  const extensionPath = path.resolve(__dirname, "../src/extension.js");
  delete require.cache[extensionPath];

  let refreshCommand;
  let informationMessages = 0;
  const subscriptions = [];
  const originalLoad = Module._load;

  const fakeVscode = {
    StatusBarAlignment: { Right: 1 },
    ThemeColor: function ThemeColor(id) {
      this.id = id;
    },
    commands: {
      registerCommand(command, callback) {
        if (command === "agentTokenStatus.refresh") {
          refreshCommand = callback;
        }
        return { dispose() {} };
      },
    },
    window: {
      createStatusBarItem() {
        return {
          show() {},
        };
      },
      showInformationMessage() {
        informationMessages += 1;
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

  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return fakeVscode;
    }
    if (parent && parent.filename === extensionPath && request === "./agentUsage") {
      return {
        formatAgentUsage() {
          return {
            text: "Codex 3%",
            tooltip: "Codex: ctx 8k / 258k (3%)",
            severity: "low",
          };
        },
        formatClickMessage() {
          return "Codex: ctx 8k / 258k (3%)";
        },
        readLatestAgentUsage() {
          return { provider: "Codex" };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extension = require(extensionPath);
    extension.activate({ subscriptions });

    assert.equal(typeof refreshCommand, "function");
    refreshCommand();

    assert.equal(informationMessages, 0);
    extension.deactivate();
  } finally {
    subscriptions.forEach((subscription) => subscription.dispose && subscription.dispose());
    Module._load = originalLoad;
    delete require.cache[extensionPath];
  }
});
