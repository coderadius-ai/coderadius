import { Hono } from 'hono';

const app = new Hono();

// Held-out generalization: a DIFFERENT resource, param name (:sku, not :id),
// methods (GET/PUT/PATCH), a bare collection route, and a param in the MIDDLE
// of a nested path. Still sink-free for deterministic LLM-free routing.
app.get('/inventory', (c) => {
    return c.json({ items: [] });
});

app.get('/inventory/:sku', (c) => {
    const sku = c.req.param('sku');
    return c.json({ sku, available: true });
});

app.put('/inventory/:sku', (c) => {
    const sku = c.req.param('sku');
    return c.json({ sku, updated: true });
});

app.patch('/inventory/:sku/restock', (c) => {
    const sku = c.req.param('sku');
    return c.json({ sku, restocked: true });
});

export default app;
