const vscode = require("vscode");
const {
  formatAgentUsage,
  pickFreshestRateLimitSnapshot,
  readLatestAgentUsage,
} = require("./agentUsage");
const { buildHandoffPrompt, collectGitInfo } = require("./handoff");
const { getDefaultSessionsRoot } = require("./codexUsage");
const { getDefaultClaudeRoot } = require("./claudeUsage");
const { readClaudeStatuslineUsage } = require("./claudeStatuslineUsage");
const {
  readClaudeOAuthUsage,
  refreshClaudeOAuthUsage,
} = require("./claudeOAuthUsage");

// Settings that should trigger a refresh when changed, without the agentTokenStatus prefix.
const WATCHED_SETTINGS = [
  "sessionsRoot",
  "claudeRoot",
  "refreshIntervalMs",
  "enableClaudeOAuthUsage",
];

// Usage severity to status bar theme color. Theme colors adapt to light and dark themes.
const SEVERITY_COLORS = {
  low: new vscode.ThemeColor("charts.green"),
  medium: new vscode.ThemeColor("charts.yellow"),
  high: new vscode.ThemeColor("charts.red"),
};

// Context percent above which the handoff entry appears in the status bar.
const HANDOFF_THRESHOLD = 50;

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

function isClaudeOAuthUsageEnabled() {
  return vscode.workspace
    .getConfiguration("agentTokenStatus")
    .get("enableClaudeOAuthUsage", true);
}

function readUsage() {
  const claudeRoot = getConfiguredPath("claudeRoot", getDefaultClaudeRoot);
  // Claude subscription limits have two possible sources. The OAuth read works in
  // every mode, including the VS Code panel where the statusline never runs; the
  // statusline bridge (scripts/usage-cache.sh) costs nothing when a terminal
  // session is active. Take whichever observed the limits most recently. With
  // neither available the display degrades to context-only.
  const snapshot = pickFreshestRateLimitSnapshot([
    isClaudeOAuthUsageEnabled() ? readClaudeOAuthUsage() : null,
    readClaudeStatuslineUsage(claudeRoot),
  ]);
  return readLatestAgentUsage({
    codexSessionsRoot: getConfiguredPath("sessionsRoot", getDefaultSessionsRoot),
    claudeRoot,
    workspaceFolders: getWorkspaceFolders(),
    claudeRateLimits: snapshot ? snapshot.rateLimits : null,
    claudeRateLimitsCapturedAt: snapshot ? snapshot.capturedAt : null,
  });
}

// Kick off the background OAuth usage read. Throttled inside the module, never
// throws, and repaints only when it actually produced a snapshot — so the status
// bar stays synchronous and a slow or failing network never blocks a render.
function scheduleClaudeOAuthUsageRefresh(force) {
  if (!isClaudeOAuthUsageEnabled()) {
    return;
  }
  refreshClaudeOAuthUsage({
    claudeRoot: getConfiguredPath("claudeRoot", getDefaultClaudeRoot),
    force,
  })
    .then((snapshot) => {
      if (snapshot && statusItem) {
        renderStatus();
      }
    })
    .catch(() => {
      // Already swallowed inside the module; nothing actionable here.
    });
}

// Handoff is offered only when context usage is strictly above the threshold, so the suffix stays
// hidden until the session is genuinely filling up. Surfacing it is non-destructive: click only copies.
function shouldOfferHandoff(usage) {
  return Boolean(
    usage &&
      Number.isFinite(usage.contextPercent) &&
      usage.contextPercent > HANDOFF_THRESHOLD,
  );
}

// Paint the status bar from locally available data only. Split out from
// refreshStatus so the background OAuth read can repaint without re-triggering
// itself.
function renderStatus() {
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

// Full refresh: repaint from local files and kick the background OAuth read.
// `force` (an explicit user refresh) relaxes the read throttle to its floor.
function refreshStatus(options = {}) {
  scheduleClaudeOAuthUsageRefresh(Boolean(options.force));
  return renderStatus();
}

function startRefreshTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshStatus(), getRefreshIntervalMs());
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
  handoffItem.text = "$(export) Handoff";
  handoffItem.tooltip = `Context exceeds ${HANDOFF_THRESHOLD}%. Click to copy a handoff prompt and paste it into the session.`;
  handoffItem.command = "agentTokenStatus.handoff";
  context.subscriptions.push(handoffItem);

  context.subscriptions.push({
    dispose: () => {
      clearInterval(refreshTimer);
    },
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.refresh", () => {
      // An explicit click should actually re-read the limits, not just repaint.
      refreshStatus({ force: true });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentTokenStatus.handoff", async () => {
      const { usage, prompt } = composeHandoffPrompt();
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(
        shouldOfferHandoff(usage)
          ? "Handoff prompt copied — paste it into the session for Claude to fill in."
          : `Handoff prompt copied (context is still below the ${HANDOFF_THRESHOLD}% threshold).`,
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
  // Clearing these makes an in-flight OAuth read's repaint a no-op instead of
  // touching disposed status bar items.
  statusItem = undefined;
  handoffItem = undefined;
}

module.exports = {
  activate,
  deactivate,
};
