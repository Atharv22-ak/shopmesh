#!/usr/bin/env bash
# End-to-end check of the whole platform through the API gateway.
#   usage: BASE=http://localhost:8080 ./scripts/smoke-test.sh
# Works with the default 10% payment failure rate (both outcomes are verified), but is fastest/most
# deterministic with PAYMENT_FAILURE_RATE=0 STEP_SEC=2 on shipping-service.
set -uo pipefail
BASE="${BASE:-http://localhost:8080}"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✔ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✘ $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }
section() { echo; echo "== $1"; }

# api METHOD PATH [TOKEN] [JSON] [extra curl args...]  -> body in $BODY, status in $CODE
api() {
  local m=$1 p=$2 t=${3:-} d=${4:-}; shift 4 2>/dev/null || shift $#
  local args=(-s -o /tmp/smoke.body -w '%{http_code}' -X "$m" "$BASE/api$p" -H 'Content-Type: application/json')
  [ -n "$t" ] && args+=(-H "Authorization: Bearer $t")
  [ -n "$d" ] && args+=(-d "$d")
  CODE=$(curl "${args[@]}" "$@"); BODY=$(cat /tmp/smoke.body)
}
j() { echo "$BODY" | jq -r "$1"; }
register() {  # -> token
  local e="smoke$RANDOM$RANDOM@example.com"
  api POST /auth/register "" "{\"email\":\"$e\",\"password\":\"password123\",\"name\":\"Smoke $RANDOM\"}"
  api POST /auth/login "" "{\"email\":\"$e\",\"password\":\"password123\"}"; j .token
}
stock_of() { api GET "/products/$1"; j .stock; }
wait_status() {  # wait_status TOKEN ORDER_ID "STATUS1|STATUS2" SECONDS
  local i; for i in $(seq 1 $(( $4 * 2 ))); do
    api GET /orders/$2 "$1"; echo "$BODY" | jq -r .status | grep -Eq "^($3)$" && return 0; sleep 0.5
  done; return 1
}

section "waiting for the gateway"
for i in $(seq 1 60); do curl -sf "$BASE/healthz" >/dev/null && curl -sf "$BASE/api/products" >/dev/null && break; sleep 2; done
curl -sf "$BASE/api/products" >/dev/null && ok "gateway + product-service reachable" || { bad "gateway not reachable at $BASE"; exit 1; }

section "auth"
api POST /auth/register "" '{"email":"not-an-email","password":"password123"}'; check "invalid email rejected" "$CODE" 400
api POST /auth/register "" '{"email":"a@b.co","password":"short"}';            check "short password rejected" "$CODE" 400
TOKEN=$(register);  [ -n "$TOKEN" ] && [ "$TOKEN" != null ] && ok "register + login" || { bad "login failed"; exit 1; }
api GET /orders;                                          check "orders without token -> 401" "$CODE" 401
api GET /products "" "" -H 'x-user-id: 1';                check "public route ignores spoofed x-user-id" "$CODE" 200

section "catalogue"
api GET /products; PID=$(echo "$BODY" | jq -r '.[] | select(.name=="Phone Case") | .id'); [ -n "$PID" ] && ok "found product $PID" || bad "Phone Case missing"
api GET /products/abc;  check "bad product id -> 404 (not a crash)" "$CODE" 404
api GET /internal/reserve; check "internal endpoints are not exposed via gateway" "$CODE" 404

section "cart, coupons, pricing"
S0=$(stock_of $PID)
api POST /cart/items "$TOKEN" "{\"productId\":$PID,\"qty\":2}";   check "add to cart" "$CODE" 200
api POST /cart/items "$TOKEN" "{\"productId\":$PID,\"qty\":99}";  check "qty > 10 rejected" "$CODE" 400
api POST /cart/items "$TOKEN" '{"productId":999999,"qty":1}';     check "unknown product rejected" "$CODE" 404
api POST /cart/quote "$TOKEN" '{"coupon":"NOPE"}';               check "invalid coupon -> 400" "$CODE" 400
api POST /cart/quote "$TOKEN" '{"coupon":"WELCOME10"}'
SUB=$(j .subtotalCents); DISC=$(j .discountCents); SHIP=$(j .shippingCents); TOT=$(j .totalCents)
check "10% discount applied" "$DISC" $(( SUB / 10 ))
check "total = subtotal - discount + shipping" "$TOT" $(( SUB - DISC + SHIP ))

section "checkout, idempotency, stock reservation"
KEY="smoke-$RANDOM-$RANDOM"
api POST /checkout "$TOKEN" '{"address":"1 Test Street, Pune","coupon":"WELCOME10"}' -H "Idempotency-Key: $KEY"
check "checkout accepted (202)" "$CODE" 202; OID=$(j .id); check "order total = quote" "$(j .total_cents)" "$TOT"
api POST /checkout "$TOKEN" '{"address":"1 Test Street, Pune","coupon":"WELCOME10"}' -H "Idempotency-Key: $KEY"
check "same Idempotency-Key returns the SAME order" "$(j .id)" "$OID"
check "stock reserved immediately" "$(stock_of $PID)" $(( S0 - 2 ))
api GET /cart "$TOKEN"; check "cart emptied" "$BODY" "{}"

section "payment saga + fulfilment"
if wait_status "$TOKEN" "$OID" "PAID|SHIPPED|DELIVERED|PAYMENT_FAILED" 20; then
  api GET /orders/$OID "$TOKEN"; ST=$(j .status)
  if [ "$ST" = PAYMENT_FAILED ]; then
    ok "payment failed (simulated) -> status PAYMENT_FAILED"
    sleep 1.5; check "stock released after failed payment" "$(stock_of $PID)" "$S0"
  else
    ok "payment succeeded -> $ST"
    if wait_status "$TOKEN" "$OID" "DELIVERED" 90; then ok "order shipped and delivered"; else bad "order never reached DELIVERED"; fi
    api GET "/shipments/$OID" "$TOKEN"; check "shipment tracking available" "$CODE" 200
    check "tracking number format" "$(j .trackingNumber | cut -c1-3)" SMX
    T2=$(register); api GET "/shipments/$OID" "$T2"; check "other users cannot see this shipment" "$CODE" 404
    api GET /orders/$OID "$TOKEN"; [ "$(echo "$BODY" | jq '.history | length')" -ge 4 ] && ok "status timeline recorded ($(j '.history|length') entries)" || bad "timeline too short"
  fi
else bad "order stayed PENDING (is payment-service running?)"; fi

section "cancel + refund"
api POST /cart/items "$TOKEN" "{\"productId\":$PID,\"qty\":1}" >/dev/null
S1=$(stock_of $PID)
api POST /checkout "$TOKEN" '{"address":"2 Test Street, Pune"}' -H "Idempotency-Key: c-$RANDOM$RANDOM"; COID=$(j .id)
api POST /orders/$COID/cancel "$TOKEN"; check "cancel accepted" "$CODE" 200; check "status CANCELLED" "$(j .status)" CANCELLED
api POST /orders/$COID/cancel "$TOKEN"; check "cancelling twice -> 409" "$CODE" 409
sleep 4; check "stock restored after cancel" "$(stock_of $PID)" "$S1"
api GET /orders/$COID "$TOKEN"; echo "$BODY" | jq -r '.history[].note' | grep -qi refund && ok "refund recorded (paid before cancel)" || ok "no refund needed (cancelled before payment)"
OTHER=$(register); api POST /orders/$COID/cancel "$OTHER"; check "cannot cancel someone else's order" "$CODE" 404

section "overselling protection (parallel checkouts)"
api GET /products; CID=$(echo "$BODY" | jq -r '.[] | select(.name=="Ergonomic Chair") | .id'); CS=$(stock_of $CID)
EXPECT=$(( CS / 10 )); [ $EXPECT -gt 4 ] && EXPECT=4
declare -a T; for n in 1 2 3 4; do T[$n]=$(register); api POST /cart/items "${T[$n]}" "{\"productId\":$CID,\"qty\":10}" >/dev/null; done
rm -f /tmp/smoke.par.*; for n in 1 2 3 4; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/checkout" -H "Authorization: Bearer ${T[$n]}" -H 'Content-Type: application/json' -d '{"address":"par"}' > /tmp/smoke.par.$n & done; wait
GOT=$(cat /tmp/smoke.par.* | grep -c '^202$'); check "exactly $EXPECT of 4 parallel orders (qty 10 each, stock $CS) succeeded" "$GOT" "$EXPECT"

section "notifications + reviews"
api GET /notifications "$TOKEN"; [ "$(echo "$BODY" | jq '.items|length')" -ge 1 ] && ok "in-app notifications delivered ($(j .unread) unread)" || bad "no notifications"
api POST /notifications/read "$TOKEN"; api GET /notifications "$TOKEN"; check "mark as read" "$(j .unread)" 0
api POST /products/$PID/reviews "" '{"rating":5}';                   check "review without login -> 401" "$CODE" 401
api POST /products/$PID/reviews "$TOKEN" '{"rating":9}';             check "invalid rating -> 400" "$CODE" 400
api POST /products/$PID/reviews "$TOKEN" '{"rating":5,"title":"Great","body":"Works well"}'; check "post review" "$CODE" 201
api POST /products/$PID/reviews "$TOKEN" '{"rating":4,"title":"Updated","body":"Still good"}'; api GET /products/$PID/reviews
check "one review per customer (upsert)" "$(echo "$BODY" | jq '[.reviews[]|select(.title=="Updated")]|length')" 1

echo; echo "passed: $PASS   failed: $FAIL"; [ "$FAIL" -eq 0 ]
