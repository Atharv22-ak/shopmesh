const { connect, publish, subscribe, health, sleep } = require('./events');
const FAIL_RATE = Number(process.env.PAYMENT_FAILURE_RATE || 0.1);

(async () => {
  health(process.env.PORT || 3004);
  const ch = await connect();
  await subscribe(ch, 'payment-service.orders', ['order.created'], async (_key, order) => {
    console.log('processing payment for order', order.orderId);
    await sleep(1500); // pretend to talk to a payment gateway
    const ok = Math.random() >= FAIL_RATE;
    publish(ch, ok ? 'payment.completed' : 'payment.failed',
      { orderId: order.orderId, userId: order.userId, amountCents: order.totalCents });
  });
})();
