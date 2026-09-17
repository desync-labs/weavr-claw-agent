#!/bin/sh
# curator-health.sh: cron id curator-health (no_agent, */15 * * * *): the
# LLM-free alert relay.
#
# With no_agent the scheduler delivers this script's stdout verbatim to
# Telegram and delivers nothing when stdout is empty. So this prints only
# anomalies: the alerts the signer has not delivered yet (GET /alerts hands
# each key out once until it clears and fires again), an unreachable signer,
# or a failed heartbeat. A quiet cluster produces no message every 15 minutes.
#
# It also POSTs /hermes-heartbeat so curator_hermes_heartbeat_ts moves; the
# stale-heartbeat alert is how a dead gateway is told
# apart from a quiet one, and this script is the only thing that feeds it.
set -u
. "$(dirname "$0")/curator-lib.sh"
curator_require_env curator-health.sh || exit 2

out=$(curator_tmp) || exit 1
trap 'rm -f "$out"' EXIT

if curator_call curator-health.sh GET /alerts "$out"; then
  curator_py '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    print("curator-health: GET /alerts answered without JSON")
    sys.exit(0)
for alert in doc.get("alerts") or []:
    print("%s %s %s" % (alert.get("code", "?"), alert.get("at", ""), alert.get("message", "")))
' < "$out"
  case $? in
    0) ;;
    3) grep -q '"alerts": *\[\]' "$out" || cat "$out" ;;   # no python3: raw, but still silent when empty
    *) echo "curator-health: could not read GET /alerts" ;;
  esac
else
  echo "curator-health: signer unreachable or refused GET /alerts (HTTP $CURATOR_HTTP_STATUS)"
fi

if ! curator_call curator-health.sh POST /hermes-heartbeat "$out"; then
  echo "curator-health: POST /hermes-heartbeat failed (HTTP $CURATOR_HTTP_STATUS)"
fi
exit 0
