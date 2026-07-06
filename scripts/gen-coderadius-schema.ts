/**
 * Generate schemas/coderadius.schema.json from RepoHintsStrictSchema.
 *
 * The JSON Schema powers editor-time validation/completion via the
 * yaml-language-server modeline:
 *   # yaml-language-server: $schema=https://raw.githubusercontent.com/coderadius-ai/coderadius/main/schemas/coderadius.schema.json
 *
 * Notes (verified against zod 4.x):
 *  - `io: 'input'` is REQUIRED: output mode marks every `.default()` field as
 *    required, which would make valid minimal files red in editors.
 *  - The STRICT twin (no catchall) is required: the runtime schema's catchall
 *    yields `additionalProperties: {}` and editors stop flagging typos.
 *  - Adding `.refine()` to any hint schema makes toJSONSchema throw
 *    'unrepresentable'; if that ever becomes necessary, pass
 *    `{ unrepresentable: 'any' }` here and document the lost constraint.
 *
 * Run: bun run gen:schema   (the coderadius-schema-in-sync unit test fails on drift)
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { RepoHintsStrictSchema } from '../src/config/repo-hints.js';

const out = path.resolve(import.meta.dirname, '..', 'schemas', 'coderadius.schema.json');
const schema = z.toJSONSchema(RepoHintsStrictSchema, { io: 'input' });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
console.log(`written ${out}`);
