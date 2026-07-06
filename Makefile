# CODERADIUS — Control Plane for AI-Driven Software Development
.DEFAULT_GOAL := help

# Ensure bun is found regardless of shell config
export PATH := $(HOME)/.bun/bin:$(PATH)

# --- Branding ---
L1 = $(shell sed -n '1p' src/cli/ui/logo.txt)
L2 = $(shell sed -n '2p' src/cli/ui/logo.txt)
L3 = $(shell sed -n '3p' src/cli/ui/logo.txt)
L4 = $(shell sed -n '4p' src/cli/ui/logo.txt)
L5 = $(shell sed -n '5p' src/cli/ui/logo.txt)

define HEADER

   \033[36m$(L1)\033[0m
   \033[36m$(L2)\033[0m
   \033[36m$(L3)\033[0m  \033[1mCODERADIUS\033[0m
   \033[36m$(L4)\033[0m  \033[2mPrevent breaking changes caused by AI coding agents.\033[0m
   \033[36m$(L5)\033[0m

endef
export HEADER

# --- Configuration ---
TARGET ?= loyalty-service
GRAPH_CONTAINER = coderadius-memgraph
GRAPH_USER = coderadius
GRAPH_PASS = coderadius

# --- Test Configuration ---
GRAPH_TEST_CONTAINER = coderadius-memgraph-test
GRAPH_TEST_BOLT_PORT = 7688
GRAPH_TEST_HTTP_PORT = 7475
GRAPH_TEST_URI = bolt://localhost:$(GRAPH_TEST_BOLT_PORT)

# --- Setup & Initialization ---

.PHONY: setup
setup: ## Bootstrap a fresh checkout / worktree: env + deps (idempotent, no DB).
	@bash scripts/wt-bootstrap.sh

.PHONY: install
install: ## One-click setup: install dependencies, configure .env, and start DB
	@echo "🛠️ Starting Full System Installation (Bun)..."
	@command -v bun >/dev/null 2>&1 || { echo >&2 "❌ Bun is not installed. Visit https://bun.sh/install"; exit 1; }
	@bun install
	@if [ ! -f .env ] && [ ! -L .env ]; then \
		echo "📄 No .env found — running 'make setup' to link the main repo's .env (or create from template)..."; \
		bash scripts/wt-bootstrap.sh || true; \
		[ -f .env ] || [ -L .env ] || cp .env.example .env; \
	fi
	@$(MAKE) start
	@echo "✨ Installation complete! Run 'bun run dev query agentic-radar' to test."

# ─── Infrastructure ───────────────────────────────────────────────────────────

.PHONY: start
start: ## Spin up the High-Availability Graph Persistence Layer (Memgraph)
	@echo "🚀 Initializing Enterprise Graph Database (Memgraph)..."
	@docker compose up -d
	@echo "⏳ Waiting for Memgraph to be ready..."
	@until echo "RETURN 1;" | docker exec -i $(GRAPH_CONTAINER) mgconsole --username $(GRAPH_USER) --password $(GRAPH_PASS) > /dev/null 2>&1; do sleep 2; done
	@echo "✅ Memgraph is online."

.PHONY: stop
stop: ## Gracefully shutdown infrastructure services
	@echo "🛑 Shutting down Enterprise Infrastructure..."
	@docker compose stop

.PHONY: down
down: ## Tear down infrastructure and networks
	@echo "💥 Tearing down Enterprise Infrastructure..."
	@docker compose down

# ─── Database Utilities ───────────────────────────────────────────────────────

.PHONY: db-clean
db-clean: ## Wipe all nodes, relationships, and indexes from the graph
	@echo "🧹 Wiping Intelligence Graph..."
	@echo "MATCH (n) DETACH DELETE n;" | docker exec -i $(GRAPH_CONTAINER) mgconsole --username $(GRAPH_USER) --password $(GRAPH_PASS)
	@echo "CALL schema.node_type_properties() YIELD nodeLabels UNWIND nodeLabels AS lbl WITH DISTINCT lbl CALL { WITH lbl CALL schema.properties_on_label(lbl) YIELD property_name WITH lbl, property_name WHERE property_name IS NOT NULL RETURN lbl AS l, property_name AS p } RETURN l, p;" | docker exec -i $(GRAPH_CONTAINER) mgconsole --username $(GRAPH_USER) --password $(GRAPH_PASS) > /dev/null 2>&1 || true
	@echo "DROP INDEX ON :Service(name); DROP INDEX ON :Service(urn); DROP INDEX ON :Repository(name); DROP INDEX ON :Repository(urn); DROP INDEX ON :SourceFile(urn); DROP INDEX ON :Function(urn); DROP INDEX ON :Class(urn); DROP INDEX ON :APIEndpoint(urn); DROP INDEX ON :Database(urn); DROP INDEX ON :MessageChannel(urn); DROP INDEX ON :Cache(urn); DROP INDEX ON :Library(urn); DROP INDEX ON :APIInterface(urn); DROP INDEX ON :DataContract(urn); DROP INDEX ON :System(urn); DROP INDEX ON :Team(urn);" | docker exec -i $(GRAPH_CONTAINER) mgconsole --username $(GRAPH_USER) --password $(GRAPH_PASS) 2>/dev/null || true
	@for idx in function_embedding_idx endpoint_embedding_idx agentic_config_embedding_idx; do \
		echo "DROP VECTOR INDEX $$idx;" | docker exec -i $(GRAPH_CONTAINER) mgconsole --username $(GRAPH_USER) --password $(GRAPH_PASS) 2>/dev/null || true; \
	done
	@echo "✅ Graph database cleared (data + indexes)."

# ─── Testing ──────────────────────────────────────────────────────────────

.PHONY: test-up
test-up: ## Start a dedicated Memgraph container for tests
	@echo "🚀 Starting Isolated Test Database (Memgraph)..."
	@docker compose -f docker-compose.test.yml up -d
	@echo "⏳ Waiting for Test Graph to be ready..."
	@until echo "RETURN 1;" | docker exec -i $(GRAPH_TEST_CONTAINER) mgconsole --username coderadius --password coderadius > /dev/null 2>&1; do sleep 2; done
	@echo "✅ Test Database is online on port $(GRAPH_TEST_BOLT_PORT)."

.PHONY: test-down
test-down: ## Stop and remove the test database container
	@echo "🛑 Tearing down Test Infrastructure..."
	@docker compose -f docker-compose.test.yml down -v > /dev/null 2>&1 || true

.PHONY: test-unit
test-unit: ## Run unit tests (logic, parsing, taint analysis)
	@echo "🧪 Running Unit Test Suite..."
	@bun run test:unit

.PHONY: test-integration
test-integration: test-up ## Run integration/eval tests with isolated database (replay by default)
	@echo "🧪 Running Integration/Eval Suite (mode: $${EVAL_LLM_MODE:-replay})..."
	@EVAL_LLM_MODE=$${EVAL_LLM_MODE:-replay} MEMGRAPH_URI=$(GRAPH_TEST_URI) bun run test:integration; \
	status=$$?; \
	$(MAKE) test-down; \
	exit $$status
	
.PHONY: test-coverage
test-coverage: ## Run unit tests with coverage reporting
	@echo "🧪 Running Unit Test Coverage Suite..."
	@bun run test:coverage

.PHONY: test-patterns
test-patterns: ## Run deterministic eval patterns (full static pipeline, no LLM, no DB) — fast + hermetic
	@echo "🧪 Running Deterministic Eval Patterns..."
	@EVAL_LLM_MODE=replay bun vitest run tests/eval/patterns --config vitest.patterns.config.ts

.PHONY: test-extraction
test-extraction: ## Run the extraction goldens (ephemeral pipeline → precision/recall gate, replay)
	@echo "🧪 Running Extraction Golden Suite..."
	@EVAL_LLM_MODE=replay bun vitest run tests/eval/extraction --config vitest.eval.config.ts

.PHONY: test
test: test-unit test-patterns test-integration ## Run unit, deterministic eval patterns, and integration suites

.PHONY: test-eval
test-eval: test-up ## Run graph eval suite with hard assertions (precision/recall report + history)
	@echo "🧪 Running Graph Eval Suite (hard-assertion mode)..."
	@MEMGRAPH_URI=$(GRAPH_TEST_URI) bun vitest run tests/integration/eval-graph.test.ts --config vitest.integration.config.ts; \
	status=$$?; \
	$(MAKE) test-down; \
	exit $$status

.PHONY: test-eval-golden
test-eval-golden: ## Run LLM golden dataset evals (replay mode — cached, no LLM calls, ~5s)
	@echo "🏆 Running LLM Golden Dataset Evals (mode: $${EVAL_LLM_MODE:-replay})..."
	@EVAL_LLM_MODE=$${EVAL_LLM_MODE:-replay} bun vitest run tests/eval --config vitest.eval.config.ts

.PHONY: test-eval-golden-live
test-eval-golden-live: ## Run LLM golden dataset evals with LIVE LLM calls (nightly — serialized)
	@echo "🔴 Running LLM Golden Dataset Evals (LIVE mode — real LLM calls)..."
	@EVAL_LLM_MODE=live bun vitest run tests/eval --config vitest.eval.config.ts \
		--pool=forks --poolOptions.forks.singleFork

.PHONY: test-eval-golden-refresh
test-eval-golden-refresh: ## Refresh LLM cache — wipes + regenerates golden outputs (serialized). Always persists; git is the backup.
	@echo "♻️  Refreshing LLM golden cache..."
	@rm -f tests/eval/.llm-cache/*.jsonl
	@rm -rf tests/eval/.llm-cache/*.jsonl.lock tests/eval/.llm-cache/*.tmp.*
	@if EVAL_LLM_MODE=refresh bun vitest run tests/eval --config vitest.eval.config.ts \
		--pool=forks --poolOptions.forks.singleFork; then \
		echo "✅ Refresh passed. Review & commit the cache diff: git diff --stat tests/eval/.llm-cache/"; \
	else \
		status=$$?; \
		echo "⚠️  Refresh FAILED; fresh cache PERSISTED (iterate in replay mode)."; \
		echo "   Inspect drift: git diff tests/eval/.llm-cache/  ·  Rollback: git checkout -- tests/eval/.llm-cache/"; \
		exit $$status; \
	fi

.PHONY: eval-trend
eval-trend: ## Show eval precision/recall trend across past runs
	@bun tests/eval/scripts/eval-trend.ts

.PHONY: eval-flywheel
eval-flywheel: ## Show fixture coverage (which fixtures have expected.graph.yaml)
	@bun tests/eval/scripts/eval-flywheel.ts

.PHONY: studio
studio: ## Launch Mastra Studio for interactive agent testing (localhost:4111)
	@echo "🧪 Launching Mastra Studio..."
	@bun run mastra:dev

# ─── Release & Distribution ────────────────────────────────────────────────────

# Auto-derive semver from package.json → "v0.2.0"
CLI_VERSION := v$(shell bun -e "console.log(require('./package.json').version)" 2>/dev/null || echo "0.0.0")

.PHONY: build
build: ## Transpile TypeScript to JavaScript (dev use only)
	@echo "🔨 Building project (tsc)..."
	@npx tsc

.PHONY: release
release: ## Build SEA binary + package into release/cr_OS_ARCH.tar.gz
	@echo "🚀 Building Standalone SEA Release ($(CLI_VERSION))..."
	@bun install
	@bun run build:sea

.PHONY: install-local
install-local: release ## Build SEA and install locally to ~/.coderadius (no sudo)
	@echo "📦 Installing local release to $(HOME)/.coderadius..."
	@mkdir -p $(HOME)/.coderadius/lib $(HOME)/.coderadius/bin
	@rm -f $(HOME)/.coderadius/lib/cr
	@rm -rf $(HOME)/.coderadius/lib/node_modules
	@cp release/sea/cr $(HOME)/.coderadius/lib/cr
	@if [ -d release/sea/node_modules ]; then cp -R release/sea/node_modules $(HOME)/.coderadius/lib/node_modules; fi
	@chmod +x $(HOME)/.coderadius/lib/cr
	@echo '#!/bin/sh' > $(HOME)/.coderadius/bin/cr
	@echo 'export NODE_PATH="$(HOME)/.coderadius/lib/node_modules$${NODE_PATH:+:$$NODE_PATH}"' >> $(HOME)/.coderadius/bin/cr
	@echo 'exec "$(HOME)/.coderadius/lib/cr" "$$@"' >> $(HOME)/.coderadius/bin/cr
	@chmod +x $(HOME)/.coderadius/bin/cr
	@echo "✅ 'cr' installed to $(HOME)/.coderadius/bin/cr (no sudo needed)."
	@case ":$$PATH:" in *":$(HOME)/.coderadius/bin:"*) ;; *) echo "⚠️  Add to PATH: export PATH=\"$(HOME)/.coderadius/bin:\$$PATH\"" ;; esac

# Publishing is CI-driven: release-please maintains a release PR on main;
# merging it tags the release and .github/workflows/release.yml builds the
# binaries for every platform, attaches them to the GitHub Release, and
# publishes the npm packages. `make release` stays for local builds/testing.

.PHONY: mcp
mcp: ## Start MCP Inspector with the CodeRadius CLI
	@echo "🔍 Starting MCP Inspector..."
	@bunx @modelcontextprotocol/inspector bunx tsx src/cli/index.ts mcp

.PHONY: dashboard
dashboard: ## Launch dashboard dev server with live reload (http://localhost:3456)
	@bun run scripts/dev-dashboard.ts


# ─── Help ─────────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Display High-Level Operational Manual
	@printf "$$HEADER\n"
	@echo ""
	@echo "Usage: make [target] [TARGET=service-name]"
	@echo ""
	@echo "Operational Interface:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-30s\033[0m %s\n", $$1, $$2}'
