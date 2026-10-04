const test = require('node:test');
const assert = require('node:assert/strict');
const { STAGES, trackingNumber, nextStage, etaDate, canCancel } = require('../src/tracking');

test('tracking number is zero-padded', () => assert.equal(trackingNumber(12), 'SMX00000012'));
test('stages run to DELIVERED then stop', () => {
  let s = STAGES[0].status, n = 0;
  while (nextStage(s)) { s = nextStage(s).status; n++; }
  assert.equal(s, 'DELIVERED'); assert.equal(n, STAGES.length - 1);
});
test('order.shipped and order.delivered are emitted once each', () =>
  assert.deepEqual(STAGES.filter((s) => s.event).map((s) => s.event), ['order.shipped', 'order.delivered']));
test('only unshipped parcels can be cancelled', () => { assert.ok(canCancel('LABEL_CREATED')); assert.ok(!canCancel('IN_TRANSIT')); });
test('eta is 3 days out', () => assert.equal(etaDate(new Date('2026-01-01T00:00:00Z')), '2026-01-04'));
