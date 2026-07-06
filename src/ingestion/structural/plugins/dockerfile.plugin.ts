import type { StructuralPlugin, PluginContext, StructuralExtractionResult } from '../types.js';
import { buildUrn } from '../../../graph/urn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Dockerfile Plugin — Extract base images as DockerImage nodes
//
// Parses FROM instructions in Dockerfiles and creates DockerImage nodes
// with separated image name and tag. Handles multi-stage builds,
// --platform flags, and AS aliases.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Regex to match FROM instructions in Dockerfiles.
 *
 * Handles:
 *   FROM node:20-alpine
 *   FROM --platform=linux/amd64 python:3.12
 *   FROM golang:1.21 AS builder
 *   FROM ubuntu
 *   FROM myregistry.com/org/image:latest
 *
 * Groups:
 *   $1 = full image reference (e.g. "node" or "myregistry.com/org/image")
 *   $2 = tag (optional, e.g. "20-alpine" or "3.12")
 *   $3 = stage alias (optional, e.g. "builder", "runner", "final")
 */
const FROM_REGEX = /^FROM\s+(?:--platform=\S+\s+)?(\S+?)(?::(\S+))?(?:\s+AS\s+(\S+))?\s*$/gim;

/** Images to exclude (special Docker directives). */
const EXCLUDED_IMAGES = new Set(['scratch']);

export const dockerfilePlugin: StructuralPlugin = {
    name: 'dockerfile',
    label: 'Dockerfile',
    managedLabels: ['DockerImage'],

    matchFile(relativePath: string, basename: string): boolean {
        return (
            /^Dockerfile$/i.test(basename) ||
            /^Dockerfile\..+$/i.test(basename) ||
            /\.dockerfile$/i.test(relativePath)
        );
    },

    extract(content: string, context: PluginContext): StructuralExtractionResult {
        // ── Step 1: Collect ALL stages in declaration order (no dedup yet) ────────
        // Deduplication happens AFTER isFinalStage determination so that
        // `FROM node:20 AS builder` followed by `FROM node:20 AS runner` correctly
        // marks node:20 as a final-stage image (runner is last/prod-aliased).
        // [Regression fix: GPT P1-c — same image:tag in different stages]

        interface RawStage {
            name: string;
            tag: string;
            stageName: string | null;
        }
        const allStages: RawStage[] = [];

        FROM_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FROM_REGEX.exec(content)) !== null) {
            const name = match[1]!;
            const tag = match[2] ?? 'latest';
            const stageName = match[3] ?? null;
            if (!EXCLUDED_IMAGES.has(name)) {
                allStages.push({ name, tag, stageName });
            }
        }

        if (allStages.length === 0) {
            return { entities: [], summary: 'No base images found' };
        }

        // ── Step 2: Determine which stages are "final" ────────────────────────────
        // A stage is final if:
        //   a) It is the last non-excluded FROM in the file (positional), OR
        //   b) Its alias matches a conventional production name.
        const PROD_STAGE_ALIASES = new Set(['final', 'production', 'app', 'release', 'runner']);
        const lastStageIdx = allStages.length - 1;

        const isStageFinal = (stage: RawStage, idx: number): boolean =>
            idx === lastStageIdx ||
            (stage.stageName !== null && PROD_STAGE_ALIASES.has(stage.stageName.toLowerCase()));

        // ── Step 3: Collapse by image:tag, propagating isFinalStage ──────────────
        // If the same image:tag appears in multiple stages, the surviving node:
        //   • isFinalStage = true if ANY occurrence is final
        //   • stageName    = the alias of the LAST occurrence (most meaningful)
        interface MergedImage {
            name: string;
            tag: string;
            stageName: string | null;
            isFinalStage: boolean;
        }
        const imageMap = new Map<string, MergedImage>();

        for (const [idx, stage] of allStages.entries()) {
            const key = `${stage.name}:${stage.tag}`;
            const stageIsFinal = isStageFinal(stage, idx);
            const existing = imageMap.get(key);

            if (!existing) {
                imageMap.set(key, {
                    name: stage.name,
                    tag: stage.tag,
                    stageName: stage.stageName,
                    isFinalStage: stageIsFinal,
                });
            } else {
                // Merge: any final occurrence makes the whole node final;
                // keep the later stageName (last declaration wins).
                existing.isFinalStage = existing.isFinalStage || stageIsFinal;
                existing.stageName = stage.stageName ?? existing.stageName;
            }
        }

        const images = Array.from(imageMap.values());

        const entities = images.map(img => ({
            id: buildUrn('dockerimage', img.name, img.tag),
            labels: ['DockerImage'],
            properties: {
                name:          img.name,
                tag:           img.tag,
                stageName:     img.stageName,
                isFinalStage:  img.isFinalStage,
                _sourcePath:   context.relativePath,
                _ownerService: context.ownerService,
            },
            relationshipType: 'USES_BASE_IMAGE',
        }));

        return {
            entities,
            summary: `${images.length} base image(s): ${images.map(i => `${i.name}:${i.tag}`).join(', ')}`,
        };
    },
};
