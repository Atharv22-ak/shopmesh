const express = require('express');
const { createClient } = require('redis');
const { pool, init } = require('./db');

const app = express();
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => console.error('redis', e.message));

app.get('/healthz', (_q, s) => s.send('ok'));

app.get('/products', async (_req, res) => {
  const cached = await redis.get('products:all');
  if (cached) return res.set('X-Cache', 'HIT').json(JSON.parse(cached));
  const r = await pool.query('SELECT id, name, price_cents, stock FROM products ORDER BY id');
  await redis.setEx('products:all', 30, JSON.stringify(r.rows));
  res.set('X-Cache', 'MISS').json(r.rows);
});

app.get('/products/:id', async (req, res) => {
  const r = await pool.query('SELECT id, name, price_cents, stock FROM products WHERE id=$1', [req.params.id]);
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, price_cents INT NOT NULL, stock INT NOT NULL DEFAULT 100)`);
  const c = await pool.query('SELECT count(*)::int AS n FROM products');
  if (c.rows[0].n === 0) {
    await pool.query(`INSERT INTO products(name, price_cents) VALUES
      ('Mechanical Keyboard', 349900), ('Wireless Mouse', 129900), ('USB-C Hub', 249900),
      ('27" Monitor', 1499900), ('Laptop Stand', 89900), ('Webcam 1080p', 199900)`);
  }
  await redis.connect();
  const port = process.env.PORT || 3002;
  app.listen(port, () => console.log('product-service on', port));
})();
