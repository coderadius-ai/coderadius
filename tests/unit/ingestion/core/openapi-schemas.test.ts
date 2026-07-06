/**
 * OpenAPI body schema extraction (Bug residuo /renewals from core-service).
 *
 * `parseOpenAPISpec` must populate `requestSchema` and `responseSchema` on
 * each `ParsedEndpoint`. Handles JSON Schema with inline properties,
 * `$ref` to `components.schemas.X`, arrays, and nested refs.
 */
import { describe, it, expect } from 'vitest';
import { parseOpenAPISpec } from '../../../../src/ingestion/core/openapi.js';

const RENEWALS_YAML = `
openapi: 3.0.0
info:
  title: Renewal API
  version: 1.0.0
paths:
  /renewals:
    post:
      operationId: createRenewals
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                renewals:
                  type: array
                  items:
                    $ref: '#/components/schemas/ShipmentProposal'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/RenewalResponse'
components:
  schemas:
    ShipmentProposal:
      type: object
      properties:
        id: { type: string }
        amount: { type: number }
        currency: { type: string }
    RenewalResponse:
      type: object
      properties:
        accepted: { type: integer }
        rejected: { type: integer }
`;

describe('parseOpenAPISpec — body schemas', () => {
    it('extracts requestSchema and responseSchema for POST /renewals', () => {
        const spec = parseOpenAPISpec(RENEWALS_YAML, 'renewals.oas.yml');
        expect(spec).not.toBeNull();
        const ep = spec!.endpoints.find(e => e.path === '/renewals' && e.method === 'POST');
        expect(ep).toBeDefined();

        // Request schema: inline object with a `renewals: Array<ShipmentProposal>` property
        expect(ep!.requestSchema).toBeDefined();
        expect(ep!.requestSchema!.fields).toEqual([
            { name: 'renewals', type: 'Array<ShipmentProposal>', required: false },
        ]);

        // Response schema: $ref to RenewalResponse — flattened to its properties.
        expect(ep!.responseSchema).toBeDefined();
        expect(ep!.responseSchema!.name).toBe('RenewalResponse');
        expect(ep!.responseSchema!.fields).toEqual([
            { name: 'accepted', type: 'integer', required: false },
            { name: 'rejected', type: 'integer', required: false },
        ]);
    });

    it('handles inline object with required[]', () => {
        const yaml = `
openapi: 3.0.0
info: { title: x, version: '1' }
paths:
  /create:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [id, name]
              properties:
                id: { type: string }
                name: { type: string }
                optional: { type: boolean }
`;
        const spec = parseOpenAPISpec(yaml, 't.yml');
        const ep = spec!.endpoints[0];
        expect(ep.requestSchema!.fields).toEqual([
            { name: 'id', type: 'string', required: true },
            { name: 'name', type: 'string', required: true },
            { name: 'optional', type: 'boolean', required: false },
        ]);
    });

    it('handles top-level array body via $ref', () => {
        const yaml = `
openapi: 3.0.0
info: { title: x, version: '1' }
paths:
  /bulk:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: array
              items:
                $ref: '#/components/schemas/Item'
components:
  schemas:
    Item:
      type: object
      properties:
        id: { type: string }
`;
        const spec = parseOpenAPISpec(yaml, 't.yml');
        const ep = spec!.endpoints[0];
        // Top-level array: surface as a single field `_root` with the
        // array type as its declared shape.
        expect(ep.requestSchema!.fields).toEqual([
            { name: '_root', type: 'Array<Item>', required: false },
        ]);
    });

    it('returns undefined when endpoint has no body', () => {
        const yaml = `
openapi: 3.0.0
info: { title: x, version: '1' }
paths:
  /ping:
    get:
      operationId: ping
      responses:
        '200': { description: ok }
`;
        const spec = parseOpenAPISpec(yaml, 't.yml');
        const ep = spec!.endpoints[0];
        expect(ep.requestSchema).toBeUndefined();
        expect(ep.responseSchema).toBeUndefined();
    });

    it('prefers application/json over other content-types', () => {
        const yaml = `
openapi: 3.0.0
info: { title: x, version: '1' }
paths:
  /multi:
    post:
      requestBody:
        content:
          application/xml:
            schema: { type: object, properties: { wrong: { type: string } } }
          application/json:
            schema: { type: object, properties: { right: { type: string } } }
`;
        const spec = parseOpenAPISpec(yaml, 't.yml');
        const ep = spec!.endpoints[0];
        expect(ep.requestSchema!.fields).toEqual([
            { name: 'right', type: 'string', required: false },
        ]);
    });
});
