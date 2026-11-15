# Local development

Detailed procedures and delivery notes moved from the repository README at
[source 24a4ab1](https://github.com/code-corhuila/synkro-api-gateway/blob/24a4ab157bb000e152e5e4567f16deb3ebadcf05/README.md).
Recorded execution results retain their original scope; moving them does not
constitute a new execution or certify a different revision.

Run commands from the repository root unless a step explicitly changes directory.

## Running locally

```bash
docker network inspect platform >/dev/null 2>&1 || docker network create platform
cp .env.example .env
cd deploy && docker compose --env-file ../.env up -d --build
```

Upstreams are resolved per request, so the gateway starts even when none of them is running; their
routes answer `503` until the service joins the `platform` network.
