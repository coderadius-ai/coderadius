// ═══════════════════════════════════════════════════════════════════════════════
// HelmEnvExtractor — Production DB Name Extraction from Helm/K8s IaC Files
//
// Reads a Helm values file, K8s Deployment/ConfigMap/StatefulSet manifest,
// or similar Infrastructure-as-Code file, and extracts environment bindings
// that represent real, hardcoded, production database names.
//
// Design contract:
//   - ONLY extracts raw, hardcoded string values (never Go templates, never
//     secretKeyRef / configMapKeyRef references, never shell variable expansions)
//   - ONLY processes files whose path strongly signals a PRODUCTION environment.
//     Files with ambiguous paths (e.g. bare "values.yaml") are also sent to the
//     LLM, which makes the final call from both path and content signals.
//   - Output populates dt.databaseName for governance annotations ONLY.
//     It NEVER changes a DataContainer URN (no "Super-Node" risk).
//
// Priority in resolveDbContext (graph-writer.ts):
//   Priority 1: database_scope in coderadius.yaml   → URN + databaseName
//   Priority 2: HelmEnvExtractor (this module)       → databaseName only
//   Priority 3: qualifiedRepoName fallback           → no annotation
//
// Cost: 1 small LLM call per candidate file (< 1 cent/1000 files).
//       isProdFilePath() skips definitively non-production files with zero LLM.
// ═══════════════════════════════════════════════════════════════════════════════

import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { getModel } from '../models/provider.js';

// ─── Schema ──────────────────────────────────────────────────────────────────
// Pure Zod schemas — no side-effects. Safe to import in unit tests.

/**
 * A single database name binding extracted from a Helm/K8s IaC file.
 *
 * `dbName`:    The raw string value of the database name (e.g. "payments").
 * `sourceKey`: The env var / config field it was found under (for traceability).
 */
export const HelmDbBindingSchema = z.object({
    dbName: z.string().describe(
        'The raw, hardcoded database name string extracted from the file '
        + '(e.g. "payments", "billing", "orders-db"). '
        + 'MUST NOT contain Go template syntax ({ }), variable references (${}, $VAR), '
        + 'or be derived from secretKeyRef / configMapKeyRef. '
        + 'If you are not 100% certain this is a literal string, omit it.',
    ),
    sourceKey: z.string().describe(
        'The exact key or field path where the database name was found, '
        + 'e.g. "POSTGRES_DB", "DB_NAME", "database.name", "env[0].MYSQL_DATABASE".',
    ),
});

export const HelmEnvExtractionSchema = z.object({
    /**
     * Database name bindings extracted from the file.
     * Empty array if: the file is non-production, all values are template/secret-derived,
     * or the file contains no recognisable database configuration.
     */
    bindings: z.array(HelmDbBindingSchema).describe(
        'Database name bindings found in this file. '
        + 'Return an empty array rather than guessing.',
    ),
    /**
     * Whether the agent judged this file to belong to a production environment.
     * Used for logging/debugging — does not change graph behavior.
     */
    isProduction: z.boolean().describe(
        'True if the file path and/or content signals a production environment. '
        + 'False if staging, dev, local, test, or ambiguous.',
    ),
});

export type HelmEnvExtractionResult = z.infer<typeof HelmEnvExtractionSchema>;
export type HelmDbBinding = z.infer<typeof HelmDbBindingSchema>;

// ─── Production Environment Detection ────────────────────────────────────────
// Pure string logic — zero imports. Safe for unit tests and CI.

/**
 * Deterministic pre-filter: infers whether a file path belongs to a production
 * environment from naming conventions alone.
 *
 * Returns:
 *  - `true`  → definitively production (safe to call LLM)
 *  - `false` → definitively non-production (skip entirely — zero LLM cost)
 *  - `null`  → ambiguous (e.g. bare "values.yaml") — call LLM to decide from content
 *
 * Covers: Helm chart conventions, Kustomize overlay directories,
 * environment-suffixed files, and multi-environment directory structures.
 */
export function isProdFilePath(relPath: string): boolean | null {
    // Split the path into individual segments and check each one.
    // This prevents short patterns like /\bci\b/ from false-positiving on
    // repository/org names that contain "ci" as a *compound* (e.g. "reporting-ci"):
    // in the old approach, the full string "reporting-ci/helm/values-prod.yaml"
    // was scanned and "-ci" triggered \bci\b (- is a word boundary).
    //
    // With per-segment matching, "reporting-ci" is one segment.
    // We use \b-bounded patterns within that segment:
    //   "ci" → matches only if ci is a standalone word in the segment
    //   "reporting-ci" → the \b before "ci" and after "ci" means:
    //     - before "c": "-" is non-word → boundary ✓ 
    //     - after "i": end-of-string → boundary ✓
    //   → STILL matches! We need a different approach.
    //
    // The actual safe approach: require the keyword to be the ENTIRE segment
    // OR appear as a recognizable env suffix in the filename segment.
    // We handle this with two separate checks per segment:
    //   1. Is this segment EXACTLY the keyword? (directory names: "ci", "qa", "prod")
    //   2. Does the filename contain the keyword as an env label?
    //      (e.g. "values-dev.yaml", "values-prod.yaml", "values.example.yaml")
    const segments = relPath.toLowerCase().split(/[/\\]/);

    // Filename-targeted patterns: match the env label in a filename segment.
    // Format: values-{env}.yaml, values.{env}.yaml, values-{env}.yml, etc.
    // We apply these only to the LAST segment (the filename).
    const filename = segments[segments.length - 1] ?? '';

    const filenameNonProdPatterns: RegExp[] = [
        /(?:^|[-_.])dev(?:elop(?:ment)?)?(?:[-_.]|$)/,    // values-dev.yaml, dev-values.yaml
        /(?:^|[-_.])develop(?:ment)?(?:[-_.]|$)/,
        /(?:^|[-_.])stag(?:ing|e)?(?:[-_.]|$)/,           // values-staging.yaml
        /(?:^|[-_.])test(?:ing)?(?:[-_.]|$)/,              // values-test.yaml, values-testing.yaml
        /(?:^|[-_.])local(?:[-_.]|$)/,                     // values-local.yaml
        /(?:^|[-_.])preview(?:[-_.]|$)/,                   // values-preview.yaml
        /(?:^|[-_.])sandbox(?:[-_.]|$)/,                   // values-sandbox.yaml
        /(?:^|[-_.])uat(?:[-_.]|$)/,                       // values-uat.yaml
        /(?:^|[-_.])qa(?:[-_.]|$)/,                        // values-qa.yaml
        /\.example\./,                                      // values.example.yaml
        /\.sample\./,                                       // values.sample.yaml
        /\.template\./,                                     // values.template.yaml
    ];

    const filenameProdPatterns: RegExp[] = [
        /(?:^|[-_.])prod(?:uction)?(?:[-_.]|$)/,           // values-prod.yaml, values-production.yaml
        /(?:^|[-_.])prd(?:[-_.]|$)/,                       // values-prd.yaml
        /(?:^|[-_.])live(?:[-_.]|$)/,                      // values-live.yaml
    ];

    // Directory-segment patterns: match EXACT directory names as standalone env markers.
    // Applied to all segments EXCEPT the last (filename).
    // We use exact match here because directory names are usually the env keyword alone.
    const dirNonProdKeywords = new Set(['dev', 'develop', 'development', 'staging', 'stage', 'test', 'testing', 'local', 'ci', 'qa', 'sandbox', 'preview', 'uat']);
    const dirProdKeywords = new Set(['prod', 'production', 'prd', 'live']);

    // ── Check filename ────────────────────────────────────────────────────────
    if (filenameNonProdPatterns.some(p => p.test(filename))) return false;
    if (filenameProdPatterns.some(p => p.test(filename))) return true;

    // ── Check directory segments (all except filename) ────────────────────────
    const dirSegments = segments.slice(0, -1);
    for (const seg of dirSegments) {
        if (dirNonProdKeywords.has(seg)) return false;
        if (dirProdKeywords.has(seg)) return true;
    }

    // ── Ambiguous — no decisive signal found ──────────────────────────────────
    return null;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

let _helmEnvExtractorAgent: Agent | null = null;

export function getHelmEnvExtractorAgent(): Agent {
    if (!_helmEnvExtractorAgent) {
        _helmEnvExtractorAgent = new Agent({
            id: 'helm-env-extractor',
            name: 'Helm/K8s Production DB Name Extractor',
            defaultOptions: {
                modelSettings: { temperature: 0, maxRetries: 0 },
            },
            instructions: `You are a DevOps infrastructure analysis expert. I will give you the path and contents of a Helm values file, a Kubernetes manifest (Deployment, ConfigMap, StatefulSet, etc.), or a similar Infrastructure-as-Code file.

Your task: extract the physical database names this service uses in **production**, if they are present as raw literal values.

---

## What to Extract

Look for environment variable declarations or nested config values whose key is one of:

- DB_NAME, DATABASE_NAME
- POSTGRES_DB, POSTGRESQL_DB
- MYSQL_DATABASE, MYSQL_DB
- MONGO_DB, MONGODB_DATABASE
- REDIS_DB (only if it is a string name, not a numeric index 0–15)
- DATABASE (only when clearly used as a database name, not a full connection URL)
- Nested YAML equivalents: database.name, db.name, postgres.database, mongo.dbName

---

## RULE 1 — Only extract HARDCODED string literals

You may ONLY extract a value that is a raw, unquoted string written directly in the file.

**ACCEPT:**
\`\`\`yaml
DB_NAME: payments                   # ✅ literal string
POSTGRES_DB: "billing"              # ✅ quoted literal
database:
  name: orders                      # ✅ nested literal
env:
  - name: MYSQL_DATABASE
    value: "reporting"              # ✅ explicit value: key
\`\`\`

**REJECT — Helm Go Templates ({{ }}):**
\`\`\`yaml
DB_NAME: "{{ .Values.global.dbName }}"                    # ❌ Go template — IGNORE
DB_NAME: '{{ .Values.database.name | default "main" }}'   # ❌ Go template — IGNORE
database:
  name: '{{ include "app.dbName" . }}'                    # ❌ Helm include — IGNORE
POSTGRES_DB: "{{ .Release.Name }}-db"                     # ❌ Go template — IGNORE
\`\`\`

**REJECT — Shell/K8s variable interpolations:**
\`\`\`yaml
DB_NAME: "\${DB_NAME}"           # ❌ shell variable — IGNORE
DB_NAME: "\$(DB_ENV_VAR)"        # ❌ K8s env substitution — IGNORE
DATABASE_NAME: "!Ref DbName"    # ❌ CloudFormation ref — IGNORE
DB_NAME: "\$(cat /secrets/db)"  # ❌ command substitution — IGNORE
\`\`\`

---

## RULE 2 — Never extract values from secretKeyRef or configMapKeyRef

If an env var uses valueFrom with secretKeyRef or configMapKeyRef, IGNORE the entire env entry. The actual value lives in an external Secret or ConfigMap we cannot access statically.

**REJECT:**
\`\`\`yaml
env:
  - name: POSTGRES_DB
    valueFrom:
      secretKeyRef:          # ❌ Secret reference — IGNORE this env entry
        name: db-credentials
        key: dbname
  - name: DB_NAME
    valueFrom:
      configMapKeyRef:       # ❌ ConfigMap reference — IGNORE
        name: db-config
        key: database
\`\`\`

**ACCEPT (only when value: is explicit):**
\`\`\`yaml
env:
  - name: POSTGRES_DB
    value: "payments"        # ✅ hardcoded inline — extract "payments"
\`\`\`

---

## RULE 3 — Reject generic / ambiguous database names

If the extracted value is a generic placeholder that could refer to any physical database, return an empty bindings array for that entry.

**Reject these values (case-insensitive, exact match):**
main, db, database, default, app, service, local, test, staging, prod, production, postgres, mysql, mongodb, mongo, redis, master, replica, primary, secondary, core, base, data, store, backend

**Accept specific, descriptive names:**
payments, billing, orders-db, inventory, acme_users, crm_legacy, analytics, reporting, auth_service, subscriptions

---

## RULE 4 — Determine production status from the file path

The file path is provided at the start of the input (e.g. "File: helm/values-prod.yaml").

- **isProduction = true** if the path contains: prod, production, prd, live, or production-specific directories
- **isProduction = false** if the path contains: dev, development, staging, stage, test, qa, sandbox, local, ci, preview, uat, .example, .sample
- **isProduction = false** (default) if ambiguous AND the file content contains no ENVIRONMENT variable set to "production" or similar

If isProduction = false, return empty bindings[].

---

## RULE 5 — Return empty bindings rather than guess

If you are not 100% certain that a value is a hardcoded, literal, production database name, return bindings: []. Incorrect data in a governance graph is more harmful than missing data.`,
            model: getModel('ingest'),
        });
    }
    return _helmEnvExtractorAgent;
}


