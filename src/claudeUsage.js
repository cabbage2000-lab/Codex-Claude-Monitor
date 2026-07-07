const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  calculateContextPercent,
  readLastMatchingEvent,
  sortByMtimeDesc,
  walkFiles,
} = require("./sessionFiles");
const { isWindowsLikePath, matchesText, startsWithText } = require("./pathMatching");

function getDefaultClaudeRoot() {
  return path.join(os.homedir(), ".claude");
}

function mungeClaudeProjectPath(absolutePath) {
  return String(absolutePath).replace(/[^a-zA-Z0-9]/g, "-");
}

function matchesClaudeProjectDir(name, workspaceFolder) {
  const munged = mungeClaudeProjectPath(workspaceFolder);
  const caseInsensitive = isWindowsLikePath(workspaceFolder);
  return (
    matchesText(name, munged, caseInsensitive) ||
    startsWithText(name, `${munged}-`, caseInsensitive)
  );
}

function listMatchingProjectDirs(projectsRoot, workspaceFolders) {
  if (!fs.existsSync(projectsRoot)) {
    return [];
  }

  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => workspaceFolders.some((folder) => matchesClaudeProjectDir(name, folder)))
    .map((name) => path.join(projectsRoot, name));
}

// Probe sessions (`claude -p "/usage"`) and freshly started sessions have no assistant
// entry yet; callers try a few newest files instead of only the very newest.
const MAX_SESSION_FILE_CANDIDATES = 10;

function listClaudeSessionFilesByMtime(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  const projectsRoot = path.join(claudeRoot, "projects");
  const filterByWorkspace = Array.isArray(workspaceFolders) && workspaceFolders.length > 0;
  const roots = filterByWorkspace
    ? listMatchingProjectDirs(projectsRoot, workspaceFolders)
    : [projectsRoot];
  const files = roots.flatMap((root) => walkFiles(root, (name) => name.endsWith(".jsonl")));
  return sortByMtimeDesc(files);
}

function findLatestClaudeSessionFile(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  return listClaudeSessionFilesByMtime(claudeRoot, workspaceFolders)[0] || null;
}

function inferClaudeContextWindow(model) {
  const value = String(model || "").toLowerCase();
  if (value.includes("1m") || /claude-opus-4-[78]/.test(value)) {
    return 1000000;
  }
  return 200000;
}

function getUsageContextTokens(usage) {
  if (!usage) {
    return null;
  }

  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

function extractAssistantUsage(entry) {
  const usage = entry && entry.message && entry.message.usage;
  if (entry && entry.type === "assistant" && usage) {
    return {
      model: entry.message.model,
      usage,
      timestamp: entry.timestamp,
    };
  }
  return null;
}

function readLastClaudeUsageEvent(sessionFile) {
  return readLastMatchingEvent(sessionFile, extractAssistantUsage);
}

function readLatestClaudeUsage(claudeRoot = getDefaultClaudeRoot(), workspaceFolders = []) {
  const candidates = listClaudeSessionFilesByMtime(claudeRoot, workspaceFolders).slice(
    0,
    MAX_SESSION_FILE_CANDIDATES,
  );

  for (const sessionFile of candidates) {
    const event = readLastClaudeUsageEvent(sessionFile);
    if (!event) {
      continue;
    }
    const contextTokens = getUsageContextTokens(event.usage);
    const contextWindow = inferClaudeContextWindow(event.model);
    return {
      provider: "Claude",
      sessionFile,
      updatedAt: event.timestamp
        ? new Date(event.timestamp).getTime()
        : fs.statSync(sessionFile).mtimeMs,
      model: event.model,
      contextTokens,
      contextWindow,
      contextPercent: calculateContextPercent(contextTokens, contextWindow),
      usage: event.usage,
    };
  }
  return null;
}

module.exports = {
  findLatestClaudeSessionFile,
  getDefaultClaudeRoot,
  getUsageContextTokens,
  inferClaudeContextWindow,
  mungeClaudeProjectPath,
  readLastClaudeUsageEvent,
  readLatestClaudeUsage,
};
