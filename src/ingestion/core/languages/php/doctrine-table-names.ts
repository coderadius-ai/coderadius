/**
 * Deterministic Doctrine `#[ORM\Table(name: '...')]` parser.
 *
 * Pure-regex (no tree-sitter dependency) so the schema-extractor LLM pre-pass
 * stays lightweight. Returns the mapping `className → tableName` for every
 * Doctrine entity whose attribute block declares an explicit table name.
 *
 * Supports:
 *   - `#[ORM\Table(name: 'foo')]`           single-quoted
 *   - `#[ORM\Table(name: "foo")]`           double-quoted
 *   - `#[ORM\Table(name: 'foo', indexes: ...)]` extra args after name
 *   - `#[ORM\Entity, ORM\Table(name: 'foo')]` grouped attributes
 *   - docblock `@ORM\Table(name="foo")` legacy annotation
 *
 * Caller (`schema-extractor.ts`) uses this to recover the real table name
 * when the LLM emits the entity FQCN (`Entity\SupplierRenewals`) instead
 * of the SQL identifier declared in the attribute (`supplier_renewals`).
 */

interface DoctrineTablePair {
    /** Plain class name (no namespace), e.g. `SupplierRenewals`. */
    className: string;
    /** Table name from `#[ORM\Table(name: ...)]`, e.g. `supplier_renewals`. */
    tableName: string;
}

/** Matches both PHP 8 attributes and legacy docblock annotations. */
const TABLE_ATTRIBUTE_RE =
    /(?:#\[[^\]]*ORM\\Table\s*\(\s*name\s*:\s*['"]([^'"]+)['"][^\]]*\]|@ORM\\Table\s*\(\s*name\s*=\s*['"]([^'"]+)['"][^)]*\))/g;
const CLASS_DECLARATION_RE = /\bclass\s+(\w+)/g;

/**
 * Scan PHP source and return all `(className, tableName)` pairs declared
 * via Doctrine Table attributes/annotations.
 *
 * Pairing rule: the table name from the closest preceding Table attribute
 * before each `class` declaration wins. If two tables appear without an
 * intervening class, the SECOND one wins (overrides the first, mirroring
 * actual PHP semantics where only the attribute immediately above the
 * class is honoured).
 */
export function extractPhpDoctrineTableNames(sourceCode: string): DoctrineTablePair[] {
    interface Hit { index: number; kind: 'table' | 'class'; value: string }
    const hits: Hit[] = [];

    TABLE_ATTRIBUTE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TABLE_ATTRIBUTE_RE.exec(sourceCode)) !== null) {
        const tableName = m[1] ?? m[2];
        if (tableName) hits.push({ index: m.index, kind: 'table', value: tableName });
    }

    CLASS_DECLARATION_RE.lastIndex = 0;
    while ((m = CLASS_DECLARATION_RE.exec(sourceCode)) !== null) {
        hits.push({ index: m.index, kind: 'class', value: m[1] });
    }

    hits.sort((a, b) => a.index - b.index);

    const pairs: DoctrineTablePair[] = [];
    let pendingTable: string | null = null;
    for (const hit of hits) {
        if (hit.kind === 'table') {
            pendingTable = hit.value;
        } else if (pendingTable) {
            pairs.push({ className: hit.value, tableName: pendingTable });
            pendingTable = null;
        }
    }
    return pairs;
}

/**
 * Build a mapping of `{ classNameOrFQCN: tableName }` for fast lookup,
 * including bare-name keys ('SupplierRenewals') AND FQCN-style keys
 * (any string ending with `\ClassName`) so callers can look up either
 * form the LLM emitted.
 */
export function buildDoctrineTableLookup(pairs: DoctrineTablePair[]): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const { className, tableName } of pairs) {
        lookup.set(className, tableName);
    }
    return lookup;
}

/**
 * Test a candidate LLM-emitted schema name and return the corrected
 * table name if a Doctrine attribute pins it. The match accepts:
 *   - the plain class name (exact, case-sensitive)
 *   - any FQCN that ends with `\ClassName`
 *   - any namespaced suffix without `\` (e.g. `Entity\SupplierRenewals` →
 *     last segment `SupplierRenewals`)
 *
 * Returns null when no Doctrine attribute matches — caller leaves the
 * name untouched (the existing FQCN filter in `validateSchemas` will
 * drop it if it remained FQCN-shaped).
 */
export function resolveDoctrineTableName(
    schemaName: string,
    lookup: Map<string, string>,
): string | null {
    if (lookup.size === 0) return null;
    if (lookup.has(schemaName)) return lookup.get(schemaName)!;
    // Try last-segment fallback for FQCNs.
    const lastSegment = schemaName.includes('\\')
        ? schemaName.slice(schemaName.lastIndexOf('\\') + 1)
        : schemaName.includes('.')
            ? schemaName.slice(schemaName.lastIndexOf('.') + 1)
            : null;
    if (lastSegment && lookup.has(lastSegment)) return lookup.get(lastSegment)!;
    return null;
}
