import { SimpleTooltip } from './Tooltip';
import { EntityBadge, AccentCard, DetailCard, BadgeWithLabel } from './design-system';
import type { BadgeSize } from './design-system';
import { SIMPLE_ICONS, ECOSYSTEM_ICON_KEY } from './design-system/simple-icons';

export { EntityBadge, AccentCard, DetailCard, BadgeWithLabel };
export type { BadgeSize };

// ─── HTTP Method Semantics ─────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type TechFlavor = 'graphql' | 'grpc';

export interface HttpMethodMeta {
    method: HttpMethod | null;
    path: string;
    techFlavor?: TechFlavor;
    techSubtype?: string;   // e.g. 'QUERY', 'MUTATION', 'SUBSCRIPTION', 'UNARY'
    color: string;
    bgColor: string;
    borderColor: string;
    label: string;
}

const HTTP_METHOD_CONFIG: Record<string, { color: string; bg: string; border: string }> = {
    GET:     { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',   border: 'rgba(96,165,250,0.25)'    },
    POST:    { color: '#4ade80', bg: 'rgba(74,222,128,0.12)',   border: 'rgba(74,222,128,0.25)'    },
    PUT:     { color: '#fb923c', bg: 'rgba(251,146,60,0.12)',   border: 'rgba(251,146,60,0.25)'    },
    PATCH:   { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',   border: 'rgba(251,191,36,0.25)'    },
    DELETE:  { color: '#f87171', bg: 'rgba(248,113,113,0.12)',  border: 'rgba(248,113,113,0.25)'   },
    HEAD:    { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)',  border: 'rgba(167,139,250,0.25)'   },
    OPTIONS: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)',   border: 'rgba(148,163,184,0.2)'    },
};

/**
 * Parses HTTP method + path from an APIEndpoint name.
 * Expects names like "GET /api/v1/users" or "POST /records".
 * Returns { method, path } — method is null if not recognized.
 */
export function parseHttpMethod(name: string): { method: HttpMethod | null; path: string } {
    const METHODS: HttpMethod[] = ['DELETE', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'GET', 'HEAD'];
    const upper = name.trim().toUpperCase();
    for (const m of METHODS) {
        if (upper.startsWith(m + ' ') || upper.startsWith(m + '\t')) {
            return { method: m, path: name.slice(m.length).trim() };
        }
    }
    return { method: null, path: name };
}

export function getHttpMethodMeta(
    name: string,
    apiKind?: string | null,
    operation?: string | null,
): HttpMethodMeta {
    const NEUTRAL = { color: '#94a3b8', bgColor: 'rgba(148,163,184,0.1)', borderColor: 'rgba(148,163,184,0.2)' };

    // ── Fast path: structured apiKind from topology data ──────────────────
    if (apiKind === 'graphql') {
        return {
            method: null,
            path: name,
            techFlavor: 'graphql',
            techSubtype: operation ?? undefined,
            ...NEUTRAL,
            label: name,
        };
    }
    if (apiKind === 'grpc') {
        return {
            method: null,
            path: name,
            techFlavor: 'grpc',
            techSubtype: operation ?? 'UNARY',
            ...NEUTRAL,
            label: name,
        };
    }

    // ── Fallback: parse from name string (legacy / un-migrated data) ──────
    const { method, path: fullPath } = parseHttpMethod(name);
    let path = fullPath;

    // Strip common protocol prefixes that aren't formal HTTP methods but appear in URNs
    const pre = path.toUpperCase();
    if (pre.startsWith('WS ')) path = path.slice(3).trim();
    else if (pre.startsWith('WSS ')) path = path.slice(4).trim();

    let techFlavor: TechFlavor | undefined;
    let techSubtype: string | undefined;

    // Extract tech flavor + operation subtype from the path prefix (legacy data only)
    const up = path.toUpperCase();
    if (up.startsWith('GRAPHQL MUTATION ')) {
        techFlavor = 'graphql'; techSubtype = 'MUTATION';
        path = path.slice('GRAPHQL MUTATION '.length).trim();
    } else if (up.startsWith('GRAPHQL QUERY ')) {
        techFlavor = 'graphql'; techSubtype = 'QUERY';
        path = path.slice('GRAPHQL QUERY '.length).trim();
    } else if (up.startsWith('GRAPHQL SUBSCRIPTION ')) {
        techFlavor = 'graphql'; techSubtype = 'SUBSCRIPTION';
        path = path.slice('GRAPHQL SUBSCRIPTION '.length).trim();
    } else if (up.startsWith('GRAPHQL ')) {
        techFlavor = 'graphql';
        path = path.slice('GRAPHQL '.length).trim();
    } else if (up.startsWith('GRPC ')) {
        techFlavor = 'grpc'; techSubtype = 'UNARY';
        path = path.slice('GRPC '.length).trim();
    }

    if (!method) return { method: null, path, techFlavor, techSubtype, ...NEUTRAL, label: name };
    // Defensive: fall back to NEUTRAL if the parsed method ever lands outside
    // the registry (shouldn't happen since parseHttpMethod only emits keys
    // from `METHODS`, but a misbuilt backend snapshot or a future verb extension
    // could otherwise crash the whole render path).
    const cfg = HTTP_METHOD_CONFIG[method] ?? { color: NEUTRAL.color, bg: NEUTRAL.bgColor, border: NEUTRAL.borderColor };
    return { method, path, techFlavor, techSubtype, color: cfg.color, bgColor: cfg.bg, borderColor: cfg.border, label: method };
}

/**
 * Colored pill for HTTP method. Renders the verb (GET, POST, etc.)
 * with semantic colors. Works in both card and banner contexts.
 */
export function HttpMethodBadge({
    method,
    color,
    bgColor,
    borderColor,
    size = 'sm',
}: {
    method: string;
    color: string;
    bgColor: string;
    borderColor: string;
    size?: BadgeSize;
}) {
    return (
        <EntityBadge
            label={method}
            color={color}
            bgColor={bgColor}
            borderColor={borderColor}
            size={size}
        />
    );
}

/**
 * TechBadge — text pill for protocol subtypes (GraphQL QUERY/MUTATION, gRPC UNARY, etc.).
 * Matches the visual grammar of HttpMethodBadge but with protocol-specific colors.
 */
const TECH_BADGE_CONFIG: Record<TechFlavor, { color: string; bg: string; border: string }> = {
    graphql:  { color: '#E10098', bg: 'rgba(225,0,152,0.10)',  border: 'rgba(225,0,152,0.25)'  },
    grpc:     { color: '#00bcd4', bg: 'rgba(0,188,212,0.10)',  border: 'rgba(0,188,212,0.25)'  },
};

/**
 * Returns the colour triple (text / bg / border) for a tech flavor + optional
 * GraphQL subtype. Exported so callers that need to render a stand-alone
 * subtype chip (`MUTATION`, `QUERY`, `SUBSCRIPTION`) with the same semantic
 * palette can do so without duplicating the colour math.
 *
 * Defensive: returns a NEUTRAL palette when the runtime value of `flavor`
 * isn't a registered key (TypeScript narrows to `'graphql' | 'grpc'` but
 * the value can drift if the backend stamps a non-canonical `apiKind`).
 */
const NEUTRAL_TECH_CFG = { color: '#94a3b8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.25)' };
export function getTechBadgeMeta(flavor: TechFlavor, subtype?: string): { color: string; bg: string; border: string } {
    let cfg = TECH_BADGE_CONFIG[flavor] ?? NEUTRAL_TECH_CFG;
    // Align GraphQL operations with semantic design system colors (Read=Blue, Write=Red)
    if (flavor === 'graphql') {
        if (subtype === 'MUTATION') {
            cfg = { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' };
        } else if (subtype === 'QUERY') {
            cfg = { color: '#60a5fa', bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.25)' };
        } else if (subtype === 'SUBSCRIPTION') {
            cfg = { color: '#a78bfa', bg: 'rgba(167,139,250,0.10)', border: 'rgba(167,139,250,0.25)' };
        }
    }
    return cfg;
}

export function TechBadge({
    flavor,
    subtype,
    size = 'sm',
}: {
    flavor: TechFlavor;
    subtype?: string;
    size?: BadgeSize;
}) {
    const cfg = getTechBadgeMeta(flavor, subtype);

    let label = subtype ?? (flavor === 'graphql' ? 'GQL' : 'gRPC');
    if (subtype && flavor === 'graphql') label = `GQL ${subtype}`;
    return (
        <EntityBadge
            label={label}
            color={cfg.color}
            bgColor={cfg.bg}
            borderColor={cfg.border}
            size={size}
        />
    );
}

/**
 * ChannelKindBadge — text pill for MessageChannel kinds (topic, queue, exchange).
 * Matches the visual grammar of HttpMethodBadge.
 */
const CHANNEL_KIND_CONFIG: Record<string, { color: string; bg: string; border: string }> = {
    topic:        { color: '#2dd4bf', bg: 'rgba(45,212,191,0.10)',  border: 'rgba(45,212,191,0.22)'  }, // Teal — distinct from amber envelope
    queue:        { color: '#4ade80', bg: 'rgba(74,222,128,0.12)',  border: 'rgba(74,222,128,0.25)'  }, // Green
    exchange:     { color: '#c084fc', bg: 'rgba(192,132,252,0.12)', border: 'rgba(192,132,252,0.25)' }, // Purple
    subscription: { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  border: 'rgba(96,165,250,0.25)'  }, // Blue
};

export function ChannelKindBadge({
    kind,
    size = 'sm',
}: {
    kind: string;
    size?: BadgeSize;
}) {
    const key = kind.toLowerCase();
    const cfg = CHANNEL_KIND_CONFIG[key] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.2)' };
    return (
        <EntityBadge
            label={kind.toUpperCase()}
            color={cfg.color}
            bgColor={cfg.bg}
            borderColor={cfg.border}
            size={size}
        />
    );
}

const SCHEMA_FORMAT_CONFIG: Record<string, { color: string; bg: string; border: string }> = {
    avro:          { color: '#22d3ee', bg: 'rgba(34,211,238,0.10)', border: 'rgba(34,211,238,0.25)' },
    protobuf:      { color: '#4ade80', bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.25)' },
    'json-schema': { color: '#818cf8', bg: 'rgba(129,140,248,0.10)', border: 'rgba(129,140,248,0.25)' },
};

export function SchemaFormatBadge({ format, size = 'sm' }: { format: string; size?: BadgeSize }) {
    const key = format.toLowerCase();
    const cfg = SCHEMA_FORMAT_CONFIG[key] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', border: 'rgba(148,163,184,0.2)' };
    const label = key === 'json-schema' ? 'JSON' : format.toUpperCase();
    return (
        <EntityBadge
            label={label}
            color={cfg.color}
            bgColor={cfg.bg}
            borderColor={cfg.border}
            size={size}
        />
    );
}

// ─── Provenance & Technology Badges ──────────────────────────────────────────

/**
 * DiscoverySourceChip — inline icon + label showing how a node was discovered.
 * Matches the visual language of TeamIcon/repo chips: small icon, muted text, no pill chrome.
 * Each source gets a unique hand-crafted SVG icon with its signature color.
 */
const DISCOVERY_SOURCE_META: Record<string, { label: string; color: string }> = {
    backstage:           { label: 'Backstage',   color: '#a78bfa' },
    autodiscovery:       { label: 'Auto',        color: '#6b7280' },
    'code-analysis':     { label: 'Code',        color: '#60a5fa' },
    crossplane:          { label: 'Crossplane',  color: '#22d3ee' },
    'package-publisher': { label: 'Package',     color: '#fbbf24' },
    codeowners:          { label: 'CODEOWNERS',  color: '#4ade80' },
};

export function getStringHashColor(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 75%, 65%)`;
}

/** Per-source SVG icons — 16×16 viewBox, stroke-based, clean at 9–10px. */
function DiscoverySourceSvg({ source, size = 10 }: { source: string; size?: number }) {
    const color = DISCOVERY_SOURCE_META[source]?.color ?? getStringHashColor(source);
    const props = { width: size, height: size, fill: 'none' as const, 'aria-hidden': true as const };

    switch (source) {
        // Backstage — catalog / book icon
        case 'backstage':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M3 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
                    <path d="M3 2v12" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
                    <path d="M6 5h4M6 8h3" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.7"/>
                </svg>
            );
        // AutoDiscovery — sparkle / magic icon
        case 'autodiscovery':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M8 2C8 5.3 5.3 8 2 8C5.3 8 8 10.7 8 14C8 10.7 10.7 8 14 8C10.7 8 8 5.3 8 2Z" stroke={color} strokeWidth="1.3" strokeLinejoin="round" fill="none" />
                </svg>
            );
        // Code Analysis — terminal / code brackets
        case 'code-analysis':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M5.5 4L2 8l3.5 4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M10.5 4L14 8l-3.5 4" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
            );
        // Crossplane — cloud / infrastructure
        case 'crossplane':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M4 12h8a3 3 0 1 0-.5-5.96A4.5 4.5 0 0 0 3 7.5 3 3 0 0 0 4 12z" stroke={color} strokeWidth="1.3" strokeLinejoin="round"/>
                </svg>
            );
        // Package publisher — box / package
        case 'package-publisher':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M2 5l6-3 6 3v6l-6 3-6-3V5z" stroke={color} strokeWidth="1.3" strokeLinejoin="round"/>
                    <path d="M2 5l6 3 6-3M8 8v6" stroke={color} strokeWidth="1.2" strokeLinecap="round" opacity="0.6"/>
                </svg>
            );
        // CODEOWNERS — shield / file-check
        case 'codeowners':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M8 2L3 4.5v3.5c0 3 2.2 5.3 5 6 2.8-.7 5-3 5-6V4.5L8 2z" stroke={color} strokeWidth="1.3" strokeLinejoin="round"/>
                    <path d="M6 8l1.5 1.5L10 7" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/>
                </svg>
            );
        // Fallback — generic compass
        default:
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <circle cx="8" cy="8" r="5.5" stroke={color} strokeWidth="1.3"/>
                    <path d="M10 6l-1.5 2.5L6 10l1.5-2.5L10 6z" fill={color} opacity="0.6"/>
                </svg>
            );
    }
}

export function DiscoverySourceChip({ source, size = 10 }: { source: string; size?: number }) {
    const meta = DISCOVERY_SOURCE_META[source] ?? { label: source.charAt(0).toUpperCase() + source.slice(1), color: getStringHashColor(source) };
    return (
        <span className="blast-meta-item blast-meta-item--provenance" style={{ color: meta.color }}>
            <DiscoverySourceSvg source={source} size={size} />
            {meta.label}
        </span>
    );
}

/** @deprecated Use DiscoverySourceChip instead */
export function DiscoverySourceBadge({ source, size = 'sm' }: { source: string; size?: BadgeSize }) {
    return <DiscoverySourceChip source={source} size={size === 'sm' ? 8 : 10} />;
}

/**
 * InfraTechChip — inline icon + label for infrastructure technology.
 * Matches provenance/team chip pattern: small icon, muted text, no pill chrome.
 */
const INFRA_TECH_META: Record<string, { label: string; color: string }> = {
    // Infrastructure
    postgres:      { label: 'Postgres',       color: '#60a5fa' },
    mongodb:       { label: 'MongoDB',        color: '#4ade80' },
    mysql:         { label: 'MySQL',          color: '#fb923c' },
    redis:         { label: 'Redis',          color: '#f87171' },
    kafka:         { label: 'Kafka',          color: '#818cf8' },
    rabbitmq:      { label: 'RabbitMQ',       color: '#fb923c' },
    s3:            { label: 'S3',             color: '#f59e0b' },
    elasticsearch: { label: 'Elastic',        color: '#fbbf24' },
    pubsub:        { label: 'PubSub',         color: '#22d3ee' },
    kubernetes:    { label: 'Kubernetes',     color: '#326ce5' },
    aws:           { label: 'AWS',            color: '#ff9900' },
    gcp:           { label: 'Google Cloud',   color: '#4285f4' },
    graphql:       { label: 'GraphQL',        color: '#e10098' },
    snowflake:     { label: 'Snowflake',      color: '#29b5e8' },
    // Languages — brand colors so the chip reads as the language at a glance
    typescript:    { label: 'TypeScript',     color: '#3178c6' },
    javascript:    { label: 'JavaScript',     color: '#f7df1e' },
    python:        { label: 'Python',         color: '#3776ab' },
    go:            { label: 'Go',             color: '#00add8' },
    golang:        { label: 'Go',             color: '#00add8' },
    php:           { label: 'PHP',            color: '#777bb4' },
    java:          { label: 'Java',           color: '#ed8b00' },
    ruby:          { label: 'Ruby',           color: '#cc342d' },
    rust:          { label: 'Rust',           color: '#dea584' },
    csharp:        { label: 'C#',             color: '#239120' },
    kotlin:        { label: 'Kotlin',         color: '#7f52ff' },
    swift:         { label: 'Swift',          color: '#fa7343' },
    scala:         { label: 'Scala',          color: '#dc322f' },
    elixir:        { label: 'Elixir',         color: '#6e4a7e' },
    // Ecosystems (for EcosystemIcon color lookup)
    npm:           { label: 'npm',            color: '#cb3837' },
    composer:      { label: 'Composer',       color: '#885630' },
    pypi:          { label: 'PyPI',           color: '#3775a9' },
    maven:         { label: 'Maven',          color: '#c71a36' },
    nuget:         { label: 'NuGet',          color: '#004880' },
    rubygems:      { label: 'RubyGems',       color: '#e9573f' },
    docker:        { label: 'Docker',         color: '#2496ed' },
    terraform:     { label: 'Terraform',      color: '#844fba' },
};

function InfraTechSvg({ technology, nodeType, size = 10 }: { technology: string; nodeType?: string; size?: number }) {
    const key = technology.toLowerCase();
    const color = INFRA_TECH_META[key]?.color ?? getStringHashColor(technology);
    const lookupKey = key === 'golang' ? 'go' : key;
    const icon = SIMPLE_ICONS[lookupKey];
    if (icon) {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
                <path d={icon.path} />
            </svg>
        );
    }
    const props = { width: size, height: size, fill: 'none' as const, 'aria-hidden': true as const };
    switch (key) {
        case 's3':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M3 4l1 10h8l1-10" stroke={color} strokeWidth="1.3" strokeLinejoin="round"/>
                    <path d="M2 4h12" stroke={color} strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
            );
        case 'aws':
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <path d="M3 11c2.5 2 6.5 2 9.5 0" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
                    <path d="M11.5 11.5l1.5-.5-.5-1.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M5 6h2M9 6h2" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.7"/>
                </svg>
            );
        default:
            if (nodeType === 'MessageChannel') {
                return (
                    <svg {...props} viewBox="0 0 16 16">
                        <path d="M2 4h12M2 8h12M2 12h12" stroke={color} strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
                        <path d="M5 4l3 4 3-4" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                );
            }
            if (nodeType === 'APIEndpoint') {
                return (
                    <svg {...props} viewBox="0 0 16 16">
                        <path d="M4 8H12M8 4l4 4-4 4" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="3" cy="8" r="1.5" stroke={color} strokeWidth="1.3" />
                    </svg>
                );
            }
            if (nodeType === 'Datastore' || nodeType === 'DataContainer') {
                return (
                    <svg {...props} viewBox="0 0 16 16">
                        <ellipse cx="8" cy="4.5" rx="5" ry="2" stroke={color} strokeWidth="1.3"/>
                        <path d="M3 4.5v7c0 1.1 2.24 2 5 2s5-.9 5-2v-7" stroke={color} strokeWidth="1.3"/>
                    </svg>
                );
            }
            return (
                <svg {...props} viewBox="0 0 16 16">
                    <rect x="3" y="3" width="10" height="10" rx="2" stroke={color} strokeWidth="1.3"/>
                    <circle cx="8" cy="8" r="1.5" stroke={color} strokeWidth="1.3"/>
                </svg>
            );
    }
}

export function EcosystemIcon({ ecosystem, size = 12 }: { ecosystem: string; size?: number }) {
    const key = ECOSYSTEM_ICON_KEY[ecosystem.toLowerCase()];
    const icon = key ? SIMPLE_ICONS[key] : null;
    if (!icon) return null;
    const color = INFRA_TECH_META[key]?.color ?? getStringHashColor(ecosystem);
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden>
            <path d={icon.path} />
        </svg>
    );
}

const TECH_ICON_SCALE: Record<string, number> = { php: 1.35, elixir: 1.2, kotlin: 1.15 };

export function TechIconQuiet({ technology, size = 14 }: { technology: string; size?: number }) {
    const key = technology.toLowerCase();
    const lookupKey = key === 'golang' ? 'go' : key;
    const icon = SIMPLE_ICONS[lookupKey];
    const meta = INFRA_TECH_META[key];
    const label = meta?.label ?? technology.charAt(0).toUpperCase() + technology.slice(1);
    const brandColor = meta?.color ?? getStringHashColor(technology);
    if (!icon) {
        return (
            <SimpleTooltip content={label}>
                <span className="cr-tech-icon-quiet">{label.slice(0, 2)}</span>
            </SimpleTooltip>
        );
    }
    const scale = TECH_ICON_SCALE[lookupKey];
    return (
        <SimpleTooltip content={label}>
            <svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                className="cr-tech-icon-quiet"
                style={{ '--tech-brand': brandColor, transform: scale ? `scale(${scale})` : undefined } as React.CSSProperties}
                aria-hidden
            >
                <path d={icon.path} />
            </svg>
        </SimpleTooltip>
    );
}

export function InfraTechChip({ technology, nodeType, size = 10 }: { technology: string; nodeType?: string; size?: number }) {
    const key = technology.toLowerCase();
    const meta = INFRA_TECH_META[key] ?? { label: technology.charAt(0).toUpperCase() + technology.slice(1), color: getStringHashColor(technology) };
    return (
        <span className="blast-meta-item blast-meta-item--tech" style={{ color: meta.color }}>
            <InfraTechSvg technology={technology} nodeType={nodeType} size={size} />
            {meta.label}
        </span>
    );
}

/** @deprecated Use InfraTechChip instead */
export function InfraTechBadge({ technology, size = 'sm' }: { technology: string; size?: BadgeSize }) {
    return <InfraTechChip technology={technology} size={size === 'sm' ? 8 : 10} />;
}

export type RelColor = 'rel-write' | 'rel-read' | 'rel-call' | 'rel-impl' | 'rel-dep' | 'rel-schema' | 'rel-pub' | 'rel-sub' | 'rel-default';

export function getRelColor(rawRel: string): RelColor {
    const rel = rawRel.toUpperCase();
    if (['PUBLISHES_TO', 'PRODUCES', 'EMITS'].includes(rel))                return 'rel-pub';
    if (['LISTENS_TO', 'CONSUMES', 'SUBSCRIBES', 'ROUTES_TO'].includes(rel)) return 'rel-sub';
    if (['WRITES'].includes(rel))                                           return 'rel-write';
    if (['READS'].includes(rel))                                            return 'rel-read';
    // IMPLEMENTS gets its own color (cyan, echoing APIEndpoint node color)
    // so the user can distinguish "Service implements Endpoint" edges from
    // generic CALLS/SPAWNS behavioral coupling at a glance.
    if (['IMPLEMENTS_ENDPOINT', 'IMPLEMENTS'].includes(rel))                return 'rel-impl';
    if (['CALLS', 'COMMUNICATES_WITH', 'SPAWNS'].includes(rel))             return 'rel-call';
    if (['DEPENDS_ON', 'EXPOSES_API'].includes(rel))                        return 'rel-dep';
    if (['MAPS_TO', 'DEFINES'].includes(rel))                               return 'rel-schema';
    return 'rel-default';
}

export function humanizeRel(rel: string): string {
    const MAP: Record<string, string> = {
        WRITES: 'Writes', READS: 'Reads', CALLS: 'Calls',
        LISTENS_TO: 'Listens', PUBLISHES_TO: 'Publishes',
        CONSUMES: 'Consumes', COMMUNICATES_WITH: 'Communicates',
        SPAWNS: 'Spawns', DEPENDS_ON: 'Depends on', PRODUCES: 'Produces',
        MAPS_TO: 'Defines', DEFINES: 'Defines', ROUTES_TO: 'Routes',
        SUBSCRIBES: 'Subscribes', EMITS: 'Emits',
        EXPOSES_API: 'Exposes', HAS_ENDPOINT: 'Has endpoint',
        IMPLEMENTS_ENDPOINT: 'Implements', IMPLEMENTS: 'Implements',
    };
    return MAP[rel] ?? rel;
}

/**
 * Hex color for each `RelColor` semantic class. Mirrors the CSS variables
 * used by `.blast-rel-badge--*`, but available to inline-styled callers
 * (e.g. SVG strokes, FlowCanvas) that can't use class names.
 */
const REL_COLOR_HEX: Record<RelColor, string> = {
    'rel-write':   '#f87171',  // red — data mutation
    'rel-read':    '#60a5fa',  // blue — safe read
    'rel-call':    '#c084fc',  // purple — behavioral coupling
    'rel-impl':    '#22d3ee',  // cyan  — implements endpoint (matches APIEndpoint node color)
    'rel-pub':     '#facc15',  // amber — fan-out signal (publish/produce/emit)
    'rel-sub':     '#34d399',  // mint  — fan-in consume (listen/consume/subscribe)
    'rel-dep':     '#94a3b8',  // slate — structural dependency
    'rel-schema':  '#2dd4bf',  // teal  — declarative mapping
    'rel-default': '#71717a',  // muted gray — fallback
};

export function relColorHex(rel: string): string {
    return REL_COLOR_HEX[getRelColor(rel)];
}

/**
 * Canonical sort order for rel families. Used so badge clusters render in a
 * stable, predictable sequence everywhere they appear (preview graph,
 * navigator rows, package deps, function panels). Within the same family
 * we fall back to alphabetic so e.g. `READS` and `LISTENS_TO` keep a stable
 * relative order.
 */
const REL_COLOR_ORDER: Record<RelColor, number> = {
    'rel-write':   0,
    'rel-pub':     1,
    'rel-read':    2,
    'rel-sub':     3,
    'rel-call':    4,
    'rel-impl':    5,
    'rel-dep':     6,
    'rel-schema':  7,
    'rel-default': 8,
};

export function compareRels(a: string, b: string): number {
    const ca = REL_COLOR_ORDER[getRelColor(a)];
    const cb = REL_COLOR_ORDER[getRelColor(b)];
    if (ca !== cb) return ca - cb;
    return a.localeCompare(b);
}

export function sortRels(rels: string[]): string[] {
    return [...rels].sort(compareRels);
}

/**
 * Single source of truth for rendering a relationship pill.
 *
 * Variants:
 *   - `full` (default): the verbose chip used in the Functions panel and the
 *     legend — full humanized label, dimmed semitrasparent bg + colored border.
 *   - `letter`: compact 16×16 chip with the first letter of the humanized
 *     label and a tooltip carrying the full text. Used in tight layouts
 *     (side-drawer preview graph, navigator rows). Same color palette as
 *     `full` so the two read as members of the same family.
 *
 * Both variants delegate styling to the `.blast-rel-badge` CSS family
 * (`packages/dashboard-ui/src/styles/impact.css:760+`); component callers
 * stay declarative.
 */
export function RelBadge({ rel, variant = 'full' }: { rel: string; variant?: 'full' | 'letter' }) {
    const human = humanizeRel(rel);
    const colorKey = getRelColor(rel);
    const baseClass = `blast-rel-badge blast-rel-badge--${colorKey}`;

    if (variant === 'letter') {
        const letter = (human[0] ?? rel[0] ?? '?').toUpperCase();
        return (
            <SimpleTooltip content={human} side="top">
                <span aria-label={human} className={`${baseClass} blast-rel-badge--letter`}>
                    {letter}
                </span>
            </SimpleTooltip>
        );
    }

    return <span className={baseClass}>{human}</span>;
}

export const NODE_TYPE_COLORS: Record<string, string> = {
    Service:        '#a78bfa',
    Library:        '#c084fc',
    DataContainer:  '#60a5fa',
    Datastore:      '#818cf8',
    MessageChannel: '#f59e0b',
    APIEndpoint:    '#22d3ee',
    Package:        '#4ade80',
    SystemProcess:  '#f472b6',
};

export function getNodeTypeColor(type: string): string {
    return NODE_TYPE_COLORS[type] ?? '#737373';
}

/**
 * Filter chip bar shared between list and graph views.
 *
 * Both views render the same pill chips with optional counts; this is the
 * single source of truth for that pattern. Callers compute the per-type
 * counts (and optional T2 count) once, then pass them in along with the
 * `activeTypes` set — chips render dimmed when their key is not in
 * `activeTypes`. The 'T2' key is reserved for the transitive toggle.
 */
export function NodeTypeFilterBar({
    types,
    t2Count,
    activeTypes,
    onToggle,
    showCounts = true,
}: {
    types: Array<{ type: string; count: number }>;
    t2Count?: number;
    activeTypes: Set<string>;
    onToggle: (key: string) => void;
    showCounts?: boolean;
}) {
    if (types.length <= 1 && !t2Count) return null;
    return (
        <div className="blast-filter-bar" role="toolbar" aria-label="Filter by node type">
            {t2Count !== undefined && t2Count > 0 && (
                <button
                    key="T2"
                    className={`blast-filter-chip ${activeTypes.has('T2') ? 'blast-filter-chip--active' : ''}`}
                    onClick={() => onToggle('T2')}
                    style={activeTypes.has('T2') ? {
                        borderColor: 'rgba(249, 115, 22, 0.27)',
                        background: 'rgba(249, 115, 22, 0.08)',
                        color: '#f97316',
                    } : undefined}
                    aria-pressed={activeTypes.has('T2')}
                >
                    <span style={{ color: '#f97316', fontSize: '10px', fontWeight: 600, letterSpacing: '0.04em' }}>T2</span>
                    <span>Transitive</span>
                    {showCounts && <span className="blast-filter-chip__count">{t2Count}</span>}
                </button>
            )}
            {types.map(({ type, count }) => {
                const active = activeTypes.has(type);
                const color = getNodeTypeColor(type);
                return (
                    <button
                        key={type}
                        className={`blast-filter-chip ${active ? 'blast-filter-chip--active' : ''}`}
                        onClick={() => onToggle(type)}
                        style={active ? {
                            borderColor: `${color}44`,
                            background: `${color}14`,
                            color,
                        } : undefined}
                        aria-pressed={active}
                    >
                        <NodeIcon type={type} size={10} />
                        <span>{type}</span>
                        {showCounts && <span className="blast-filter-chip__count">{count}</span>}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Single source of truth for the per-node-type icon glyphs.
 *
 * Both `NodeIcon` (React) and `appendNodeIconToSvg` (D3) read from this
 * registry. Add new icons here ONCE; they automatically surface in both
 * rendering pipelines.
 *
 * Each shape is a small structural descriptor — kept intentionally close
 * to raw SVG primitives so neither consumer needs to do anything clever.
 */
export type IconShape =
    | { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number; sw?: number }
    | { kind: 'circle'; cx: number; cy: number; r: number; sw?: number }
    | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; sw?: number }
    | { kind: 'path'; d: string; sw?: number; cap?: 'round' | 'butt' | 'square'; join?: 'round' | 'miter' | 'bevel'; opacity?: number };

export interface NodeIconDef {
    /** Native viewBox edge — used to scale into the consumer's chosen size. */
    viewBoxSize: number;
    shapes: IconShape[];
}

const NODE_ICON_REGISTRY: Record<string, NodeIconDef> = {
    Service: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'rect', x: 1, y: 1, w: 12, h: 12, rx: 3, sw: 1.5 },
            { kind: 'path', d: 'M4 7h6M7 4v6', sw: 1.5, cap: 'round' },
        ],
    },
    Library: {
        // Open book: the conventional "library" glyph in dev tooling (JetBrains,
        // Lucide). The open silhouette keeps it distinct from the Backstage
        // discovery source, which is a closed book (see DiscoverySourceSvg,
        // case 'backstage'), and reads cleanly down to the 10px filter chip.
        // Geometry fills ~82% of the 16u box so its optical weight matches the
        // other node glyphs (Service/Package fill their own boxes to a similar degree).
        viewBoxSize: 16,
        shapes: [
            { kind: 'path', d: 'M8 3.8 C5.4 2.3 3.1 2.1 1.4 2.5 L1.4 12.8 C3.1 12.4 5.4 12.7 8 14.2', sw: 1.5, cap: 'round', join: 'round' },   // left page
            { kind: 'path', d: 'M8 3.8 C10.6 2.3 12.9 2.1 14.6 2.5 L14.6 12.8 C12.9 12.4 10.6 12.7 8 14.2', sw: 1.5, cap: 'round', join: 'round' }, // right page
            { kind: 'path', d: 'M8 3.8 V14.2', sw: 1.3, cap: 'round', opacity: 0.55 },                                                            // spine
        ],
    },
    DataContainer: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'rect', x: 1, y: 1, w: 12, h: 12, rx: 2, sw: 1.5 },
            { kind: 'path', d: 'M1 5h12M5 5v8', sw: 1.25 },
        ],
    },
    MessageChannel: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'path', d: 'M2 3h10a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1z', sw: 1.5 },
            { kind: 'path', d: 'M1.5 3.5l5.5 4 5.5-4', sw: 1.25, cap: 'round' },
        ],
    },
    APIEndpoint: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'circle', cx: 7, cy: 7, r: 5.5, sw: 1.5 },
            { kind: 'path', d: 'M4 7c0-2 1-3.5 3-4.5M10 7c0 2-1 3.5-3 4.5M2 7h10', sw: 1.2, cap: 'round' },
        ],
    },
    Package: {
        viewBoxSize: 16,
        shapes: [
            { kind: 'path', d: 'M2 5l6-3 6 3v6l-6 3-6-3V5z', sw: 1.3, join: 'round' },
            { kind: 'path', d: 'M2 5l6 3 6-3M8 8v6', sw: 1.2, cap: 'round', opacity: 0.6 },
        ],
    },
    Datastore: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'ellipse', cx: 7, cy: 4, rx: 5, ry: 2.5, sw: 1.5 },
            { kind: 'path', d: 'M2 4v6c0 1.38 2.24 2.5 5 2.5s5-1.12 5-2.5V4', sw: 1.5 },
            { kind: 'path', d: 'M2 7c0 1.38 2.24 2.5 5 2.5S12 8.38 12 7', sw: 1.25 },
        ],
    },
    SystemProcess: {
        viewBoxSize: 14,
        shapes: [
            { kind: 'circle', cx: 7, cy: 7, r: 2, sw: 1.5 },
            { kind: 'path', d: 'M7 1v2M7 11v2M1 7h2M11 7h2M2.93 2.93l1.41 1.41M9.66 9.66l1.41 1.41M9.66 4.34L11.07 2.93M2.93 11.07l1.41-1.41', sw: 1.5, cap: 'round' },
        ],
    },
};

/** Fallback shape used when a type isn't in the registry. */
const DEFAULT_NODE_ICON: NodeIconDef = {
    viewBoxSize: 14,
    shapes: [{ kind: 'circle', cx: 7, cy: 7, r: 5.5, sw: 1.5 }],
};

export function getNodeIconDef(type: string): NodeIconDef {
    return NODE_ICON_REGISTRY[type] ?? DEFAULT_NODE_ICON;
}

/** Render an icon shape as JSX (used by `NodeIcon`). */
function shapeToJsx(s: IconShape, color: string, key: number): JSX.Element {
    switch (s.kind) {
        case 'rect':
            return <rect key={key} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.rx} stroke={color} strokeWidth={s.sw ?? 1.4} fill="none" />;
        case 'circle':
            return <circle key={key} cx={s.cx} cy={s.cy} r={s.r} stroke={color} strokeWidth={s.sw ?? 1.4} fill="none" />;
        case 'ellipse':
            return <ellipse key={key} cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} stroke={color} strokeWidth={s.sw ?? 1.4} fill="none" />;
        case 'path':
            return <path key={key} d={s.d} stroke={color} strokeWidth={s.sw ?? 1.4} strokeLinecap={s.cap} strokeLinejoin={s.join} fill="none" opacity={s.opacity} />;
    }
}

/**
 * D3-friendly helper — appends the icon shapes for `type` into an existing
 * SVG `<g>` element, centered at (x, y), scaled to `size`.
 *
 * Lives next to the React `NodeIcon` so both render the SAME glyphs from the
 * SAME registry. Don't duplicate paths in callers.
 */
export function appendNodeIconToSvg(
    parent: SVGGElement,
    type: string,
    x: number,
    y: number,
    size: number,
    strokeWidthOverride?: number,
    colorOverride?: string,
): void {
    const def = getNodeIconDef(type);
    const color = colorOverride ?? getNodeTypeColor(type);
    const scale = size / def.viewBoxSize;
    const ns = 'http://www.w3.org/2000/svg';

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('transform', `translate(${x - size / 2}, ${y - size / 2}) scale(${scale})`);
    g.setAttribute('pointer-events', 'none');

    for (const s of def.shapes) {
        const sw = (strokeWidthOverride !== undefined ? strokeWidthOverride : (s.sw ?? 1.4)).toString();
        if (s.kind === 'rect') {
            const el = document.createElementNS(ns, 'rect');
            el.setAttribute('x', String(s.x));
            el.setAttribute('y', String(s.y));
            el.setAttribute('width', String(s.w));
            el.setAttribute('height', String(s.h));
            if (s.rx !== undefined) el.setAttribute('rx', String(s.rx));
            el.setAttribute('stroke', color);
            el.setAttribute('stroke-width', sw);
            el.setAttribute('fill', 'none');
            g.appendChild(el);
        } else if (s.kind === 'circle') {
            const el = document.createElementNS(ns, 'circle');
            el.setAttribute('cx', String(s.cx));
            el.setAttribute('cy', String(s.cy));
            el.setAttribute('r', String(s.r));
            el.setAttribute('stroke', color);
            el.setAttribute('stroke-width', sw);
            el.setAttribute('fill', 'none');
            g.appendChild(el);
        } else if (s.kind === 'ellipse') {
            const el = document.createElementNS(ns, 'ellipse');
            el.setAttribute('cx', String(s.cx));
            el.setAttribute('cy', String(s.cy));
            el.setAttribute('rx', String(s.rx));
            el.setAttribute('ry', String(s.ry));
            el.setAttribute('stroke', color);
            el.setAttribute('stroke-width', sw);
            el.setAttribute('fill', 'none');
            g.appendChild(el);
        } else if (s.kind === 'path') {
            const el = document.createElementNS(ns, 'path');
            el.setAttribute('d', s.d);
            el.setAttribute('stroke', color);
            el.setAttribute('stroke-width', sw);
            el.setAttribute('fill', 'none');
            if (s.cap) el.setAttribute('stroke-linecap', s.cap);
            if (s.join) el.setAttribute('stroke-linejoin', s.join);
            if (s.opacity !== undefined) el.setAttribute('opacity', String(s.opacity));
            g.appendChild(el);
        }
    }

    parent.appendChild(g);
}

export function NodeIcon({ type, size = 13 }: { type: string; size?: number }) {
    const def = getNodeIconDef(type);
    const color = getNodeTypeColor(type);
    return (
        <SimpleTooltip content={type} delayDuration={400}>
            <span className="node-type-icon" aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center' }}>
                <svg width={size} height={size} viewBox={`0 0 ${def.viewBoxSize} ${def.viewBoxSize}`} fill="none">
                    {def.shapes.map((s, i) => shapeToJsx(s, color, i))}
                </svg>
            </span>
        </SimpleTooltip>
    );
}

/**
 * TeamIcon — single owner. Head + shoulders arc.
 * Matches Vercel / Linear style: proportioned, compact, clean at 9–14px.
 */
export function TeamIcon({ size = 10 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            {/* Head */}
            <circle cx="8" cy="5" r="2.75" stroke="currentColor" strokeWidth="1.4"/>
            {/* Shoulders / body arc */}
            <path
                d="M2.5 14c0-3.04 2.46-5.5 5.5-5.5s5.5 2.46 5.5 5.5"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
            />
        </svg>
    );
}

/**
 * TeamsIcon — group / multiple owners.
 * Lucide-style "users" in a square 24×24 viewBox — no aspect-ratio distortion.
 * Back person faded, front person full opacity. Crisp at 10–14 px.
 */
export function TeamsIcon({ size = 12 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {/* Back person — offset right, faded */}
            <circle cx="17" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.8" opacity="0.45"/>
            <path d="M21 21c0-2.5-1.8-4.5-4-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.45"/>
            {/* Front person */}
            <circle cx="9" cy="7.5" r="3.5" stroke="currentColor" strokeWidth="1.8"/>
            <path d="M2 21c0-3.5 2.8-6.5 7-6.5s7 3 7 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
    );
}

// ─── Structural / Infra Icons ─────────────────────────────────────────────────

/** ContainerIcon — stacked layers representing a container image. */
export function ContainerIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M1 5.5L8 2l7 3.5L8 9 1 5.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            <path d="M1 8l7 3.5L15 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M1 10.5L8 14l7-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
    );
}

/** ToolConfigIcon — horizontal sliders / settings. */
export function ToolConfigIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <circle cx="5" cy="4" r="1.5" fill="var(--bg-primary, #1a1a1a)" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="10" cy="8" r="1.5" fill="var(--bg-primary, #1a1a1a)" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="7" cy="12" r="1.5" fill="var(--bg-primary, #1a1a1a)" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
    );
}

/** TaskIcon — list with a check mark. */
export function TaskIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4h7M2 8h5M2 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M11 10l1.5 1.5L15 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
    );
}

/** CiPipelineIcon — workflow nodes connected in a pipeline. */
export function CiPipelineIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="3" cy="4" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="3" cy="12" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="12" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M5 4.5l5 2.5M5 11.5l5-2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
    );
}

/** ExternalLinkIcon — arrow pointing out of a box. */
export function ExternalLinkIcon({ size = 11 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M5.5 2.5H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M8 2h4v4M12 2 6.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
    );
}

/** AgentIcon — crosshair / target representing an AI agent. */
export function AgentIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
    );
}

/** RepositoryIcon — git branch graph representing a code repository. */
export function RepositoryIcon({ size = 18 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="5" cy="16" r="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="15" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 6v8M15 6c0 3-2 4-7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

/** ServiceIcon — square with an outgoing endpoint. */
export function ServiceIcon({ size = 18 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 10h6M10 7v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    );
}

