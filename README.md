# ShopMesh — mini e-commerce on Kubernetes (Helm)

```
                    ┌────────────┐   /api/*    ┌─────────────┐
 browser ─────────► │  frontend  │ ──────────► │ api-gateway │  (JWT check)
   Gateway API      │  (nginx)   │             └──────┬──────┘
                    └────────────┘        ┌───────────┼─────────────┐
                                          ▼           ▼             ▼
                                   user-service  product-service  order-service ──► Redis (cart)
                                     Postgres      Postgres+Redis   Postgres  │
                                                    (cache)                   │ publish order.created
                                                                              ▼
                                                                  ┌──────────────────────┐
                                                                  │  RabbitMQ shop.events │
                                                                  └───┬──────────────┬───┘
                                        order.created                 │              │ order.* / payment.*
                                                          payment-service      notification-worker
                                                          (mock, 1.5s, 10% fail)     (logs "email")
                                                                  │ payment.completed / payment.failed
                                                                  └──► order-service updates status
```

## Learning goals -> where to look
| Concept | File |
|---|---|
| Sync service-to-service (HTTP) | `order-service` -> `product-service` in `POST /checkout` |
| API gateway + JWT | `apps/api-gateway/src/index.js` |
| Async events (topic exchange) | `events.js` (order/payment/notification) |
| Cache | `product-service` (Redis, 30s TTL, `X-Cache` header) |
| Cart in Redis | `order-service` `/cart` |
| Helm loop over services | `infra/templates/services.yaml` |
| Gateway API routes | `infra/templates/httproutes.yaml` |

## Repo layout (same as devops-platform-v1)
```
shopmesh/
├── apps/                # one folder per microservice (own Dockerfile)
├── infra/               # ONE flat Helm chart: apps + postgres + redis + rabbitmq + HTTPRoutes
│   ├── Chart.yaml
│   ├── values.yaml      # gateway/domain, images, resources, routes
│   └── templates/
├── argocd/              # Argo CD Application + HTTPRoute
├── scripts/             # build-push.sh, create-secrets.sh, init-db.sql
├── docker-compose.yaml  # local dev without k8s
└── Makefile
```

## Cluster prerequisites (same as the old cluster)
- Gateway API CRDs + a Gateway controller, with a Gateway `my-gateway` in `default` that accepts routes from all namespaces
- `local-path` as default StorageClass (Postgres PVC)
- (optional) Argo CD in namespace `argocd`

## Deploy
Images ya to local `make build` se, ya GitHub Actions (`.github/workflows/build-push.yaml`) se push hote hain. Repo Settings -> Secrets me `DOCKERHUB_USERNAME` aur `DOCKERHUB_TOKEN` (Docker Hub access token) add karo.

```bash
# 1. images (docker login rwxatharv pehle)
make build

# 2. values check: infra/values.yaml -> gateway.domain / gateway.nodePort NEW cluster ke hisaab se
#    ya command line se:  make deploy DOMAIN=<node-ip>.nip.io NODEPORT=<gateway-nodeport>
make lint
make deploy            # creates random secrets once, then helm upgrade --install

make status
```
URLs: `http://shop.<domain>:<nodePort>` (UI), `http://api.<domain>:<nodePort>/api/products`, `http://rabbitmq.<domain>:<nodePort>`.

### GitOps with Argo CD
```bash
git init && git remote add origin <your repo> && git push -u origin main
make secrets                                   # Secret Argo ke bahar banta hai (jaanbujhkar)
kubectl apply -f argocd/argocd-app.yaml        # repoURL edit karna mat bhoolna
kubectl apply -f argocd/argocd-httproute.yaml  # optional: argocd.<domain>
```
Note: Argo CD `helm template` se render karta hai, isliye `lookup`/`randAlphaNum` wale secrets har sync pe badal jate hain. Isliye secrets chart ke bahar (`create-secrets.sh`) rakhe hain.

## Next steps (ideas)
Old chart ke `monitoring/` (Prometheus + Grafana) aur `elk/` (Filebeat + ELK) templates yahan copy karke `ServiceMonitor`-free scrape config se add kar sakte ho; HPA on api-gateway; NetworkPolicies; CI (GitHub Actions build -> tag bump -> Argo sync); Kafka swap; stock decrement on `payment.completed`.
