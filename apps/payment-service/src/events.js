// RabbitMQ helper: topic exchange "shop.events"
const amqp = require('amqplib');
const http = require('http');
const EXCHANGE = 'shop.events';
const url = `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@${process.env.RABBITMQ_HOST || 'localhost'}:5672`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const conn = await amqp.connect(url);
      const ch = await conn.createChannel();
      await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
      conn.on('close', () => { console.error('rabbitmq closed, exiting'); process.exit(1); });
      return ch;
    } catch (e) {
      console.log('waiting for rabbitmq...');
      await sleep(2000);
    }
  }
  throw new Error('rabbitmq unreachable');
}

const publish = (ch, key, payload) =>
  ch.publish(EXCHANGE, key, Buffer.from(JSON.stringify(payload)), { persistent: true });

async function subscribe(ch, queue, keys, handler) {
  await ch.assertQueue(queue, { durable: true });
  for (const k of keys) await ch.bindQueue(queue, EXCHANGE, k);
  ch.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      await handler(msg.fields.routingKey, JSON.parse(msg.content.toString()));
      ch.ack(msg);
    } catch (e) {
      console.error('handler failed', e);
      ch.nack(msg, false, false);
    }
  });
}

// tiny HTTP server so k8s probes work for worker-type services
function health(port) {
  http.createServer((_q, s) => s.end('ok')).listen(port, () => console.log('health on', port));
}

module.exports = { connect, publish, subscribe, health, sleep };
