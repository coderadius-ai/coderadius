/**
 * @file plugin-validate-inbound-path-gql.test.ts
 * Tests for the GQL `validateInboundPath` soft guard in TypeScriptPlugin and PHPPlugin.
 *
 * Actual behavior of the GQL branch:
 *   - Returns `true` when strong decorator evidence (@Query, @Mutation, #[Query] etc.) is found
 *   - Returns `undefined` (defer to LLM) when no strong evidence is found
 *   - NEVER returns `false` for GQL paths (too many valid forms — resolver maps, codegen, etc.)
 *   - Returns `false` for clearly invalid HTTP paths (no evidence in source code)
 */
import { describe, it, expect } from 'vitest';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';

const tsPlugin = new TypeScriptPlugin();
const phpPlugin = new PHPPlugin();

// ─── TypeScript GQL soft guard ───────────────────────────────────────────────

describe('TypeScriptPlugin.validateInboundPath — GQL branch', () => {
    it('returns true for GRAPHQL QUERY path with @Query(() => Type) decorator', () => {
        const code = `@Query(() => User)\nasync user(): Promise<User> { return this.svc.find(); }`;
        const result = tsPlugin.validateInboundPath('GRAPHQL QUERY user', code);
        expect(result).toBe(true);
    });

    it('returns true for GRAPHQL MUTATION path with @Mutation decorator', () => {
        const code = `@Mutation('createUser')\nasync createUser(): Promise<User> {}`;
        const result = tsPlugin.validateInboundPath('GRAPHQL MUTATION createUser', code);
        expect(result).toBe(true);
    });

    it('returns true for GRAPHQL SUBSCRIPTION path with @Subscription decorator', () => {
        const code = `@Subscription('newMessage')\nasync newMessage(): AsyncIterator<Message> {}`;
        const result = tsPlugin.validateInboundPath('GRAPHQL SUBSCRIPTION newMessage', code);
        expect(result).toBe(true);
    });

    it('returns undefined (defer) for GRAPHQL path without strong decorator evidence', () => {
        // Resolver map style — no decorator
        const code = `async user(root, args) { return this.userService.findOne(args.id); }`;
        const result = tsPlugin.validateInboundPath('GRAPHQL QUERY user', code);
        expect(result).toBeUndefined();
    });

    it('NEVER returns false for a GQL path (always true or undefined)', () => {
        // Even with no source code evidence, GQL path should not be hard-dropped
        const result = tsPlugin.validateInboundPath('GRAPHQL QUERY user', '');
        expect(result).not.toBe(false);
    });

    it('returns false for a clearly invalid HTTP path (no evidence)', () => {
        // A truly noisy path that has no evidence in source
        const result = tsPlugin.validateInboundPath('/completely/random/path/xyz', '// no routes here');
        expect(result).toBe(false);
    });

    it('does not interfere with a valid HTTP path that has evidence', () => {
        const code = `router.get('/api/users', handler);`;
        const result = tsPlugin.validateInboundPath('/api/users', code);
        expect(result).not.toBe(false);
    });
});

// ─── PHP GQL soft guard ───────────────────────────────────────────────────────

describe('PHPPlugin.validateInboundPath — GQL branch', () => {
    it('returns true for GRAPHQL QUERY path with Lighthouse #[Query] attribute', () => {
        const code = `#[Query]\npublic function user(mixed $root, array $args): User\n{ return User::find($args['id']); }`;
        const result = phpPlugin.validateInboundPath('GRAPHQL QUERY user', code);
        expect(result).toBe(true);
    });

    it('returns true for GRAPHQL MUTATION path with #[Mutation] attribute', () => {
        const code = `#[Mutation]\npublic function createUser(mixed $root, array $args): User\n{ return User::create($args); }`;
        const result = phpPlugin.validateInboundPath('GRAPHQL MUTATION createUser', code);
        expect(result).toBe(true);
    });

    it('returns undefined (defer) for GRAPHQL path without attribute evidence', () => {
        // Webonyx resolver map — no attribute
        const code = `public function resolve($root, $args) { return $this->userRepo->find($args['id']); }`;
        const result = phpPlugin.validateInboundPath('GRAPHQL QUERY user', code);
        expect(result).toBeUndefined();
    });

    it('NEVER returns false for a GQL path', () => {
        const result = phpPlugin.validateInboundPath('GRAPHQL MUTATION createUser', '');
        expect(result).not.toBe(false);
    });

    it('does not block a valid Symfony REST route', () => {
        const code = `#[Route('/api/users', methods: ['GET'])]\npublic function index(): Response {}`;
        const result = phpPlugin.validateInboundPath('/api/users', code);
        expect(result).not.toBe(false);
    });
});
