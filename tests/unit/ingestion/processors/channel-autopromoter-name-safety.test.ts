import { describe, it, expect } from 'vitest';
import { isUncorroboratedMessageClass } from '../../../../src/ingestion/processors/channel-autopromoter.js';

describe('isUncorroboratedMessageClass (autopromoter name-safety gate)', () => {
    // --- DROP: bare CQRS class names with no structural config corroboration ---
    it('drops a *Event class name (LLM payload misread as a channel)', () => {
        expect(isUncorroboratedMessageClass('NotPurchasableEvent', false)).toBe(true);
    });
    it('drops a *Message class name', () => {
        expect(isUncorroboratedMessageClass('UpdateSaveRequestedMessage', false)).toBe(true);
    });
    it('drops a *Command class name', () => {
        expect(isUncorroboratedMessageClass('ShipOrderCommand', false)).toBe(true);
    });

    // --- KEEP: structurally corroborated (config-declared abstract bus) ---
    it('keeps a CQRS class name when structurally corroborated (config)', () => {
        expect(isUncorroboratedMessageClass('OrderPlacedMessage', true)).toBe(false);
    });

    // --- KEEP: real routing keys + namespaced FQCN message classes never match ---
    it('keeps a dotted routing key (never a class shape)', () => {
        expect(isUncorroboratedMessageClass('acme.notification.save.requested', false)).toBe(false);
    });
    it('keeps a namespaced FQCN message class (backslashes — not the bare pattern)', () => {
        expect(isUncorroboratedMessageClass('Acme\\Messenger\\Message\\SaveMessage', false)).toBe(false);
    });
    it('keeps a separator-bearing physical topic name', () => {
        expect(isUncorroboratedMessageClass('acme-inventory-dwh-streaming', false)).toBe(false);
    });
});
