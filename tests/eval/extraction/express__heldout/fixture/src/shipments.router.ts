import express from 'express';

export const router = express.Router();

router.get('/shipments/:trackingId', (req, res) => {
    res.json({ trackingId: req.params.trackingId, delivered: false });
});

router.delete('/shipments/:trackingId', (req, res) => {
    res.json({ trackingId: req.params.trackingId, cancelled: true });
});
