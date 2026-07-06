import { describe, it, expect } from 'vitest';
import { TypeScriptPlugin } from '../../../../src/ingestion/core/languages/typescript.js';
import { PHPPlugin } from '../../../../src/ingestion/core/languages/php.js';
import { GoPlugin } from '../../../../src/ingestion/core/languages/go.js';
import { PythonPlugin } from '../../../../src/ingestion/core/languages/python.js';
import type Parser from 'tree-sitter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse source, find the function spanning [startLine, endLine],
 * and run hasServiceCallsInRange on it.
 *
 * For single-function snippets, we check the entire file range.
 */
function parseAndCheck(
    plugin: { createParser(): Parser; hasServiceCallsInRange?(root: Parser.SyntaxNode, start: number, end: number): boolean | undefined },
    source: string,
    startLine?: number,
    endLine?: number,
): boolean | undefined {
    const parser = plugin.createParser();
    const tree = parser.parse(source);
    const lines = source.split('\n');
    return plugin.hasServiceCallsInRange?.(
        tree.rootNode,
        startLine ?? 1,
        endLine ?? lines.length,
    );
}

// ─── TypeScript ──────────────────────────────────────────────────────────────

describe('hasServiceCallsInRange — TypeScript', () => {
    const plugin = new TypeScriptPlugin();

    it('should detect direct this.service.method() calls', () => {
        const source = `class Svc {
  async persist(data: any) {
    return this.saveRepo.save(data);
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 4)).toBe(true);
    });

    it('should detect destructured service calls', () => {
        const source = `class Svc {
  async persist(data: any) {
    const repo = this.saveRepo;
    return repo.save(data);
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 5)).toBe(true);
    });

    it('should detect chained pipe calls (fp-ts)', () => {
        const source = `class Svc {
  execute() {
    return pipe(
      TE.tryCatch(() => this.api.call(), toDomainError),
      TE.map(result => result.data),
    );
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 7)).toBe(true);
    });

    it('should detect nested await calls', () => {
        const source = `class Svc {
  async findById(id: string) {
    const client = await this.pool.connect();
    return client.query('SELECT 1');
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 5)).toBe(true);
    });

    it('should return false for pure data transformation (no member calls)', () => {
        const source = `class Svc {
  buildQuoteData(id: string, type: string): object {
    return { id: id, type: type, combined: id + type };
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 4)).toBe(false);
    });

    it('should return false for validator functions', () => {
        const source = `class Svc {
  validate(x: number): boolean {
    return x > 0 && x < 100;
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 4)).toBe(false);
    });

    it('should return false for pure assignment-only functions', () => {
        const source = `class Svc {
  setConfig(enabled: boolean) {
    this.config = enabled;
    this.enabled = true;
  }
}`;
        expect(parseAndCheck(plugin, source, 2, 5)).toBe(false);
    });

    it('items.map() is a member call → conservative true', () => {
        const source = `class Svc {
  mapToDto(items: any[]) {
    return items.map(item => ({ id: item.id }));
  }
}`;
        // items.map() is a member_expression call → detected as service call
        // This is conservative behavior: we'd rather send to LLM than miss
        expect(parseAndCheck(plugin, source, 2, 4)).toBe(true);
    });
});

// ─── PHP ─────────────────────────────────────────────────────────────────────

describe('hasServiceCallsInRange — PHP', () => {
    const plugin = new PHPPlugin();

    it('should detect $this->repo->find() calls', () => {
        const source = `<?php
class Svc {
  function findById($id) {
    return $this->repository->find($id);
  }
}`;
        expect(parseAndCheck(plugin, source, 3, 5)).toBe(true);
    });

    it('should detect static::query() calls', () => {
        const source = `<?php
class Model {
  function search($criteria) {
    return static::query()->where($criteria)->get();
  }
}`;
        expect(parseAndCheck(plugin, source, 3, 5)).toBe(true);
    });

    it('should detect global function calls like curl_exec', () => {
        const source = `<?php
function fetchData($url) {
  $ch = curl_init($url);
  return curl_exec($ch);
}`;
        expect(parseAndCheck(plugin, source, 2, 5)).toBe(true);
    });

    it('should return false for pure PHP functions (no calls at all)', () => {
        const source = `<?php
class Svc {
  function calculateTotal($items) {
    $total = 0;
    foreach ($items as $item) {
      $total += $item['quantity'];
    }
    return $total;
  }
}`;
        expect(parseAndCheck(plugin, source, 3, 9)).toBe(false);
    });
});

// ─── Go ──────────────────────────────────────────────────────────────────────

describe('hasServiceCallsInRange — Go', () => {
    const plugin = new GoPlugin();

    it('should detect receiver method calls (s.repo.Find)', () => {
        const source = `package main

func (s *Server) GetUser(id string) (*User, error) {
    return s.repo.Find(id)
}`;
        expect(parseAndCheck(plugin, source, 3, 5)).toBe(true);
    });

    it('should detect package-level calls (http.Get)', () => {
        const source = `package main

import "net/http"

func fetchPage(url string) {
    http.Get(url)
}`;
        expect(parseAndCheck(plugin, source, 5, 7)).toBe(true);
    });

    it('should return false for pure Go functions', () => {
        const source = `package main

func add(a int, b int) int {
    return a + b
}`;
        expect(parseAndCheck(plugin, source, 3, 5)).toBe(false);
    });
});

// ─── Python ──────────────────────────────────────────────────────────────────

describe('hasServiceCallsInRange — Python', () => {
    const plugin = new PythonPlugin();

    it('should detect self.repo.find() calls', () => {
        const source = `class Svc:
    def find_by_id(self, id):
        return self.repository.find(id)`;
        expect(parseAndCheck(plugin, source, 2, 3)).toBe(true);
    });

    it('should detect aliased service calls', () => {
        const source = `class Svc:
    def process(self):
        repo = self.save_repository
        return repo.find_by_id(42)`;
        expect(parseAndCheck(plugin, source, 2, 4)).toBe(true);
    });

    it('should detect module-level calls (requests.get)', () => {
        const source = `def fetch_data(url):
    return requests.get(url)`;
        expect(parseAndCheck(plugin, source, 1, 2)).toBe(true);
    });

    it('should return false for pure Python functions', () => {
        const source = `def calculate_total(items):
    total = 0
    for item in items:
        total = total + item
    return total`;
        expect(parseAndCheck(plugin, source, 1, 5)).toBe(false);
    });
});
