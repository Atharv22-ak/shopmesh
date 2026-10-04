// Pure business rules (no I/O) so they can be unit-tested. All money is in paise (1/100 rupee).
const FREE_SHIPPING_MIN = Number(process.env.FREE_SHIPPING_MIN_CENTS || 50000);   // ₹500
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE_CENTS || 4000);               // ₹40

const COUPONS = {
  WELCOME10: { type: 'percent', value: 10, maxCents: 20000, minCents: 0, description: '10% off, up to ₹200' },
  FLAT100: { type: 'flat', value: 10000, minCents: 100000, description: '₹100 off on orders above ₹1,000' },
  FREESHIP: { type: 'shipping', minCents: 0, description: 'Free delivery on any order' },
};

const err = (status, message) => Object.assign(new Error(message), { status });

function applyCoupon(code, subtotalCents) {
  if (!code) return { code: null, discountCents: 0, freeShipping: false, description: null };
  const key = String(code).trim().toUpperCase();
  const c = COUPONS[key];
  if (!c) throw err(400, 'invalid coupon code');
  if (subtotalCents < c.minCents) throw err(400, `${key} needs a minimum order of ₹${c.minCents / 100}`);
  let discountCents = 0;
  if (c.type === 'percent') discountCents = Math.min(Math.floor((subtotalCents * c.value) / 100), c.maxCents);
  if (c.type === 'flat') discountCents = Math.min(c.value, subtotalCents);
  return { code: key, discountCents, freeShipping: c.type === 'shipping', description: c.description };
}

function computeTotals(subtotalCents, couponCode) {
  const coupon = applyCoupon(couponCode, subtotalCents);
  const qualifies = subtotalCents >= FREE_SHIPPING_MIN || coupon.freeShipping;
  const shippingCents = qualifies ? 0 : SHIPPING_FEE;
  return {
    subtotalCents, discountCents: coupon.discountCents, shippingCents,
    totalCents: subtotalCents - coupon.discountCents + shippingCents,
    coupon: coupon.code, couponDescription: coupon.description,
  };
}

// order lifecycle: who may move where (enforced in SQL via `WHERE status = ANY(from)`)
const TRANSITIONS = {
  PENDING: ['PAID', 'PAYMENT_FAILED', 'CANCELLED'],
  PAID: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  PAYMENT_FAILED: [], CANCELLED: [], DELIVERED: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

module.exports = { COUPONS, FREE_SHIPPING_MIN, SHIPPING_FEE, applyCoupon, computeTotals, canTransition, TRANSITIONS };
