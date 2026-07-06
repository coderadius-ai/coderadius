import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    loadRepoHints,
    clearRepoHintsCache,
    getLastHintsLoadError,
} from '../../../src/config/repo-hints.js';

describe('getLastHintsLoadError', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-hints-err-'));
        clearRepoHintsCache();
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        clearRepoHintsCache();
    });

    it('malformed yaml: loadRepoHints still returns defaults, error is retrievable', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'foo: [unclosed\n  - bar: {');
        const hints = loadRepoHints(tmp);
        expect(hints.decorators).toEqual([]);                 // silent-default contract intact
        expect(getLastHintsLoadError(tmp)).toMatch(/./);      // non-null, non-empty
    });

    it('schema-invalid yaml: error is retrievable', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'decorators: "not-an-array"\n');
        loadRepoHints(tmp);
        expect(getLastHintsLoadError(tmp)).toMatch(/./);
    });

    it('valid yaml: no error', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'decorators: []\n');
        loadRepoHints(tmp);
        expect(getLastHintsLoadError(tmp)).toBeNull();
    });

    it('missing file: no error (nothing to load is not a failure)', () => {
        loadRepoHints(tmp);
        expect(getLastHintsLoadError(tmp)).toBeNull();
    });

    it('clearRepoHintsCache clears the recorded error too', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'foo: [unclosed\n  - bar: {');
        loadRepoHints(tmp);
        clearRepoHintsCache(tmp);
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'decorators: []\n');
        loadRepoHints(tmp);
        expect(getLastHintsLoadError(tmp)).toBeNull();
    });
});
