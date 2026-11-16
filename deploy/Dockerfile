FROM nginx:1.30.6-alpine@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a
RUN apk upgrade --no-cache \
    && apk del nginx-module-xslt nginx-module-njs nginx-module-image-filter nginx-module-geoip nginx-module-acme
COPY --chmod=755 deploy/19-customer-list-budget.envsh /docker-entrypoint.d/19-customer-list-budget.envsh
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY snippets/ /etc/nginx/snippets/
EXPOSE 8000
