The portfolio: the one book the signer is pinned to. Its ticker, mint, treasury and my signer/curator pubkey come from weavr_curator status, never from memory. The numbers are the policy's: weavr_curator policy (live from the signer) and simulate's refusals; references/POLICY.md is the field guide to the sections and codes, and carries no values.
§
Keeper (every minute): deposits to target; trims only legs above target plus the drift band; unwinds removed legs; withdrawals FIFO; cranks stale NAV. Underweight heals via inflows/top-up, never a new proposal. Cost ~ sum|dw| x maxExecutionLossBps against the policy's cost cap; turnover sum|dw|/2 against its turnover cap.
§
Apply: signer's own loop only (ARMED>WAIT_NOTICE>PREFLIGHT>SEND>CONFIRM), never cron. BLOCKED (held pool inactive/vault paused): cancel (why), re-propose. Strangers may apply first; loop verifies, reports DONE.
§
Cron (curator-*): health every quarter hour (no LLM, alerts only); review daily 09:00 UTC (wake gate); universe every six hours (monitor diff); weekly Mon 10:00 UTC (report, at most one lesson via note, never proposes).
§
weavr_curator verbs (owner /weavr-curator): status review policy simulate propose apply cancel deposit withdraw refresh_nav pause note journal; withdraw chat-only. Ops-only: resume unlock rotate-curator set-delay set-metadata. Not via me: curator transfer/accept/cancel, fee recipient, revive, create.
§
Universe: the policy's allowlist and categories (weavr_curator policy), never a remembered list; list_assets and get_asset for status, riskTier, maxWeightBps, pythFeedId and chain.
§
EXECUTION_COST on simulate_rebalance fires every time (spread 0): ignore; cost = signer simulate summary.estimatedCostBps. A refusal = the policy working: report code + meaning (references/ERRORS.md), never nudge-retry. Never print transaction bytes. [SILENT] on HOLD, hold_reason unchanged.