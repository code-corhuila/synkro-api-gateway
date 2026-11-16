# Stable local traffic entry

Trace: NFR-004/007/009 → HU-INF-09/#325 →
`tests/blue-green-entry.test.mjs` → `deploy/blue-green-entry.*`.
Design authority: Accepted ADR-024, published inline in the existing central
`10-devops/ci-cd.md`. Earlier accepted records and normal gateway routes are unchanged.

The entry forwards web traffic to the active Host and API traffic to the active
Gateway. It validates neither identity nor business payloads itself; requests
still cross the unchanged owning Gateway and services. Slots publish no ports.
The outer entry alone binds loopback5173/8000 and joins both private slot networks.

Infra renders only validated `__ACTIVE_HOST__`, `__ACTIVE_GATEWAY__` and `__SLOT__`
values. It mounts a directory so an atomic file replacement is visible to NGINX,
checks the candidate with nginx -t, reloads gracefully and retains the previous
configuration/state for rollback. Upstream errors never trigger POST replay.
The 30-second worker drain exceeds the 15-second proxy response bound.

Only missing public content-hashed GET/HEAD assets can be served from the retained
archive. index.html, remoteEntry.js, APIs and other methods cannot use the fallback.
Archive exact public files before retiring a slot; never copy keys/configuration,
replace a colliding path with different bytes or silently delete old assets.

This entry supplies no database failover or Worker scheduling continuity. Application
overlap requires compatible contracts/schema and the same Workflow lock algorithm.
Initial port handoff is preparation, not a measured zero-interruption rollout.
Owning root acceptance must exercise real authenticated traffic, a browser, actual
image identities, change/rollback and unchanged persisted records.
