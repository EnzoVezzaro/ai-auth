#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

docker compose -f "$ROOT/infra/keycloak/compose.yaml" up -d
TOKEN=""
for _ in $(seq 1 60); do
  TOKEN="$(curl -fsS -X POST http://127.0.0.1:8080/realms/ai-auth-dev/protocol/openid-connect/token \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode grant_type=client_credentials \
    --data-urlencode client_id=ai-auth-test \
    --data-urlencode client_secret=ai-auth-test-dev-secret | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token||"")}catch{}})' || true)"
  [[ -n "$TOKEN" ]] && break
  sleep 2
done
[[ -n "$TOKEN" ]] || { echo "Keycloak did not issue an access token" >&2; exit 1; }

PORT=34339 \
AI_AUTH_DB="$TMP_DIR/keycloak.sqlite" \
OIDC_ISSUER=http://127.0.0.1:8080/realms/ai-auth-dev \
OIDC_AUDIENCE=ai-auth-api \
OIDC_JWKS_URL=http://127.0.0.1:8080/realms/ai-auth-dev/protocol/openid-connect/certs \
node --import tsx "$ROOT/apps/server/src/server.ts" >"$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do
  curl -fsS http://127.0.0.1:34339/health >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS http://127.0.0.1:34339/v1/me -H "authorization: Bearer $TOKEN" >"$TMP_DIR/me.json"
node --input-type=commonjs - "$TMP_DIR/me.json" <<'NODE'
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (data.agent.name !== 'Keycloak Integration Agent' || data.agent.category !== 'simulated_test_client') {
  throw new Error(`unexpected Keycloak identity mapping: ${JSON.stringify(data.agent)}`);
}
console.log('Keycloak issued and AI Auth verified a real OIDC access token.');
NODE

TAMPERED="${TOKEN%?}x"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:34339/v1/me -H "authorization: Bearer $TAMPERED")"
[[ "$STATUS" == 401 ]] || { echo "tampered token was not rejected (HTTP $STATUS)" >&2; exit 1; }
echo "Tampered-token rejection passed."
