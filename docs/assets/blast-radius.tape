# CodeRadius hero demo — analyze + blast on a multi-repo fleet (~20s).
#
# Scene 1  cr analyze code . --depth contracts on the fleet root (5 repos
#          auto-discovered; time-lapse cut while ingestion runs; summary).
# Scene 2  git diff -U1: one innocent-looking renamed queue (clean screen).
# Scene 3  cr blast → × breaking, cross-repo consumer named.
#
# Prerequisites (before running vhs from the coderadius repo root):
#   - Memgraph running (cr up), demo fleet at
#     /Users/emenon/Code/coderadius-ai/demo-fleet with git remotes set.
#   - Graph wiped (cr prune graph --force) so the analyze is a real run.
#   - order-service working tree CLEAN (the tape applies the breaking
#     change itself, hidden, from ../.blast-demo.patch).
#
# NOTE: do not use Wait/Wait+Screen here — in this ttyd setup VHS's Wait
# evaluates a stale screen and always times out. Fixed Sleeps only.

Output docs/assets/blast-radius.gif

Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 700
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 15ms

# ── Hidden setup: fleet root, friendly prompt, cr from source ────────────────
Hide
Type `cr() { bun /Users/emenon/Code/coderadius-ai/coderadius/src/cli/index.ts "$@"; }`
Enter
Type "cd /Users/emenon/Code/coderadius-ai/demo-fleet && export PS1='demo-fleet ❯ ' GIT_PAGER=cat GIT_SSH_COMMAND=false GIT_TERMINAL_PROMPT=0 && clear"
Enter
Sleep 1s
Show

# ── Scene 1: analyze the fleet from its root (time-lapse) ───────────────────
Type "cr analyze code . --depth contracts"
Sleep 300ms
Enter
Sleep 5s

Hide
Sleep 240s
Show
Sleep 4s

# ── Hidden: hop into the producer repo, apply the breaking change ───────────
Hide
Type "cd order-service && export PS1='order-service ❯ ' && { git apply --check ../.blast-demo.patch 2>/dev/null && git apply ../.blast-demo.patch; }; clear"
Enter
Sleep 1s
Show

# ── Scene 2: the diff looks harmless ────────────────────────────────────────
Type "git diff -U1"
Sleep 300ms
Enter
Sleep 2.5s

# ── Scene 3: blast radius says otherwise ────────────────────────────────────
Type "cr blast"
Sleep 300ms
Enter
Sleep 1.5s

Hide
Sleep 12s
Show
Sleep 4s
