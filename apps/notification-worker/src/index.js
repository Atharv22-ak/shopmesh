const { connect, subscribe, health } = require('./events');

(async () => {
  health(process.env.PORT || 3005);
  const ch = await connect();
  await subscribe(ch, 'notification-worker.all', ['order.*', 'payment.*'], async (key, evt) => {
    // real life: send email/SMS. Here: log it.
    console.log(`[NOTIFY] user=${evt.userId} event=${key} order=${evt.orderId}`);
  });
})();
