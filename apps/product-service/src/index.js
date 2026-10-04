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
const KEY = 'products:v2:all';
const COLS = 'id, name, price_cents, mrp_cents, stock, category, emoji, rating, reviews, description';
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

// name, price, mrp, stock, category, emoji, rating, reviews, description
const SEED = [
  ['Mechanical Keyboard', 349900, 499900, 100, 'Computers', '⌨️', 4.5, 2314, 'RGB backlit, hot-swappable blue switches, aluminium top plate, detachable USB-C cable.'],
  ['Wireless Mouse', 129900, 149900, 100, 'Computers', '🖱️', 4.3, 8120, 'Silent clicks, 2.4GHz + Bluetooth, 12-month battery life, ergonomic shape.'],
  ['USB-C Hub', 249900, 349900, 100, 'Computers', '🔌', 4.2, 1530, '7-in-1 hub: HDMI 4K, 2x USB 3.0, SD/microSD, 100W power delivery.'],
  ['27" Monitor', 1499900, 1999900, 100, 'Computers', '🖥️', 4.6, 642, '27-inch QHD IPS display, 75Hz, 99% sRGB, ultra-slim bezels, eye-care mode.'],
  ['Laptop Stand', 89900, 149900, 100, 'Computers', '💻', 4.4, 3310, 'Foldable aluminium stand, 6 height levels, fits 10-17 inch laptops.'],
  ['Webcam 1080p', 199900, 249900, 100, 'Computers', '📷', 4.1, 978, 'Full HD webcam with autofocus, dual noise-cancelling mics and privacy cover.'],
  ['Noise Cancelling Headphones', 799900, 1299900, 60, 'Audio', '🎧', 4.5, 5120, 'Active noise cancellation, 40-hour battery, fast charge, deep bass.'],
  ['Bluetooth Speaker', 349900, 599900, 80, 'Audio', '🔊', 4.3, 7420, 'Waterproof IPX7 portable speaker with 360° sound and 20-hour playtime.'],
  ['Smart Watch', 499900, 799900, 70, 'Wearables', '⌚', 4.2, 2210, '1.8" AMOLED display, SpO2 + heart-rate tracking, 100+ sports modes, GPS.'],
  ['Fitness Band', 149900, 249900, 120, 'Wearables', '🏃', 4.0, 4100, 'Slim band with step tracking, sleep monitor and 14-day battery.'],
  ['Power Bank 20000mAh', 189900, 299900, 150, 'Mobile Accessories', '🔋', 4.4, 9800, '22.5W fast charging, dual output, USB-C in/out, LED battery indicator.'],
  ['Phone Case', 39900, 99900, 300, 'Mobile Accessories', '📱', 4.1, 12000, 'Shockproof transparent case with raised edges for camera and screen protection.'],
  ['LED Desk Lamp', 69900, 129900, 90, 'Home & Office', '💡', 4.3, 2890, 'Touch control, 5 colour modes, 5 brightness levels, USB charging port.'],
  ['Ergonomic Chair', 1299900, 1999900, 25, 'Home & Office', '🪑', 4.4, 1120, 'Mesh back, adjustable lumbar support, 3D armrests, 135° recline.'],
  ['Gaming Mouse', 299900, 499900, 75, 'Computers', '🖱️', 4.4, 320, 'High-precision gaming mouse with customizable RGB lighting, programmable buttons, and ergonomic design for extended gaming sessions.'],
  ['4K Webcam', 799900, 999900, 60, 'Computers', '📷', 4.6, 1850, 'Ultra HD 4K webcam with HDR, autofocus, and built-in dual microphones for crystal clear video conferencing and streaming.'],
  ['USB-C Laptop Charger', 499900, 699900, 120, 'Computers', '🔌', 4.3, 890, 'Powerful 65W USB-C laptop charger with fast charging capability and multiple safety protections.'],
  ['Laptop Cooling Pad', 199900, 299900, 100, 'Computers', '❄️', 4.2, 1420, 'Adjustable laptop cooling pad with dual fans and ergonomic design to prevent overheating during intensive use.'],
  ['True Wireless Earbuds', 349900, 499900, 200, 'Audio', '🎧', 4.3, 5420, 'Premium true wireless earbuds with active noise cancellation, 30-hour battery life, and water-resistant design.'],
  ['Portable PA Speaker', 1299900, 1799900, 35, 'Audio', '🔊', 4.4, 2100, 'Powerful portable PA speaker with 120W output, Bluetooth connectivity, and built-in mixer for events and parties.'],
  ['Studio Microphone', 649900, 899900, 50, 'Audio', '🎤', 4.5, 1890, 'Professional studio condenser microphone with cardioid pattern, shock mount, and pop filter for clear vocal recordings.'],
  ['GPS Running Watch', 899900, 1299900, 80, 'Wearables', '⌚', 4.4, 3200, 'Advanced GPS running watch with heart rate monitoring, sleep tracking, and 20-hour battery life for athletes.'],
  ['Smart Scale', 249900, 349900, 150, 'Wearables', '⚖️', 4.1, 2800, 'Wi-Fi enabled smart scale that measures weight, body fat, muscle mass, and syncs with fitness apps.'],
  ['Car Phone Mount', 89900, 149900, 300, 'Mobile Accessories', '📱', 4.2, 7800, 'Secure car phone mount with 360-degree rotation, strong suction base, and compatibility with all smartphone sizes.'],
  ['Wireless Charger Pad', 199900, 299900, 180, 'Mobile Accessories', '📱', 4.0, 4100, 'Fast wireless charging pad with 15W output, LED indicator, and non-slip surface for smartphones and earbuds.'],
  ['Tempered Glass Screen Protector', 49900, 99900, 500, 'Mobile Accessories', '📱', 4.3, 15200, '9H hardness tempered glass screen protector with oleophobic coating and easy installation kit.'],
  ['Standing Desk Converter', 899900, 1299900, 40, 'Home & Office', '🪑', 4.3, 1650, 'Adjustable standing desk converter that transforms any desk into an ergonomic sit-stand workstation.'],
  ['Desk Organizer Set', 79900, 129900, 220, 'Home & Office', '📋', 4.2, 3400, 'Comprehensive desk organizer set with file holder, pen cup, phone stand, and cable management clips.'],
  ['Mechanical Gaming Keyboard', 549900, 799900, 90, 'Gaming', '⌨️', 4.6, 4200, 'Mechanical gaming keyboard with RGB backlighting, programmable macro keys, and durable aircraft-grade aluminum frame.'],
];

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, price_cents INT NOT NULL, stock INT NOT NULL DEFAULT 100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS mrp_cents INT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT '📦';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating NUMERIC(2,1) DEFAULT 4.0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS reviews INT DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
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
