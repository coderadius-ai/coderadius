import express from 'express';

// express.Router() — the second idiomatic Express routing form. Sink-free
// handlers (return a literal object) keep routing measurable with zero LLM calls.
export const router = express.Router();

router.get('/items/:sku', (req, res) => {
    res.json({ sku: req.params.sku, inStock: true });
});

router.post('/items', (req, res) => {
    res.json({ sku: 'sku_1', created: true });
});
