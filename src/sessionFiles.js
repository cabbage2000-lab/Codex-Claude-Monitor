const fs = require("node:fs");
const path = require("node:path");

// Recursively collect files under root whose filenames match matchesName.
function walkFiles(root, matchesName, files = []) {
  if (!fs.existsSync(root)) {
    return files;
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, matchesName, files);
    } else if (entry.isFile() && matchesName(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

// Sort by descending mtime. Break ties by descending filename for stable results.
function sortByMtimeDesc(files) {
  return files
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file))
    .map((entry) => entry.file);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function calculateContextPercent(contextTokens, contextWindow) {
  if (!Number.isFinite(contextTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  return Math.round((contextTokens / contextWindow) * 100);
}

// The status bar refreshes every few seconds, so cache parsed results by (mtime, size).
const lastEventCache = new Map();

// Parse JSONL line by line and return the last non-null result from extract.
function readLastMatchingEvent(sessionFile, extract) {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return null;
  }

  const stat = fs.statSync(sessionFile);
  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = lastEventCache.get(sessionFile);
  if (cached && cached.key === cacheKey) {
    return cached.result;
  }

  const content = fs.readFileSync(sessionFile, "utf8");
  let latest = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const result = extract(parseJsonLine(line));
    if (result) {
      latest = result;
    }
  }

  lastEventCache.set(sessionFile, { key: cacheKey, result: latest });
  return latest;
}

module.exports = {
  calculateContextPercent,
  parseJsonLine,
  readLastMatchingEvent,
  sortByMtimeDesc,
  walkFiles,
};
