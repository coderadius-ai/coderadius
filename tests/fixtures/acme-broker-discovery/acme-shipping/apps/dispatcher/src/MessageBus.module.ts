// Anonymised fixture: the CO-IMPORT that proves the config↔sink association.
// This file imports BOTH the declared broker-client package AND the typed
// config module — the structural gate for s2 emission.
import { messageBus } from '@acme/wire';
import { messageBusConfig } from './MessageBus.config';

export const messageBusProvider = {
    provide: Symbol.for('MESSAGE_BUS'),
    inject: [messageBusConfig.KEY],
    useFactory: (cfg: { SHIP_BUS_HOSTNAME: string; SHIP_BUS_VHOST: string }) =>
        messageBus({ hostname: cfg.SHIP_BUS_HOSTNAME, vhost: cfg.SHIP_BUS_VHOST }),
};
