/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Unit Tests — Completeness Validator
 *
 * Tests the AST-driven post-LLM completeness check.
 * Zero LLM, zero DB — pure function tests.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import {
    validateCompleteness,
    type LLMOutput,
} from '../../../src/ai/completeness-validator.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLLMOutput(overrides: Partial<LLMOutput> = {}): LLMOutput {
    return {
        has_io: true,
        infrastructure: [],
        emergent_api_calls: [],
        ...overrides,
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CompletenessValidator', () => {

    // ═══════════════════════════════════════════════════════════════════════
    // SIGNAL DETECTION — Does it find the right patterns?
    // ═══════════════════════════════════════════════════════════════════════

    describe('signal detection', () => {
        it('should detect SQL SELECT as database signal', () => {
            const source = `
function getUsers(db) {
    const result = db.query("SELECT * FROM users WHERE active = 1");
    return result.rows;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'database')).toBe(true);
        });

        it('should detect INSERT INTO as database signal', () => {
            const source = `
function createOrder(db, order) {
    db.execute("INSERT INTO orders (id, amount) VALUES (?, ?)", [order.id, order.amount]);
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'database')).toBe(true);
        });

        it('should detect PDO prepare() as database signal (PHP)', () => {
            const source = `
<?php
class UserRepo {
    public function find($id) {
        $stmt = $this->pdo->prepare("SELECT * FROM users WHERE id = ?");
        $stmt->execute([$id]);
        return $stmt->fetch();
    }
}`;
            const report = validateCompleteness(source, 'php', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'database')).toBe(true);
        });

        it('should detect axios as HTTP client signal', () => {
            const source = `
async function fetchUser(id) {
    const response = await axios.get(\`/api/users/\${id}\`);
    return response.data;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'http-client')).toBe(true);
        });

        it('should detect fetch() as HTTP client signal', () => {
            const source = `
async function callAPI() {
    const res = await fetch("https://api.example.com/data");
    return res.json();
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'http-client')).toBe(true);
        });

        it('should detect Guzzle as HTTP client signal (PHP)', () => {
            const source = `
<?php
class ApiClient {
    public function send() {
        $client = new GuzzleHttp\\Client();
        return $client->post('/api/charge', ['json' => $data]);
    }
}`;
            const report = validateCompleteness(source, 'php', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'http-client')).toBe(true);
        });

        it('should detect channel.publish as message broker signal', () => {
            const source = `
function publishEvent(channel, event) {
    channel.publish('exchange', 'routing.key', Buffer.from(JSON.stringify(event)));
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'message-broker')).toBe(true);
        });

        it('should detect MessageBusInterface as message broker signal (PHP)', () => {
            const source = `
<?php
class OrderPublisher {
    public function dispatch($order) {
        $this->messageBus->dispatch(new OrderCreated($order->id));
    }
}`;
            const report = validateCompleteness(source, 'php', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'message-broker')).toBe(true);
        });

        it('should detect @Query decorator as GraphQL signal', () => {
            const source = `
@Resolver()
class OrderResolver {
    @Query(() => Order)
    async order(@Arg("id") id: string) {
        return this.orderService.findById(id);
    }
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'graphql')).toBe(true);
        });

        it('should detect exec() as process spawn signal (PHP)', () => {
            const source = `
<?php
function runScript($path) {
    exec("php " . $path . " --daemon", $output, $exitCode);
    return $exitCode === 0;
}`;
            const report = validateCompleteness(source, 'php', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'process-spawn')).toBe(true);
        });

        it('should detect spawn() as process spawn signal (Node)', () => {
            const source = `
const { spawn } = require('child_process');
function runWorker(script) {
    const child = spawn('node', [script]);
    return child;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.some(s => s.category === 'process-spawn')).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // FALSE POSITIVE RESISTANCE — Should NOT flag these
    // ═══════════════════════════════════════════════════════════════════════

    describe('false positive resistance', () => {
        it('should NOT flag SQL in single-line comments', () => {
            const source = `
function getUsers() {
    // SELECT * FROM users WHERE active = 1
    return cachedUsers;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.filter(s => s.category === 'database')).toEqual([]);
        });

        it('should NOT flag SQL in multi-line comments', () => {
            const source = `
function getUsers() {
    /* 
     * SELECT * FROM users
     * INSERT INTO logs (message) VALUES ('test')
     */
    return [];
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals.filter(s => s.category === 'database')).toEqual([]);
        });

        it('should NOT flag import statements as signals', () => {
            const source = `
import axios from 'axios';
import amqplib from 'amqplib';
import { PrismaClient } from '@prisma/client';

export function doNothing() {
    return 42;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.signals).toEqual([]);
        });

        it('should NOT flag PHP use statements as signals', () => {
            const source = `
<?php
use Symfony\\Component\\Messenger\\MessageBusInterface;
use Doctrine\\ORM\\EntityManagerInterface;

class Config {
    private int $timeout = 30;
}`;
            const report = validateCompleteness(source, 'php', makeLLMOutput());
            expect(report.signals).toEqual([]);
        });

        it('should return score 1.0 for code with no I/O signals', () => {
            const source = `
function add(a, b) {
    return a + b;
}`;
            const report = validateCompleteness(source, 'typescript', makeLLMOutput());
            expect(report.score).toBe(1.0);
            expect(report.missingCoverage).toEqual([]);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // MISSING COVERAGE — LLM didn't extract what the source clearly shows
    // ═══════════════════════════════════════════════════════════════════════

    describe('missing coverage detection', () => {
        it('should flag when SQL is in source but no Database in LLM output', () => {
            const source = `
function getUser(db, id) {
    return db.query("SELECT * FROM users WHERE id = ?", [id]);
}`;
            const output = makeLLMOutput({ infrastructure: [] });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage).toHaveLength(1);
            expect(report.missingCoverage[0].category).toBe('database');
            expect(report.score).toBe(0);
        });

        it('should NOT flag when SQL is in source AND Database is in LLM output', () => {
            const source = `
function getUser(db, id) {
    return db.query("SELECT * FROM users WHERE id = ?", [id]);
}`;
            const output = makeLLMOutput({
                infrastructure: [{ name: 'users', type: 'Database' }],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage).toHaveLength(0);
            expect(report.score).toBe(1.0);
        });

        it('should flag when axios is used but no emergent_api_calls', () => {
            const source = `
async function callPayment(amount) {
    return axios.post("/api/charge", { amount });
}`;
            const output = makeLLMOutput({ emergent_api_calls: [] });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage).toHaveLength(1);
            expect(report.missingCoverage[0].category).toBe('http-client');
        });

        it('should NOT flag when axios is used AND emergent_api_calls exist', () => {
            const source = `
async function callPayment(amount) {
    return axios.post("/api/charge", { amount });
}`;
            const output = makeLLMOutput({
                emergent_api_calls: [{ path: '/api/charge', method: 'POST' }],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage).toHaveLength(0);
        });

        it('should flag when message broker is used but no MessageChannel in output', () => {
            const source = `
function publishOrder(channel, order) {
    channel.sendToQueue('orders', Buffer.from(JSON.stringify(order)));
}`;
            const output = makeLLMOutput({ infrastructure: [] });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage.some(m => m.category === 'message-broker')).toBe(true);
        });

        it('should NOT flag broker when MessageChannel is in output', () => {
            const source = `
function publishOrder(channel, order) {
    channel.sendToQueue('orders', Buffer.from(JSON.stringify(order)));
}`;
            const output = makeLLMOutput({
                infrastructure: [{ name: 'orders', type: 'MessageChannel' }],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage.filter(m => m.category === 'message-broker')).toEqual([]);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // SCORING — Partial coverage
    // ═══════════════════════════════════════════════════════════════════════

    describe('scoring', () => {
        it('should return 0.5 when 1 of 2 signal categories is covered', () => {
            const source = `
function hybridFn(db) {
    db.query("SELECT * FROM users");
    axios.post("/api/notify", {});
}`;
            const output = makeLLMOutput({
                infrastructure: [{ name: 'users', type: 'Database' }],
                emergent_api_calls: [],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.score).toBe(0.5);
        });

        it('should return 1.0 when all signal categories are covered', () => {
            const source = `
function hybridFn(db) {
    db.query("SELECT * FROM users");
    axios.post("/api/notify", {});
}`;
            const output = makeLLMOutput({
                infrastructure: [{ name: 'users', type: 'Database' }],
                emergent_api_calls: [{ path: '/api/notify', method: 'POST' }],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.score).toBe(1.0);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // GRAPHQL — Special case (emergent_api_calls with GRAPHQL prefix)
    // ═══════════════════════════════════════════════════════════════════════

    describe('GraphQL coverage', () => {
        it('should flag when @Query is present but no GRAPHQL in emergent calls', () => {
            const source = `
@Resolver()
class OrderResolver {
    @Query(() => Order)
    async order(id: string) { return {}; }
}`;
            const output = makeLLMOutput({ emergent_api_calls: [] });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage.some(m => m.category === 'graphql')).toBe(true);
        });

        it('should NOT flag when @Query is present AND GRAPHQL call exists', () => {
            const source = `
@Resolver()
class OrderResolver {
    @Query(() => Order)
    async order(id: string) { return {}; }
}`;
            const output = makeLLMOutput({
                emergent_api_calls: [{ path: 'GRAPHQL QUERY order' }],
            });
            const report = validateCompleteness(source, 'typescript', output);
            expect(report.missingCoverage.filter(m => m.category === 'graphql')).toEqual([]);
        });
    });
});
