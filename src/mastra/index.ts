// ── Mastra Studio Entry Point ────────────────────────────────────────────────
// This file is the conventional entry point for `mastra dev` (Studio UI).
// It force-enables tracing BEFORE importing the singleton, then re-exports it.
// All agent registrations live in src/ai/mastra/index.ts — zero duplication.

process.env.RADIUS_TRACE = 'true';

import { getMastra } from '../ai/mastra/index.js';

export const mastra = getMastra();
