#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# gwa — `git worktree add` + bootstrap.
#
# Thin wrapper that creates a worktree exactly like `git worktree add` and
# then runs `scripts/wt-bootstrap.sh` on the new path. Args are passed
# through verbatim, so all `git worktree add` flags work.
#
# Examples:
#   ./scripts/gwa.sh ../wt-feature -b feature-orders
#   ./scripts/gwa.sh ../wt-feature feature-orders
#   ./scripts/gwa.sh --detach ../wt-detached HEAD~1
#
# To call it as `gwa` from anywhere, drop a one-line alias / function in
# your shell rc:
#   alias gwa='/path/to/repo/scripts/gwa.sh'
# Or, monorepo-friendly (resolves the script of the repo you're standing in):
#   gwa() { "$(git rev-parse --show-toplevel)/scripts/gwa.sh" "$@"; }
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve the directory holding this script — used to call wt-bootstrap.sh
# regardless of CWD.
script_dir="$(cd "$(dirname "$0")" && pwd)"

# Pre-check: must be inside a git repo, otherwise `git worktree add` fails
# with a confusing message.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[gwa] not inside a git repo — aborting" >&2
    exit 1
fi

# Find the first non-flag argument: that's the new worktree path.
new_path=""
for a in "$@"; do
    case "$a" in
        -*) ;;
        *) new_path="$a"; break ;;
    esac
done

if [ -z "$new_path" ]; then
    echo "[gwa] usage: gwa <path> [<branch>] [git worktree add flags...]" >&2
    exit 2
fi

# Create the worktree.
git worktree add "$@"

# Bootstrap the new worktree (env + deps).
"$script_dir/wt-bootstrap.sh" "$new_path"

abs_new="$(cd "$new_path" && pwd)"
echo "✅ gwa: $abs_new"
