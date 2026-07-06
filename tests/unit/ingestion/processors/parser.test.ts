import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseFile } from '../../../../src/ingestion/processors/parser/index.js';
import fs from 'node:fs';

vi.mock('node:fs');

describe('Parser Unit Tests', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('parsePHP (Synthetic Chunks)', () => {
        it('should create a synthetic chunk for top-level code with I/O', () => {
            const phpSource = `<?php
$db = getDb();
$res = $db->query("SELECT * FROM orders");
echo "Done";
`;
            vi.mocked(fs.readFileSync).mockReturnValue(phpSource);

            const { chunks } = parseFile('test.php');

            const scriptChunk = chunks.find(c => c.name === 'test::main');
            expect(scriptChunk).toBeDefined();
            expect(scriptChunk?.sourceCode).toContain('SELECT * FROM orders');
            expect(scriptChunk?.language).toBe('php');
        });

        it('should NOT create a synthetic chunk for short code or code without I/O', () => {
            const phpSource = `<?php
$a = 1 + 2;
echo $a;
`; // Low length and no I/O keywords
            vi.mocked(fs.readFileSync).mockReturnValue(phpSource);

            const { chunks } = parseFile('test.php');
            expect(chunks.length).toBe(0);
        });

        it('should extract named functions alongside synthetic chunks', () => {
            const phpSource = `<?php
function normalFunction() {
    return true;
}
// Adding some boilerplate to exceed the 50 character threshold
$config = ['db' => 'mysql', 'host' => 'localhost'];
$db = getDb($config);
$db->execute("DELETE FROM logs WHERE created_at < NOW()");
`;
            vi.mocked(fs.readFileSync).mockReturnValue(phpSource);

            const { chunks } = parseFile('test.php');

            expect(chunks.some(c => c.name === 'normalFunction')).toBe(true);
            expect(chunks.some(c => c.name === 'test::main')).toBe(true);
        });
    });

    describe('parseTypeScript (Regression Check)', () => {
        it('should extract TypeScript functions correctly', () => {
            const tsSource = `
export function myApiHandler(req: any) {
    const val = process.env.DB_URL;
    return { ok: true };
}

class MyService {
    async saveData(data: any) {
        console.log("Saving...");
    }
}
`;
            vi.mocked(fs.readFileSync).mockReturnValue(tsSource);

            const { chunks } = parseFile('test.ts');

            expect(chunks.some(c => c.name === 'myApiHandler')).toBe(true);
            expect(chunks.some(c => c.name === 'MyService.saveData')).toBe(true);
            expect(chunks.find(c => c.name === 'myApiHandler')?.envVars).toContain('DB_URL');
        });
    });
});
