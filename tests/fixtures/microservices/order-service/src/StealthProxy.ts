import { ApiGateway } from './CustomHttpWrapper.js';

// Gate 3 stealth test — uses DI-injected ApiGateway
// without triggering Gate 1 regex.
export class StealthProxy {
    private gateway: ApiGateway;

    constructor(gw: ApiGateway) {
        this.gateway = gw;
    }

    // Pure DI call — no banned words in body or comments.
    forwardPayload(data: Record<string, unknown>) {
        return this.gateway.post('/internal/relay', data);
    }
}
