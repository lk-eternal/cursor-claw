#!/usr/bin/env bash
# T2 contract: POST /api/session-agent-phase (non-destructive)
set -euo pipefail

PORT="${DAEMON_PORT:-${LARK_DAEMON_PORT:-19528}}"
BASE="http://127.0.0.1:${PORT}"
SESSION_KEY="${KB_TEST_SESSION_KEY:-__kb_test_phase__}"

post_phase() {
  local phase="$1"
  local expect_code="$2"
  local body
  body=$(printf '{"session_key":"%s","phase":"%s"}' "$SESSION_KEY" "$phase")
  local code
  code=$(curl -s -o /tmp/kb_phase_resp.json -w "%{http_code}" \
    -X POST "${BASE}/api/session-agent-phase" \
    -H "Content-Type: application/json" \
    -d "$body")
  if [[ "$code" != "$expect_code" ]]; then
    echo "FAIL phase=${phase} expected HTTP ${expect_code} got ${code}"
    cat /tmp/kb_phase_resp.json 2>/dev/null || true
    exit 1
  fi
  if [[ "$expect_code" == "200" ]]; then
    if ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/kb_phase_resp.json 2>/dev/null; then
      echo "FAIL phase=${phase} body missing ok:true"
      cat /tmp/kb_phase_resp.json
      exit 1
    fi
  fi
  echo "OK phase=${phase} HTTP ${code}"
}

post_bad() {
  local label="$1"
  local payload="$2"
  local code
  code=$(curl -s -o /tmp/kb_phase_bad.json -w "%{http_code}" \
    -X POST "${BASE}/api/session-agent-phase" \
    -H "Content-Type: application/json" \
    -d "$payload")
  if [[ "$code" != "400" ]]; then
    echo "FAIL ${label} expected HTTP 400 got ${code}"
    cat /tmp/kb_phase_bad.json 2>/dev/null || true
    exit 1
  fi
  echo "OK ${label} HTTP 400"
}

echo "phase-api-contract: ${BASE} session_key=${SESSION_KEY}"

post_phase starting 200
post_phase processing 200

# T-FIX-01: instant poll 路径（ensureMergePreviewSentBeforeClaim）非破坏冒烟
instant_poll() {
  local label="$1"
  local code
  code=$(curl -s -o /tmp/kb_poll_resp.json -w "%{http_code}" \
    "${BASE}/api/poll-message?sessionKey=${SESSION_KEY}&wait=false")
  if [[ "$code" != "200" ]]; then
    echo "FAIL ${label} instant poll expected HTTP 200 got ${code}"
    cat /tmp/kb_poll_resp.json 2>/dev/null || true
    exit 1
  fi
  if ! grep -q '"messages"' /tmp/kb_poll_resp.json 2>/dev/null; then
    echo "FAIL ${label} instant poll body missing messages"
    cat /tmp/kb_poll_resp.json
    exit 1
  fi
  echo "OK ${label} instant poll HTTP 200"
}

instant_poll "processing+suppress"
post_phase idle 200
instant_poll "idle-compensation-hook"
post_phase idle 200
echo "OK idle compensation idempotent"

post_bad "missing session_key" '{"phase":"starting"}'
post_bad "invalid phase" "{\"session_key\":\"${SESSION_KEY}\",\"phase\":\"bogus\"}"

echo "phase-api-contract: all checks passed"
