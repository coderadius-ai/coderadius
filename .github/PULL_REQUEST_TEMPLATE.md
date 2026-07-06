## Summary

<!-- What does this PR change, and why? One or two sentences. -->

## Linked issue

<!-- e.g. "Closes #123", or "n/a" for small standalone changes. -->

## Test tier

<!-- See CONTRIBUTING.md — "Which test tier covers my change?" -->

- [ ] **Unit** (`tests/unit/`) — sanitizer, schemas, regex/heuristic guards, in-memory logic
- [ ] **Integration** (`tests/integration/`) — graph mutations, welder, persistence ordering
- [ ] **Eval — agents** (`tests/eval/agents/`) — prompt / LLM output schema changes (replay cache updated)
- [ ] **Eval — patterns** (`tests/eval/patterns/`) — multi-file taint / import / plugin / framework-signal changes (mandatory for these subsystems)

Command(s) run and passing:

```bash
# e.g. bun run test:unit
```

## Checklist

- [ ] `bun run build` passes (typecheck)
- [ ] Test written first (red), then the change (green) — the fix and its test land together
- [ ] Any new or modified fixtures are **fully synthetic** and use the `acme` e-commerce vocabulary (no code, identifiers, paths, or domain terms from private codebases)
- [ ] Language/framework-specific logic lives in a plugin, not in the language-agnostic core
- [ ] Commit messages follow Conventional Commits (`feat(scope): ...`)
