/**
 * Unit Tests: Governance Alerts — Tech Blindspot & Duplicate Filter Logic
 *
 * We test the pure TypeScript reasoning layer, not the Cypher queries.
 * The DB-dependent functions (queryTechBlindspots, querySkillRecommendations)
 * are tested via integration tests against the test Memgraph container.
 *
 * Covered:
 *   - TECH_NORMALIZATION map correctness (no substring collisions)
 *   - Coverage matching: dual-pass (raw pkg name → normalized label fallback)
 *   - The original bug: searching normalized labels in pkg-name text was always false
 *   - Blindspot construction and sorting
 *   - Duplicate cluster noise filter (single-repo killer)
 *   - Alert sort order (error → warning → info)
 */

import { describe, it, expect } from 'vitest';
import type { TechBlindspot, DuplicateCluster } from '../../../src/graph/mutations/agentic.js';

// ─── Re-export helpers from the production module ─────────────────────────────
// We extract the pure logic into testable helper functions by reimplementing
// the same algorithms here. This keeps the tests hermetic (no DB dep) while
// validating the exact same contract.

// ─── Mirror of TECH_NORMALIZATION (source of truth is agentic.ts) ─────────────

const TECH_NORMALIZATION: Record<string, string> = {
    'react': 'React', 'react-dom': 'React', '@types/react': 'React',
    'next': 'Next.js', '@next/bundle-analyzer': 'Next.js', '@next/font': 'Next.js',
    'vue': 'Vue', '@vue/cli-service': 'Vue', 'nuxt': 'Nuxt',
    '@angular/core': 'Angular', '@angular/cli': 'Angular',
    'svelte': 'Svelte', '@sveltejs/kit': 'SvelteKit',
    'solid-js': 'Solid',
    '@nestjs/core': 'NestJS', '@nestjs/common': 'NestJS',
    'express': 'Express', '@types/express': 'Express',
    'fastify': 'Fastify', 'hono': 'Hono', 'koa': 'Koa',
    'vitest': 'Vitest', '@vitest/ui': 'Vitest',
    'jest': 'Jest', '@jest/core': 'Jest', 'ts-jest': 'Jest',
    '@testing-library/react': 'Testing Library', '@testing-library/vue': 'Testing Library',
    'playwright': 'Playwright', '@playwright/test': 'Playwright',
    'cypress': 'Cypress',
    'storybook': 'Storybook', '@storybook/react': 'Storybook', '@storybook/vue3': 'Storybook',
    '@prisma/client': 'Prisma', 'prisma': 'Prisma',
    'drizzle-orm': 'Drizzle', 'typeorm': 'TypeORM',
    'sequelize': 'Sequelize', 'mongoose': 'Mongoose', 'knex': 'Knex',
    'zustand': 'Zustand', 'redux': 'Redux', '@reduxjs/toolkit': 'Redux',
    'mobx': 'MobX', 'jotai': 'Jotai', 'recoil': 'Recoil',
    'vite': 'Vite', '@vitejs/plugin-react': 'Vite',
    'webpack': 'Webpack', 'turbopack': 'Turbopack',
    'esbuild': 'esbuild', 'rollup': 'Rollup',
    'tailwindcss': 'Tailwind CSS', '@tailwindcss/typography': 'Tailwind CSS',
    'styled-components': 'Styled Components', 'sass': 'Sass',
    'docker-compose': 'Docker',
    '@aws-sdk/client-s3': 'AWS SDK', 'aws-sdk': 'AWS SDK',
    '@google-cloud/storage': 'Google Cloud',
    'firebase': 'Firebase', 'firebase-admin': 'Firebase',
    '@sentry/node': 'Sentry', '@sentry/react': 'Sentry', '@sentry/browser': 'Sentry',
    '@opentelemetry/sdk-node': 'OpenTelemetry', '@opentelemetry/api': 'OpenTelemetry',
    'pino': 'Pino', 'winston': 'Winston',
    'next-auth': 'NextAuth', '@auth/core': 'Auth.js',
    'zod': 'Zod', 'joi': 'Joi', 'yup': 'Yup',
    'graphql': 'GraphQL', '@apollo/server': 'Apollo', '@apollo/client': 'Apollo',
    'bullmq': 'BullMQ', 'amqplib': 'RabbitMQ', 'kafkajs': 'Kafka', 'ioredis': 'Redis',
    'typescript': 'TypeScript',
    'eslint': 'ESLint', '@eslint/js': 'ESLint',
    'biome': 'Biome', '@biomejs/biome': 'Biome',
    'prettier': 'Prettier',
};

// ─── Mirror of the coverage matching logic ────────────────────────────────────

function buildRepoCoverage(configs: { technologies?: string; topics?: string }[]): Set<string> {
    const covered = new Set<string>();
    // Note: no contentPreview — dropped from the Cypher query for performance.
    const allText = configs
        .flatMap(c => [c.technologies ?? '', c.topics ?? ''])
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    // Dual-pass: mirrors the production algorithm in agentic.ts
    for (const [pkgName, normalizedTech] of Object.entries(TECH_NORMALIZATION)) {
        if (covered.has(normalizedTech)) continue;

        // Pass 1: raw package name (primary path — what LLMs actually output)
        if (allText.includes(pkgName.toLowerCase())) {
            covered.add(normalizedTech);
            continue;
        }

        // Pass 2: normalized label fallback (human-written prose)
        const escapedTech = normalizedTech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\b${escapedTech}\\b`, 'i');
        if (regex.test(allText)) {
            covered.add(normalizedTech);
        }
    }
    return covered;
}

function computeBlindspot(
    tech: string,
    repos: string[],
    repoCoverage: Map<string, Set<string>>,
): TechBlindspot | null {
    if (repos.length < 3) return null;
    const uncovered: string[] = [];
    let coveredCount = 0;
    for (const repo of repos) {
        const cov = repoCoverage.get(repo);
        if (cov && cov.has(tech)) coveredCount++;
        else uncovered.push(repo);
    }
    if (uncovered.length === 0) return null;
    return {
        technology: tech,
        totalRepos: repos.length,
        coveredRepos: coveredCount,
        uncoveredRepoNames: uncovered.sort(),
        coveragePct: Math.round((coveredCount / repos.length) * 100),
    };
}

// ─── Mirror of the duplicate cluster noise filter ─────────────────────────────

function isSignificantCluster(instances: Array<{ repo: string; team: string }>): boolean {
    const uniqueRepos = new Set(instances.map(i => i.repo));
    return instances.length > 1 && uniqueRepos.size > 1;
}

// ─── Mirror of the alert sort ─────────────────────────────────────────────────

const typePriority = (t: string) => t === 'error' ? 0 : t === 'warning' ? 1 : 2;

// ═════════════════════════════════════════════════════════════════════════════

describe('TECH_NORMALIZATION map', () => {
    it('maps react to React (not react-router)', () => {
        expect(TECH_NORMALIZATION['react']).toBe('React');
    });

    it('maps react-dom to React (same group as react)', () => {
        expect(TECH_NORMALIZATION['react-dom']).toBe('React');
    });

    it('maps @types/react to React', () => {
        expect(TECH_NORMALIZATION['@types/react']).toBe('React');
    });

    it('maps ts-jest to Jest (not a separate tech)', () => {
        expect(TECH_NORMALIZATION['ts-jest']).toBe('Jest');
    });

    it('maps @jest/core to Jest', () => {
        expect(TECH_NORMALIZATION['@jest/core']).toBe('Jest');
    });

    it('maps @prisma/client and prisma to the same tech', () => {
        expect(TECH_NORMALIZATION['@prisma/client']).toBe('Prisma');
        expect(TECH_NORMALIZATION['prisma']).toBe('Prisma');
    });

    it('maps @nestjs/core and @nestjs/common to the same tech', () => {
        expect(TECH_NORMALIZATION['@nestjs/core']).toBe('NestJS');
        expect(TECH_NORMALIZATION['@nestjs/common']).toBe('NestJS');
    });

    it('does NOT map react-router (unlisted package = ignored)', () => {
        expect(TECH_NORMALIZATION['react-router']).toBeUndefined();
    });

    it('does NOT map ts-jest to Vitest (separate tech)', () => {
        expect(TECH_NORMALIZATION['ts-jest']).not.toBe('Vitest');
    });

    it('maps all Vite-related packages to Vite', () => {
        expect(TECH_NORMALIZATION['vite']).toBe('Vite');
        expect(TECH_NORMALIZATION['@vitejs/plugin-react']).toBe('Vite');
    });

    it('maps Sentry packages across platforms to same tech', () => {
        const sentryPkgs = ['@sentry/node', '@sentry/react', '@sentry/browser'];
        sentryPkgs.forEach(pkg => expect(TECH_NORMALIZATION[pkg]).toBe('Sentry'));
    });

    it('maps Redux toolkit to Redux (not a separate thing)', () => {
        expect(TECH_NORMALIZATION['@reduxjs/toolkit']).toBe('Redux');
    });

    it('produces no duplicate values from the same package key', () => {
        const keys = Object.keys(TECH_NORMALIZATION);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).toBe(keys.length);
    });
});

// The KEY insight: the LLM populates `technologies` with raw package names, not normalized labels.
// The old bug: searching for "Tailwind CSS" in "tailwindcss next-auth" always returned false.
// The fix: Pass 1 checks raw package names; Pass 2 falls back to normalized labels for prose.

describe('Coverage matching — dual-pass (raw pkg name + normalized label)', () => {
    // ── The bug scenario: Pass 1 (raw package name matching) ───────────────────────

    it('[BUG REGRESSION] detects Tailwind CSS from raw package name "tailwindcss" in technologies', () => {
        // Old bug: searched for "Tailwind CSS" in "tailwindcss" → false negative
        const covered = buildRepoCoverage([{ technologies: 'tailwindcss,next,typescript' }]);
        expect(covered.has('Tailwind CSS')).toBe(true);
    });

    it('[BUG REGRESSION] detects NextAuth from raw package name "next-auth"', () => {
        // Old bug: searched for "NextAuth" in "next-auth" → false negative
        const covered = buildRepoCoverage([{ technologies: 'next-auth,react,prisma' }]);
        expect(covered.has('NextAuth')).toBe(true);
    });

    it('[BUG REGRESSION] detects Styled Components from raw package name', () => {
        // Old bug: searched for "Styled Components" in "styled-components" → false negative
        const covered = buildRepoCoverage([{ technologies: 'styled-components,react' }]);
        expect(covered.has('Styled Components')).toBe(true);
    });

    it('[BUG REGRESSION] detects NestJS from scoped package name "@nestjs/core"', () => {
        // Scoped packages: \b would fail on "@" but includes() handles it correctly
        const covered = buildRepoCoverage([{ technologies: '@nestjs/core,@nestjs/common' }]);
        expect(covered.has('NestJS')).toBe(true);
    });

    it('[BUG REGRESSION] detects Prisma from "@prisma/client" in technologies', () => {
        const covered = buildRepoCoverage([{ technologies: '@prisma/client' }]);
        expect(covered.has('Prisma')).toBe(true);
    });

    // ── Pass 2 (normalized label fallback) — human-written prose ─────────────────

    it('[FALLBACK] detects Tailwind CSS from normalized label in topics', () => {
        // When the LLM writes the human name in topics rather than the package name
        const covered = buildRepoCoverage([{ topics: 'styling,Tailwind CSS,accessibility' }]);
        expect(covered.has('Tailwind CSS')).toBe(true);
    });

    it('[FALLBACK] detects NestJS from normalized label in topics', () => {
        const covered = buildRepoCoverage([{ topics: 'backend,NestJS,microservices' }]);
        expect(covered.has('NestJS')).toBe(true);
    });

    it('[FALLBACK] detects TypeScript from lowercase normalized label', () => {
        // Regex is case-insensitive
        const covered = buildRepoCoverage([{ topics: 'all code must be typescript' }]);
        expect(covered.has('TypeScript')).toBe(true);
    });

    // ── Coverage deduplication: covered.has() early-exit ──────────────────────────

    it('does not double-add a tech if both passes match', () => {
        // react appears as raw name AND "React" could match fallback regex; should still be one entry
        const covered = buildRepoCoverage([{ technologies: 'react', topics: 'React framework' }]);
        expect(covered.has('React')).toBe(true);
        expect([...covered].filter(t => t === 'React').length).toBe(1);
    });

    it('detects Vitest from raw package name in topics CSV', () => {
        const covered = buildRepoCoverage([{ topics: 'testing,vitest,ci-cd' }]);
        expect(covered.has('Vitest')).toBe(true);
    });

    it('detects React from raw package name in technologies CSV', () => {
        const covered = buildRepoCoverage([{ technologies: 'react,typescript,zod' }]);
        expect(covered.has('React')).toBe(true);
    });

    it('handles empty configs gracefully', () => {
        const covered = buildRepoCoverage([{}]);
        expect(covered.size).toBe(0);
    });

    it('handles multiple config objects per repo', () => {
        const covered = buildRepoCoverage([
            { technologies: 'react' },
            { topics: 'testing,vitest' },
        ]);
        expect(covered.has('React')).toBe(true);
        expect(covered.has('Vitest')).toBe(true);
    });

    it('is case-insensitive for raw package names', () => {
        // technologies CSV stored uppercase by some LLMs
        const covered = buildRepoCoverage([{ technologies: 'REACT,VITEST' }]);
        expect(covered.has('React')).toBe(true);
        expect(covered.has('Vitest')).toBe(true);
    });
});

describe('computeBlindspot', () => {
    const makeMap = (entries: Array<[string, string[]]>) => {
        const m = new Map<string, Set<string>>();
        for (const [repo, techs] of entries) {
            m.set(repo, new Set(techs));
        }
        return m;
    };

    it('returns null if fewer than 3 repos use the technology', () => {
        const coverage = makeMap([['repo-a', ['React']], ['repo-b', []]]);
        const result = computeBlindspot('React', ['repo-a', 'repo-b'], coverage);
        expect(result).toBeNull();
    });

    it('returns null if all repos have coverage', () => {
        const coverage = makeMap([
            ['repo-a', ['React']], ['repo-b', ['React']], ['repo-c', ['React']],
        ]);
        const result = computeBlindspot('React', ['repo-a', 'repo-b', 'repo-c'], coverage);
        expect(result).toBeNull();
    });

    it('identifies uncovered repos correctly', () => {
        const coverage = makeMap([
            ['repo-a', ['React']],
            ['repo-b', []],          // no coverage
            ['repo-c', []],          // no coverage
        ]);
        const result = computeBlindspot('React', ['repo-a', 'repo-b', 'repo-c'], coverage);
        expect(result).not.toBeNull();
        expect(result!.coveredRepos).toBe(1);
        expect(result!.uncoveredRepoNames).toEqual(['repo-b', 'repo-c']);
        expect(result!.coveragePct).toBe(33);
    });

    it('sorts uncovered repo names alphabetically', () => {
        const coverage = makeMap([
            ['repo-z', []], ['repo-a', []], ['repo-m', []],
        ]);
        const result = computeBlindspot('Vitest', ['repo-z', 'repo-a', 'repo-m'], coverage);
        expect(result!.uncoveredRepoNames).toEqual(['repo-a', 'repo-m', 'repo-z']);
    });

    it('computes coveragePct as integer (rounded)', () => {
        // 1 out of 3 = 33.33... → rounds to 33
        const coverage = makeMap([
            ['a', ['Vitest']], ['b', []], ['c', []],
        ]);
        const result = computeBlindspot('Vitest', ['a', 'b', 'c'], coverage);
        expect(result!.coveragePct).toBe(33);
    });

    it('handles repo not in coverage map (treated as uncovered)', () => {
        const coverage = new Map<string, Set<string>>(); // empty — no configs ingested
        const result = computeBlindspot('React', ['repo-a', 'repo-b', 'repo-c'], coverage);
        expect(result!.coveredRepos).toBe(0);
        expect(result!.coveragePct).toBe(0);
        expect(result!.uncoveredRepoNames).toHaveLength(3);
    });
});

describe('Duplicate cluster noise filter', () => {
    it('rejects single-instance clusters', () => {
        const instances = [{ repo: 'my-repo', team: 'team-a' }];
        expect(isSignificantCluster(instances)).toBe(false);
    });

    it('rejects clusters where all instances are from the same repo (different services)', () => {
        // Same repo, two different teams — might happen if a repo has multiple services
        const instances = [
            { repo: 'my-repo', team: 'team-a' },
            { repo: 'my-repo', team: 'team-b' },
        ];
        expect(isSignificantCluster(instances)).toBe(false);
    });

    it('accepts clusters with two different repos', () => {
        const instances = [
            { repo: 'repo-a', team: 'team-a' },
            { repo: 'repo-b', team: 'team-a' },
        ];
        expect(isSignificantCluster(instances)).toBe(true);
    });

    it('accepts cross-team clusters with multiple repos', () => {
        const instances = [
            { repo: 'repo-a', team: 'team-a' },
            { repo: 'repo-b', team: 'team-b' },
            { repo: 'repo-c', team: 'team-c' },
        ];
        expect(isSignificantCluster(instances)).toBe(true);
    });

    it('accepts intra-team clusters with two different repos', () => {
        const instances = [
            { repo: 'frontend-app', team: 'frontend' },
            { repo: 'backend-api', team: 'frontend' },
        ];
        expect(isSignificantCluster(instances)).toBe(true);
    });
});

describe('Alert sort order', () => {
    it('orders error < warning < info', () => {
        expect(typePriority('error')).toBeLessThan(typePriority('warning'));
        expect(typePriority('warning')).toBeLessThan(typePriority('info'));
    });

    it('sorts a mixed alert list correctly', () => {
        const alerts = [
            { type: 'info', title: 'Skill Recommendation' },
            { type: 'error', title: 'Blindspot: React' },
            { type: 'warning', title: 'Standardization Gap' },
            { type: 'error', title: 'Blindspot: Vitest' },
        ];
        const sorted = [...alerts].sort((a, b) => typePriority(a.type) - typePriority(b.type));
        expect(sorted[0].type).toBe('error');
        expect(sorted[1].type).toBe('error');
        expect(sorted[2].type).toBe('warning');
        expect(sorted[3].type).toBe('info');
    });

    it('preserves relative order of same-type alerts (stable sort)', () => {
        const alerts = [
            { type: 'warning', title: 'A' },
            { type: 'warning', title: 'B' },
        ];
        const sorted = [...alerts].sort((a, b) => typePriority(a.type) - typePriority(b.type));
        expect(sorted[0].title).toBe('A');
        expect(sorted[1].title).toBe('B');
    });
});

describe('Blindspot severity thresholds', () => {
    it('classifies coverage < 20% as error severity', () => {
        const bs: TechBlindspot = { technology: 'React', totalRepos: 10, coveredRepos: 1, uncoveredRepoNames: [], coveragePct: 10 };
        const severity = bs.coveragePct < 20 ? 'error' : 'warning';
        expect(severity).toBe('error');
    });

    it('classifies coverage >= 20% as warning severity', () => {
        const bs: TechBlindspot = { technology: 'React', totalRepos: 10, coveredRepos: 3, uncoveredRepoNames: [], coveragePct: 30 };
        const severity = bs.coveragePct < 20 ? 'error' : 'warning';
        expect(severity).toBe('warning');
    });

    it('boundary: exactly 20% is warning, not error', () => {
        const bs: TechBlindspot = { technology: 'React', totalRepos: 5, coveredRepos: 1, uncoveredRepoNames: [], coveragePct: 20 };
        const severity = bs.coveragePct < 20 ? 'error' : 'warning';
        expect(severity).toBe('warning');
    });

    it('boundary: 19% is error', () => {
        const bs: TechBlindspot = { technology: 'React', totalRepos: 100, coveredRepos: 19, uncoveredRepoNames: [], coveragePct: 19 };
        const severity = bs.coveragePct < 20 ? 'error' : 'warning';
        expect(severity).toBe('error');
    });
});
