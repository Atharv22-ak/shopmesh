const express = require('express');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express(); // NOTE: no body parser here, proxy streams the raw body
const SECRET = process.env.JWT_SECRET || 'dev-secret';
const USER = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const ORDER = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';

app.get('/healthz', (_q, s) => s.send('ok'));

const auth = (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    req.headers['x-user-id'] = String(jwt.verify(token, SECRET).sub);
    next();
  } catch { res.status(401).json({ error: 'unauthorized' }); }
};

const proxy = (pathFilter, target) =>
  createProxyMiddleware({ pathFilter, target, changeOrigin: true, pathRewrite: { '^/api': '' } });

const PRIVATE = ['/api/cart', '/api/checkout', '/api/orders'];
app.use(proxy('/api/auth', USER));          // public
app.use(proxy('/api/products', PRODUCT));   // public
app.use(PRIVATE, auth);                     // JWT required below this line
app.use(proxy(PRIVATE, ORDER));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log('api-gateway on', port));
