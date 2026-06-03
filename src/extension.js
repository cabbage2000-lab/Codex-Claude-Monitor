const vscode = require("vscode");
const {
  formatAgentUsage,
  readLatestAgentUsage,
} = require("./agentUsage");
const { getDefaultSessionsRoot } = require("./codexUsage");
const { getDefaultClaudeRoot } = require("./claudeUsage");

// Settings that should trigger a refresh when changed, without the agentTokenStatus prefix.
const WATCHED_SETTINGS = ["sessionsRoot", "claudeRoot", "refreshIntervalMs"];

// Usage severity to status bar theme color. Theme colors adapt to light and dark themes.
const SEVERITY_COLORS = {
  low: new vscode.ThemeColor("charts.green"),
  medium: new vscode.ThemeColor("charts.yellow"),
  high: new vscode.ThemeColor("charts.red"),
};

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
    return null;
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
    statusItem.color = SEVERITY_COLORS[formatted.severity] || undefined;
    statusItem.show();
    return formatted;
  } catch (error) {
    const formatted = {
      text: "$(pulse) Context: error",
      tooltip: `Context Meter failed to read usage.\n${error.message}`,
      severity: null,
    };
    statusItem.text = formatted.text;
    statusItem.tooltip = formatted.tooltip;
    statusItem.color = undefined;
    statusItem.show();
    return formatted;
  }
}

function startRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshStatus, getRefreshIntervalMs());
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.name = "Context Meter";
  statusItem.command = "agentTokenStatus.refresh";
  context.subscriptions.push(statusItem);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.refresh", () => {
      refreshStatus();
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
