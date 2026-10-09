#!/usr/bin/env bash
#
# End-to-end container test for the DeepSeek Harness Web UI image.
#
# Verifies, against a running container reached over a NON-LOOPBACK address:
#   1. the publishing proxy answers remote requests (401, never the harness 403)
#   2. the launch-token exchange mints a browser session and serves the UI
#   3. the /api browser-trust fence admits the remote authority through the proxy
#   4. the /api WebSocket upgrade completes (101)
#   5. the requested Linux tooling is present in the sandbox
#
# Usage: ./docker/test/smoke-test.sh [IMAGE] [HOST_PORT]
set -uo pipefail

IMAGE="${1:-deepseek-harness-web:0.2.1-alpha.1}"
HOST_PORT="${2:-3080}"
CONTAINER="dsh-smoke-$$"
COOKIE_JAR="$(mktemp)"
PAGE_FILE="$(mktemp)"
FAILURES=0

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '\033[36m==> %s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -f "${COOKIE_JAR}" "${PAGE_FILE}"
}
trap cleanup EXIT

# A genuinely non-loopback address for the harness host.
LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -vE '^$|^127\.' | head -1)"
if [ -z "${LAN_IP}" ]; then
  echo "smoke-test: no non-loopback IPv4 address on this host; the remote-path assertions would be meaningless" >&2
  exit 2
fi
BASE="http://${LAN_IP}:${HOST_PORT}"

info "starting ${IMAGE} as ${CONTAINER} (remote base ${BASE})"
docker run -d --name "${CONTAINER}" \
  --env DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-smoke-test-placeholder}" \
  --env DSH_TELEMETRY_DISABLED=true \
  --publish "${HOST_PORT}:3080" \
  "${IMAGE}" >/dev/null || { echo "smoke-test: docker run failed" >&2; exit 1; }

info "waiting for the container health check"
for _ in $(seq 1 60); do
  state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${CONTAINER}" 2>/dev/null)"
  [ "${state}" = "healthy" ] && break
  sleep 5
done
if [ "${state}" != "healthy" ]; then
  echo "smoke-test: container never became healthy (last state: ${state})" >&2
  docker logs "${CONTAINER}" 2>&1 | tail -40 >&2
  exit 1
fi
pass "container healthy"

LOGS="$(docker logs "${CONTAINER}" 2>&1)"
TOKEN="$(printf '%s' "${LOGS}" | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)"
if [ -z "${TOKEN}" ]; then
  fail "launch token found in the container log"
  printf '%s\n' "${LOGS}" | tail -20
else
  pass "launch token found in the container log"
fi

info "1. remote request without a session is refused by auth, not by the trust fence"
CODE_ANON="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE}/")"
if [ "${CODE_ANON}" = "401" ]; then
  pass "GET / -> 401 (proxy forwarded; harness did not answer 403 for authority ${LAN_IP})"
elif [ "${CODE_ANON}" = "403" ]; then
  fail "GET / -> 403: the browser-trust fence rejected the remote authority"
else
  fail "GET / -> ${CODE_ANON} (expected 401)"
fi

info "2. launch-token exchange over the remote address serves the UI"
if [ -n "${TOKEN}" ]; then
  CODE_UI="$(curl -s -L -c "${COOKIE_JAR}" -b "${COOKIE_JAR}" \
    -o "${PAGE_FILE}" -w '%{http_code}' --max-time 20 "${BASE}/?token=${TOKEN}")"
  if [ "${CODE_UI}" = "200" ] && grep -qi '<div id="root"' "${PAGE_FILE}"; then
    pass "GET /?token=... -> 200 and the Web UI shell was served"
  else
    fail "GET /?token=... -> ${CODE_UI}; expected 200 with the UI shell"
    head -c 300 "${PAGE_FILE}"; echo
  fi
  if [ -s "${COOKIE_JAR}" ]; then
    pass "browser-session cookie issued for the remote authority"
  else
    fail "browser-session cookie issued for the remote authority"
  fi
fi

info "3. /api passes the browser-trust fence over the remote address"
# /api/file is a real GET route owned by the session controller: any answer other
# than 403 proves the request reached the RPC bridge instead of the trust fence.
CODE_API="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "${COOKIE_JAR}" "${BASE}/api/file")"
if [ "${CODE_API}" = "403" ]; then
  fail "GET /api/file -> 403: the browser-trust fence rejected the proxied request"
elif [ "${CODE_API}" = "000" ]; then
  fail "GET /api/file -> no response (expected a routed status, not 403)"
else
  pass "GET /api/file -> ${CODE_API} (routed past the 403 fence)"
fi

info "4. /api WebSocket upgrade completes"
KEY="$(head -c 16 /dev/urandom | base64)"
WS_OUT="$(curl -s -i --max-time 8 -b "${COOKIE_JAR}" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: ${KEY}" \
  "${BASE}/api/remote.mux" 2>/dev/null | head -1 | tr -d '\r')"
if printf '%s' "${WS_OUT}" | grep -q '101'; then
  pass "WS /api/remote.mux -> ${WS_OUT}"
else
  fail "WS /api/remote.mux -> ${WS_OUT:-<no response>} (expected 101)"
fi

info "4b. the proxy does not bypass harness authentication"
KEY="$(head -c 16 /dev/urandom | base64)"
WS_ANON="$(curl -s -i --max-time 8 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: ${KEY}" \
  "${BASE}/api/remote.mux" 2>/dev/null | head -1 | tr -d '\r')"
if printf '%s' "${WS_ANON}" | grep -q '101'; then
  fail "unauthenticated WS upgrade was accepted (${WS_ANON}) — the proxy leaked access"
else
  pass "unauthenticated WS upgrade refused: ${WS_ANON:-<no response>}"
fi

info "5. requested Linux tooling inside the sandbox"
TOOL_REPORT="$(docker run --rm "${IMAGE}" bash -lc '
  for c in curl wget vim get ll ls tree jq git rg fd bat less htop tmux nc dig ping ps python3 pip3; do
    command -v "$c" >/dev/null 2>&1 && echo "ok $c" || echo "missing $c"
  done
  echo "python $(python3 -c "import sys; print(sys.version.split()[0])")"
  echo "venv-support $(python3 -m venv --help >/dev/null 2>&1 && echo yes || echo no)"
  echo "ll-output $(ll /usr/local/bin | head -1 | wc -l)"
' 2>&1)"
MISSING="$(printf '%s\n' "${TOOL_REPORT}" | awk '$1=="missing"{print $2}' | tr '\n' ' ')"
if [ -z "${MISSING}" ]; then
  pass "all requested commands present (curl wget vim get ll ls tree jq git rg fd bat less htop tmux dig ping ps python3 pip3)"
else
  fail "missing commands: ${MISSING}"
fi
if printf '%s' "${TOOL_REPORT}" | grep -q '^ll-output 1$'; then
  pass "ll runs as a real command"
else
  fail "ll did not produce a listing"
fi
if printf '%s' "${TOOL_REPORT}" | grep -q '^venv-support yes$'; then
  pass "the built-in python3 can create virtual environments"
else
  fail "the built-in python3 cannot create virtual environments"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  printf '\033[32mALL CHECKS PASSED\033[0m\n'
  exit 0
fi
printf '\033[31m%s CHECK(S) FAILED\033[0m\n' "${FAILURES}"
exit 1
