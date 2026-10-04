const express = require('express');
const { createClient } = require('redis');
const { connect, subscribe } = require('./events');
const { log, requestMw, metricsHandler, ah, errorMw, shutdown } = require('./common')('notification-worker');

const USER_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => log.error('redis', { err: e.message }));
const inr = (c) => '₹' + ((c || 0) / 100).toLocaleString('en-IN');

// event -> what the customer reads (in-app inbox + mock e-mail)
const TEMPLATES = {
  'order.created': (e) => ({ title: `Order #${e.orderId} placed`, body: `We received your order of ${inr(e.totalCents)}. Waiting for payment confirmation.` }),
  'payment.completed': (e) => ({ title: `Payment received for order #${e.orderId}`, body: `${inr(e.amountCents)} paid${e.paymentId ? ` (${e.paymentId})` : ''}. We are packing your items.` }),
  'payment.failed': (e) => ({ title: `Payment failed for order #${e.orderId}`, body: `Reason: ${String(e.reason || 'unknown').replace(/_/g, ' ')}. Items were released; you can place the order again.` }),
  'payment.refunded': (e) => ({ title: `Refund issued for order #${e.orderId}`, body: `${inr(e.amountCents)} is on its way back to your payment method.` }),
  'order.cancelled': (e) => ({ title: `Order #${e.orderId} cancelled`, body: e.wasPaid ? 'Your refund has been initiated.' : 'No charge was made.' }),
  'order.shipped': (e) => ({ title: `Order #${e.orderId} shipped`, body: e.trackingNumber ? `Your package is on the way with ${e.carrier}. Tracking: ${e.trackingNumber}.` : 'Your package is on the way.' }),
  'shipment.created': (e) => ({ title: `Order #${e.orderId} is being prepared`, body: `Tracking ${e.trackingNumber} (${e.carrier}). Estimated delivery ${e.eta}.` }),
  'order.delivered': (e) => ({ title: `Order #${e.orderId} delivered`, body: 'Enjoy! You can now review the products you bought.' }),
};

async function lookupEmail(userId) {
  try {   // /users/:id is internal-only (the gateway does not expose it)
    const r = await fetch(`${USER_URL}/users/${userId}`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.json()).email : null;
  } catch { return null; }
}

const app = express();
app.use(requestMw);
app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);

// in-app inbox (gateway: GET /api/notifications, POST /api/notifications/read)
app.get('/notifications', ah(async (req, res) => {
  const u = req.headers['x-user-id'];
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const items = (await redis.lRange(`notif:${u}`, 0, 29)).map((s) => JSON.parse(s));
  const seen = Number(await redis.get(`notif:${u}:seen`)) || 0;
  res.json({ unread: items.filter((n) => Date.parse(n.at) > seen).length, items });
}));
app.post('/notifications/read', ah(async (req, res) => {
  const u = req.headers['x-user-id'];
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  await redis.set(`notif:${u}:seen`, String(Date.now()));
  res.status(204).end();
}));
app.use(errorMw);

(async () => {
  await redis.connect();
  const ch = await connect();
  await subscribe(ch, 'notification-worker.all', ['order.*', 'payment.*', 'shipment.*'], async (key, evt, meta) => {
    const tpl = TEMPLATES[key];
    if (!tpl || !evt.userId) return;
    // redelivered message -> do not notify twice
    if (meta.messageId && !(await redis.set(`notif:dedupe:${meta.messageId}`, '1', { NX: true, EX: 86400 }))) return;
    const n = { id: meta.messageId || `${Date.now()}`, type: key, orderId: evt.orderId, at: new Date().toISOString(), ...tpl(evt) };
    await redis.lPush(`notif:${evt.userId}`, JSON.stringify(n));
    await redis.lTrim(`notif:${evt.userId}`, 0, 49);
    const to = await lookupEmail(evt.userId);
    // real life: SES / SendGrid / SMS gateway. Here: a structured log line (visible in Kibana as order_id / event)
    log.info('notification sent (mock email)', { channel: 'email', to, user_id: evt.userId, event: key, order_id: evt.orderId, subject: n.title });
  });
  const port = process.env.PORT || 3005;
  const server = app.listen(port, () => log.info('notification-worker listening', { port }));
  shutdown(server, () => redis.quit());
})();
