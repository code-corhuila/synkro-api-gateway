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
#    connection error or an NGINX default error page. login is public, so
#    this sends no Authorization: a 502/503 here also proves the gateway
#    itself let an unauthenticated request through.
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/login")
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

# 8. Public auth routes (HU-GTW-02): login and refresh need no Authorization.
#    synkro-auth-api is not running here, so "the gateway let it through"
#    shows up as 502/503 — never the gateway's own 401.
#    Login has its own tight rate limit that survives only a handful of
#    requests per minute per IP, so the login requests in this suite are
#    kept to a minimum (and a re-run needs ~1 minute, or a restarted gateway).
check_passes_gateway() {
  local desc="$1" status="$2"
  if [ "$status" = "502" ] || [ "$status" = "503" ]; then
    echo "PASS: $desc (got $status)"; PASS=$((PASS+1))
  else
    echo "FAIL: $desc (expected 502/503, got $status)"; FAIL=$((FAIL+1))
  fi
}

# (login without Authorization is covered by test 4, which spares login's
# small rate budget.)

status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/auth/refresh")
check_passes_gateway "refresh without Authorization is not rejected by the gateway" "$status"

# register stays protected: no header -> the gateway's own 401 (its JSON
# body proves the request never reached an upstream).
body=$(curl -s -w "\n%{http_code}" -X POST "$BASE/api/v1/auth/register")
check "register without Authorization -> 401" "401" "${body##*$'\n'}"
case "$body" in
  *"a valid Authorization header is required"*) echo "PASS: register 401 comes from the gateway, not an upstream"; PASS=$((PASS+1)) ;;
  *) echo "FAIL: register 401 body is not the gateway's (got: $body)"; FAIL=$((FAIL+1)) ;;
esac

# Any value is enough: the gateway checks presence, never content.
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer x.y.z" "$BASE/api/v1/auth/register")
check_passes_gateway "register with Authorization reaches the upstream" "$status"

for route in "GET /api/v1/auth/users/1" "POST /api/v1/auth/service-tokens" "POST /api/v1/auth/logout"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X "${route%% *}" "$BASE${route#* }")
  check "${route} without Authorization -> 401" "401" "$status"
done

# CORS and correlation ID behave on the public login location exactly as on
# protected ones (same assertions as tests 5 and 6, no Authorization sent).
# Two requests cover all four assertions to spare login's rate budget.
h1=$(curl -s -D - -o /dev/null -X POST -H "Origin: http://localhost:5173" "$BASE/api/v1/auth/login" | tr -d '\r')
printf '%s\n' "$h1" | grep -qi "^X-Correlation-Id: ." \
  && { echo "PASS: login: X-Correlation-Id generated when absent"; PASS=$((PASS+1)); } \
  || { echo "FAIL: login: X-Correlation-Id missing"; FAIL=$((FAIL+1)); }
case "$(printf '%s\n' "$h1" | grep -i "Access-Control-Allow-Origin")" in
  *"http://localhost:5173"*) echo "PASS: login: CORS header present for the allowed origin"; PASS=$((PASS+1)) ;;
  *) echo "FAIL: login: CORS header missing for the allowed origin"; FAIL=$((FAIL+1)) ;;
esac

h2=$(curl -s -D - -o /dev/null -X POST -H "Origin: http://evil.example" -H "X-Correlation-Id: $sent" "$BASE/api/v1/auth/login" | tr -d '\r')
case "$(printf '%s\n' "$h2" | grep -i "X-Correlation-Id")" in
  *"$sent"*) echo "PASS: login: X-Correlation-Id echoed back"; PASS=$((PASS+1)) ;;
  *) echo "FAIL: login: X-Correlation-Id not echoed"; FAIL=$((FAIL+1)) ;;
esac
if [ -z "$h2" ]; then
  echo "FAIL: login: CORS header absent for a disallowed origin (no response at all)"; FAIL=$((FAIL+1))
elif ! printf '%s\n' "$h2" | grep -qi "Access-Control-Allow-Origin"; then
  echo "PASS: login: CORS header absent for a disallowed origin"; PASS=$((PASS+1))
else
  echo "FAIL: login: CORS header wrongly present for a disallowed origin"; FAIL=$((FAIL+1))
fi

# Preflight on the public route is answered by the gateway, never forwarded.
status=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST" "$BASE/api/v1/auth/login")
check "login preflight -> 204" "204" "$status"

# 9. Login has its own, much tighter rate limit (security-threat-model S-1).
#    It exhausts only the login zone, so it runs before test 7 and then
#    proves a protected route is still served from the untouched general zone.
login_args=()
for i in $(seq 1 15); do login_args+=(-o /dev/null "$BASE/api/v1/auth/login"); done
codes=$(curl -s -Z --parallel-max 15 -X POST -w "%{http_code}\n" "${login_args[@]}")
if printf '%s\n' "$codes" | grep -qx "429"; then
  echo "PASS: login rate limit triggers 429 under burst"; PASS=$((PASS+1))
else
  echo "FAIL: login rate limit never triggered after 15 parallel requests (got: $(printf '%s ' $codes))"; FAIL=$((FAIL+1))
fi

headers=$(curl -s -D - -o /dev/null -X POST "$BASE/api/v1/auth/login" | tr -d '\r')
if printf '%s\n' "$headers" | grep -q "^HTTP/.* 429" && printf '%s\n' "$headers" | grep -qi "^Retry-After: [0-9]"; then
  echo "PASS: login 429 carries Retry-After"; PASS=$((PASS+1))
else
  echo "FAIL: login 429 with Retry-After not seen (got: $(printf '%s\n' "$headers" | head -1))"; FAIL=$((FAIL+1))
fi

status=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer x.y.z" "$BASE/api/v1/products")
if [ "$status" != "429" ]; then
  echo "PASS: protected route unaffected by the exhausted login limit (got $status)"; PASS=$((PASS+1))
else
  echo "FAIL: protected route throttled by the login limit (got 429)"; FAIL=$((FAIL+1))
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
