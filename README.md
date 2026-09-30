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

## ELK + Filebeat (optional, `values.yaml` me true/false)
```
pods stdout/stderr -> Filebeat (DaemonSet) -> Logstash -> Elasticsearch -> Kibana
```
| Switch | Meaning |
|---|---|
| `elk.enabled` | master switch (default `false`) |
| `elk.elasticsearch.enabled` / `elk.logstash.enabled` / `elk.kibana.enabled` / `elk.filebeat.enabled` | har component alag on/off |
| `elk.logstash.enabled: false` | Filebeat seedha Elasticsearch ko bhejta hai (~1Gi RAM bachti hai) |
| `elk.kibana.route.enabled` | Kibana ko `kibana.<domain>:<nodePort>` pe expose karo |
| `elk.elasticsearch.persistence.enabled` | ES data PVC (local-path) |
| `elk.retentionDays` | itne din baad purane log indices auto-delete (ILM) |

```bash
make deploy ELK=true            # ya: helm upgrade --install shopmesh infra -n shopmesh --set elk.enabled=true
make elk-status
make kibana                     # port-forward, agar route off hai
```
Kibana me pehle se ek data view **ShopMesh Logs** bana hota hai -> Discover kholo. Useful filters: `service : "order-service"`, `level : "error"`, `order_id : 12`.
Argo CD me: `argocd/argocd-app.yaml` ke `source:` ke neeche `helm: { parameters: [{ name: elk.enabled, value: "true" }] }` ya seedha `values.yaml` me `enabled: true` commit karo.

**Dhyan rakho:** Elasticsearch/Kibana me security OFF hai (demo/learning setup) aur Kibana route public hai — production me `kibana.route.enabled: false` rakho ya Elastic security + auth lagao. Sab ON = ~4 GB RAM.

## Next steps (ideas)
Old chart ke `monitoring/` (Prometheus + Grafana) templates copy karke add kar sakte ho (ELK ab add ho chuka hai); HPA on api-gateway; NetworkPolicies; CI (GitHub Actions build -> tag bump -> Argo sync); Kafka swap; stock decrement on `payment.completed`.
