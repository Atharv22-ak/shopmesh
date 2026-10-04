# What changed in this version (v7)

## Bug fixes
- apps/*/src/events.js  (all 5 copies)  `ch.connection = conn` broke amqplib -> crash loop in order/payment/product/notification. Now `ch.conn`. publish/subscribe now carry `messageId`.
- apps/frontend/index.html              router syntax error fixed (UI did not load).
- docker-compose.yaml                   notification route + env added.

## New: shipping-service  (apps/shipping-service/)
- src/index.js, src/tracking.js, src/common.js, test/tracking.test.js

## Wiring
- apps/order-service/src/index.js       follows shipment events; old warehouse timer only if FULFILMENT_SIM=true
- apps/api-gateway/src/index.js         /api/shipments (JWT)
- apps/notification-worker/src/index.js shipment.* events + tracking in e-mail text
- apps/frontend/index.html              tracking timeline on Orders page
- infra/values.yaml                     shipping-service, gateway env, imageTag v7
- .github/workflows/build-push.yaml     shipping-service in matrix, default tag v7
- scripts/build-push.sh, scripts/smoke-test.sh, Makefile (TAG v7), README.md

## IMPORTANT: git
Many files are NEW/untracked in your repo (shipping-service/, */src/common.js, pricing.js, package-lock.json, smoke-test.sh).
Use `git add -A` (not `git commit -a`) or they will not be pushed and the Docker builds will fail.

## Round 2: catalogue + images
- apps/product-service/src/seed.js (NEW)   119 products in 12 categories (was 29). Seeded idempotently on start, existing price/stock untouched.
- apps/product-service/src/index.js        uses seed.js, new optional `image_url` column, cache key products:v3:all.
- apps/frontend/index.html                 images were broken: via.placeholder.com is dead. Now generated SVG art (no external requests);
                                           set products.image_url to use a real photo (auto-falls back to the SVG if it fails to load).
                                           "New" badge only on the 8 newest items; bigger image on the product page.
- apps/shipping-service/package.json       added missing `express` dependency.
