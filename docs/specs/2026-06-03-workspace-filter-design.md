# Workspace Filter Design

Date: 2026-06-03

## Goal

The status bar should only show agent sessions whose working directory (`cwd`) is inside the current VS Code workspace. This prevents CLI sessions opened from other directories from taking over the display.

## Matching Rules

- A session matches when its `cwd` equals a workspace folder or is inside one of its subdirectories. Prefix matching must respect path separator boundaries.
- Multi-root workspaces match when any workspace folder matches.

## Implementation

### Interface Change

`readLatestAgentUsage({ codexSessionsRoot, claudeRoot, workspaceFolders })` accepts optional `workspaceFolders` as an array of absolute paths:

- Missing or empty arrays mean no filtering and preserve the existing global behavior.
- Parser layers (`codexUsage`, `claudeUsage`, and `agentUsage`) stay independent from the `vscode` API.
- `extension.js` reads paths from `vscode.workspace.workspaceFolders` and passes them in.

### Claude Code (`claudeUsage.js`)

Claude stores sessions by cwd under `~/.claude/projects/<munged-cwd>/`, where non-alphanumeric characters in the path are replaced with `-`. Apply the same munging to each workspace path, then scan project directories whose name equals the munged path or starts with `<munged>-`. This filters without reading file contents.

### Codex (`codexUsage.js`)

Codex rollout files are stored in date directories, and the cwd is available in the first line at `session_meta.payload.cwd`. Sort candidate files by descending mtime, read only the first line of each candidate, and stop at the first match.

## Edge Cases

- Empty VS Code windows with no workspace folder do not filter and keep the existing behavior.
- Workspaces without a matching session display the existing `n/a` state.
- Codex files with missing or unparsable `session_meta` are treated as non-matches while filtering.

## Tests

- Codex and Claude sessions inside and outside a workspace.
- Munged directory prefix matching for subdirectory sessions.
- Multi-root workspace matching.
- Existing global behavior when `workspaceFolders` is omitted.
