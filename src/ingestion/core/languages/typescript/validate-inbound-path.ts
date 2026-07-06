export function validateTypeScriptInboundPath(path: string, sourceCode: string): boolean | undefined {
    const q = "['\"`]";

    if (/^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+/i.test(path)) {
        const parts = path.split(' ');
        const opName = parts[2];
        if (opName) {
            const nameEsc = opName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const decoratorRe = new RegExp(
                `@(?:Query|Mutation|Subscription)\\(` +
                `(?:${q}${nameEsc}${q}|\\(\\)\\s*=>)`,
                'i',
            );
            if (decoratorRe.test(sourceCode)) return true;
        }
        return undefined;
    }

    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(q + escaped + q).test(sourceCode)) return true;

    const segments = path.split('/').filter(segment => segment.length > 0 && !segment.startsWith('{') && !segment.startsWith(':'));
    if (segments.length > 0) {
        const last = segments[segments.length - 1];
        const segmentEscaped = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(q + '/' + segmentEscaped + "(?=[/\"'`:{<])").test(sourceCode)) return true;
    }

    return false;
}
