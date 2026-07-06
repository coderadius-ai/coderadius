export function validatePhpInboundPath(path: string, sourceCode: string): boolean | undefined {
    const Q = "['\"]";

    if (/^GRAPHQL\s+(QUERY|MUTATION|SUBSCRIPTION)\s+/i.test(path)) {
        const parts = path.split(' ');
        const operationName = parts[2];
        if (operationName) {
            const escapedName = operationName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (/#\[(?:Query|Mutation|Subscription)\]/i.test(sourceCode)) {
                return true;
            }

            const fieldRegex = new RegExp(`['"]name['"]\\s*=>\\s*['"]${escapedName}['"]`, 'i');
            if (fieldRegex.test(sourceCode)) {
                return true;
            }
        }

        return undefined;
    }

    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(Q + escapedPath + Q).test(sourceCode)) {
        return true;
    }

    const segments = path.split('/').filter(segment => segment.length > 0 && !segment.startsWith('{'));
    if (segments.length > 0) {
        const lastSegment = segments[segments.length - 1];
        const escapedSegment = lastSegment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(Q + '/' + escapedSegment + "(?=[/\"':{<])").test(sourceCode)) {
            return true;
        }
    }

    return false;
}
