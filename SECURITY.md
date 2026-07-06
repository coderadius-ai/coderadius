# Security Policy

## Supported Versions

CodeRadius is pre-1.0. Only the latest 0.x release receives security fixes.

| Version | Supported |
| --- | --- |
| Latest 0.x | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

1. **Preferred**: use GitHub's private vulnerability reporting. Go to the
   [Security tab](https://github.com/coderadius-ai/coderadius/security) of the
   repository and click **"Report a vulnerability"**. This opens a private
   advisory visible only to the maintainers.
2. **Fallback**: if you cannot use GitHub, email **emnlmn@gmail.com** with a
   description of the issue, reproduction steps, and the affected version.

You will receive an acknowledgement within **7 days**. We will keep you
informed as we triage, develop a fix, and coordinate disclosure. Please give us
a reasonable window to ship a fix before publishing details.

## Scope

CodeRadius is a CLI that statically analyzes codebases you point it at and
sends extracted snippets to LLM providers for semantic analysis. That threat
surface makes the following report classes especially welcome:

- **Path traversal / arbitrary file access** while analyzing an untrusted
  repository (the analyzed codebase should be treated as hostile input).
- **Prompt injection**: analyzed source code influencing LLM output in ways
  that corrupt the graph, exfiltrate data, or alter tool behavior.
- **Credential handling**: leakage of LLM API keys, graph database credentials,
  or repository secrets through logs, caches, error messages, or the graph
  itself.
- **Command or query injection** via crafted file names, manifests, or
  connection strings in analyzed repositories.

Reports about dependencies are also welcome if CodeRadius uses the dependency
in an exploitable way.
