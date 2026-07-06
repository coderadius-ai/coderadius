import Fastify from 'fastify';

const app = Fastify();

// Shorthand route methods (same call shape as Express).
app.get('/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { id, status: 'pending' };
});

app.post('/orders', async (req) => {
    const body = req.body as { item: string; qty: number };
    return { id: 'ord_1', item: body.item, qty: body.qty };
});

app.put('/orders/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { id, updated: true };
});

// Object form — Fastify-specific (not Express). Explicitly deferred in
// route-extractor.ts V1, so this is the gap the coverage loop must close.
app.route({
    method: 'DELETE',
    url: '/orders/:id',
    handler: async (req) => {
        const { id } = req.params as { id: string };
        return { id, deleted: true };
    },
});

app.listen({ port: 3000 });
