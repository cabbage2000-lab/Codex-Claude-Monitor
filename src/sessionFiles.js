const fs = require("node:fs");
const path = require("node:path");

// 递归收集 root 下文件名满足 matchesName 的所有文件。
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

// 按 mtime 降序排序（同 mtime 时按文件名字典序降序，保证结果稳定）。
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

// 状态栏每隔几秒刷新一次，按 (mtime, size) 缓存解析结果，避免重复读取未变化的会话文件。
const lastEventCache = new Map();

// 逐行解析 JSONL，返回最后一条 extract 命中（返回非空）的结果。
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
