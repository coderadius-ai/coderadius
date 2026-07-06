import { describe, it, expect } from 'vitest';
import {
    stripGoTemplates,
    resolveHelmValue,
    resolvePlaceholders,
    extractValuesPaths,
} from '../../../../src/ingestion/structural/plugins/contrib/helm-template-resolver.js';

// ═════════════════════════════════════════════════════════════════════════════
// Helm Template Resolver — Unit Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('stripGoTemplates', () => {
    it('should replace {{ $.Values.x.y }} with placeholder', () => {
        const input = 'topicId: {{ $.Values.global.configuration.TOPIC_NAME }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('topicId: __CR_VAL_global|configuration|TOPIC_NAME__');
    });

    it('should replace {{ .Values.x }} (no $ prefix) with placeholder', () => {
        const input = 'name: {{ .Values.topicName }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('name: __CR_VAL_topicName__');
    });

    it('should handle whitespace-trimming hyphens {{- and -}}', () => {
        const input = 'topicId: {{- .Values.global.TOPIC_NAME -}}';
        const result = stripGoTemplates(input);
        expect(result).toBe('topicId: __CR_VAL_global|TOPIC_NAME__');
    });

    it('should delete control flow lines entirely', () => {
        const input = [
            'spec:',
            '  {{- if eq .Values.env "production" }}',
            '  topicId: {{ $.Values.global.TOPIC_NAME }}',
            '  {{- else }}',
            '  topicId: prefix-{{ $.Values.global.TOPIC_NAME }}',
            '  {{- end }}',
        ].join('\n');
        const result = stripGoTemplates(input);
        expect(result).toContain('spec:');
        expect(result).toContain('__CR_VAL_global|TOPIC_NAME__');
        expect(result).not.toContain('{{- if');
        expect(result).not.toContain('{{- else');
        expect(result).not.toContain('{{- end');
    });

    it('should strip {{ .Release.Name }} references', () => {
        const input = 'name: {{ $.Release.Name }}-{{ $.Values.global.TOPIC_NAME }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('name: -__CR_VAL_global|TOPIC_NAME__');
    });

    it('should strip remaining unknown template expressions', () => {
        const input = 'label: {{ include "app.name" . }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('label:  # template');
    });

    it('should strip templates containing nested braces (JSON default)', () => {
        const input = 'annotations: {{ default "{}" .Values.podAnnotations }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('annotations:  # template');
    });

    it('should strip templates with complex nested braces', () => {
        const input = 'config: {{ toJson (dict "key" "value") }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('config:  # template');
    });

    it('should strip templates with dict/tuple containing braces', () => {
        const input = 'data: {{ printf "{%s: %s}" .Values.key .Values.val }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('data:  # template');
    });

    it('should handle multiple Values refs on one line', () => {
        const input = 'name: {{ $.Values.project }}-{{ $.Values.topicName }}';
        const result = stripGoTemplates(input);
        expect(result).toBe('name: __CR_VAL_project__-__CR_VAL_topicName__');
    });

    it('should pass through plain YAML unchanged', () => {
        const input = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: my-config';
        const result = stripGoTemplates(input);
        expect(result).toBe(input);
    });
});

describe('resolveHelmValue', () => {
    const values = {
        global: {
            configuration: {
                TOPIC_NAME: 'Platform-SampleUser',
                SUBSCRIPTION_NAME: 'save-user-emails',
                GOOGLE_CLOUD_PROJECT: 'acme-platform',
            },
        },
        topicName: 'SimpleTopic',
        numericValue: 42,
    };

    it('should resolve a deeply nested dot-path', () => {
        expect(resolveHelmValue(values, 'global.configuration.TOPIC_NAME')).toBe('Platform-SampleUser');
    });

    it('should resolve a top-level key', () => {
        expect(resolveHelmValue(values, 'topicName')).toBe('SimpleTopic');
    });

    it('should convert non-string values to string', () => {
        expect(resolveHelmValue(values, 'numericValue')).toBe('42');
    });

    it('should return undefined for missing paths', () => {
        expect(resolveHelmValue(values, 'global.configuration.MISSING')).toBeUndefined();
    });

    it('should return undefined for partial paths into non-objects', () => {
        expect(resolveHelmValue(values, 'topicName.nested')).toBeUndefined();
    });

    it('should return undefined for empty object', () => {
        expect(resolveHelmValue({}, 'any.path')).toBeUndefined();
    });
});

describe('resolvePlaceholders', () => {
    const values = {
        global: {
            configuration: {
                TOPIC_NAME: 'Platform-SampleUser',
                SUBSCRIPTION_NAME: 'save-user-emails',
            },
        },
    };

    it('should replace a single placeholder with the resolved value', () => {
        const input = 'topicId: __CR_VAL_global|configuration|TOPIC_NAME__';
        const result = resolvePlaceholders(input, values);
        expect(result).toBe('topicId: Platform-SampleUser');
    });

    it('should replace multiple placeholders', () => {
        const input = 'topic: __CR_VAL_global|configuration|TOPIC_NAME__ sub: __CR_VAL_global|configuration|SUBSCRIPTION_NAME__';
        const result = resolvePlaceholders(input, values);
        expect(result).toBe('topic: Platform-SampleUser sub: save-user-emails');
    });

    it('should keep unresolvable placeholders as-is', () => {
        const input = 'name: __CR_VAL_missing_key__';
        const result = resolvePlaceholders(input, values);
        expect(result).toBe('name: __CR_VAL_missing_key__');
    });

    it('should pass through text without placeholders', () => {
        const input = 'plain text without any placeholders';
        const result = resolvePlaceholders(input, values);
        expect(result).toBe(input);
    });
});

describe('extractValuesPaths', () => {
    it('should extract all Values dot-paths from a template', () => {
        const input = [
            'topicId: {{ $.Values.global.configuration.TOPIC_NAME }}',
            'projectId: {{ .Values.global.configuration.GOOGLE_CLOUD_PROJECT }}',
            'name: {{ $.Release.Name }}',
        ].join('\n');
        const paths = extractValuesPaths(input);
        expect(paths).toContain('global.configuration.TOPIC_NAME');
        expect(paths).toContain('global.configuration.GOOGLE_CLOUD_PROJECT');
        expect(paths).not.toContain('Release.Name');
    });

    it('should deduplicate repeated references', () => {
        const input = [
            'a: {{ $.Values.topicName }}',
            'b: {{ $.Values.topicName }}',
        ].join('\n');
        const paths = extractValuesPaths(input);
        expect(paths).toEqual(['topicName']);
    });

    it('should return empty array for plain YAML', () => {
        expect(extractValuesPaths('kind: ConfigMap')).toEqual([]);
    });
});
