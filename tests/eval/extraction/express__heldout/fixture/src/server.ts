import express from 'express';
import { router } from './shipments.router.js';

const app = express();

// Same Express idioms as the primary fixture, different routes/resources and a
// verb (PATCH) the primary set does not exercise.
app.get('/payments/:paymentId', (req, res) => {
    res.json({ paymentId: req.params.paymentId, status: 'captured' });
});

app.post('/payments', (req, res) => {
    res.json({ paymentId: 'pay_1', created: true });
});

app.patch('/payments/:paymentId', (req, res) => {
    res.json({ paymentId: req.params.paymentId, status: 'refunded' });
});

app.use(router);

app.listen(3000);
