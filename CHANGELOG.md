# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07

First public release.

First fully open-source release under Apache-2.0. Current capability areas:

### Added

- **Polyglot code ingestion**: static analysis (tree-sitter AST) plus LLM
  semantic extraction for TypeScript, PHP, Python, Go, and Java, with a
  language-agnostic core and per-language plugins for imports, exports, and
  framework signals.
- **Architectural knowledge graph**: C4-style model (System, Repository,
  Service, SourceFile, Function, Class, Database, MessageChannel, Cache,
  APIInterface, APIEndpoint, contracts) persisted to Memgraph/Neo4j, with
  Merkle-cached, crash-resilient incremental ingestion.
- **Blast radius**: pre-merge impact evaluation, which includes ephemeral extraction of a
  change, graph diffing, and cross-repo downstream-consumer resolution.
- **Governance policies**: declarative YAML/JS policy rules evaluated against
  the live architecture graph (ownership, deprecated dependencies, shared
  database anti-patterns, and more).
- **Catalog drift**: grounded-identity reconciliation between declared
  `dependsOn` catalog entries and observed graph edges; unverifiable
  references are reported as coverage gaps, not drift.
- **MCP server**: live architectural context for IDEs and AI coding agents
  over the Model Context Protocol.
- **Architecture dashboard**: interactive web UI over the graph, with a
  Bun-powered live-reload dev server.
- **Grounding metadata**: every node and edge carries provenance (source,
  quality tier, evidence trail), separating deterministic AST facts from LLM
  inferences and enabling a human triage queue for low-confidence claims.

[Unreleased]: https://github.com/coderadius-ai/coderadius/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/coderadius-ai/coderadius/releases/tag/v0.1.0
