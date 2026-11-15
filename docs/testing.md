# Testing

Detailed procedures and delivery notes moved from the repository README at
[source 24a4ab1](https://github.com/code-corhuila/synkro-api-gateway/blob/24a4ab157bb000e152e5e4567f16deb3ebadcf05/README.md).
Recorded execution results retain their original scope; moving them does not
constitute a new execution or certify a different revision.

Run commands from the repository root unless a step explicitly changes directory.

## Running the tests

```bash
./tests/smoke.sh
```

Test 3 expects `synkro-products-api` to be running on the `platform` network. Without it, run
`PRODUCTS_API_AVAILABLE=false ./tests/smoke.sh` (as CI does).

`POST /api/v1/auth/login` has its own rate limit (5 quick attempts per IP, then one per minute), so
the smoke suite can only run about once a minute against the same gateway. Restart it
(`docker compose restart`) to reset the limiter between runs. Tests 4 and 8 expect
`synkro-auth-api` to be absent (502/503).
