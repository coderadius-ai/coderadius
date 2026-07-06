import path from 'node:path';
import fs from 'node:fs';

export function findTracesFile(sources: string[]): string | null {
    for (const source of sources) {
        const absSource = path.resolve(source);
        const candidates = [
            path.join(absSource, 'traces', 'mock-traces.json'),
            path.join(absSource, 'mock-traces.json'),
            path.join(absSource, 'traces.json'),
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

export function deduceTargetFromCwd(cwd: string): string {
    const appsMatch = cwd.match(/\/apps\/([^/]+)/);
    if (appsMatch) return appsMatch[1];
    return path.basename(cwd);
}
