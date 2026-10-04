#!/usr/bin/env bash
# Usage: REGISTRY=docker.io/myuser TAG=0.1.0 ./scripts/build-push.sh [service ...]
set -euo pipefail
REGISTRY="${REGISTRY:?set REGISTRY, e.g. docker.io/myuser}"
TAG="${TAG:-0.1.0}"
ALL=(frontend api-gateway user-service product-service order-service payment-service notification-worker shipping-service)
SERVICES=("${@:-${ALL[@]}}")

for s in "${SERVICES[@]}"; do
  img="$REGISTRY/shopmesh-$s:$TAG"
  echo ">>> building $img"
  docker build -t "$img" "apps/$s"
  docker push "$img"
done
