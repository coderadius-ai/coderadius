import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RepoHintsStrictSchema } from '../../../src/config/repo-hints.js';

const SCHEMA_PATH = path.resolve(
    import.meta.dirname, '..', '..', '..', 'schemas', 'coderadius.schema.json',
);

describe('schemas/coderadius.schema.json', () => {
    it('is in sync with RepoHintsStrictSchema (run `bun run gen:schema` on drift)', () => {
        const onDisk = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
        // io:'input' so defaulted sections are optional for authors;
        // the strict twin gives additionalProperties:false at the top level.
        const generated = z.toJSONSchema(RepoHintsStrictSchema, { io: 'input' });
        expect(onDisk).toEqual(JSON.parse(JSON.stringify(generated)));
    });

    it('flags unknown top-level keys and keeps every section optional', () => {
        const onDisk = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
        expect(onDisk.additionalProperties).toBe(false);
        expect(onDisk.required ?? []).toEqual([]);
        expect(Object.keys(onDisk.properties)).toContain('envAccessors');
    });
});
