import { describe, it, expect } from 'vitest';
import { parseIngressYaml } from '../../../../src/ingestion/processors/api-deployment-resolver.js';

describe('api-deployment-resolver: parseIngressYaml', () => {
    it('extracts host from a TLS-terminated production ingress', () => {
        const yaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: orders-api
spec:
  tls:
    - hosts:
        - api.acme.example.com
      secretName: acme-tls
  rules:
    - host: api.acme.example.com
      http:
        paths:
          - path: /v2
            pathType: Prefix
            backend:
              service:
                name: orders-api
                port:
                  number: 8080
`;
        const hints = parseIngressYaml(yaml, 'helm/templates/ingress-production.yaml');
        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({
            baseUrl: 'https://api.acme.example.com',
            environment: 'production',
            visibility: 'public',
            declaredBy: 'helm-ingress',
            confidence: 'high',
        });
    });

    it('classifies admin hosts as visibility=admin', () => {
        const yaml = `kind: Ingress
spec:
  tls:
    - hosts: [admin.acme.example.com]
  rules:
    - host: admin.acme.example.com
`;
        const hints = parseIngressYaml(yaml, 'k8s/admin-ingress.yaml');
        expect(hints).toHaveLength(1);
        expect(hints[0].visibility).toBe('admin');
        expect(hints[0].declaredBy).toBe('k8s-ingress');
    });

    it('uses http scheme when TLS block is absent', () => {
        const yaml = `kind: Ingress
spec:
  rules:
    - host: dev.acme.example.com
`;
        const hints = parseIngressYaml(yaml, 'helm/values-dev/ingress.yaml');
        expect(hints[0].baseUrl).toBe('http://dev.acme.example.com');
        expect(hints[0].environment).toBe('dev');
    });

    it('deduplicates duplicate host entries (rules + tls hosts)', () => {
        const yaml = `kind: Ingress
spec:
  tls:
    - hosts:
        - api.acme.example.com
  rules:
    - host: api.acme.example.com
    - host: api.acme.example.com
`;
        const hints = parseIngressYaml(yaml, 'helm/templates/ingress.yaml');
        expect(hints).toHaveLength(1);
    });

    it('skips templated hosts (helm placeholders) and wildcards', () => {
        const yaml = `kind: Ingress
spec:
  rules:
    - host: \${INGRESS_HOST}
    - host: "*"
    - host: api.acme.example.com
`;
        const hints = parseIngressYaml(yaml, 'helm/templates/ingress.yaml');
        expect(hints.map(h => h.baseUrl)).toEqual(['http://api.acme.example.com']);
    });

    it('skips Go-template (helm {{ }}) hosts so they never become an http://{{ deployment', () => {
        const yaml = `kind: Ingress
spec:
  rules:
    - host: {{ .Values.ingress.host }}
    - host: api.acme.example.com
`;
        const hints = parseIngressYaml(yaml, 'helm/templates/ingress.yaml');
        // The unresolved Go-template host must be dropped, not emitted as 'http://{{'.
        expect(hints.map(h => h.baseUrl)).toEqual(['http://api.acme.example.com']);
    });

    it('returns empty when the document is not an Ingress', () => {
        const yaml = `kind: Service
spec:
  type: ClusterIP
  ports: [{ port: 80 }]
`;
        const hints = parseIngressYaml(yaml, 'helm/templates/service.yaml');
        expect(hints).toEqual([]);
    });

    it('marks internal mesh hosts (.svc.cluster.local) as visibility=internal', () => {
        const yaml = `kind: Ingress
spec:
  rules:
    - host: orders-api.svc.cluster.local
`;
        const hints = parseIngressYaml(yaml, 'k8s/internal-ingress.yaml');
        expect(hints[0].visibility).toBe('internal');
    });
});
