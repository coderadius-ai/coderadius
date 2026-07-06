import { describe, it, expect } from 'vitest';
import { phpRecognizesServiceLocatorKey } from '../../../../../src/ingestion/core/languages/php/service-locator-key.js';

const LOCATOR_ONLY = `<?php
class ReportAction {
    public function run($sm) {
        $cache = $sm->get('cache_acl');
        $ws = $this->container->get('acme_webservice.default');
        return $cache;
    }
}`;

const PUBLISH_TOO = `<?php
class Notifier {
    public function run($sm) {
        $producer = $sm->get('notifications');
        $producer->publish('notifications', $payload);
    }
}`;

const SQL_EVIDENCE = `<?php
class Repo {
    public function load($sm) {
        $db = $sm->get('orders');
        return $db->query("SELECT * FROM orders WHERE id = 1");
    }
}`;

describe('phpRecognizesServiceLocatorKey (PSR-11 / ServiceManager contract)', () => {
    it('true when the name occurs ONLY as a locator ->get() literal arg', () => {
        expect(phpRecognizesServiceLocatorKey('cache_acl', LOCATOR_ONLY)).toBe(true);
        expect(phpRecognizesServiceLocatorKey('acme_webservice.default', LOCATOR_ONLY)).toBe(true);
    });

    it('false when the name ALSO occurs in a non-locator context (publish arg)', () => {
        expect(phpRecognizesServiceLocatorKey('notifications', PUBLISH_TOO)).toBe(false);
    });

    it('false when the name also appears inside SQL text (data evidence wins)', () => {
        expect(phpRecognizesServiceLocatorKey('orders', SQL_EVIDENCE)).toBe(false);
    });

    it('false when the name never occurs as a literal', () => {
        expect(phpRecognizesServiceLocatorKey('ghost_key', LOCATOR_ONLY)).toBe(false);
    });

    it('handles ::get and ->has as locator contexts too', () => {
        const src = `<?php $x = Registry::get('legacy_adapter'); if ($sm->has('legacy_adapter')) {}`;
        expect(phpRecognizesServiceLocatorKey('legacy_adapter', src)).toBe(true);
    });

    it('regex metacharacters in the name never break matching', () => {
        const src = `<?php $svc = $sm->get('acme.report+v2');`;
        expect(phpRecognizesServiceLocatorKey('acme.report+v2', src)).toBe(true);
    });
});
