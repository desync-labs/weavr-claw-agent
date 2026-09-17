# The policy document: a field guide

The signer enforces a JSON policy document. Every number in it is a refusal
threshold: the signer refuses, it never clamps. This page says what each
section governs and which refusal code it produces.
It states **no values on purpose**: read them live with
`weavr_curator {verb: "policy"}` (the document, its version and its sha256),
and take the ones that bind a proposal from `simulate`, whose `refusals` are
the ones that will actually fire and whose empty list means the proposal
passes now.

**The deployed document is the only truth.** Two books run two documents;
the rehearsal preset allows what the standard one refuses; an owner edits a
number and restarts the signer, and no page changes with it. `status` reports
only `policy.version`, which is the schema version, not the document. Holding
against a clean `simulate` because of a number remembered from a page is the
one way to get this wrong. The codes are explained in `ERRORS.md`.

## Portfolio

The signer is pinned to one shares mint. Anything else: `PORTFOLIO_NOT_ALLOWED`.

## `universe`: which pools may be targeted at all

Every row must pass: the chain list (`CHAIN_DENIED`); the required catalogue
status (`POOL_NOT_ACTIVE`); whether a price feed id is required, the maximum
risk tier and the symbol allowlist (`POOL_DENIED`); the pool's own
maxExecutionLossBps ceiling (`POOL_COST_TOO_HIGH`). `categories` assigns each
allowlisted symbol to exactly one category; the catalogue carries none, so the
document does. The allowlist is the shelf: a pool not on it is out however
good it looks.

## `shape`: what a proposal may look like

Minimum and maximum leg count (`MIN_LEGS` / `MAX_LEGS`); the page limit on
held ∪ new so an apply fits one page (`PAGE_LIMIT`); the per-leg weight band
and the pool's own maxWeightBps (`LEG_WEIGHT_CAP`); the band for the stable
category combined (`STABLE_BAND`); the cap on any single category
(`CATEGORY_CAP`); the sum the weights must reach exactly (`WEIGHTS_SUM`).

## `turnover` and `cost`: how big a step may be

Turnover is Σ|Δw|/2 against the current targets, capped per proposal
(`TURNOVER_CAP`). Cost is Σ|Δw_i| × maxExecutionLossBps_i / 10000, in bps
of NAV, capped (`COST_CAP`). Both come back from `simulate` as
`summary.turnoverBps` and `summary.estimatedCostBps`, already compared.

## `cadence`: when a proposal is allowed

A minimum age of the on-chain `last_rebalance_at` (`PROPOSAL_TOO_SOON`); a
quota of proposals per rolling window, counted from the journal
(`PROPOSAL_QUOTA`); none while a change is pending (`TARGETS_PENDING`);
none unless trailingYieldBps, tvlUsdc and riskTier are present for every
targeted pool, unless the proposal is a risk exit (`INPUTS_INCOMPLETE`); a
UTC propose window so the notice lands in the owner's day
(`OUTSIDE_WINDOW`). `simulate` answers `nextProposeAt` for the first two.

## `reason`

Whether `why` is required on propose and cancel, and its maximum length
(`WHY_REQUIRED`).

## `deposit`

A USD cap per UTC day, a separate cap on the launch day when one is set
(`DEPOSIT_DAILY_CAP`); whether the book's priceState must be fresh
(`BOOK_NOT_FRESH`); the vault's own caps and idle headroom, read from chain
(`CAP_HEADROOM`).

## `withdraw`

Chat sessions only (`WITHDRAW_CRON_BLOCKED`); a USD cap per UTC day
(`WITHDRAW_DAILY_CAP`); always to the signer's own token account.

## `verbs`

`agent`: the routes the agent token may call. `ops`: the ops token only
(`OPS_ONLY`). `denied`: never through the signer by anyone (`VERB_DENIED`);
curator transfer, accept and cancel, fee recipient, revive and create are the
owner's wallet actions. `cronDenied`: refused when the session is cron or
unknown (`WITHDRAW_CRON_BLOCKED`).

## `rate`

A ceiling on write attempts per rolling hour, successful or not
(`RATE_LIMITED`); a lamport floor under which the signer will not sign
(`LOW_SOL`).

## `invariants`: checked every tick

portfolio.curator == the signer's key; pending_curator == none; the
portfolio's rebalance delay == the document's notice; accountant.recipient1
== the treasury; factory.guardian == the expected guardian;
composition_locked == false. Any drift self-locks every write and alerts
(`SELF_LOCKED`, `INVARIANT_DRIFT`); only the ops `unlock` clears it, and only
once the drift is gone.

## `apply`: the signer's loop, not the agent's

The tick; how long before effectiveAt the machine arms; how long after it
gives up (`WINDOW_CLOSED`); sends per tick and failed ticks before
escalating; when the loop refreshes NAV itself; the wait and retry count on
`APPLY_IN_FLIGHT`; the retry after the api prepends a custody create; and
`escalateAfterSecs` per blocker (zero escalates at once, null never). None
of it is yours to tune from chat.

## `review`: the daily wake gate

The weekday of the monthly thesis review; how many consecutive gates a leg
may sit under target with no inflow, and for how long, before
`LEG_NEEDS_INFLOW`; the age of a publisher park that wakes you
(`PUBLISHER_PARK`); the drawdown floor (`DRAWDOWN_30D`); the brief's size.
