#!/bin/bash
# Codex-Claude-Monitor: statusline usage bridge.
#
# Claude Code passes a JSON blob on stdin to the configured statusline command.
# For Claude.ai subscribers it includes a `rate_limits` block (the 5-hour and
# 7-day subscription windows sourced from the OAuth /api/oauth/usage endpoint) —
# the only place a user script can read those limits. This script snapshots that
# block to a cache file the VS Code extension reads, then passes stdin through
# unchanged so an existing statusline command can pipe through it:
#
#   cat | ~/.vscode/extensions/.../scripts/usage-cache.sh | your-statusline
#
# It never fails the pipeline: a missing jq, absent rate_limits, or unwritable
# cache directory just skips the snapshot. The percent-only case is impossible
# here because reset timestamps come from the same payload.

CACHE_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.usage-cache.json"

# Buffer stdin so we can both snapshot it and pass it through.
input=$(cat)
printf '%s' "$input"

# Best-effort snapshot; any failure below is swallowed so the statusline still renders.
if command -v jq >/dev/null 2>&1; then
  rate_limits=$(printf '%s' "$input" | jq -c '.rate_limits // empty' 2>/dev/null)
  if [ -n "$rate_limits" ]; then
    now=$(date +%s)
    tmp="${CACHE_FILE}.tmp.$$"
    if printf '{"capturedAt":%s,"rate_limits":%s}\n' "$now" "$rate_limits" > "$tmp" 2>/dev/null; then
      mv -f "$tmp" "$CACHE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
    fi
  fi
fi
