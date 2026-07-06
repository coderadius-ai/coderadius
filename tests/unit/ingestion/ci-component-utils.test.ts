import { describe, test, expect } from 'vitest';
import {
    parseGitLabComponentRef,
    ciComponentUrn,
} from '../../../src/ingestion/structural/plugins/ci-component-utils.js';

describe('parseGitLabComponentRef — URL reconstruction', () => {
    test('parses the canonical host/path/name@ref form', () => {
        const result = parseGitLabComponentRef('gitlab.example.com/components/node/runner@main');
        expect(result).not.toBeNull();
        expect(result).toMatchObject({
            host: 'gitlab.example.com',
            projectPath: 'components/node',
            name: 'runner',
            ref: 'main',
            templateUrl: 'https://gitlab.example.com/components/node/-/raw/main/templates/runner/template.yml',
        });
    });

    test('handles a deeper project path with multiple slashes', () => {
        const result = parseGitLabComponentRef('gitlab.example.com/group/sub/proj/deploy@1.2.3');
        expect(result).not.toBeNull();
        expect(result!.host).toBe('gitlab.example.com');
        expect(result!.projectPath).toBe('group/sub/proj');
        expect(result!.name).toBe('deploy');
        expect(result!.ref).toBe('1.2.3');
        expect(result!.templateUrl).toBe(
            'https://gitlab.example.com/group/sub/proj/-/raw/1.2.3/templates/deploy/template.yml',
        );
    });

    test('serializes inputs as JSON when provided', () => {
        const result = parseGitLabComponentRef('gitlab.com/a/b/c@main', {
            stage: 'test',
            node_version: '20-alpine',
        });
        expect(result!.inputsJson).toBe(
            '{"stage":"test","node_version":"20-alpine"}',
        );
    });

    test('omits inputsJson when inputs is undefined', () => {
        const result = parseGitLabComponentRef('gitlab.com/a/b/c@main');
        expect(result!.inputsJson).toBeUndefined();
    });

    test('returns null for empty string', () => {
        expect(parseGitLabComponentRef('')).toBeNull();
    });

    test('returns null when @ref is missing', () => {
        expect(parseGitLabComponentRef('gitlab.com/a/b/c')).toBeNull();
    });

    test('returns null when ref is empty (trailing @)', () => {
        expect(parseGitLabComponentRef('gitlab.com/a/b/c@')).toBeNull();
    });

    test('returns null when there is no path between host and component name', () => {
        expect(parseGitLabComponentRef('gitlab.com/component@main')).toBeNull();
    });
});

describe('ciComponentUrn — stable identity', () => {
    test('encodes tool + full reference including ref', () => {
        const decl = parseGitLabComponentRef('gitlab.example.com/components/node/runner@main')!;
        expect(ciComponentUrn(decl, 'gitlab-ci')).toBe(
            'cr:cicomponent:gitlab-ci:gitlab.example.com:components/node:runner@main',
        );
    });

    test('different refs of the same component get different URNs', () => {
        const v1 = parseGitLabComponentRef('gitlab.example.com/a/b@v1')!;
        const v2 = parseGitLabComponentRef('gitlab.example.com/a/b@v2')!;
        expect(ciComponentUrn(v1, 'gitlab-ci')).not.toBe(ciComponentUrn(v2, 'gitlab-ci'));
    });

    test('different tools produce different URNs for the same declaration', () => {
        const decl = parseGitLabComponentRef('gitlab.example.com/a/b@v1')!;
        expect(ciComponentUrn(decl, 'gitlab-ci')).not.toBe(ciComponentUrn(decl, 'github-actions'));
    });
});
