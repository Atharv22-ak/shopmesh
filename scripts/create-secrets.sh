#!/usr/bin/env bash
# Creates the shopmesh-secrets Secret once (idempotent). Run BEFORE helm/Argo sync.
set -euo pipefail
NS="${NS:-shopmesh}"
kubectl get ns "$NS" >/dev/null 2>&1 || kubectl create ns "$NS"
if kubectl -n "$NS" get secret shopmesh-secrets >/dev/null 2>&1; then
  echo "secret shopmesh-secrets already exists in $NS - leaving it as is"; exit 0
fi
kubectl -n "$NS" create secret generic shopmesh-secrets \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=RABBITMQ_USER=shop \
  --from-literal=RABBITMQ_PASSWORD="$(openssl rand -hex 16)"
echo "created shopmesh-secrets in $NS"
