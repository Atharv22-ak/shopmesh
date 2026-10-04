// Shared helpers copied into every service (Docker build context is per-app, so no shared package yet).
// JSON logs (picked up by Logstash), Prometheus metrics, request ids, async error handling, graceful shutdown.
const client = require('prom-client');
const crypto = require('crypto');

let instance;
function common(service) {
  client.register.setDefaultLabels({ service });
  client.collectDefaultMetrics();
  const httpHist = new client.Histogram({
    name: 'http_request_duration_seconds', help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  });

  const write = (level, msg, extra) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...extra });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };
  const log = { info: (m, e) => write('info', m, e), warn: (m, e) => write('warn', m, e), error: (m, e) => write('error', m, e) };

  // one JSON line + one histogram observation per request; propagates x-request-id
  const requestMw = (req, res, next) => {
    const t0 = process.hrtime.bigint();
    const given = String(req.headers['x-request-id'] || '');
    req.id = /^[\w-]{8,64}$/.test(given) ? given : crypto.randomUUID();
    req.headers['x-request-id'] = req.id;
    res.setHeader('x-request-id', req.id);
    res.on('finish', () => {
      const p = req.originalUrl.split('?')[0];
      if (p === '/healthz' || p === '/metrics') return;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const route = req.route ? (req.baseUrl || '') + req.route.path : 'other';
      httpHist.observe({ method: req.method, route, status: res.statusCode }, ms / 1000);
      log.info('request', { method: req.method, path: p, status: res.statusCode, ms: Math.round(ms), req_id: req.id, user_id: req.headers['x-user-id'] });
    });
    next();
  };

  const metricsHandler = async (_q, res) => {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  };

  // Express 4 does not catch rejected promises -> one bad request used to crash the whole process
  const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  // eslint-disable-next-line no-unused-vars
  const errorMw = (err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('unhandled error', { err: err.message, stack: err.stack, req_id: req.id });
    res.status(status).json({ error: status >= 500 ? 'server error' : err.message, requestId: req.id });
  };

  const shutdown = (server, onClose) => {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        log.info('shutting down', { sig });
        server.close(async () => { try { await onClose?.(); } catch { /* ignore */ } process.exit(0); });
        setTimeout(() => process.exit(1), 10000).unref();
      });
    }
  };

  instance = { client, log, requestMw, metricsHandler, ah, httpError, errorMw, shutdown };
  return instance;
}
common.get = () => instance || common('service');
module.exports = common;
