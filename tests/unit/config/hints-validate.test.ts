import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRepoHints } from '../../../src/config/hints-validate.js';
import { clearRepoHintsCache } from '../../../src/config/repo-hints.js';
import { clearAccessorScanCache } from '../../../src/ingestion/processors/connection-extractors/env-accessor-scanner.js';

const ACME_FIXTURE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/acme-secret-wrapper/acme-orders',
);

describe('validateRepoHints', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-validate-'));
        clearRepoHintsCache();
        clearAccessorScanCache();
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
        clearRepoHintsCache();
        clearAccessorScanCache();
    });

    it('valid fixture: schema ok, accessor dry-run reports harvested keys with MASKED defaults', () => {
        const report = validateRepoHints(ACME_FIXTURE);
        expect(report.schemaValid).toBe(true);
        expect(report.issues.filter((i) => i.severity === 'error')).toEqual([]);

        const accessor = report.semantics.find((s) => s.section === 'envAccessors');
        expect(accessor).toBeDefined();
        expect(accessor!.status).toBe('ok');
        expect(accessor!.detail).toMatch(/3 key/);
        // Raw default values must never be printed (masked).
        expect(JSON.stringify(report)).not.toContain('db.acme-prod.internal');
        expect(JSON.stringify(report)).not.toContain('mq.acme-internal.consul');
    });

    it('top-level typo: schema error names the unrecognized key', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'decoratorss:\n  - name: X\n');
        const report = validateRepoHints(tmp);
        expect(report.schemaValid).toBe(false);
        expect(report.issues.some((i) =>
            i.severity === 'error' && i.message.includes('decoratorss'),
        )).toBe(true);
    });

    it('declared-but-matching-nothing: decorator with zero source matches → warning', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'),
            'decorators:\n  - name: GhostConsumer\n    kind: message-consumer\n');
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.writeFileSync(path.join(tmp, 'src', 'app.php'), '<?php echo "no decorators here";');
        const report = validateRepoHints(tmp);
        expect(report.schemaValid).toBe(true);
        const dec = report.semantics.find((s) => s.section === 'decorators' && s.subject === 'GhostConsumer');
        expect(dec?.status).toBe('no-match');
        expect(report.issues.some((i) => i.severity === 'warning' && i.message.includes('GhostConsumer'))).toBe(true);
    });

    it('packages.analyze entry absent from manifests → warning; present → ok', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'),
            'packages:\n  analyze:\n    - "@acme/wire"\n    - "@acme/ghost-sdk"\n');
        fs.writeFileSync(path.join(tmp, 'package.json'),
            JSON.stringify({ dependencies: { '@acme/wire': '^1.0.0' } }));
        const report = validateRepoHints(tmp);
        const wire = report.semantics.find((s) => s.subject === '@acme/wire');
        const ghost = report.semantics.find((s) => s.subject === '@acme/ghost-sdk');
        expect(wire?.status).toBe('ok');
        expect(ghost?.status).toBe('not-found');
    });

    it('missing coderadius.yaml → file null + warning, no crash', () => {
        const report = validateRepoHints(tmp);
        expect(report.file).toBeNull();
        expect(report.schemaValid).toBe(true);
        expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
    });

    it('malformed yaml → schema error, no crash', () => {
        fs.writeFileSync(path.join(tmp, 'coderadius.yaml'), 'foo: [unclosed\n  - bar: {');
        const report = validateRepoHints(tmp);
        expect(report.schemaValid).toBe(false);
        expect(report.issues.some((i) => i.severity === 'error')).toBe(true);
    });
});
