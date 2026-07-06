import { MongoClient } from 'mongodb';

export class EventRepository {
    constructor(private readonly client: MongoClient) {}

    async findEvents(type: string, tenantId: number) {
        const tablePrefix = type === 'system' ? 'user' : 'system';
        const collection = this.client.db('metrics').collection(`event_${tablePrefix}`);
        
        return collection.find({ tenantId }).toArray();
    }
}
