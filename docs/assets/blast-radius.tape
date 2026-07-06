# CodeRadius hero demo — blast radius on a multi-repo fleet.
#
# Scene 1  cr analyze code . --depth contracts on the fleet root (5 repos
#          auto-discovered; time-lapse cut while the full contracts-depth
#          ingestion runs; summary shown at the end).
# Scene 2  git diff of an innocent-looking one-line change (producer repo).
# Scene 3  cr blast → × breaking, cross-repo consumer named.
#
# Prerequisites (before running vhs from the coderadius repo root):
#   - Memgraph running (cr up) and the demo fleet at
#     /Users/emenon/Code/coderadius-ai/demo-fleet with git remotes set.
#   - Graph wiped (cr prune graph --force) so the analyze is a real run.
#   - order-service working tree CLEAN (the tape applies the breaking
#     change itself, hidden, from ../.blast-demo.patch).
#
# NOTE: do not use Wait/Wait+Screen here — in this ttyd setup VHS's Wait
# evaluates a stale screen and always times out. Fixed Sleeps only.

Output docs/assets/blast-radius.gif

Set Shell "bash"
Set FontSize 17
Set Width 1100
Set Height 620
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 15ms

# ── Hidden setup: fleet root, friendly prompt, no pager ─────────────────────
# `cr` runs the CLI from the repo source (bun) so copy changes not yet in the
# published binary are reflected in the recording.
Hide
Type `cr() { bun /Users/emenon/Code/coderadius-ai/coderadius/src/cli/index.ts "$@"; }`
Enter
Type "cd /Users/emenon/Code/coderadius-ai/demo-fleet && export PS1='demo-fleet ❯ ' GIT_PAGER=cat GIT_SSH_COMMAND=false GIT_TERMINAL_PROMPT=0 && clear"
Enter
Sleep 1s
Show

# ── Scene 1: analyze the fleet from its root (time-lapse) ───────────────────
Type "cr analyze code . --depth contracts"
Sleep 500ms
Enter
Sleep 6s

Hide
Sleep 240s
Show
Sleep 5s

# ── Hidden: hop into the producer repo, apply the breaking change ───────────
Hide
Type "cd order-service && export PS1='order-service ❯ ' && git apply ../.blast-demo.patch && clear"
Enter
Sleep 1s
Show

# ── Scene 2: the diff looks harmless ────────────────────────────────────────
Type "git diff"
Sleep 300ms
Enter
Sleep 4s

# ── Scene 3: blast radius says otherwise ────────────────────────────────────
Type "cr blast"
Sleep 300ms
Enter
Sleep 15s
