#!/usr/bin/env bash
set -uo pipefail

BASE="http://localhost:8000"
PASS=0
FAIL=0

check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $desc"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc (expected $expected, got $actual)"
    FAIL=$((FAIL+1))
  fi
}

# 1. /health is public and answers 200
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
check "/health returns 200" "200" "$status"

# 2. No Authorization header -> 401, before reaching any upstream
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/products")
check "no Authorization -> 401" "401" "$status"

# 3. A malformed-but-present Authorization header is forwarded unchanged —
#    the gateway only checks presence, never validity. synkro-products-api
#    is real (HU-PRO-03) and its own middleware answers 401 for a malformed
#    token, so the end-to-end result is still 401, but for a different
#    reason than test 2 — if this one passed without the gateway actually
#    forwarding the request, that would be a false positive worth noticing.
#    Where synkro-products-api isn't running (CI), set
#    PRODUCTS_API_AVAILABLE=false: the forwarded request then ends in
#    502/503, which still proves it got past the gateway's own 401 gate.
status=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer not-a-real-token" "$BASE/api/v1/products")
if [ "${PRODUCTS_API_AVAILABLE:-true}" = "true" ]; then
  check "malformed-but-present token forwarded to upstream" "401" "$status"
elif [ "$status" = "502" ] || [ "$status" = "503" ]; then
  echo "PASS: malformed-but-present token forwarded (products-api absent, got $status)"; PASS=$((PASS+1))
else
  echo "FAIL: malformed-but-present token forwarded (products-api absent, expected 502/503, got $status)"; FAIL=$((FAIL+1))
fi

# 4. A path whose upstream doesn't exist yet answers 502/503, never a raw
#    connection error or an NGINX default error page.
status=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer x.y.z" "$BASE/api/v1/auth/login")
if [ "$status" = "502" ] || [ "$status" = "503" ]; then
  echo "PASS: nonexistent upstream returns 502/503 (got $status)"
  PASS=$((PASS+1))
else
  echo "FAIL: nonexistent upstream returns 502/503 (got $status)"
  FAIL=$((FAIL+1))
fi

# 5. Correlation ID: generated when absent, echoed back when sent
corr=$(curl -s -D - -o /dev/null "$BASE/health" | grep -i "X-Correlation-Id" | tr -d '\r')
[ -n "$corr" ] && { echo "PASS: X-Correlation-Id generated when absent"; PASS=$((PASS+1)); } \
               || { echo "FAIL: X-Correlation-Id missing"; FAIL=$((FAIL+1)); }

sent="test-correlation-123"
corr2=$(curl -s -D - -o /dev/null -H "X-Correlation-Id: $sent" "$BASE/health" | grep -i "X-Correlation-Id" | tr -d '\r')
case "$corr2" in
  *"$sent"*) echo "PASS: X-Correlation-Id echoed back"; PASS=$((PASS+1)) ;;
  *) echo "FAIL: X-Correlation-Id not echoed (got: $corr2)"; FAIL=$((FAIL+1)) ;;
esac

# 6. CORS: allowed origin gets the header, a different origin does not
cors_ok=$(curl -s -D - -o /dev/null -H "Origin: http://localhost:5173" -H "Authorization: Bearer x.y.z" "$BASE/api/v1/products" | grep -i "Access-Control-Allow-Origin" | tr -d '\r')
case "$cors_ok" in
  *"http://localhost:5173"*) echo "PASS: CORS header present for the allowed origin"; PASS=$((PASS+1)) ;;
  *) echo "FAIL: CORS header missing for the allowed origin"; FAIL=$((FAIL+1)) ;;
esac

# An absent header only means something if a response actually arrived —
# otherwise this check would pass against a server that isn't running.
headers_bad=$(curl -s -D - -o /dev/null -H "Origin: http://evil.example" -H "Authorization: Bearer x.y.z" "$BASE/api/v1/products" | tr -d '\r')
cors_bad=$(printf '%s\n' "$headers_bad" | grep -i "Access-Control-Allow-Origin")
if [ -z "$headers_bad" ]; then
  echo "FAIL: CORS header absent for a disallowed origin (no response at all)"; FAIL=$((FAIL+1))
elif [ -z "$cors_bad" ]; then
  echo "PASS: CORS header absent for a disallowed origin"; PASS=$((PASS+1))
else
  echo "FAIL: CORS header wrongly present for a disallowed origin (got: $cors_bad)"; FAIL=$((FAIL+1))
fi

# 7. Rate limiting — run LAST: it deliberately exhausts the limiter, which
#    would pollute every test above if it ran earlier.
#    The burst goes out from ONE curl process in parallel: a loop spawning
#    one curl per request is slow enough on some hosts (~90ms each on
#    Windows) to stay under 10 r/s and never exhaust the bucket.
burst_args=()
for i in $(seq 1 40); do burst_args+=(-o /dev/null "$BASE/api/v1/products"); done
codes=$(curl -s -Z --parallel-max 40 -w "%{http_code}\n" -H "Authorization: Bearer x.y.z" "${burst_args[@]}")
if printf '%s\n' "$codes" | grep -qx "429"; then
  echo "PASS: rate limit triggers 429 under burst"; PASS=$((PASS+1))
else
  echo "FAIL: rate limit never triggered after 40 parallel requests (got: $(printf '%s ' $codes))"; FAIL=$((FAIL+1))
fi

echo ""
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
