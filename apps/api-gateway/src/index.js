const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { log, requestMw, metricsHandler, errorMw, shutdown } = require('./common')('api-gateway');

const app = express(); // NOTE: no body parser here, proxy streams the raw body
const SECRET = process.env.JWT_SECRET || 'dev-secret';
if (process.env.NODE_ENV === 'production' && SECRET === 'dev-secret') { log.error('JWT_SECRET must be set in production'); process.exit(1); }
const USER = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const ORDER = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';
const SHIPPING = process.env.SHIPPING_SERVICE_URL || 'http://localhost:3006';
const NOTIFY = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3005';

app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));   // real client IP for rate limiting (nginx / Gateway API in front)
app.disable('x-powered-by');
app.get('/healthz', (_q, s) => s.send('ok'));
app.get('/metrics', metricsHandler);
app.use(requestMw);

// identity headers are set ONLY by this gateway from a verified JWT - never trust ones sent by a client
app.use((req, _res, next) => { delete req.headers['x-user-id']; delete req.headers['x-user-name']; next(); });
app.use((_q, res, next) => { res.setHeader('x-content-type-options', 'nosniff'); next(); });

const limiter = (windowMs, limit, what) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => { log.warn('rate limited', { what, ip: req.ip, path: req.originalUrl.split('?')[0] }); res.status(429).json({ error: 'too many requests, slow down' }); },
});
app.use('/api/auth', limiter(60_000, Number(process.env.AUTH_RATE_LIMIT || 20), 'auth'));   // brute-force protection
app.use('/api', limiter(60_000, Number(process.env.API_RATE_LIMIT || 600), 'api'));

const auth = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    req.headers['x-user-id'] = String(claims.sub);
    req.headers['x-user-name'] = encodeURIComponent(claims.name || String(claims.email || '').split('@')[0]);
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
};

const proxy = (pathFilter, target) => createProxyMiddleware({
  pathFilter, target, changeOrigin: true, pathRewrite: { '^/api': '' }, proxyTimeout: 10_000, timeout: 10_000,
  on: { error: (err, req, res) => {
    log.error('upstream error', { target, err: err.message, req_id: req.id });
    if (!res.headersSent && res.writeHead) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'service unavailable', requestId: req.id })); }
  } },
});

const PRIVATE = ['/api/cart', '/api/checkout', '/api/orders'];
app.use(proxy('/api/auth', USER));                                   // public
app.use('/api/products', (req, res, next) => (['GET', 'HEAD'].includes(req.method) ? next() : auth(req, res, next)));  // reading is public, writing (reviews) needs login
app.use(proxy('/api/products', PRODUCT));
app.use('/api/shipments', auth);
app.use(proxy('/api/shipments', SHIPPING));
app.use('/api/notifications', auth);
app.use(proxy('/api/notifications', NOTIFY));
app.use(PRIVATE, auth);                                                           // JWT required below this line
app.use(proxy(PRIVATE, ORDER));

app.use('/api', (_q, res) => res.status(404).json({ error: 'not found' }));
app.use(errorMw);

const port = process.env.PORT || 8080;
const server = app.listen(port, () => log.info('api-gateway listening', { port }));
shutdown(server);
