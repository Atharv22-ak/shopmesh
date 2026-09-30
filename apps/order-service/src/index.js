const express = require('express');
const { createClient } = require('redis');
const { pool, init } = require('./db');
const { connect, publish, subscribe } = require('./events');

const app = express();
app.use(express.json());
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => console.error('redis', e.message));
const PRODUCT_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
let ch;

const uid = (req) => req.headers['x-user-id'];
const cartKey = (req) => `cart:${uid(req)}`;

app.get('/healthz', (_q, s) => s.send('ok'));

// ---- cart (Redis) ----
app.post('/cart/items', async (req, res) => {
  const { productId, qty = 1 } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });
  await redis.hIncrBy(cartKey(req), String(productId), Number(qty));
  res.json(await redis.hGetAll(cartKey(req)));
});
app.put('/cart/items', async (req, res) => {  // set exact qty; 0 removes
  const { productId, qty } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId required' });
  const n = Math.max(0, Math.min(10, Number(qty) || 0));
  if (n) await redis.hSet(cartKey(req), String(productId), n);
  else await redis.hDel(cartKey(req), String(productId));
  res.json(await redis.hGetAll(cartKey(req)));
});
app.delete('/cart/items/:id', async (req, res) => {
  await redis.hDel(cartKey(req), String(req.params.id));
  res.json(await redis.hGetAll(cartKey(req)));
});
app.get('/cart', async (req, res) => res.json(await redis.hGetAll(cartKey(req))));
app.delete('/cart', async (req, res) => { await redis.del(cartKey(req)); res.status(204).end(); });

// ---- checkout: sync call to product-service + async event ----
app.post('/checkout', async (req, res) => {
  const cart = await redis.hGetAll(cartKey(req));
  if (!Object.keys(cart).length) return res.status(400).json({ error: 'cart is empty' });
  const items = []; let total = 0;
  for (const [pid, qty] of Object.entries(cart)) {
    const r = await fetch(`${PRODUCT_URL}/products/${pid}`);
    if (!r.ok) return res.status(400).json({ error: `product ${pid} not found` });
    const p = await r.json();
    if (Number(qty) > p.stock) return res.status(400).json({ error: `only ${p.stock} left for ${p.name}` });
    items.push({ productId: p.id, name: p.name, qty: Number(qty), priceCents: p.price_cents });
    total += p.price_cents * Number(qty);
  }
  const address = String((req.body || {}).address || '').slice(0, 500);
  const o = await pool.query(
    `INSERT INTO orders(user_id, total_cents, status, items, address) VALUES($1,$2,'PENDING',$3,$4) RETURNING *`,
    [uid(req), total, JSON.stringify(items), address]);
  await redis.del(cartKey(req));
  publish(ch, 'order.created', { orderId: o.rows[0].id, userId: Number(uid(req)), totalCents: total, items });
  res.status(202).json(o.rows[0]);
});

app.get('/orders', async (req, res) => {
  const r = await pool.query('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [uid(req)]);
  res.json(r.rows);
});

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY, user_id INT NOT NULL, total_cents INT NOT NULL,
    status TEXT NOT NULL, items JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT;`);
  await redis.connect();
  ch = await connect();
  // payment result events -> update order status
  await subscribe(ch, 'order-service.payments', ['payment.*'], async (key, evt) => {
    const status = key === 'payment.completed' ? 'PAID' : 'PAYMENT_FAILED';
    await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [status, evt.orderId]);
    console.log(`order ${evt.orderId} -> ${status}`);
  });
  const port = process.env.PORT || 3003;
  app.listen(port, () => console.log('order-service on', port));
})();
