const express = require('express');
const { createClient } = require('redis');
const { pool, init } = require('./db');

const app = express();
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => console.error('redis', e.message));
const KEY = 'products:v2:all';
const COLS = 'id, name, price_cents, mrp_cents, stock, category, emoji, rating, reviews, description';

app.get('/healthz', (_q, s) => s.send('ok'));

app.get('/products', async (_req, res) => {
  const cached = await redis.get(KEY);
  if (cached) return res.set('X-Cache', 'HIT').json(JSON.parse(cached));
  const r = await pool.query(`SELECT ${COLS} FROM products ORDER BY id`);
  await redis.setEx(KEY, 30, JSON.stringify(r.rows));
  res.set('X-Cache', 'MISS').json(r.rows);
});

app.get('/products/:id', async (req, res) => {
  const r = await pool.query(`SELECT ${COLS} FROM products WHERE id=$1`, [req.params.id]);
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});

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
    CREATE UNIQUE INDEX IF NOT EXISTS products_name_uq ON products(name);`);
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
  await redis.del(KEY);
  const port = process.env.PORT || 3002;
  app.listen(port, () => console.log('product-service on', port));
})();
