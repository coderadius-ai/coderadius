import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const router = new Router();

// Held-out generalization fixture: a DIFFERENT resource (shipments), a custom
// param name (:trackingId), a mid-path param, and a different filename (app.ts).
// Proves the extractor is not memorizing `id`/`orders`/`server.ts`.
router.get('/shipments', (ctx) => {
    ctx.body = [{ trackingId: 'trk_1', status: 'created' }];
});

router.post('/shipments', (ctx) => {
    ctx.body = { trackingId: 'trk_1', created: true };
});

router.get('/shipments/:trackingId', (ctx) => {
    ctx.body = { trackingId: ctx.params.trackingId, status: 'created' };
});

// Param in the MIDDLE of a nested path — exercises multi-segment lossless
// normalization (:trackingId → {trackingId}, static `status` preserved).
router.put('/shipments/:trackingId/status', (ctx) => {
    ctx.body = { trackingId: ctx.params.trackingId, status: 'in_transit' };
});

app.use(router.routes());
app.use(router.allowedMethods());
app.listen(3001);
