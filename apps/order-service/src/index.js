const express = require('express');
const { createClient } = require('redis');
const { pool, init } = require('./db');
const { connect, publish, subscribe } = require('./events');
const { computeTotals } = require('./pricing');
const { client, log, requestMw, metricsHandler, ah, httpError, errorMw, shutdown } = require('./common')('order-service');

const app = express();
app.use(requestMw);
app.use(express.json({ limit: '50kb' }));
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => log.error('redis', { err: e.message }));
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const FULFILMENT_SIM = process.env.FULFILMENT_SIM === 'true';          // legacy built-in warehouse; shipping-service replaces it
const SHIP_AFTER = Number(process.env.SHIP_AFTER_SEC || 20);
const DELIVER_AFTER = Number(process.env.DELIVER_AFTER_SEC || 40);
let ch;

const ordersCreated = new client.Counter({ name: 'shopmesh_orders_created_total', help: 'Orders placed' });
const orderStatus = new client.Counter({ name: 'shopmesh_order_status_total', help: 'Order status transitions', labelNames: ['status'] });
const revenue = new client.Counter({ name: 'shopmesh_order_value_cents_total', help: 'Sum of placed order totals (paise)' });

const uid = (req) => req.headers['x-user-id'];
const cartKey = (req) => `cart:${uid(req)}`;
const toInt = (v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN);

app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);
app.use((req, _res, next) => { if (!uid(req)) return next(httpError(401, 'unauthorized')); next(); });

// ---------- helpers ----------
async function fetchProduct(id) {
  let r;
  try { r = await fetch(`${PRODUCT_URL}/products/${id}`, { signal: AbortSignal.timeout(3000) }); }
  catch { throw httpError(502, 'catalogue unavailable'); }
  if (r.status === 404) return null;
  if (!r.ok) throw httpError(502, 'catalogue unavailable');
  return r.json();
}

// price the cart from the catalogue (never trust the browser) -> items + totals
async function quote(cart, couponCode) {
  const entries = Object.entries(cart);
  if (!entries.length) throw httpError(400, 'cart is empty');
  const products = await Promise.all(entries.map(([pid]) => fetchProduct(pid)));
  const items = entries.map(([pid, qty], i) => {
    const p = products[i];
    if (!p) throw httpError(400, `product ${pid} not found`);
    if (Number(qty) > p.stock) throw httpError(409, p.stock ? `only ${p.stock} left for ${p.name}` : `${p.name} is out of stock`);
    return { productId: p.id, name: p.name, qty: Number(qty), priceCents: p.price_cents };
  });
  const subtotal = items.reduce((a, i) => a + i.priceCents * i.qty, 0);
  return { items, ...computeTotals(subtotal, couponCode) };
}

const historyEntry = (status, note) => JSON.stringify({ status, at: new Date().toISOString(), note });

// guarded state change + follow-up event written to the outbox in the SAME transaction
async function transition(orderId, from, to, note, mkEvent) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `WITH old AS (SELECT id, status FROM orders WHERE id=$1 FOR UPDATE)
       UPDATE orders o SET status=$2, updated_at=now(),
              history = o.history || jsonb_build_array(jsonb_build_object('status',$2::text,'at',now(),'note',$3::text))
       FROM old WHERE o.id=old.id AND old.status = ANY($4) RETURNING o.*, old.status AS prev_status`,
      [orderId, to, note, from]);
    const row = r.rows[0];
    if (row && mkEvent) {
      const ev = mkEvent(row, row.prev_status);
      if (ev) await c.query('INSERT INTO outbox(routing_key, payload) VALUES($1,$2)', [ev[0], JSON.stringify(ev[1])]);
    }
    await c.query('COMMIT');
    if (row) { orderStatus.inc({ status: to }); log.info('order status', { order_id: orderId, status: to, from: row.prev_status }); }
    return row || null;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

const releaseStock = (orderId) => fetch(`${PRODUCT_URL}/internal/release`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId }), signal: AbortSignal.timeout(3000),
}).catch((e) => log.error('stock release failed - needs manual fix', { order_id: orderId, err: e.message }));

// ---------- cart (Redis) ----------
app.post('/cart/items', ah(async (req, res) => {
  const productId = toInt((req.body || {}).productId);
  const qty = (req.body || {}).qty == null ? 1 : toInt(req.body.qty);
  if (!productId) throw httpError(400, 'valid productId required');
  if (!(qty >= 1 && qty <= 10)) throw httpError(400, 'qty must be 1-10');
  if (!(await fetchProduct(productId))) throw httpError(404, 'product not found');
  const cur = Number((await redis.hGet(cartKey(req), String(productId))) || 0);
  await redis.hSet(cartKey(req), String(productId), Math.min(10, cur + qty));
  res.json(await redis.hGetAll(cartKey(req)));
}));
app.put('/cart/items', ah(async (req, res) => {  // set exact qty; 0 removes
  const productId = toInt((req.body || {}).productId);
  if (!productId) throw httpError(400, 'valid productId required');
  const n = Math.max(0, Math.min(10, Number(req.body.qty) || 0));
  if (n) await redis.hSet(cartKey(req), String(productId), n);
  else await redis.hDel(cartKey(req), String(productId));
  res.json(await redis.hGetAll(cartKey(req)));
}));
app.delete('/cart/items/:id', ah(async (req, res) => {
  await redis.hDel(cartKey(req), String(req.params.id));
  res.json(await redis.hGetAll(cartKey(req)));
}));
app.get('/cart', ah(async (req, res) => res.json(await redis.hGetAll(cartKey(req)))));
app.delete('/cart', ah(async (req, res) => { await redis.del(cartKey(req)); res.status(204).end(); }));
// server-side price breakdown incl. coupon + shipping (what the customer will actually be charged)
app.post('/cart/quote', ah(async (req, res) => {
  const q = await quote(await redis.hGetAll(cartKey(req)), (req.body || {}).coupon);
  res.json(q);
}));

// ---------- checkout: idempotent; stock reserved in product-service; event goes through the outbox ----------
async function placeOrder(userId, cart, address, couponCode) {
  const q = await quote(cart, couponCode);
  const c = await pool.connect();
  let orderId; let reserved = false;
  try {
    await c.query('BEGIN');
    const o = await c.query(
      `INSERT INTO orders(user_id, subtotal_cents, discount_cents, shipping_cents, total_cents, coupon, status, items, address, history)
       VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,$8,$9) RETURNING *`,
      [userId, q.subtotalCents, q.discountCents, q.shippingCents, q.totalCents, q.coupon, JSON.stringify(q.items), address,
        JSON.stringify([JSON.parse(historyEntry('PENDING', 'Order placed'))])]);
    orderId = o.rows[0].id;
    // synchronous call: atomically reserve stock (409 = someone else bought it first)
    let r;
    try {
      r = await fetch(`${PRODUCT_URL}/internal/reserve`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ orderId, items: q.items.map((i) => ({ productId: i.productId, qty: i.qty })) }),
      });
    } catch { throw httpError(502, 'inventory unavailable'); }
    if (r.status === 409) throw httpError(409, (await r.json().catch(() => ({}))).error || 'insufficient stock');
    if (!r.ok) throw httpError(502, 'inventory unavailable');
    reserved = true;
    await c.query('INSERT INTO outbox(routing_key, payload) VALUES($1,$2)', ['order.created',
      JSON.stringify({ orderId, userId: Number(userId), totalCents: q.totalCents, items: q.items })]);
    await c.query('COMMIT');
    ordersCreated.inc(); revenue.inc(q.totalCents);
    log.info('order created', { order_id: orderId, user_id: userId, total_cents: q.totalCents });
    return o.rows[0];
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (reserved) await releaseStock(orderId);   // compensate: order row was rolled back, give the stock back
    throw e;
  } finally { c.release(); }
}

app.post('/checkout', ah(async (req, res) => {
  const body = req.body || {};
  const address = String(body.address || '').slice(0, 500);
  // Idempotency-Key: a double click / client retry returns the SAME order instead of creating a second one
  let idem;
  const given = req.headers['idempotency-key'];
  if (given) {
    idem = `idem:${uid(req)}:${String(given).slice(0, 64)}`;
    const first = await redis.set(idem, '__pending__', { NX: true, EX: 30 });
    if (!first) {
      const prev = await redis.get(idem);
      if (prev && prev !== '__pending__') return res.set('Idempotent-Replay', 'true').status(202).json(JSON.parse(prev));
      throw httpError(409, 'checkout already in progress');
    }
  }
  try {
    const cart = await redis.hGetAll(cartKey(req));
    const order = await placeOrder(uid(req), cart, address, body.coupon);
    await redis.del(cartKey(req));
    if (idem) await redis.setEx(idem, 86400, JSON.stringify(order));
    res.status(202).json(order);
  } catch (e) { if (idem) await redis.del(idem).catch(() => {}); throw e; }
}));

// ---------- orders ----------
app.get('/orders', ah(async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [uid(req)]);
  res.json(r.rows);
}));
app.get('/orders/:id', ah(async (req, res) => {
  const id = toInt(req.params.id);
  const r = Number.isNaN(id) ? { rows: [] } : await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [id, uid(req)]);
  if (!r.rows[0]) throw httpError(404, 'order not found');
  res.json(r.rows[0]);
}));
app.post('/orders/:id/cancel', ah(async (req, res) => {
  const id = toInt(req.params.id);
  const own = Number.isNaN(id) ? { rows: [] } : await pool.query('SELECT status FROM orders WHERE id=$1 AND user_id=$2', [id, uid(req)]);
  if (!own.rows[0]) throw httpError(404, 'order not found');
  const o = await transition(id, ['PENDING', 'PAID'], 'CANCELLED', 'Cancelled by customer',
    (row, prev) => ['order.cancelled', { orderId: row.id, userId: row.user_id, totalCents: row.total_cents, wasPaid: prev === 'PAID' }]);
  if (!o) throw httpError(409, `order can no longer be cancelled (${own.rows[0].status.toLowerCase()})`);
  res.json(o);
}));

app.use((_q, _s, next) => next(httpError(404, 'not found')));
app.use(errorMw);

// ---------- background jobs ----------
// transactional outbox relay: events are published only after the DB commit, at-least-once
async function relayOutbox() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT id, routing_key, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED');
    for (const row of r.rows) {
      await publish(ch, row.routing_key, row.payload, { messageId: `outbox-${row.id}` });
      await c.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); log.error('outbox relay failed', { err: e.message }); } finally { c.release(); }
}

// demo "warehouse": PAID -> SHIPPED -> DELIVERED after a few seconds
async function advanceFulfilment() {
  for (const [from, to, after, key, note] of [
    ['PAID', 'SHIPPED', SHIP_AFTER, 'order.shipped', 'Packed and handed to ShopMesh Express'],
    ['SHIPPED', 'DELIVERED', DELIVER_AFTER, 'order.delivered', 'Delivered'],
  ]) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        `UPDATE orders SET status=$2, updated_at=now(),
                history = history || jsonb_build_array(jsonb_build_object('status',$2::text,'at',now(),'note',$4::text || CASE WHEN $2='SHIPPED' THEN ' · tracking SMX' || lpad(id::text, 8, '0') ELSE '' END))
         WHERE status=$1 AND updated_at < now() - make_interval(secs => $3) RETURNING id, user_id, total_cents`,
        [from, to, after, note]);
      for (const o of r.rows) {
        await c.query('INSERT INTO outbox(routing_key, payload) VALUES($1,$2)', [key, JSON.stringify({ orderId: o.id, userId: o.user_id, totalCents: o.total_cents })]);
        orderStatus.inc({ status: to }); log.info('order status', { order_id: o.id, status: to, from });
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); log.error('fulfilment tick failed', { err: e.message }); } finally { c.release(); }
  }
}

const loop = (fn, ms) => { const run = async () => { try { await fn(); } catch (e) { log.error('job failed', { err: e.message }); } setTimeout(run, ms).unref?.(); }; run(); };

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, total_cents INT NOT NULL,
    status TEXT NOT NULL, items JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal_cents INT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_cents INT NOT NULL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, id DESC);
    CREATE TABLE IF NOT EXISTS outbox (
      id BIGSERIAL PRIMARY KEY, routing_key TEXT NOT NULL, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox(id) WHERE published_at IS NULL;`);
  await redis.connect();
  ch = await connect();

  // payment results -> order status. Handlers are idempotent (guarded transitions), so redelivery is safe.
  await subscribe(ch, 'order-service.payments', ['payment.*'], async (key, evt) => {
    if (key === 'payment.completed') {
      const o = await transition(evt.orderId, ['PENDING'], 'PAID', `Payment received${evt.paymentId ? ` (${evt.paymentId})` : ''}`);
      if (!o) {
        // customer cancelled while the payment was in flight -> money was taken, so ask for a refund
        const cur = await pool.query('SELECT user_id, total_cents, status FROM orders WHERE id=$1', [evt.orderId]);
        if (cur.rows[0] && cur.rows[0].status === 'CANCELLED') {
          await pool.query('INSERT INTO outbox(routing_key, payload) VALUES($1,$2)', ['order.cancelled',
            JSON.stringify({ orderId: evt.orderId, userId: cur.rows[0].user_id, totalCents: cur.rows[0].total_cents, wasPaid: true })]);
        }
      }
    } else if (key === 'payment.failed') {
      await transition(evt.orderId, ['PENDING'], 'PAYMENT_FAILED', `Payment failed${evt.reason ? `: ${String(evt.reason).replace(/_/g, ' ')}` : ''}`);
    } else if (key === 'payment.refunded') {
      await pool.query(
        `UPDATE orders SET history = history || jsonb_build_array(jsonb_build_object('status','CANCELLED','at',now(),'note',$2::text)) WHERE id=$1`,
        [evt.orderId, `Refund of ₹${((evt.amountCents || 0) / 100).toLocaleString('en-IN')} issued`]);
    }
  });

  // shipping-service owns the parcel; order status follows it (guarded transitions -> idempotent)
  await subscribe(ch, 'order-service.shipments', ['order.shipped', 'order.delivered'], async (key, evt) => {
    const tn = evt.trackingNumber ? ` · ${evt.carrier || 'carrier'} tracking ${evt.trackingNumber}` : '';
    if (key === 'order.shipped') await transition(evt.orderId, ['PAID'], 'SHIPPED', `Packed and handed over${tn}`);
    else await transition(evt.orderId, ['SHIPPED'], 'DELIVERED', 'Delivered');
  });

  loop(relayOutbox, 500);
  if (FULFILMENT_SIM) loop(advanceFulfilment, 5000);
  loop(() => pool.query("DELETE FROM outbox WHERE published_at < now() - interval '1 day'"), 3600 * 1000);

  const port = process.env.PORT || 3003;
  const server = app.listen(port, () => log.info('order-service listening', { port }));
  shutdown(server, async () => { await redis.quit(); await pool.end(); });
})();
