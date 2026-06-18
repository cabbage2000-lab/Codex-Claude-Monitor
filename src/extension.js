const vscode = require("vscode");
const {
  formatAgentUsage,
  readLatestAgentUsage,
} = require("./agentUsage");
const { buildHandoffPrompt, collectGitInfo } = require("./handoff");
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

// Context percent at/above which the handoff entry appears in the status bar.
const HANDOFF_THRESHOLD = 80;

let statusItem;
let handoffItem;
let refreshTimer;
let latestUsage = null;

function getConfiguredPath(key, getDefault) {
  const configured = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get(key, "");
  return configured && configured.trim() ? configured.trim() : getDefault();
}

function getRefreshIntervalMs() {
  const configured = vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get("refreshIntervalMs", 10000);
  return Math.max(1000, Number(configured) || 10000);
}

function getWorkspaceFolders() {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri && folder.uri.fsPath)
    .filter(Boolean);
}

function readUsage() {
  return readLatestAgentUsage({
    codexSessionsRoot: getConfiguredPath("sessionsRoot", getDefaultSessionsRoot),
    claudeRoot: getConfiguredPath("claudeRoot", getDefaultClaudeRoot),
    workspaceFolders: getWorkspaceFolders(),
  });
}

// Handoff is offered only when context usage is at/above the threshold, so the suffix stays hidden
// until the session is genuinely near full. Surfacing it is non-destructive: clicking only copies.
function shouldOfferHandoff(usage) {
  return Boolean(
    usage &&
      Number.isFinite(usage.contextPercent) &&
      usage.contextPercent >= HANDOFF_THRESHOLD,
  );
}

function refreshStatus() {
  if (!statusItem) {
    return null;
  }

  try {
    const usage = readUsage();
    latestUsage = usage;
    const formatted = formatAgentUsage(usage);
    statusItem.text = formatted.text;
    statusItem.tooltip = formatted.tooltip;
    statusItem.color = SEVERITY_COLORS[formatted.severity] || undefined;
    statusItem.show();
    if (handoffItem) {
      if (shouldOfferHandoff(usage)) {
        handoffItem.show();
      } else {
        handoffItem.hide();
      }
    }
    return formatted;
  } catch (error) {
    latestUsage = null;
    const formatted = {
      text: "$(pulse) ctx: error",
      tooltip: `Codex-Claude-Monitor failed to read usage.\n${error.message}`,
      severity: null,
    };
    statusItem.text = formatted.text;
    statusItem.tooltip = formatted.tooltip;
    statusItem.color = undefined;
    statusItem.show();
    if (handoffItem) {
      handoffItem.hide();
    }
    return formatted;
  }
}

function startRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshStatus, getRefreshIntervalMs());
}

// Build the handoff prompt from the freshest usage available. Falls back to a fresh read when the
// cached usage is stale or missing (e.g. refresh failed or the user clicked before first refresh).
function composeHandoffPrompt() {
  const usage = latestUsage || readUsage();
  const cwd = getWorkspaceFolders()[0] || process.cwd();
  return { usage, prompt: buildHandoffPrompt(usage, collectGitInfo(cwd)) };
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.name = "Codex-Claude-Monitor";
  statusItem.command = "agentTokenStatus.refresh";
  context.subscriptions.push(statusItem);

  // Handoff suffix sits just left of the main status item (lower priority on the right side).
  // It only shows at/above HANDOFF_THRESHOLD so it reads as an actionable "time to hand off" cue.
  handoffItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
  handoffItem.name = "Codex-Claude-Monitor Handoff";
  handoffItem.text = "$(export) 交接";
  handoffItem.tooltip =
    "上下文已达 80%。点击复制交接提示词,粘贴到当前窗口让 Claude 填全。";
  handoffItem.command = "agentTokenStatus.handoff";
  context.subscriptions.push(handoffItem);

  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.refresh", () => {
      refreshStatus();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.handoff", async () => {
      const { usage, prompt } = composeHandoffPrompt();
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        shouldOfferHandoff(usage)
          ? "交接提示词已复制,粘贴到当前窗口让 Claude 填全。"
          : "交接提示词已复制(当前上下文未到 80%)。",
      );
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
