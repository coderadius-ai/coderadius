import { describe, it, expect } from 'vitest';
import { parseCodeownersFile, doesRuleCoverServiceRoot } from '../../../../src/ingestion/extractors/codeowners-extractor.js';

describe('CODEOWNERS Extractor', () => {

    describe('doesRuleCoverServiceRoot', () => {
        // Global wildcard
        it('should match global wildcard * against any root', () => {
            expect(doesRuleCoverServiceRoot('*', 'apps/payment-api')).toBe(true);
            expect(doesRuleCoverServiceRoot('*', 'src')).toBe(true);
        });

        // "apps/*" vs "apps/payment-api"
        it('should match pattern finishing with * bounding a parent directory', () => {
            expect(doesRuleCoverServiceRoot('apps/*', 'apps/payment-api')).toBe(true);
            expect(doesRuleCoverServiceRoot('apps/**', 'apps/payment-api')).toBe(true);
        });

        // Exact matches
        it('should match exact directory path', () => {
            expect(doesRuleCoverServiceRoot('apps/payment-api', 'apps/payment-api')).toBe(true);
            expect(doesRuleCoverServiceRoot('/apps/payment-api', 'apps/payment-api')).toBe(true);
        });

        // Sub-path rules (should be ignored)
        it('should NOT match sub-paths within a service root', () => {
            expect(doesRuleCoverServiceRoot('apps/payment-api/db/migrations/*', 'apps/payment-api')).toBe(false);
            expect(doesRuleCoverServiceRoot('apps/payment-api/docs', 'apps/payment-api')).toBe(false);
        });

        // Unrelated trees
        it('should NOT match different trees', () => {
            expect(doesRuleCoverServiceRoot('libs/*', 'apps/payment-api')).toBe(false);
        });

        // Trailing slash tolerance
        it('should tolerate trailing slashes', () => {
            expect(doesRuleCoverServiceRoot('services/auth/', 'services/auth')).toBe(true);
            expect(doesRuleCoverServiceRoot('services/auth', 'services/auth/')).toBe(true);
        });

        // Nested patterns covering deep services
        it('should match nested patterns covering deep services', () => {
            expect(doesRuleCoverServiceRoot('a/b/c/**', 'a/b/c/d/e')).toBe(true);
        });
        
        // Deep wildcards
        it('should not match deep wildcard sub-paths', () => {
             expect(doesRuleCoverServiceRoot('**/*.ts', 'apps/payment-api')).toBe(false);
        });
        
        // Root slash wildcards
        it('should match /*', () => {
             expect(doesRuleCoverServiceRoot('/*', 'apps/payment-api')).toBe(true);
             expect(doesRuleCoverServiceRoot('/**', 'apps/payment-api')).toBe(true);
        });
    });

    describe('parseCodeownersFile', () => {
        it('should parse simple github format', () => {
            const content = `
# A comment
* @org/global-owner
apps/* @org/squad-backend @another-user
`;
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(2);
            expect(rules[0].pattern).toBe('*');
            expect(rules[0].teams).toEqual(['global-owner']);
            expect(rules[0].users).toEqual([]);

            expect(rules[1].pattern).toBe('apps/*');
            expect(rules[1].teams).toEqual(['squad-backend']);
            expect(rules[1].users).toEqual(['another-user']);
        });

        it('should parse gitlab format with sections', () => {
            const content = `
[Frontend]
apps/frontend/* @group/frontend-team

[Backend] @@maintainer
apps/backend/* @group/subgroup/backend-team
`;
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(2);
            expect(rules[0].pattern).toBe('apps/frontend/*');
            expect(rules[0].teams).toEqual(['frontend-team']);
            
            expect(rules[1].pattern).toBe('apps/backend/*');
            // Role specifier should be skipped
            expect(rules[1].teams).toEqual(['subgroup/backend-team']);
        });

        it('should skip blank lines and pure comments', () => {
            const content = `

# Top comment



# Another comment
`;
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(0);
        });
        
        it('should parse emails', () => {
            const content = 'docs/* docs@example.com';
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(1);
            expect(rules[0].users).toEqual(['docs@example.com']);
            expect(rules[0].teams).toEqual([]);
        });

        it('should ignore inline comments avoiding false positives', () => {
            const content = 'apps/payment/* @org/team-backend # Affidato temporaneamente a @org/team-frontend';
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(1);
            expect(rules[0].teams).toEqual(['team-backend']); // team-frontend should NOT be included
        });

        it('should not truncate paths containing valid # characters (like C#)', () => {
            const content = 'apps/backend/C#/api/* @org/team-dotnet';
            const rules = parseCodeownersFile(content);
            expect(rules).toHaveLength(1);
            expect(rules[0].pattern).toBe('apps/backend/C#/api/*');
            expect(rules[0].teams).toEqual(['team-dotnet']);
        });
    });

});
