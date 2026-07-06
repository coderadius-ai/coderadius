import express from 'express';
import { router } from './items.router.js';

const app = express();

// Shorthand route methods on the express() app (Express's primary idiom).
app.get('/orders/:id', (req, res) => {
    res.json({ id: req.params.id, status: 'pending' });
});

app.post('/orders', (req, res) => {
    res.json({ id: 'ord_1', created: true });
});

app.put('/orders/:id', (req, res) => {
    res.json({ id: req.params.id, updated: true });
});

app.delete('/orders/:id', (req, res) => {
    res.json({ id: req.params.id, deleted: true });
});

// Router root-mounted (no path prefix), so each router path IS the exposed
// path — the golden stays grounded in the endpoints Express actually serves.
app.use(router);

app.listen(3000);
