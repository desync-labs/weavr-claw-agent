#!/bin/sh
# curator-universe.sh: cron id curator-universe (agent + monitor_script,
# 0 */6 * * *): the universe watch.
#
# The scheduler hashes this script's exact stdout each tick: unchanged bytes
# suppress the agent run, changed bytes wake it with a unified diff. So the
# output is one sorted line per catalogue pool and nothing that moves on its
# own: no timestamps, no TVL, no prices, no yields:
#   pool,status,tier,maxWeight,chain
# A pool going inactive, a risk tier raised, a weight cap lowered or a new
# pool on the shelf is exactly the diff the agent should reassess; the policy
# still applies to whatever it proposes.
#
# Source: the signer, GET /review?mode=universe, expected to answer
# {pools:[{symbol|poolId,status,riskTier,maxWeightBps,chain}]}. An older
# signer answers /review without a mode; when the answer carries no `pools`
# array the public catalogue GET $WEAVR_API_URL/v1/pools is read when
# WEAVR_API_URL is set (the same rows, no auth). With neither, stdout stays
# empty (a stable hash, no wake) and the reason goes to stderr.
set -u
. "$(dirname "$0")/curator-lib.sh"
curator_require_env curator-universe.sh || exit 2

out=$(curator_tmp) || exit 1
trap 'rm -f "$out"' EXIT

render='
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(4)
pools = doc.get("pools") if isinstance(doc, dict) else doc
if not isinstance(pools, list):
    sys.exit(4)
rows = []
for p in pools:
    if not isinstance(p, dict):
        continue
    name = p.get("symbol") or p.get("poolId") or "?"
    rows.append("%s,%s,%s,%s,%s" % (name, p.get("status", "?"), p.get("riskTier", "?"), p.get("maxWeightBps", "?"), p.get("chain", "?")))
for row in sorted(rows):
    print(row)
'

if curator_call curator-universe.sh GET '/review?mode=universe' "$out"; then
  curator_py "$render" < "$out" && exit 0
  rc=$?
  [ "$rc" -eq 4 ] || { echo "curator-universe: cannot render the signer's answer (rc $rc)" >&2; exit 0; }
  echo "curator-universe: the signer's /review carries no pools array (mode=universe not implemented); trying the catalogue" >&2
else
  echo "curator-universe: signer unreachable or refused GET /review?mode=universe (HTTP $CURATOR_HTTP_STATUS)" >&2
fi

if [ -n "${WEAVR_API_URL:-}" ]; then
  if curl -sS --max-time "${CURATOR_CURL_MAX_TIME:-20}" -o "$out" "${WEAVR_API_URL%/}/v1/pools" 2>/dev/null; then
    curator_py "$render" < "$out" && exit 0
    echo "curator-universe: cannot render GET /v1/pools" >&2
  else
    echo "curator-universe: catalogue unreachable" >&2
  fi
fi
exit 0
