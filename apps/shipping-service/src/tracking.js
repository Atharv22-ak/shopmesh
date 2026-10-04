// Pure shipment rules (no I/O) so they can be unit-tested.
const CARRIERS = ['ShopMesh Express', 'BlueDart Lite', 'Delhivery Demo'];
const STAGES = [
  { status: 'LABEL_CREATED', note: 'Shipping label created' },
  { status: 'PICKED_UP', note: 'Picked up by carrier', event: 'order.shipped' },
  { status: 'IN_TRANSIT', note: 'In transit to destination city' },
  { status: 'OUT_FOR_DELIVERY', note: 'Out for delivery' },
  { status: 'DELIVERED', note: 'Delivered', event: 'order.delivered' },
];

const trackingNumber = (orderId) => `SMX${String(orderId).padStart(8, '0')}`;
const carrierFor = (orderId) => CARRIERS[Number(orderId) % CARRIERS.length];
const nextStage = (status) => { const i = STAGES.findIndex((s) => s.status === status); return i >= 0 ? STAGES[i + 1] || null : null; };
const etaDate = (from, days = 3) => new Date(from.getTime() + days * 86400000).toISOString().slice(0, 10);
const canCancel = (status) => ['LABEL_CREATED'].includes(status);

module.exports = { STAGES, trackingNumber, carrierFor, nextStage, etaDate, canCancel };
