FROM nginx:1.27-alpine
ENV API_GATEWAY_URL=http://api-gateway:8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html /usr/share/nginx/html/index.html
