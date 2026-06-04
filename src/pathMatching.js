function isWindowsLikePath(value) {
  const pathValue = String(value || "");
  return /^[a-zA-Z]:[\\/]/.test(pathValue) || pathValue.startsWith("\\\\") || pathValue.includes("\\");
}

function normalizePathForComparison(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const normalized = value.replace(/[\\/]+/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}

function isPathInside(child, parent) {
  const normalizedChild = normalizePathForComparison(child);
  const normalizedParent = normalizePathForComparison(parent);
  if (!normalizedChild || !normalizedParent) {
    return false;
  }

  const caseInsensitive = isWindowsLikePath(child) || isWindowsLikePath(parent);
  const comparableChild = caseInsensitive ? normalizedChild.toLowerCase() : normalizedChild;
  const comparableParent = caseInsensitive ? normalizedParent.toLowerCase() : normalizedParent;

  return (
    comparableChild === comparableParent ||
    comparableChild.startsWith(`${comparableParent}/`)
  );
}

function matchesText(value, expected, caseInsensitive) {
  if (caseInsensitive) {
    return String(value).toLowerCase() === String(expected).toLowerCase();
  }
  return value === expected;
}

function startsWithText(value, expected, caseInsensitive) {
  if (caseInsensitive) {
    return String(value).toLowerCase().startsWith(String(expected).toLowerCase());
  }
  return value.startsWith(expected);
}

module.exports = {
  isPathInside,
  isWindowsLikePath,
  matchesText,
  startsWithText,
};
