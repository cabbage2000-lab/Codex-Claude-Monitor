const vscode = require("vscode");
const {
  formatAgentUsage,
  readLatestAgentUsage,
} = require("./agentUsage");
const { getDefaultSessionsRoot } = require("./codexUsage");
const { getDefaultClaudeRoot } = require("./claudeUsage");

// 配置变更时需要触发刷新的设置项（不含 agentTokenStatus. 前缀）。
const WATCHED_SETTINGS = ["sessionsRoot", "claudeRoot", "refreshIntervalMs"];

let statusItem;
let refreshTimer;

function getConfiguredPath(key, getDefault) {
  const configured = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get(key, "");
  return configured && configured.trim() ? configured.trim() : getDefault();
}

function getRefreshIntervalMs() {
  const configured = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get("refreshIntervalMs", 5000);
  return Math.max(1000, Number(configured) || 5000);
}

function getWorkspaceFolders() {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri && folder.uri.fsPath)
    .filter(Boolean);
}

function refreshStatus() {
  if (!statusItem) {
    return;
  }

  try {
    const usage = readLatestAgentUsage({
      codexSessionsRoot: getConfiguredPath("sessionsRoot", getDefaultSessionsRoot),
      claudeRoot: getConfiguredPath("claudeRoot", getDefaultClaudeRoot),
      workspaceFolders: getWorkspaceFolders(),
    });
    const formatted = formatAgentUsage(usage);
    statusItem.text = formatted.text;
    statusItem.tooltip = formatted.tooltip;
    statusItem.show();
  } catch (error) {
    statusItem.text = "$(pulse) Agent tokens: error";
    statusItem.tooltip = `Agent Token Status failed to read usage.\n${error.message}`;
    statusItem.show();
  }
}

function startRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshStatus, getRefreshIntervalMs());
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.name = "Agent Token Status";
  statusItem.command = "agentTokenStatus.refresh";
  context.subscriptions.push(statusItem);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.refresh", () => {
      refreshStatus();
      vscode.window.showInformationMessage("Agent token status refreshed.");
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (WATCHED_SETTINGS.some((key) => event.affectsConfiguration(`agentTokenStatus.${key}`))) {
        refreshStatus();
        startRefreshTimer();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatus();
    }),
  );

  refreshStatus();
  startRefreshTimer();
}

function deactivate() {
  clearInterval(refreshTimer);
}

module.exports = {
  activate,
  deactivate,
};
