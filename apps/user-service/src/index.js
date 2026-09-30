const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, init } = require('./db');

const app = express();
app.use(express.json());
const SECRET = process.env.JWT_SECRET || 'dev-secret';

app.get('/healthz', (_q, s) => s.send('ok'));

app.post('/auth/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  try {
    const hash = await bcrypt.hash(password, 8);
    const r = await pool.query(
      'INSERT INTO users(email, name, password_hash) VALUES($1,$2,$3) RETURNING id, email, name',
      [email, name || '', hash]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already registered' });
    console.error(e); res.status(500).json({ error: 'server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ sub: u.id, email: u.email }, SECRET, { expiresIn: '2h' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name } });
});

app.get('/users/:id', async (req, res) => {
  const r = await pool.query('SELECT id, email, name FROM users WHERE id=$1', [req.params.id]);
  r.rows[0] ? res.json(r.rows[0]) : res.status(404).json({ error: 'not found' });
});

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now())`);
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log('user-service on', port));
})();
