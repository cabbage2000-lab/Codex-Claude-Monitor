const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeTempDir(prefix = "agent-token-status-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

// time 接受 Date 或 epoch 秒数。
function setMtime(filePath, time) {
  fs.utimesSync(filePath, time, time);
}

module.exports = {
  makeTempDir,
  setMtime,
  writeJsonl,
};
