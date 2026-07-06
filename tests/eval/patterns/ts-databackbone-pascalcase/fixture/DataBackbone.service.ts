import { DataBackboneClient } from '@apps/event-consumer/core/databackbone/DataBackboneClient';

// Simulate a globally injected config or external import that the LLM cannot resolve
declare const DATABACKBONE_CONFIG: { QUOTE_REQUEST: string };

export class DataBackBoneService {
    constructor(private readonly client: DataBackboneClient) {}

    public async publishQuoteRequest(payload: any) {
        // The LLM cannot resolve this, so it will extract "DATABACKBONE_CONFIG.QUOTE_REQUEST"
        await this.client.publish(DATABACKBONE_CONFIG.QUOTE_REQUEST, payload);
    }
}
