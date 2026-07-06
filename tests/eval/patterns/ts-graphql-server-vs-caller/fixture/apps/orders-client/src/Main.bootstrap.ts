import http from 'node:http';
import { initOrder } from './client';

async function bootstrap() {
    const server = http.createServer(async (_req, res) => {
        await initOrder({ sku: 'SKU-1', quantity: 2 });
        res.end('ok');
    });
    server.listen(8080);
}

bootstrap();
