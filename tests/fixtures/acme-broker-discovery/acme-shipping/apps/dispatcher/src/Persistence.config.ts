// Anonymised fixture: a DB-shaped typed config in the SAME service. No file
// co-imports this together with the broker-client package, so the s2 lane
// must NOT turn the database host into a broker candidate.
import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
    SHIP_DB_HOST: z.string(),
    SHIP_DB_NAME: z.string(),
    SHIP_DB_PORT: z.string().optional(),
});

export const persistenceConfig = registerAs('persistence', () => schema.parse(process.env));
