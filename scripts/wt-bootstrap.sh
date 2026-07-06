#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# wt-bootstrap.sh — idempotent setup of a freshly-created git worktree.
#
# Runs three steps:
#   1. Resolve the main repo's `.git/objects` (via --git-common-dir) so the
#      worktree can pull `.env` / credentials from the canonical location.
#   2. Activate `.envrc` via direnv if available, otherwise fall back to a
#      symlink of `.env` (and `.env.local`).
#   3. Reinstall dependencies (bun / pnpm / npm) so node_modules is consistent.
#
# Safe to re-run. Skips work that's already been done.
#
# Invocation:
#   ./scripts/wt-bootstrap.sh                    # bootstrap CWD
#   ./scripts/wt-bootstrap.sh /abs/path/to/wt    # bootstrap that path
#   <called from .git/hooks/post-checkout>       # automatic on worktree add
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

target="${1:-$(pwd)}"
target="$(cd "$target" && pwd)"
cd "$target"

# ── Sanity: must be inside a git repo / worktree ──────────────────────────
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[wt-bootstrap] $target is not a git work tree — skipping" >&2
    exit 0
fi

# Resolve the canonical (shared) git dir — this is the main repo's `.git/`
# regardless of which worktree we are in.
common_dir="$(git rev-parse --git-common-dir)"
common_dir="$(cd "$common_dir" && pwd)"
main_root="$(cd "$common_dir/.." && pwd)"

# If we ARE the main repo, nothing to do.
if [ "$main_root" = "$target" ]; then
    echo "[wt-bootstrap] running inside main repo — nothing to bootstrap"
    exit 0
fi

echo "[wt-bootstrap] worktree:  $target"
echo "[wt-bootstrap] main repo: $main_root"

# ── 1. Env loading: direnv path or symlink fallback ───────────────────────
if command -v direnv >/dev/null 2>&1 && [ -f "$target/.envrc" ]; then
    # direnv handles env loading on every `cd`. We only need to authorise.
    direnv allow "$target" >/dev/null 2>&1 || true
    echo "[wt-bootstrap] env: direnv allowed (.envrc resolves to $main_root/.env)"

    # Clean up any stale symlinks left from the fallback path; .envrc
    # supersedes them. Files (non-symlinks) are NOT touched — those are
    # legitimate per-worktree overrides the user has put down.
    for f in .env .env.local; do
        if [ -L "$target/$f" ]; then
            rm "$target/$f"
            echo "[wt-bootstrap] env: removed stale symlink $f (direnv supersedes)"
        fi
    done
else
    # Fallback: symlink the env files. Only creates the link if the source
    # exists in the main and the destination doesn't already (safe to re-run).
    for f in .env .env.local; do
        src="$main_root/$f"
        dst="$target/$f"
        if [ -f "$src" ] && [ ! -e "$dst" ]; then
            ln -s "$src" "$dst"
            echo "[wt-bootstrap] env: symlinked $f → $src"
        fi
    done
fi

# ── 2. Dependencies ───────────────────────────────────────────────────────
if [ -f "$target/bun.lock" ] || [ -f "$target/bun.lockb" ]; then
    if [ ! -d "$target/node_modules" ]; then
        ( cd "$target" && bun install --frozen-lockfile )
    else
        echo "[wt-bootstrap] deps: node_modules present, skipping bun install"
    fi
elif [ -f "$target/pnpm-lock.yaml" ]; then
    if [ ! -d "$target/node_modules" ]; then
        ( cd "$target" && pnpm install --frozen-lockfile )
    else
        echo "[wt-bootstrap] deps: node_modules present, skipping pnpm install"
    fi
elif [ -f "$target/package-lock.json" ]; then
    if [ ! -d "$target/node_modules" ]; then
        ( cd "$target" && npm ci )
    else
        echo "[wt-bootstrap] deps: node_modules present, skipping npm ci"
    fi
else
    echo "[wt-bootstrap] deps: no lockfile detected, skipping"
fi

echo "[wt-bootstrap] ✅ done"
