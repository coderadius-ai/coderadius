import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

export interface FileTreeItem {
    path: string;
    size: number;
}

export function scanRepositoryTree(rootDir: string): FileTreeItem[] {
    const ig = ignore();

    // Default ignores common to all projects
    ig.add(['.git', 'node_modules', 'dist', 'build', '.DS_Store', 'coverage']);

    const gitignorePath = path.join(rootDir, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        ig.add(gitignoreContent);
    }

    const results: FileTreeItem[] = [];

    function walk(currentDir: string, relativePathSoFar: string) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (e) {
            return; // Skip folders without permissions, etc.
        }

        for (const entry of entries) {
            const entryRelativePath = relativePathSoFar ? `${relativePathSoFar}/${entry.name}` : entry.name;

            // Skip if ignored (note: ignore package expects paths without leading slash)
            if (ig.ignores(entryRelativePath)) {
                continue;
            }

            const fullPath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                walk(fullPath, entryRelativePath);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(fullPath);
                    results.push({
                        path: entryRelativePath,
                        size: stat.size
                    });
                } catch (e) {
                    // Ignore transient files or symlink issues
                }
            }
        }
    }

    walk(rootDir, '');
    return results;
}

export function formatTreeAsCsv(items: FileTreeItem[]): string {
    return items.map(item => `${item.path},${item.size}`).join('\n');
}
