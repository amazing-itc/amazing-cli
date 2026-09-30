#!/usr/bin/env bash
# A real cursor CLI resumes across two turns of one session.
#   turn 1: "Lembre o numero 42…"  →  turn 2: "Qual numero…" must answer 42, and turnCount = 2.
# Needs: AMAZING_CLI_BASE_URL, AMAZING_CLI_PRODUCT (default aw), AMAZING_CLI_PRODUCT_KEY, CURSOR_API_KEY,
#        and a workspace inside that product's jail (default /data/products/<product>).
# Fails loud when the credential or the server is missing — never skips.
set -u
BASE=${AMAZING_CLI_BASE_URL:?set AMAZING_CLI_BASE_URL}
PRODUCT=${AMAZING_CLI_PRODUCT:-aw}
KEY=${AMAZING_CLI_PRODUCT_KEY:?set AMAZING_CLI_PRODUCT_KEY}
: "${CURSOR_API_KEY:?set CURSOR_API_KEY (the cursor connection configured in the product)}"
WS=${AMAZING_CLI_WORKSPACE:-/data/products/$PRODUCT}
MODEL=${AMAZING_CLI_CURSOR_MODEL:-auto}

fail() { echo "FAIL $1" >&2; exit 1; }
auth=(-H "authorization: Bearer $KEY" -H "x-amazing-product: $PRODUCT" -H 'content-type: application/json')

SID=$(python3 -c 'import uuid; print(uuid.uuid4())')
R1="e2e-cursor-${SID:0:8}-t1"
R2="e2e-cursor-${SID:0:8}-t2"
echo "session=$SID workspace=$WS model=$MODEL"

code=$(curl -s -o /tmp/e2e-cursor-create.json -w '%{http_code}' -X POST "$BASE/v1/sessions" "${auth[@]}" \
  -d "{\"sessionId\":\"$SID\",\"family\":\"cursor\",\"workspace\":{\"path\":\"$WS\"},\"modelId\":\"$MODEL\",\"mode\":\"ask\"}")
[ "$code" = "202" ] || fail "POST /v1/sessions → $code $(cat /tmp/e2e-cursor-create.json)"

turn() { # turn <runId> <prompt> <outfile>
  local c
  c=$(curl -s -o "$3" -w '%{http_code}' -X POST "$BASE/v1/sessions/$SID/turns" "${auth[@]}" \
    -d "$(CURSOR_API_KEY="$CURSOR_API_KEY" python3 -c 'import json,os,sys; print(json.dumps({"runId":sys.argv[1],"prompt":sys.argv[2],"credential":{"secret":os.environ["CURSOR_API_KEY"]}}))' "$1" "$2")")
  [ "$c" = "202" ] || fail "POST turn $1 → $c $(cat "$3")"
  local i status
  for i in $(seq 1 90); do
    sleep 2
    status=$(curl -sf "$BASE/v1/runs/$1" "${auth[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
    case $status in SUCCEEDED|FAILED|CANCELLED) break ;; esac
  done
  [ "$status" = "SUCCEEDED" ] || fail "run $1 finished $status"
}

turn "$R1" "Lembre o numero 42. Responda apenas: anotado." /tmp/e2e-cursor-t1.json
turn "$R2" "Qual numero eu pedi para voce lembrar? Responda apenas o numero." /tmp/e2e-cursor-t2.json

ANSWER=$(curl -sf "$BASE/v1/runs/$R2/events" -H "authorization: Bearer $KEY" -H "x-amazing-product: $PRODUCT" -H 'accept: application/json' \
  | python3 -c '
import sys, json
text = ""
for block in sys.stdin.read().split("\n\n"):
    data = next((ln[5:] for ln in block.split("\n") if ln.startswith("data:")), None)
    if not data: continue
    ev = json.loads(data)
    if ev.get("type") in ("assistant/message", "assistant/delta"):
        text += str((ev.get("data") or {}).get("text", ""))
print(text)
')
echo "turn 2 answer: $ANSWER"
printf '%s' "$ANSWER" | grep -q '42' || fail "turn 2 did not cite 42 — resume failed"

SESSION=$(curl -sf "$BASE/v1/sessions/$SID" "${auth[@]}")
echo "$SESSION" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["turnCount"]==2, d; assert d.get("providerSessionRef"), d; print("turnCount=2 providerSessionRef=%s" % d["providerSessionRef"])' \
  || fail "session did not record two turns"

HOME_SIZE=$(curl -sf "$BASE/health" >/dev/null && echo "n/a")
echo "OK cursor session resumed (answer cites 42, turnCount 2)"
