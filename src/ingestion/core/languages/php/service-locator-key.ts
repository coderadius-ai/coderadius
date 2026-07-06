/**
 * PSR-11 / Laminas ServiceManager evidence check.
 *
 * A name that occurs in the function source ONLY as the literal argument of a
 * service-locator getter (`$container->get('X')`, `$sm->get('X')`,
 * `Registry::get('X')`, `->has('X')`, `->build('X')`) is a DI handle the code
 * looks up — never the physical channel/table the LLM claimed it to be. The
 * locator getter is a PUBLISHED contract (PSR-11 ContainerInterface,
 * Laminas ServiceManager), so this is evidence-based, not a name list:
 * customer keys of any shape are caught, and the same name appearing anywhere
 * else (publish arg, SQL text, config value) immediately disqualifies the
 * rejection.
 */

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const LOCATOR_CALL_TAIL_RE = /(?:->|::)\s*(?:get|has|build)\s*\(\s*['"]$/;

function countMatches(re: RegExp, text: string): number {
    re.lastIndex = 0;
    let n = 0;
    while (re.exec(text) !== null) n++;
    return n;
}

export function phpRecognizesServiceLocatorKey(name: string, sourceCode: string): boolean {
    const escaped = name.replace(REGEX_ESCAPE_RE, '\\$&');

    // Every appearance of the name as a standalone token (quoted or bare —
    // SQL text, publish args, config values all count).
    const anyOccurrence = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
    const total = countMatches(anyOccurrence, sourceCode);
    if (total === 0) return false;

    // Appearances as the literal argument of a locator getter.
    const quoted = new RegExp(`['"]${escaped}['"]`, 'g');
    let locator = 0;
    let m: RegExpExecArray | null;
    while ((m = quoted.exec(sourceCode)) !== null) {
        const before = sourceCode.slice(Math.max(0, m.index - 64), m.index + 1);
        if (LOCATOR_CALL_TAIL_RE.test(before)) locator++;
    }

    // Pure locator key: at least one locator hit and NO other occurrence.
    return locator > 0 && locator === total;
}
