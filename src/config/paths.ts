import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), '.coderadius');

export const paths = {
    root: ROOT,

    config: {
        dir: path.join(ROOT, 'config'),
        settings: path.join(ROOT, 'config', 'settings.json'),
        credentials: path.join(ROOT, 'config', 'credentials.json'),
        gcpServiceAccount: path.join(ROOT, 'config', 'gcp-service-account.json'),
    },

    data: {
        dir: path.join(ROOT, 'data'),
        memgraph: path.join(ROOT, 'data', 'memgraph'),
        memgraphLogs: path.join(ROOT, 'data', 'memgraph-logs'),
    },

    cache: {
        dir: path.join(ROOT, 'cache'),
        embeddings: path.join(ROOT, 'cache', 'embeddings.json'),
        updateCheck: path.join(ROOT, 'cache', 'update-check.json'),
        osv: path.join(ROOT, 'cache', 'osv'),
        sinkClassifier: path.join(ROOT, 'cache', 'sink-classifier'),
        sinkClassifierSnapshot: path.join(ROOT, 'cache', 'sink-classifier-snapshot'),
        datastoreAssignments: path.join(ROOT, 'cache', 'datastore-assignments.jsonl'),
    },

    sandbox: path.join(ROOT, 'sandbox'),

    traces: path.join(ROOT, 'traces'),

    logs: {
        dir: path.join(ROOT, 'logs'),
        sinkClassifierAudit: path.join(ROOT, 'logs', 'sink-classifier-audit.jsonl'),
    },
} as const;
