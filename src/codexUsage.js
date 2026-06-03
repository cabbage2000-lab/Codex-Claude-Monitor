const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  calculateContextPercent,
  parseJsonLine,
  readLastMatchingEvent,
  sortByMtimeDesc,
  walkFiles,
} = require("./sessionFiles");

function getDefaultSessionsRoot() {
  return path.join(os.homedir(), ".codex", "sessions");
}

function isPathInside(child, parent) {
  if (typeof child !== "string" || !child) {
    return false;
  }
  return child === parent || child.startsWith(parent + path.sep);
}

function readFirstLine(sessionFile, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(sessionFile, "r");
    const chunk = Buffer.alloc(8192);
    const chunks = [];
    let position = 0;
    let newlineFound = false;
    while (position < maxBytes && !newlineFound) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
      newlineFound = chunk.subarray(0, bytesRead).includes(0x0a);
      position += bytesRead;
    }
    if (chunks.length === 0) {
      return null;
    }
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0];
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

// session_meta is written as the first line when the session is created and does not change.
// Cache successful cwd reads by file path so refreshes do not reread unchanged candidate files.
// Only cache matches so newly created files without a first line are not permanently treated as empty.
const sessionCwdCache = new Map();

function readSessionCwd(sessionFile) {
  if (sessionCwdCache.has(sessionFile)) {
    return sessionCwdCache.get(sessionFile);
  }

  const entry = parseJsonLine(readFirstLine(sessionFile));
  const cwd =
    entry && entry.type === "session_meta" && entry.payload ? entry.payload.cwd || null : null;
  if (cwd) {
    sessionCwdCache.set(sessionFile, cwd);
  }
  return cwd;
}

function matchesWorkspace(sessionFile, workspaceFolders) {
  const cwd = readSessionCwd(sessionFile);
  return workspaceFolders.some((folder) => isPathInside(cwd, folder));
}

function findLatestSessionFile(sessionsRoot = getDefaultSessionsRoot(), workspaceFolders = []) {
  const files = walkFiles(sessionsRoot, (name) => /^rollout-.*\.jsonl$/.test(name));
  if (files.length === 0) {
    return null;
  }

  const sorted = sortByMtimeDesc(files);

  if (!Array.isArray(workspaceFolders) || workspaceFolders.length === 0) {
    return sorted[0];
  }

  return sorted.find((file) => matchesWorkspace(file, workspaceFolders)) || null;
}

function getTokenCountPayload(entry) {
  if (entry && entry.type === "event_msg" && entry.payload && entry.payload.type === "token_count") {
    return {
      ...entry.payload,
      rate_limits: entry.payload.rate_limits || entry.rate_limits || {},
    };
  }
  return null;
}

function readLastTokenEvent(sessionFile) {
  return readLastMatchingEvent(sessionFile, getTokenCountPayload);
}

function readLatestUsage(sessionsRoot = getDefaultSessionsRoot(), workspaceFolders = []) {
  const sessionFile = findLatestSessionFile(sessionsRoot, workspaceFolders);
  const tokenEvent = readLastTokenEvent(sessionFile);
  if (!tokenEvent || !tokenEvent.info || !tokenEvent.info.total_token_usage) {
    return null;
  }

  const total = tokenEvent.info.total_token_usage;
  const last = tokenEvent.info.last_token_usage || {};
  const contextWindow = tokenEvent.info.model_context_window || null;
  const contextTokens = Number.isFinite(last.input_tokens) ? last.input_tokens : last.total_tokens;

  return {
    provider: "Codex",
    sessionFile,
    updatedAt: fs.statSync(sessionFile).mtimeMs,
    total,
    last,
    contextWindow,
    contextTokens,
    contextPercent: calculateContextPercent(contextTokens, contextWindow),
    rateLimits: tokenEvent.rate_limits || {},
  };
}

module.exports = {
  findLatestSessionFile,
  getDefaultSessionsRoot,
  readLastTokenEvent,
  readLatestUsage,
};
