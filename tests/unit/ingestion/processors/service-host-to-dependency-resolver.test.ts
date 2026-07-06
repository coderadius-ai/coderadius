import { describe, it, expect } from 'vitest';
import {
    extractHostFromUrl,
    leftmostLabel,
} from '../../../../src/ingestion/processors/service-host-to-dependency-resolver.js';

describe('extractHostFromUrl', () => {
    it('extracts host from a plain HTTPS URL', () => {
        expect(extractHostFromUrl('https://inventory.acme.dev/graphql')).toBe('inventory.acme.dev');
    });

    it('lowercases the host', () => {
        expect(extractHostFromUrl('HTTPS://Inventory.Acme.Dev')).toBe('inventory.acme.dev');
    });

    it('strips port', () => {
        expect(extractHostFromUrl('http://orders:8080/api')).toBe('orders');
    });

    it('strips credentials', () => {
        expect(extractHostFromUrl('https://user:pass@orders.acme/graphql')).toBe('orders.acme');
    });

    it('strips IPv6 brackets', () => {
        expect(extractHostFromUrl('http://[2001:db8::1]:8080/x')).toBe('2001:db8::1');
    });

    it('returns null for non-URL strings', () => {
        expect(extractHostFromUrl('not-a-url')).toBeNull();
        expect(extractHostFromUrl('/just/a/path')).toBeNull();
        expect(extractHostFromUrl('')).toBeNull();
    });

    it('returns null for protocols missing scheme separator', () => {
        expect(extractHostFromUrl('inventory.acme.dev')).toBeNull();
    });

    it('handles non-http schemes', () => {
        expect(extractHostFromUrl('amqp://broker.acme/x')).toBe('broker.acme');
    });
});

describe('leftmostLabel', () => {
    it('extracts the first label of a multi-segment host', () => {
        expect(leftmostLabel('inventory.acme.k8s.dev')).toBe('inventory');
    });

    it('returns the entire host when there is no dot', () => {
        expect(leftmostLabel('localhost')).toBe('localhost');
    });

    it('preserves casing as given', () => {
        // (caller is expected to lowercase before passing in)
        expect(leftmostLabel('Inventory.Acme')).toBe('Inventory');
    });
});
