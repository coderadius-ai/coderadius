import fs from 'node:fs';
import path from 'node:path';
import ignore, { Ignore } from 'ignore';
import { logger } from '../../utils/logger.js';
import { getAllScopeExclusions } from './languages/registry.js';

export class ScopeManager {
    private ig: Ignore;

    constructor(repoRoot: string) {
        this.ig = ignore();
        this.loadIgnoreFiles(repoRoot);

        // ── Tier 2a: Universal exclusions (not language-specific) ────────────
        // These apply to any project regardless of language.
        // Language-specific exclusions live in each plugin's scopeExclusions
        // and ignorePatterns — they are loaded in Tier 2b below.
        //
        // All path patterns are matched against the REPO-RELATIVE path
        // (see isOmitted), so `tests/**` only catches a `tests/` folder
        // inside the analyzed repo (never the host filesystem's
        // `.../tests/fixtures/microservices/<svc>` integration roots,
        // whose relative-to-repo paths begin at `src/...`).
        this.ig.add([
            // ── Test scaffolding & E2E frameworks ─────────────────────────
            // Unanchored (`**/dir/**`) so monorepo layouts like
            // `packages/orders/tests/...` or `apps/web/e2e/...` are caught,
            // not just the repo-root variants.
            '**/tests/**', '**/test/**', '**/spec/**',
            '**/e2e/**', '**/cypress/**', '**/playwright/**',
            '**/__tests__/**', '**/__mocks__/**', '**/__fixtures__/**',
            '**/Tests/**', '**/Spec/**',

            // ── Docs & examples ───────────────────────────────────────────
            '**/docs/**', '**/examples/**',
            '**/*.example.*', '**/*.doc.*',

            // ── Build / tooling configuration (root-level) ────────────────
            'vite.config.*', 'tsup.config.*', 'webpack.config.*',
            'rollup.config.*', 'eslint.config.*', 'playwright.config.*',
            'jest.config.*', 'vitest.config.*', 'cypress.config.*',

            // ── Generic & OS noise ────────────────────────────────────────
            '.DS_Store', 'Thumbs.db',
            '.idea/**', '.vscode/**', '.history/**',
            '*.log',

            // ── Cross-language build output (also caught per-module) ──────
            'target/**', '**/target/**',
            '.gradle/**', '**/.gradle/**',
            '.mvn/**',

            // ── Lock files ────────────────────────────────────────────────
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            'Pipfile.lock', 'poetry.lock', 'Gemfile.lock', 'Cargo.lock',

            // ── Vendored JS libraries (bundled third-party code) ──────────
            // Cover common framework public-asset and webroot layouts so we
            // never tree-sit a 200KB minified amcharts/jszip/jQuery copy.
            '**/public/js/lib/**', '**/public/js/vendor/**', '**/public/js/plugins/**',
            '**/public/vendor/**', '**/public/js/build/**',
            '**/assets/vendor/**', '**/assets/lib/**',
            '**/static/js/lib/**', '**/static/vendor/**',
            '**/wwwroot/lib/**', '**/wwwroot/vendor/**',

            // ── Minified / sourcemap artefacts (extension-anchored) ───────
            // These are framework-agnostic (same shape across Webpack, Vite,
            // Rollup, Parcel, Symfony Encore, Laravel Mix, Rails Sprockets).
            '*.min.js', '*.min.mjs', '*.min.cjs', '*.min.jsx', '*.min.tsx',
            '*.min.css',
            '*-min.js', '*-min.css',
            '*.js.map', '*.mjs.map', '*.cjs.map', '*.jsx.map', '*.tsx.map', '*.css.map',

            // ── Compiled binary artefacts (cross-language) ────────────────
            '*.class', '*.jar', '*.war', '*.ear', '*.nar',
            '*.exe', '*.dll', '*.so', '*.dylib',
            '*.pyc', '*.pyo',

            // ── Container / IaC build outputs ─────────────────────────────
            '**/.terraform/**', '**/terraform.tfstate*',
            '**/cdk.out/**', '**/.serverless/**',
        ]);

        // ── Tier 2b: Language-specific exclusions (from each plugin) ─────────
        // Each plugin declares its own scopeExclusions. Adding a new language
        // plugin automatically includes its exclusions here — no edit required.
        const pluginExclusions = getAllScopeExclusions();
        if (pluginExclusions.length > 0) {
            this.ig.add(pluginExclusions);
        }
    }

    private loadIgnoreFiles(repoRoot: string) {
        const files = ['.gitignore', '.crignore'];
        for (const file of files) {
            const fullPath = path.join(repoRoot, file);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    this.ig.add(content);
                } catch (e) {
                    logger.warn(`Failed to read ignore file ${fullPath}: ${(e as Error).message}`);
                }
            }
        }
    }

    /**
     * Determine if a file should be completely omitted from ingestion.
     * Integrates path matching (ignore/blacklist) AND heuristic analysis (size/minification).
     */
    public isOmitted(absolutePath: string, repoRoot: string): boolean {
        const relativePath = path.relative(repoRoot, absolutePath);

        // Tier 1 & 2: Path-based matching (gitignores, crignores, blacklist)
        if (relativePath.startsWith('..')) {
            return false; // Can't ignore paths outside the reporoot gracefully
        }

        if (this.ig.ignores(relativePath)) {
            return true;
        }

        // Tier 3: Heuristic Safety Net
        try {
            const stats = fs.statSync(absolutePath);

            if (!stats.isFile()) {
                return false;
            }

            // Size Check: > 300KB
            if (stats.size > 300 * 1024) {
                return true;
            }

            // Minification / generated-bundle heuristic.
            //
            // The original predicate ("no newlines in first 10KB") only fired on
            // wall-to-wall minification with zero whitespace. Real-world
            // bundled libraries (amcharts.js, jszip.js, ag-grid, etc.) prepend a
            // multiline license header, then dump tens of KB of single-line
            // payload; they pass the strict check but still take seconds in
            // tree-sitter. We now flag any file whose first 10KB averages
            // more than `MAX_CHARS_PER_NEWLINE` decoded characters per line.
            //
            // We use CHARACTERS (post-UTF-8 decoding) rather than raw bytes
            // because UTF-8 is variable-width: a single Japanese ideograph or
            // emoji can occupy 3-4 bytes. A 10KB Japanese source file might
            // contain only ~3,300 characters, and using bytes-per-newline
            // there would over-count and false-flag legitimate non-ASCII
            // source. Code points (chunk.length) normalise the metric.
            const fd = fs.openSync(absolutePath, 'r');
            const buffer = Buffer.alloc(10000);
            const bytesRead = fs.readSync(fd, buffer, 0, 10000, 0);
            fs.closeSync(fd);

            if (bytesRead >= 4096) {
                const chunk = buffer.toString('utf8', 0, bytesRead);
                let newlines = 0;
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk.charCodeAt(i) === 10) newlines++;
                }
                if (newlines === 0) return true;
                const charsPerNewline = chunk.length / newlines;
                if (charsPerNewline > MAX_CHARS_PER_NEWLINE) return true;
            }
        } catch (e) {
            logger.warn(`Failed heuristic check on ${absolutePath}: ${(e as Error).message}`);
            return true;
        }

        return false;
    }
}

// Mean characters-per-newline (post UTF-8 decoding) above which a file is
// treated as minified / bundled. Reference points:
//   - Hand-written source (ASCII, Italian w/ accents, CJK): 30-180 chars/line
//   - Generated DTOs / long type declarations: ~200-280 chars/line
//   - Bundled libraries (amcharts.js, lodash.min, ag-grid): >400 chars/line
// 300 leaves headroom for legitimate generated-but-readable code while still
// catching the tree-sitter-pathological cases.
const MAX_CHARS_PER_NEWLINE = 300;
