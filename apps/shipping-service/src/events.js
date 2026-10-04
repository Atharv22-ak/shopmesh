// RabbitMQ helper: topic exchange "shop.events"  (same file is copied into every service that talks to the broker)
const amqp = require('amqplib');
const http = require('http');
const EXCHANGE = 'shop.events';
const url = `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@${process.env.RABBITMQ_HOST || 'localhost'}:5672`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// onClose: optional callback. Without it the process exits so the orchestrator restarts it (fine for workers).
// A service that must stay up without the broker (product-service) passes its own reconnect logic instead.
async function connect({ onClose } = {}) {
  for (let i = 0; i < 60; i++) {
    try {
      const conn = await amqp.connect(url);
      const ch = await conn.createChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      conn.on('error', (e) => console.error('rabbitmq error', e.message));
      conn.on('close', () => {
        if (onClose) return onClose();
        console.error('rabbitmq closed, exiting'); process.exit(1);
      });
      ch.connection = conn;
      return ch;
    } catch (e) {
      console.log('waiting for rabbitmq...');
      await sleep(2000);
    }
  }
  throw new Error('rabbitmq unreachable');
}

const publish = (ch, key, payload, opts = {}) =>
  ch.publish(EXCHANGE, key, Buffer.from(JSON.stringify(payload)), {
    persistent: true, contentType: 'application/json',
    messageId: opts.messageId || require('crypto').randomUUID(), timestamp: Math.floor(Date.now() / 1000),
  });

async function subscribe(ch, queue, keys, handler) {
  await ch.assertQueue(queue, { durable: true });
  for (const k of keys) await ch.bindQueue(queue, EXCHANGE, k);
  ch.prefetch(10);
  ch.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      await handler(msg.fields.routingKey, JSON.parse(msg.content.toString()), { messageId: msg.properties.messageId, redelivered: msg.fields.redelivered });
      ch.ack(msg);
    } catch (e) {
      // retry once (requeue); a message that fails twice is dropped so a poison message can't loop forever
      const retry = !msg.fields.redelivered;
      console.error(`handler failed for ${msg.fields.routingKey} (${retry ? 'retrying once' : 'dropping'}):`, e.message);
      ch.nack(msg, false, retry);
    }
  });
}

// tiny HTTP server so k8s probes work for worker-type services; also serves Prometheus metrics if prom-client is installed
function health(port) {
  let prom = null;
  try { prom = require('prom-client'); } catch { /* optional */ }
  return http.createServer(async (req, res) => {
    if (prom && req.url === '/metrics') {
      res.setHeader('Content-Type', prom.register.contentType);
      return res.end(await prom.register.metrics());
    }
    res.end('ok');
  }).listen(port, () => console.log('health on', port));
}

module.exports = { connect, publish, subscribe, health, sleep, EXCHANGE };
