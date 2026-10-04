const express = require('express');
const { createClient } = require('redis');
const { connect, publish, subscribe } = require('./events');
const { client, log, requestMw, metricsHandler, ah, httpError, errorMw, shutdown } = require('./common')('shipping-service');
const { STAGES, trackingNumber, carrierFor, nextStage, etaDate, canCancel } = require('./tracking');

const STEP_SEC = Number(process.env.STEP_SEC || 10);   // demo: seconds between tracking stages
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => log.error('redis', { err: e.message }));
const shipped = new client.Counter({ name: 'shopmesh_shipment_stage_total', help: 'Shipment stage changes', labelNames: ['status'] });
let ch;

const key = (id) => `ship:${id}`;
const DUE = 'ship:due';   // sorted set: orderId scored by next-advance time -> safe with several replicas

const app = express();
app.use(requestMw);
app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);

// customer tracking page: GET /api/shipments/:orderId (gateway adds x-user-id from the JWT)
app.get('/shipments/:orderId', ah(async (req, res) => {
  const u = req.headers['x-user-id'];
  if (!u) throw httpError(401, 'unauthorized');
  const s = /^\d+$/.test(req.params.orderId) ? await redis.get(key(req.params.orderId)) : null;
  const sh = s && JSON.parse(s);
  if (!sh || String(sh.userId) !== String(u)) throw httpError(404, 'no shipment for this order yet');
  res.json(sh);
}));
app.use((_q, _s, next) => next(httpError(404, 'not found')));
app.use(errorMw);

async function createShipment(evt) {
  const k = key(evt.orderId);
  if (await redis.exists(k)) return;   // redelivered payment.completed -> same shipment
  const now = new Date();
  const sh = {
    orderId: evt.orderId, userId: evt.userId, carrier: carrierFor(evt.orderId), trackingNumber: trackingNumber(evt.orderId),
    status: STAGES[0].status, eta: etaDate(now), createdAt: now.toISOString(),
    events: [{ status: STAGES[0].status, at: now.toISOString(), note: STAGES[0].note }],
  };
  if (!(await redis.set(k, JSON.stringify(sh), { NX: true, EX: 90 * 86400 }))) return;
  await redis.zAdd(DUE, { score: Date.now() + STEP_SEC * 1000, value: String(evt.orderId) });
  await publish(ch, 'shipment.created', { orderId: sh.orderId, userId: sh.userId, trackingNumber: sh.trackingNumber, carrier: sh.carrier, eta: sh.eta });
  shipped.inc({ status: sh.status });
  log.info('shipment created', { order_id: sh.orderId, tracking: sh.trackingNumber, carrier: sh.carrier });
}

async function cancelShipment(evt) {
  const k = key(evt.orderId); const s = await redis.get(k);
  if (!s) return;
  const sh = JSON.parse(s);
  if (!canCancel(sh.status)) return log.warn('too late to cancel shipment', { order_id: sh.orderId, status: sh.status });
  sh.status = 'CANCELLED'; sh.events.push({ status: 'CANCELLED', at: new Date().toISOString(), note: 'Shipment cancelled with the order' });
  await redis.set(k, JSON.stringify(sh), { XX: true, KEEPTTL: true });
  await redis.zRem(DUE, String(sh.orderId));
  log.info('shipment cancelled', { order_id: sh.orderId });
}

async function advanceDue() {
  const ids = await redis.zRangeByScore(DUE, 0, Date.now(), { LIMIT: { offset: 0, count: 20 } });
  for (const id of ids) {
    if (!(await redis.zRem(DUE, id))) continue;          // another replica took it
    const s = await redis.get(key(id)); if (!s) continue;
    const sh = JSON.parse(s); const next = nextStage(sh.status);
    if (!next) continue;
    sh.status = next.status; sh.events.push({ status: next.status, at: new Date().toISOString(), note: next.note });
    await redis.set(key(id), JSON.stringify(sh), { XX: true, KEEPTTL: true });
    if (next.event) await publish(ch, next.event, { orderId: sh.orderId, userId: sh.userId, trackingNumber: sh.trackingNumber, carrier: sh.carrier });
    if (nextStage(next.status)) await redis.zAdd(DUE, { score: Date.now() + STEP_SEC * 1000, value: String(id) });
    shipped.inc({ status: next.status });
    log.info('shipment update', { order_id: sh.orderId, status: next.status });
  }
}

(async () => {
  await redis.connect();
  ch = await connect();
  await subscribe(ch, 'shipping-service.orders', ['payment.completed', 'order.cancelled'], async (k, evt) => {
    if (k === 'payment.completed') await createShipment(evt); else await cancelShipment(evt);
  });
  const tick = async () => { try { await advanceDue(); } catch (e) { log.error('shipping tick failed', { err: e.message }); } setTimeout(tick, 2000).unref?.(); };
  tick();
  const port = process.env.PORT || 3006;
  const server = app.listen(port, () => log.info('shipping-service listening', { port }));
  shutdown(server, () => redis.quit());
})();
