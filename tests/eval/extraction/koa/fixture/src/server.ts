import Koa from 'koa';
import Router from '@koa/router';

const app = new Koa();
const router = new Router();

// @koa/router shorthand: router.<method>('/path', handler). Same call shape as
// Express/Fastify, but the receiver is the `@koa/router` instance, not `app`.
// Handlers are sink-free (assign a literal to ctx.body) → deterministic, no LLM.
router.get('/orders', (ctx) => {
    ctx.body = [{ id: 'ord_1', status: 'pending' }];
});

router.get('/orders/:id', (ctx) => {
    ctx.body = { id: ctx.params.id, status: 'pending' };
});

router.post('/orders', (ctx) => {
    ctx.body = { id: 'ord_1', created: true };
});

router.patch('/orders/:id', (ctx) => {
    ctx.body = { id: ctx.params.id, updated: true };
});

router.delete('/orders/:id', (ctx) => {
    ctx.body = { id: ctx.params.id, deleted: true };
});

// Router wiring — app.use(...) / router.routes() are not route registrations
// and must NOT surface as endpoints.
app.use(router.routes());
app.use(router.allowedMethods());
app.listen(3000);
