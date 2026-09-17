#!/bin/sh
# curator-weekly.sh: cron id curator-weekly (agent, 0 10 * * 1, context_from
# curator-review): the weekly report's data.
#
# Prints the signer's weekly body: GET /review?mode=weekly: NAV/share against
# the no-trade counterfactual per applied change and realised vs bounded cost.
# The weekly job always wakes the agent, so the last stdout line is an
# explicit {"wakeAgent": true}: the scheduler reads the last line as the wake
# gate, and a raw JSON body ending in "wakeAgent": false would silently skip
# the report.
#
# An older signer answers /review without a mode: the plain brief comes back
# and is printed, and the weekly report is then the brief plus the agent's own
# reading of get_portfolio_history.
set -u
. "$(dirname "$0")/curator-lib.sh"
curator_require_env curator-weekly.sh || exit 2

out=$(curator_tmp) || exit 1
trap 'rm -f "$out"' EXIT

if curator_call curator-weekly.sh GET '/review?mode=weekly' "$out"; then
  curator_py '
import json, sys
raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except Exception:
    print(raw.strip())
    sys.exit(0)
brief = doc.get("brief")
print(brief.strip() if isinstance(brief, str) and brief.strip() else "weekly: the signer returned no brief")
' < "$out" || cat "$out"
else
  echo "weekly: signer unreachable or refused GET /review?mode=weekly (HTTP $CURATOR_HTTP_STATUS); report from get_portfolio_history and the journal only"
fi
echo '{"wakeAgent": true}'
exit 0
