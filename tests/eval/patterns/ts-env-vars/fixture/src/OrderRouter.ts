import express from 'express';
import { createOrder, getOrderStatus } from './OrderController.js';

const router = express.Router();

router.post('/orders', async (req, res) => {
    const order = await createOrder(req.body.customerId, req.body.items);
    res.json(order);
});

router.get('/orders/:id', async (req, res) => {
    const status = await getOrderStatus(req.params.id);
    res.json(status);
});

router.post('/orders/forward-webhook', async (req, res) => {
    // Destructure known fields, rest is dynamic passthrough
    const { merchant_id, ...forwardData } = req.body;

    // @ts-ignore
    const result = await import('./OrderController.js').then(m => m.forwardToFulfillment(forwardData));
    res.json({ merchant_id, status: 'forwarded' });
});

export default router;

// Taint for cache bypass 2
