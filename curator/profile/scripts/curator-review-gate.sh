#!/bin/sh
# curator-review-gate.sh: cron id curator-review (agent, 0 9 * * *): the
# daily wake gate.
#
# Prints the signer's brief (GET /review: brief ≤ 4 KB, the triggers and a
# stable holdReason) and, as the LAST stdout line, {"wakeAgent": <bool>}.
# cron/scheduler.py _parse_wake_gate reads that last line: false skips the
# LLM run and the delivery entirely, anything else wakes the agent with this
# stdout as context. The signer decides (metrics.js deriveReview); this
# script only relays, so a quiet day costs no model call.
#
# Watermarks: when HERMES_HOME is set and the hermes CLI is on PATH the script
# writes the job notepad (`hermes cron notepad curator-review set …`, injected
# into the next run's prompt); the model has no terminal and cannot write it:
#   watermark     ISO time of this gate
#   hold_reason   the signer's stable holdReason ("" when waking)
#   hold_streak   consecutive gates with the same non-empty hold_reason
#   drift_streak  consecutive gates with a state trigger (LEG_NEEDS_INFLOW,
#                 HELD_POOL_NOT_ACTIVE, PUBLISHER_PARK, DRAWDOWN_30D,
#                 RISK_TIER_RAISED); MONTHLY_REVIEW and OPERATOR_REQUEST are not drift
#   pending       effectiveAt of the pending change from GET /status, or none
# The [SILENT] rule in the skill keys off hold_reason and hold_streak.
set -u
. "$(dirname "$0")/curator-lib.sh"
curator_require_env curator-review-gate.sh || exit 2

out=$(curator_tmp) || exit 1
wm=$(curator_tmp) || { rm -f "$out"; exit 1; }
status=$(curator_tmp) || { rm -f "$out" "$wm"; exit 1; }
trap 'rm -f "$out" "$wm" "$status"' EXIT

if ! curator_call curator-review-gate.sh GET /review "$out"; then
  echo "review unavailable: signer unreachable or refused GET /review (HTTP $CURATOR_HTTP_STATUS); curator-health relays the outage"
  echo '{"wakeAgent": false}'
  exit 0
fi

# Prints the brief and the gate line; writes "<wake>\n<drift>\n<hold_reason>" to $1.
curator_py '
import json, sys
wm_path = sys.argv[1] if len(sys.argv) > 1 else None
raw = sys.stdin.read()
try:
    doc = json.loads(raw)
except Exception:
    print(raw.strip()[:4096])
    print("{\"wakeAgent\": false}")
    sys.exit(0)
brief = doc.get("brief") if isinstance(doc.get("brief"), str) else ""
triggers = doc.get("triggers") if isinstance(doc.get("triggers"), list) else []
wake = doc.get("wakeAgent") is True
hold_reason = doc.get("holdReason") if isinstance(doc.get("holdReason"), str) else ""
drift_codes = {"LEG_NEEDS_INFLOW", "HELD_POOL_NOT_ACTIVE", "PUBLISHER_PARK", "DRAWDOWN_30D", "RISK_TIER_RAISED"}
drift = any(isinstance(t, dict) and t.get("code") in drift_codes for t in triggers)
print(brief.strip()[:4096] if brief.strip() else "review: the signer returned no brief")
if triggers:
    print("Triggers: " + "; ".join("%s (%s)" % (t.get("code"), t.get("detail", "")) for t in triggers if isinstance(t, dict)))
print(json.dumps({"wakeAgent": wake}))
if wm_path:
    with open(wm_path, "w") as fh:
        fh.write("%d\n%d\n%s\n" % (1 if wake else 0, 1 if drift else 0, hold_reason.replace("\n", " ").strip()))
' "$wm" < "$out"
rc=$?
if [ "$rc" -ne 0 ]; then
  # no python3 (3) or a render failure: the raw body still carries the gate for a human
  cat "$out"
  echo
  echo '{"wakeAgent": false}'
  exit 0
fi

curator_notepad_available || exit 0

wake=$(sed -n 1p "$wm"); drift=$(sed -n 2p "$wm"); hold_reason=$(sed -n 3p "$wm")
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

prev_reason=$(hermes cron notepad curator-review get hold_reason 2>/dev/null) || prev_reason=""
prev_hold=$(hermes cron notepad curator-review get hold_streak 2>/dev/null) || prev_hold=0
prev_drift=$(hermes cron notepad curator-review get drift_streak 2>/dev/null) || prev_drift=0
case "$prev_hold" in ''|*[!0-9]*) prev_hold=0 ;; esac
case "$prev_drift" in ''|*[!0-9]*) prev_drift=0 ;; esac

if [ -n "$hold_reason" ] && [ "$hold_reason" = "$prev_reason" ]; then
  hold_streak=$((prev_hold + 1))
elif [ -n "$hold_reason" ]; then
  hold_streak=1
else
  hold_streak=0
fi
if [ "$drift" = "1" ]; then drift_streak=$((prev_drift + 1)); else drift_streak=0; fi

pending=none
if curator_call curator-review-gate.sh GET /status "$status"; then
  pending=$(curator_py '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit(0)
apply = doc.get("apply") or {}
eff = apply.get("effectiveAt")
print(eff if eff else "none")
' < "$status") || pending=unknown
fi

hermes cron notepad curator-review set watermark "$now" >/dev/null 2>&1
hermes cron notepad curator-review set hold_reason "$hold_reason" >/dev/null 2>&1
hermes cron notepad curator-review set hold_streak "$hold_streak" >/dev/null 2>&1
hermes cron notepad curator-review set drift_streak "$drift_streak" >/dev/null 2>&1
hermes cron notepad curator-review set pending "$pending" >/dev/null 2>&1
exit 0
