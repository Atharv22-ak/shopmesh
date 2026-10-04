const crypto = require('crypto');
const { createClient } = require('redis');
const { connect, publish, subscribe, health, sleep } = require('./events');
const { client, log } = require('./common')('payment-service');
const FAIL_RATE = Number(process.env.PAYMENT_FAILURE_RATE || 0.1);
const REASONS = ['card_declined', 'insufficient_funds', 'gateway_timeout'];
const payments = new client.Counter({ name: 'shopmesh_payments_total', help: 'Payment attempts', labelNames: ['result'] });

(async () => {
  health(process.env.PORT || 3004);
  const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  redis.on('error', (e) => log.error('redis', { err: e.message }));
  await redis.connect();
  const ch = await connect();

  // Idempotent: the decision for an order is stored, so a redelivered order.created re-publishes the SAME
  // result instead of charging twice or flipping a failure into a success.
  await subscribe(ch, 'payment-service.orders', ['order.created'], async (_key, order) => {
    const key = `payment:${order.orderId}`;
    let result = JSON.parse((await redis.get(key)) || 'null');
    if (!result) {
      log.info('processing payment', { order_id: order.orderId, amount_cents: order.totalCents });
      await sleep(1500); // pretend to talk to a payment gateway
      result = Math.random() >= FAIL_RATE
        ? { ok: true, paymentId: `pay_${crypto.randomBytes(6).toString('hex')}` }
        : { ok: false, reason: REASONS[Math.floor(Math.random() * REASONS.length)] };
      await redis.set(key, JSON.stringify(result), { EX: 7 * 86400 });
      payments.inc({ result: result.ok ? 'success' : 'failed' });
    }
    await publish(ch, result.ok ? 'payment.completed' : 'payment.failed',
      { orderId: order.orderId, userId: order.userId, amountCents: order.totalCents, paymentId: result.paymentId, reason: result.reason });
  });

  // customer cancelled an order that was already paid -> refund
  await subscribe(ch, 'payment-service.refunds', ['order.cancelled'], async (_key, evt) => {
    if (!evt.wasPaid) return;
    const key = `refund:${evt.orderId}`;
    if (await redis.get(key)) return;
    await sleep(800);
    await publish(ch, 'payment.refunded', { orderId: evt.orderId, userId: evt.userId, amountCents: evt.totalCents });
    await redis.set(key, '1', { EX: 30 * 86400 });
    payments.inc({ result: 'refunded' });
  });
})();
