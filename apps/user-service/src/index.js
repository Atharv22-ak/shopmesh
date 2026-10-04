const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, init } = require('./db');
const { log, requestMw, metricsHandler, ah, httpError, errorMw, shutdown } = require('./common')('user-service');

const SECRET = process.env.JWT_SECRET || 'dev-secret';
if (process.env.NODE_ENV === 'production' && SECRET === 'dev-secret') { log.error('JWT_SECRET must be set in production'); process.exit(1); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const app = express();
app.use(requestMw);
app.use(express.json({ limit: '10kb' }));
app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);

app.post('/auth/register', ah(async (req, res) => {
  const { password, name } = req.body || {};
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, 'enter a valid email address');
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw httpError(400, 'password must be 8-72 characters');
  if (name && String(name).length > 60) throw httpError(400, 'name is too long');
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(email, name, password_hash) VALUES($1,$2,$3) RETURNING id, email, name',
      [email, String(name || '').trim(), hash]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'email already registered');
    throw e;
  }
}));

app.post('/auth/login', ah(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String((req.body || {}).password || ''), u.password_hash))) {
    log.warn('login failed', { email_hash: Buffer.from(email).toString('base64').slice(0, 12) });
    throw httpError(401, 'invalid credentials');
  }
  const token = jwt.sign({ sub: u.id, email: u.email, name: u.name || '' }, SECRET, { expiresIn: '2h', algorithm: 'HS256' });
  res.json({ token, user: { id: u.id, email: u.email, name: u.name } });
}));

// internal only (the gateway does not route it) - used by notification-worker
app.get('/users/:id', ah(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw httpError(404, 'not found');
  const r = await pool.query('SELECT id, email, name FROM users WHERE id=$1', [req.params.id]);
  if (!r.rows[0]) throw httpError(404, 'not found');
  res.json(r.rows[0]);
}));

app.use((_q, _s, next) => next(httpError(404, 'not found')));
app.use(errorMw);

(async () => {
  await init(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now())`);
  const port = process.env.PORT || 3001;
  const server = app.listen(port, () => log.info('user-service listening', { port }));
  shutdown(server, () => pool.end());
})();
