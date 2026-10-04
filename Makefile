REGISTRY ?= rwxatharv
TAG      ?= v7
NS       ?= shopmesh
RELEASE  ?= shopmesh
DOMAIN   ?=            # e.g. 13.233.1.2.nip.io  (empty = use values.yaml)
NODEPORT ?=            # Gateway NodePort (empty = use values.yaml)
ELK      ?=            # true/false -> elk.enabled (empty = use values.yaml)

SET = --set global.imageRegistry=$(REGISTRY) --set global.imageTag=$(TAG) \
      $(if $(DOMAIN),--set gateway.domain=$(DOMAIN)) $(if $(NODEPORT),--set gateway.nodePort=$(NODEPORT)) \
      $(if $(ELK),--set elk.enabled=$(ELK))

.PHONY: build lint template secrets deploy status logs destroy up down elk-status kibana

build:            ## build + push all images
	REGISTRY=$(REGISTRY) TAG=$(TAG) ./scripts/build-push.sh
lint:
	helm lint infra $(SET)
template:
	helm template $(RELEASE) infra -n $(NS) $(SET)
secrets:          ## one-time: random passwords into Secret shopmesh-secrets
	NS=$(NS) ./scripts/create-secrets.sh
deploy: secrets   ## helm install/upgrade (or let Argo CD do it: kubectl apply -f argocd/argocd-app.yaml)
	helm upgrade --install $(RELEASE) infra -n $(NS) --create-namespace $(SET)
status:
	kubectl -n $(NS) get pods,svc,httproute,pvc
logs:             ## make logs S=order-service
	kubectl -n $(NS) logs -f deploy/$(S)
destroy:
	helm uninstall $(RELEASE) -n $(NS)
up:
	docker compose up --build
down:
	docker compose down -v
elk-status:       ## make elk-status  (after: make deploy ELK=true)
	kubectl -n $(NS) get pods,pvc -l app.kubernetes.io/part-of=shopmesh-elk
kibana:           ## port-forward Kibana -> http://localhost:5601
	kubectl -n $(NS) port-forward svc/kibana 5601:5601
