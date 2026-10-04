const express = require('express');
const { createClient } = require('redis');
const { pool, init } = require('./db');
const { connect, subscribe } = require('./events');
const { client, log, requestMw, metricsHandler, ah, httpError, errorMw, shutdown } = require('./common')('product-service');

const app = express();
app.use(requestMw);
app.use(express.json({ limit: '50kb' }));
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => log.error('redis', { err: e.message }));
const KEY = 'products:v3:all';
const COLS = 'id, name, price_cents, mrp_cents, stock, category, emoji, rating, reviews, description, image_url';
const reservations = new client.Counter({ name: 'shopmesh_stock_reservations_total', help: 'Stock reservations', labelNames: ['result'] });
const toInt = (v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN);
const bust = () => redis.del(KEY).catch(() => {});   // list cache must not show stale stock after a change

app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);

app.get('/products', ah(async (_req, res) => {
  try {
    const cached = await redis.get(KEY);
    if (cached) return res.set('X-Cache', 'HIT').json(JSON.parse(cached));
  } catch { /* cache down -> fall through to the database */ }
  const r = await pool.query(`SELECT ${COLS} FROM products ORDER BY id`);
  redis.setEx(KEY, 30, JSON.stringify(r.rows)).catch(() => {});
  res.set('X-Cache', 'MISS').json(r.rows);
}));

app.get('/products/:id', ah(async (req, res) => {
  const id = toInt(req.params.id);
  const r = Number.isNaN(id) ? { rows: [] } : await pool.query(`SELECT ${COLS} FROM products WHERE id=$1`, [id]);
  if (!r.rows[0]) throw httpError(404, 'not found');
  res.json(r.rows[0]);
}));

// ---------- reviews (one per customer per product; headline rating above stays the catalogue value) ----------
app.get('/products/:id/reviews', ah(async (req, res) => {
  const id = toInt(req.params.id);
  if (Number.isNaN(id)) throw httpError(404, 'not found');
  const sum = await pool.query(
    `SELECT count(*)::int AS count, COALESCE(round(avg(rating),1),0)::float AS avg,
            count(*) FILTER (WHERE rating=5)::int AS r5, count(*) FILTER (WHERE rating=4)::int AS r4,
            count(*) FILTER (WHERE rating=3)::int AS r3, count(*) FILTER (WHERE rating=2)::int AS r2,
            count(*) FILTER (WHERE rating=1)::int AS r1 FROM reviews WHERE product_id=$1`, [id]);
  const list = await pool.query(
    'SELECT id, user_id, user_name, rating, title, body, created_at FROM reviews WHERE product_id=$1 ORDER BY created_at DESC LIMIT 50', [id]);
  res.json({ summary: sum.rows[0], reviews: list.rows });
}));

app.post('/products/:id/reviews', ah(async (req, res) => {
  const userId = toInt(req.headers['x-user-id']);
  if (Number.isNaN(userId)) throw httpError(401, 'unauthorized');   // gateway enforces JWT for non-GET
  const id = toInt(req.params.id);
  const { rating, title = '', body = '' } = req.body || {};
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw httpError(400, 'rating must be 1-5');
  if (String(title).length > 100 || String(body).length > 1000) throw httpError(400, 'title max 100 / review max 1000 characters');
  let name = 'Customer';
  try { name = decodeURIComponent(String(req.headers['x-user-name'] || '')) || name; } catch { /* keep default */ }
  const p = Number.isNaN(id) ? { rowCount: 0 } : await pool.query('SELECT 1 FROM products WHERE id=$1', [id]);
  if (!p.rowCount) throw httpError(404, 'product not found');
  const r = await pool.query(
    `INSERT INTO reviews(product_id, user_id, user_name, rating, title, body) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (product_id, user_id) DO UPDATE SET rating=EXCLUDED.rating, title=EXCLUDED.title, body=EXCLUDED.body, created_at=now()
     RETURNING id, user_id, user_name, rating, title, body, created_at`,
    [id, userId, name.slice(0, 60), rating, String(title).trim(), String(body).trim()]);
  res.status(201).json(r.rows[0]);
}));

// ---------- stock reservation (INTERNAL: the gateway only proxies /api/*, so these are not reachable from outside) ----------
// All-or-nothing, concurrency-safe (UPDATE ... WHERE stock >= qty), idempotent per orderId.
app.post('/internal/reserve', ah(async (req, res) => {
  const { orderId, items } = req.body || {};
  if (!Number.isInteger(orderId) || !Array.isArray(items) || !items.length) throw httpError(400, 'orderId and items required');
  const list = items.map((i) => ({ productId: Number(i.productId), qty: Number(i.qty) }));
  if (list.some((i) => !Number.isInteger(i.productId) || !Number.isInteger(i.qty) || i.qty < 1)) throw httpError(400, 'invalid items');
  list.sort((a, b) => a.productId - b.productId);   // stable lock order -> no deadlocks between concurrent orders
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ex = await c.query('SELECT status FROM stock_reservations WHERE order_id=$1 FOR UPDATE', [orderId]);
    if (ex.rows[0]) { await c.query('ROLLBACK'); return res.json({ ok: true, duplicate: true, status: ex.rows[0].status }); }
    for (const it of list) {
      const u = await c.query('UPDATE products SET stock = stock - $2 WHERE id=$1 AND stock >= $2', [it.productId, it.qty]);
      if (!u.rowCount) {
        const p = await c.query('SELECT name, stock FROM products WHERE id=$1', [it.productId]);
        await c.query('ROLLBACK');
        reservations.inc({ result: 'rejected' });
        const msg = !p.rows[0] ? `product ${it.productId} not found` : p.rows[0].stock ? `only ${p.rows[0].stock} left for ${p.rows[0].name}` : `${p.rows[0].name} is out of stock`;
        return res.status(409).json({ error: msg, productId: it.productId });
      }
    }
    await c.query("INSERT INTO stock_reservations(order_id, items, status) VALUES($1,$2,'reserved')", [orderId, JSON.stringify(list)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  reservations.inc({ result: 'reserved' });
  await bust();
  log.info('stock reserved', { order_id: orderId, lines: list.length });
  res.json({ ok: true });
}));

async function releaseStock(orderId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query('SELECT items, status FROM stock_reservations WHERE order_id=$1 FOR UPDATE', [orderId]);
    if (!r.rows[0] || r.rows[0].status !== 'reserved') { await c.query('ROLLBACK'); return false; }   // already released / unknown -> no-op
    for (const it of r.rows[0].items) await c.query('UPDATE products SET stock = stock + $2 WHERE id=$1', [it.productId, it.qty]);
    await c.query("UPDATE stock_reservations SET status='released', released_at=now() WHERE order_id=$1", [orderId]);
    await c.query('COMMIT');
    reservations.inc({ result: 'released' });
    await bust();
    log.info('stock released', { order_id: orderId });
    return true;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
app.post('/internal/release', ah(async (req, res) => {
  const { orderId } = req.body || {};
  if (!Number.isInteger(orderId)) throw httpError(400, 'orderId required');
  res.json({ ok: true, released: await releaseStock(orderId) });
}));

app.use((_q, _s, next) => next(httpError(404, 'not found')));
app.use(errorMw);

const SEED = require('./seed');   // 100+ products, see seed.js

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, price_cents INT NOT NULL, stock INT NOT NULL DEFAULT 100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp_cents INT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT '📦';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1) DEFAULT 4.0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS reviews INT DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS products_name_uq ON products(name);
    CREATE TABLE IF NOT EXISTS stock_reservations (
      order_id INT PRIMARY KEY, items JSONB NOT NULL, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), released_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE, user_id INT NOT NULL,
      user_name TEXT NOT NULL, rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5), title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (product_id, user_id));`);
  // idempotent seed: adds new products, refreshes metadata of existing ones (never touches price/stock of existing rows)
  for (const [n, p, m, s, c, e, r, rv, d] of SEED) {
    await pool.query(
      `INSERT INTO products(name, price_cents, mrp_cents, stock, category, emoji, rating, reviews, description)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (name) DO UPDATE SET mrp_cents=EXCLUDED.mrp_cents, category=EXCLUDED.category,
         emoji=EXCLUDED.emoji, rating=EXCLUDED.rating, reviews=EXCLUDED.reviews, description=EXCLUDED.description`,
      [n, p, m, s, c, e, r, rv, d]);
  }
  await redis.connect();
  await bust();
  // give stock back when a payment fails or the customer cancels (idempotent: safe on redelivery)
  const ch = await connect();
  await subscribe(ch, 'product-service.stock', ['payment.failed', 'order.cancelled'], async (_key, evt) => { await releaseStock(evt.orderId); });
  const port = process.env.PORT || 3002;
  const server = app.listen(port, () => log.info('product-service listening', { port }));
  shutdown(server, async () => { await redis.quit(); await pool.end(); });
})();
