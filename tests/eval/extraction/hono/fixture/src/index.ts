import { Hono } from 'hono';

const app = new Hono();

// Idiomatic Hono shorthand routing: const app = new Hono(); app.<method>(path, c => ...).
// Handlers are SINK-FREE (c.json over a literal, only a path-param read) so the
// endpoints are detected by the static route extractor with zero LLM calls.
app.get('/orders/:id', (c) => {
    const id = c.req.param('id');
    return c.json({ id, status: 'pending' });
});

app.post('/orders', (c) => {
    return c.json({ id: 'ord_1', status: 'created' }, 201);
});

app.delete('/orders/:id', (c) => {
    const id = c.req.param('id');
    return c.json({ id, deleted: true });
});

export default app;
