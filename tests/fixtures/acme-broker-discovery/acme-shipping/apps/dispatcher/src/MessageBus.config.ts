// Anonymised fixture: typed NestJS config reading broker connection details
// from env vars with ARBITRARY names (no RABBITMQ_* prefix anywhere).
import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
    SHIP_BUS_HOSTNAME: z.string(),
    SHIP_BUS_VHOST: z.string(),
    SHIP_BUS_PORT: z.string().optional(),
    SHIP_BUS_USER: z.string(),
    SHIP_BUS_PASSWORD: z.string(),
});

export const messageBusConfig = registerAs('messageBus', () => schema.parse(process.env));
