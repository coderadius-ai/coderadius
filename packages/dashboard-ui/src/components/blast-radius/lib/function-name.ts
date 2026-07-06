/**
 * Splits a qualified function name into a namespace prefix and a
 * `Class.method` tail so the Code Evidence list can dim the prefix and keep
 * the tail at full emphasis.
 *
 * Only backslash-qualified names (PHP FQCNs) are split: other languages in
 * the graph surface short `Class.method` / `pkg.Func` names where a dot or
 * slash split would dim meaningful identity. The two parts always
 * concatenate back to the original string, so selection, copy/paste and
 * find-in-page stay lossless.
 */
export function splitQualifiedName(name: string): { prefix: string; tail: string } {
    const cut = name.lastIndexOf('\\');
    if (cut === -1) return { prefix: '', tail: name };
    const tail = name.slice(cut + 1);
    if (tail === '') return { prefix: '', tail: name };
    return { prefix: name.slice(0, cut + 1), tail };
}
