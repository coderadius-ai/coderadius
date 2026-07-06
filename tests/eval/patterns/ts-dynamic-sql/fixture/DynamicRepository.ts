export class DynamicRepository {
    private db: any;

    async fetchTenantData(tenantId: string) {
        // Drizzle-like or raw string interpolation
        const query = `SELECT * FROM tenant_data_${tenantId} WHERE active = 1`;
        return await this.db.query(query);
    }

    async saveRegionalSales(region: string, data: any) {
        // Kysely-like or template literal
        const tableName = `regional_sales_${region}`;
        await this.db.insertInto(tableName).values(data).execute();
    }
}
