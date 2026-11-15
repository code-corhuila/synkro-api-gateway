FROM nginx:1.27-alpine
COPY --chmod=755 deploy/19-customer-list-budget.envsh /docker-entrypoint.d/19-customer-list-budget.envsh
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
COPY snippets/ /etc/nginx/snippets/
EXPOSE 8000
