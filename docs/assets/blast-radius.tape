# CodeRadius hero demo — the 12-second cut.
#
# Scene 1  git diff -U1: one innocent-looking renamed queue (red/green line).
# Scene 2  cr blast → × breaking, cross-repo consumer named, in seconds.
#
# Prerequisites (before running vhs from the coderadius repo root):
#   - Memgraph running with the demo-fleet baseline ingested from a CLEAN
#     tree (cr prune graph --force, then from /Users/.../demo-fleet:
#     cr analyze code . --depth contracts).
#   - The tape applies ../.blast-demo.patch itself if the tree is clean.
#
# NOTE: do not use Wait/Wait+Screen here — in this ttyd setup VHS's Wait
# evaluates a stale screen and always times out. Fixed Sleeps only.

Output docs/assets/blast-radius.gif

Set Shell "bash"
Set FontSize 20
Set Width 1000
Set Height 700
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 15ms

# ── Hidden setup: producer repo, friendly prompt, cr from source ────────────
# `cr` runs the CLI from the repo source (bun) so copy changes not yet in the
# published binary are reflected in the recording.
Hide
Type `cr() { bun /Users/emenon/Code/coderadius-ai/coderadius/src/cli/index.ts "$@"; }`
Enter
Type "cd /Users/emenon/Code/coderadius-ai/demo-fleet/order-service && export PS1='order-service ❯ ' GIT_PAGER=cat GIT_SSH_COMMAND=false GIT_TERMINAL_PROMPT=0 && { git apply --check ../.blast-demo.patch 2>/dev/null && git apply ../.blast-demo.patch; }; clear"
Enter
Sleep 1s
Show

# ── Scene 1: the diff looks harmless ────────────────────────────────────────
Type "git diff -U1"
Sleep 300ms
Enter
Sleep 2.5s

# ── Scene 2: blast radius says otherwise ────────────────────────────────────
Type "cr blast"
Sleep 300ms
Enter
Sleep 1.5s

Hide
Sleep 12s
Show
Sleep 4s
