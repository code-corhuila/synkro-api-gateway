# synkro-api-gateway

> Single entry point: authentication, routing and rate limiting

Part of the **SynkroTech SAS Sales Management System** — organization `code-corhuila`.
Governance and documentation live in [`synkro-docs`](https://github.com/code-corhuila/synkro-docs).

## Branching

Three permanent branches. **None of them accepts a direct commit** — you enter through a child
branch and leave through a Pull Request.

```
develop  <--PR--  feat/... fix/... chore/...
qa       <--PR--  qa/...
main     <--PR--  release/...  hotfix/...
```

Promotion happens **by re-application** (`git cherry-pick -x`), never by merging one permanent
branch into another: `merge develop -> qa` and `merge qa -> main` do not exist in this model.

`main` requires **1 approval from `ariel5253`**. On `develop` and `qa` the team sets its own review
rule.

Full policy: `00-governance/branching-policy.md` in `synkro-docs`.

## Running locally

```bash
docker network inspect platform >/dev/null 2>&1 || docker network create platform
cp .env.example .env
cd deploy && docker compose --env-file ../.env up -d --build
```

Upstreams are resolved per request, so the gateway starts even when none of them is running; their
routes answer `503` until the service joins the `platform` network.

## Running the tests

```bash
./tests/smoke.sh
```

Test 3 expects `synkro-products-api` to be running on the `platform` network. Without it, run
`PRODUCTS_API_AVAILABLE=false ./tests/smoke.sh` (as CI does).
