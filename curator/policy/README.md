# Policy presets

The signer loads one JSON document at boot and refuses anything outside it.
It never clamps: a proposal that breaks a rule comes back with a refusal code
and the value that bound, and nothing is built or signed. The document is
the only place a threshold lives. The agent reads it live
(`weavr_curator policy`, `GET /policy`) and its prose never repeats a number;
`tests/curator_prose.test.mjs` fails the build if one creeps in. This page
keeps to the same rule: it names the key that holds a value, never the value.

Two presets ship here. `weavr-curator init` copies the one you pick, and the
compose file mounts it read-only at `/policy/policy.json`.

| Preset | For |
|---|---|
| `standard.json` | a book with the house notice: the portfolio you mean to run. A full universe and category map, a leg-shape band, a stable sleeve with a floor, turnover and cost caps, a cadence gate with a UTC propose window, daily deposit and withdraw caps for the agent, and the notice in `invariants.rebalanceDelaySecs` |
| `rehearsal.json` | a rehearsal book with a short notice: a dust portfolio you use to watch the machine work. A smaller universe; a lower leg floor (`shape.minLegs`), a lower stable floor (`shape.stableMinBps`), a looser cadence (`cadence.minSecsSinceLastRebalance`, `cadence.maxProposalsPer30d`) and a wider propose window (`cadence.proposeWindowUtc`), so one proposal can be watched end to end; its own answer to whether a price feed is required (`universe.requirePythFeedId`); deposit and withdraw moved to `verbs.denied`, so the agent moves no money here; and its own notice in `invariants.rebalanceDelaySecs` |

Each preset's notice is whatever its `invariants.rebalanceDelaySecs` says,
and the portfolio's onchain delay must equal it; read the value there, not
on this page.

Pick `rehearsal.json` first, on a portfolio with dust in it, and watch one
proposal go through propose, notice and apply. Then move to `standard.json`
and edit it for your book. The doctor validates the preset against the
portfolio's live legs and its onchain notice before you start.

## What each section refuses

| Section | Governs | Refusal codes |
|---|---|---|
| `universe` | which pools may be targeted at all: chain list, required catalogue status, whether a price feed is required, a risk-tier ceiling, a symbol allowlist, the pool's own execution-loss ceiling, and the category each allowlisted symbol belongs to | `CHAIN_DENIED` `POOL_NOT_ACTIVE` `POOL_DENIED` `POOL_COST_TOO_HIGH` |
| `shape` | what a proposal may look like: leg count, page limit, per-leg weight band, the stable category's band, any category's cap, the exact sum | `MIN_LEGS` `MAX_LEGS` `PAGE_LIMIT` `LEG_WEIGHT_CAP` `STABLE_BAND` `CATEGORY_CAP` `WEIGHTS_SUM` |
| `turnover` | how much of the book one proposal may move | `TURNOVER_CAP` |
| `cost` | the estimated execution cost one proposal may incur, in bps of NAV | `COST_CAP` |
| `cadence` | how soon after the last rebalance, how many per rolling window, none while one is pending, complete inputs unless it is a risk exit, and the UTC hours in which a proposal may be made | `PROPOSAL_TOO_SOON` `PROPOSAL_QUOTA` `TARGETS_PENDING` `INPUTS_INCOMPLETE` `OUTSIDE_WINDOW` |
| `reason` | whether a `why` is required and how long it may be | `WHY_REQUIRED` |
| `deposit` | a daily USD cap, a launch-day cap, whether the book must be fresh | `DEPOSIT_DAILY_CAP` `BOOK_NOT_FRESH` `CAP_HEADROOM` |
| `withdraw` | chat only, a daily USD cap, always to the signer's own account | `WITHDRAW_CRON_BLOCKED` `WITHDRAW_DAILY_CAP` |
| `verbs` | which routes the agent token may call, which need the ops token, which nobody may call through the signer, which are refused from cron | `OPS_ONLY` `VERB_DENIED` `WITHDRAW_CRON_BLOCKED` |
| `rate` | write attempts per rolling hour, and the SOL balance under which the signer will not sign | `RATE_LIMITED` `LOW_SOL` |
| `invariants` | what the chain must keep saying every tick: the signer is the curator, no curator transfer is pending, the rebalance delay is the notice this document expects, the composition is not locked; a drift locks every write until an operator clears it | `SELF_LOCKED` `INVARIANT_DRIFT` |
| `apply` | the signer's own apply loop: tick, arming lead, give-up window, retries, when it refreshes NAV itself, and how long each blocker may persist before it alerts | `WINDOW_CLOSED` and the apply blockers |
| `review` | the daily wake gate: the monthly-review weekday, the inflow-starvation rule, the publisher-park age, the drawdown floor, the brief's size | the review triggers |

## How to change it

Edit the file, then restart the signer:
`docker compose --env-file <home>/compose.env -f curator/compose/curator.yml restart signer`
(`<home>` is the directory `weavr-curator init` wrote; a re-run of init keeps
your edited file and touches only its notice).
The signer validates the whole document at boot and **refuses to start on an
unknown or missing key**, so a typo is a boot failure, not a silent default.
`weavr_curator policy` (or `/weavr-curator policy` in Telegram) shows what is
running, with its digest, so you can confirm the restart took.

Some rules to keep in mind when editing:

- `invariants.rebalanceDelaySecs` must equal the portfolio's onchain
  rebalance delay, or the signer self-locks on its first tick. Change the
  delay onchain first (`weavr-curator ops set-delay`), then the document.
- Every symbol in `universe.allowlist` must appear in exactly one category,
  and `shape.stableCategory` must name one of them.
- `verbs.agent` and `verbs.denied` together must settle every route the
  plugin calls, every read verb stays in `verbs.agent`, and `verbs.agent`
  names nothing the agent does not call. The signer checks a verb by list
  membership at call time, not at boot, so a missing or misspelt name is a
  refusal later; `python3 plugins/weavr-curator/test_plugin.py` reports it
  by name for both shipped presets.
- Lowering a cap below what the book already holds does not force a trade;
  it means the next proposal must move the book inside the new rule.
- A change of policy is not a change of thesis. The thesis is
  `curator/profile/skills/weavr-curator/references/MANDATE.md`, in words.
