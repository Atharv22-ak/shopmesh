const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTotals, applyCoupon, canTransition } = require('../src/pricing');

test('shipping fee below the free-delivery threshold', () => {
  const t = computeTotals(30000);
  assert.equal(t.shippingCents, 4000);
  assert.equal(t.totalCents, 34000);
});

test('free delivery from ₹500', () => {
  assert.equal(computeTotals(50000).shippingCents, 0);
});

test('WELCOME10 is capped at ₹200', () => {
  assert.equal(computeTotals(100000, 'welcome10').discountCents, 10000);
  assert.equal(computeTotals(1000000, 'WELCOME10').discountCents, 20000);
});

test('FLAT100 needs ₹1,000 minimum', () => {
  assert.throws(() => applyCoupon('FLAT100', 99999), /minimum order/);
  assert.equal(computeTotals(150000, 'FLAT100').totalCents, 140000);
});

test('FREESHIP removes the fee on small orders', () => {
  assert.equal(computeTotals(10000, 'FREESHIP').totalCents, 10000);
});

test('unknown coupon is rejected with 400', () => {
  assert.throws(() => applyCoupon('NOPE', 1000), (e) => e.status === 400);
});

test('order state machine', () => {
  assert.ok(canTransition('PENDING', 'PAID'));
  assert.ok(canTransition('PAID', 'CANCELLED'));
  assert.ok(!canTransition('SHIPPED', 'CANCELLED'));
  assert.ok(!canTransition('DELIVERED', 'PAID'));
  assert.ok(!canTransition('CANCELLED', 'PAID'));
});
