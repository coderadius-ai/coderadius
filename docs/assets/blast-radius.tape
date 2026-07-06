# CodeRadius hero demo — blast radius on a multi-repo fleet.
#
# Scene 1  cr analyze code across 5 service repos (time-lapse cut while the
#          full contracts-depth ingestion runs; summary shown at the end).
# Scene 2  git diff --stat of an innocent-looking one-file change.
# Scene 3  cr blast → × breaking, cross-repo consumer named.
#
# Prerequisites (before running vhs from the coderadius repo root):
#   - Memgraph running (cr up) and the demo fleet cloned at
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
Set TypingSpeed 40ms

# ── Hidden setup: cd into the producer repo, friendly prompt ────────────────
Hide
Type "cd /Users/emenon/Code/coderadius-ai/demo-fleet/order-service && export PS1='order-service ❯ ' GIT_PAGER=cat && clear"
Enter
Sleep 1s
Show

# ── Scene 1: analyze the fleet (time-lapse) ─────────────────────────────────
Type "cr analyze code ../order-service ../payment-service ../notification-service ../pricing-service ../logistics-routing-service --depth contracts"
Sleep 500ms
Enter
Sleep 6s

Hide
Sleep 240s
Show
Sleep 5s

# ── Hidden: apply the innocent-looking breaking change ──────────────────────
Hide
Type "git apply ../.blast-demo.patch && clear"
Enter
Sleep 1s
Show

# ── Scene 2: the diff looks harmless ────────────────────────────────────────
Type "git diff --stat"
Sleep 300ms
Enter
Sleep 3s

# ── Scene 3: blast radius says otherwise ────────────────────────────────────
Type "cr blast"
Sleep 300ms
Enter
Sleep 15s
