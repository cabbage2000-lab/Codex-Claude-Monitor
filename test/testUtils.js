const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeTempDir(prefix = "context-meter-") {
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

// time accepts either a Date or epoch seconds.
function setMtime(filePath, time) {
  fs.utimesSync(filePath, time, time);
}

module.exports = {
  makeTempDir,
  setMtime,
  writeJsonl,
};
