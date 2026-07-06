import { run } from '../src/graph/mutations/_run.js';
import { closeNeo4j } from '../src/graph/neo4j.js';
import { normalizeHost } from '../src/ingestion/processors/physical-fingerprint.js';

type Broker = {
    id: string;
    provider: string;
    host: string;
    port?: number;
    vhost?: string;
    fingerprintScope?: string;
    repoScope?: string;
};

function readFlag(name: string): string | undefined {
    const prefix = `${name}=`;
    const inline = process.argv.slice(2).find(arg => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1];
    return undefined;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(name);
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object' && 'toNumber' in value) {
        return (value as { toNumber: () => number }).toNumber();
    }
    return undefined;
}

function groupKey(b: Broker): string {
    const scope = b.fingerprintScope === 'repo' ? 'repo' : 'global';
    return JSON.stringify([
        b.provider,
        normalizeHost(b.host),
        b.port ?? '',
        b.vhost ?? '',
        scope,
        scope === 'repo' ? (b.repoScope ?? '') : '',
    ]);
}

const providerFilter = readFlag('--provider');
const hostFilter = readFlag('--host');
const showAll = hasFlag('--all');
const json = hasFlag('--json');
const strict = hasFlag('--strict');

try {
    const result = await run(
        `MATCH (b:MessageBroker)
         WHERE b.valid_to_commit IS NULL
           AND b.host IS NOT NULL
           AND ($provider IS NULL OR b.provider = $provider)
           AND ($host IS NULL OR b.host = $host)
         RETURN b.id AS id,
                b.provider AS provider,
                b.host AS host,
                b.port AS port,
                b.vhost AS vhost,
                b.fingerprintScope AS fingerprintScope,
                b.repoScope AS repoScope
         ORDER BY provider, host, port, vhost, id`,
        { provider: providerFilter ?? null, host: hostFilter ?? null },
    );

    const groups = new Map<string, Broker[]>();
    for (const rec of result.records) {
        const broker: Broker = {
            id: rec.get('id') as string,
            provider: rec.get('provider') as string,
            host: rec.get('host') as string,
            port: toNumber(rec.get('port')),
            vhost: (rec.get('vhost') as string | null) ?? undefined,
            fingerprintScope: (rec.get('fingerprintScope') as string | null) ?? undefined,
            repoScope: (rec.get('repoScope') as string | null) ?? undefined,
        };
        const group = groups.get(groupKey(broker)) ?? [];
        group.push(broker);
        groups.set(groupKey(broker), group);
    }

    const rows = [...groups.values()]
        .filter(group => showAll || group.length > 1)
        .map(group => ({
            count: group.length,
            provider: group[0].provider,
            host: normalizeHost(group[0].host),
            port: group[0].port ?? null,
            vhost: group[0].vhost ?? null,
            fingerprintScope: group[0].fingerprintScope ?? 'global',
            repoScope: group[0].repoScope ?? null,
            ids: group.map(b => b.id),
        }));

    if (json) {
        console.log(JSON.stringify({ duplicateGroups: rows.filter(r => r.count > 1), groups: rows }, null, 2));
    } else if (rows.length === 0) {
        console.log('No duplicate live MessageBroker identity groups.');
    } else {
        for (const row of rows) {
            console.log(`${row.count} broker(s): ${row.provider} ${row.host}:${row.port ?? ''} vhost=${row.vhost ?? ''} scope=${row.fingerprintScope}${row.repoScope ? ` repo=${row.repoScope}` : ''}`);
            for (const id of row.ids) console.log(`  ${id}`);
        }
    }

    if (strict && rows.some(row => row.count > 1)) {
        process.exitCode = 1;
    }
} finally {
    await closeNeo4j();
}
