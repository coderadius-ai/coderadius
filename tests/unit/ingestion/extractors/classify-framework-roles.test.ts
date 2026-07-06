import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    classifyFrameworkRoles,
} from '../../../../src/ingestion/extractors/autodiscovery';
import { getLanguagePlugin } from '../../../../src/ingestion/core/languages/registry';

function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-frameworkroles-'));
}

function touch(dir: string, rel: string, contents = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
}

describe('classifyFrameworkRoles — graphql-server signal', () => {
    let dir: string;
    beforeEach(() => { dir = makeTmp(); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('TS: NestJS GraphQLModule.forRoot in bootstrap → graphql-server', () => {
        touch(dir, 'package.json', JSON.stringify({ scripts: { start: 'node dist/main.js' } }));
        touch(dir, 'src/Main.bootstrap.ts',
            "import { GraphQLModule } from '@nestjs/graphql';\nimport { NestFactory } from '@nestjs/core';\nawait NestFactory.create(AppModule);");
        touch(dir, 'src/App.module.ts',
            "GraphQLModule.forRoot({ autoSchemaFile: 'schema.gql' })");
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('typescript'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('TS: Apollo Server instantiation → graphql-server', () => {
        touch(dir, 'package.json', '{}');
        touch(dir, 'src/index.ts',
            "import { ApolloServer } from '@apollo/server';\nconst server = new ApolloServer({ schema });");
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('typescript'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('TS: dependency @apollo/server in package.json → graphql-server', () => {
        touch(dir, 'package.json', JSON.stringify({
            dependencies: { '@apollo/server': '^4.0.0' },
        }));
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('typescript'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('TS: only @nestjs/graphql import but no forRoot → not graphql-server', () => {
        // @nestjs/graphql is the decorator surface (@Resolver/@Query). Workers and
        // CLIs routinely depend on it for typings WITHOUT hosting a server.
        // The plugin must NOT treat this dep alone as a server bootstrap signal.
        touch(dir, 'package.json', JSON.stringify({
            dependencies: { '@nestjs/graphql': '^12.0.0' },
        }));
        touch(dir, 'src/Resolver.ts',
            "import { Resolver, Query } from '@nestjs/graphql';\n@Resolver() class R { @Query() x() { return 1; } }");
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('typescript'));
        expect(roles.has('graphql-server')).toBe(false);
    });

    it('PHP: composer.json with nuwave/lighthouse → graphql-server', () => {
        touch(dir, 'composer.json', JSON.stringify({
            require: { 'nuwave/lighthouse': '^6.0' },
        }));
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('php'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('PHP: composer.json with webonyx/graphql-php → graphql-server', () => {
        touch(dir, 'composer.json', JSON.stringify({
            require: { 'webonyx/graphql-php': '^15.0' },
        }));
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('php'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('Python: pyproject.toml with strawberry-graphql → graphql-server (best-effort marker)', () => {
        // Python detection here is mostly via dep markers / entrypoint grep — accept either.
        touch(dir, 'main.py', "import strawberry\nfrom strawberry.fastapi import GraphQLRouter\nrouter = GraphQLRouter(schema)");
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('python'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('Go: gqlgen handler.NewDefaultServer → graphql-server', () => {
        touch(dir, 'go.mod', 'module acme/orders\n');
        touch(dir, 'main.go',
            'package main\nimport "github.com/99designs/gqlgen/graphql/handler"\nfunc main() { srv := handler.NewDefaultServer(es) }');
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('go'));
        expect(roles.has('graphql-server')).toBe(true);
    });

    it('plain workspace without any GQL signal → empty set', () => {
        touch(dir, 'package.json', JSON.stringify({ scripts: { start: 'node dist/main.js' } }));
        touch(dir, 'src/Main.bootstrap.ts', 'await NestFactory.create(AppModule);');
        const roles = classifyFrameworkRoles(dir, getLanguagePlugin('typescript'));
        expect(roles.has('graphql-server')).toBe(false);
        expect(roles.size).toBe(0);
    });

    it('null plugin → empty set', () => {
        touch(dir, 'package.json', '{}');
        const roles = classifyFrameworkRoles(dir, null);
        expect(roles.size).toBe(0);
    });
});
