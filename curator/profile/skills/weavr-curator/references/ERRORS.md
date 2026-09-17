# Errors: what a code means and what to do

Two families. **Refusal codes** come from the signer before anything is
built or signed: the policy working. Every threshold behind them is a number
in the policy document, which this page does not repeat: the refusal message
carries the value that bound, and `weavr_curator {verb: "policy"}` has the
whole document. **Program errors** come back from the chain when a
transaction the signer did sign fails; the signer names them from the
factory's error enum (6000 + index) and the core `stoken` enum. In both cases
report `<CODE>: <meaning>` and take the action below; never retry with a
nudge.

## Refusal codes (signer, before signing)

| Code | Meaning | Action |
|---|---|---|
| PORTFOLIO_NOT_ALLOWED | not the mint the signer is pinned to | never; the plugin only knows that one portfolio |
| CHAIN_DENIED | the pool's chain is not in the policy's chain list | drop the pool |
| POOL_DENIED | not on the policy's allowlist, above its risk tier ceiling, or missing a required price feed | drop the pool |
| POOL_NOT_ACTIVE | catalogue status is not the one the policy requires | drop it; if held, this is a risk exit |
| POOL_COST_TOO_HIGH | the pool's maxExecutionLossBps is over the policy's ceiling | drop the pool |
| MIN_LEGS / MAX_LEGS | fewer or more legs than the policy's shape allows | reshape |
| PAGE_LIMIT | held ∪ new is over the policy's page limit | remove legs before adding |
| LEG_WEIGHT_CAP | a leg outside the policy's per-leg band, or above the pool's own cap | resize |
| STABLE_BAND | the stable category outside the policy's band | resize the sleeve |
| CATEGORY_CAP | a category over the policy's cap | resize |
| WEIGHTS_SUM | weights do not reach the policy's sum exactly | fix the arithmetic |
| TURNOVER_CAP | Σ\|Δw\|/2 over the policy's turnover cap; the message carries both | a smaller step; the rest waits its cadence |
| COST_CAP | estimated cost over the policy's cost cap; the message carries both | fewer or cheaper legs to move |
| PROPOSAL_TOO_SOON | the last rebalance is younger than the policy's minimum | HOLD until `nextProposeAt` |
| PROPOSAL_QUOTA | the policy's proposals-per-window quota is spent | HOLD; say when the quota frees |
| TARGETS_PENDING | a change is already pending | wait for the apply, or `cancel {why}` first |
| INPUTS_INCOMPLETE | a targeted pool lacks yield / TVL / risk tier | HOLD unless it is a risk exit; say which pool |
| OUTSIDE_WINDOW | outside the policy's UTC propose window; the message carries it | HOLD; propose in the next window |
| WHY_REQUIRED | `why` empty or over the policy's length limit | write the reason |
| DEPOSIT_DAILY_CAP | today's deposits would pass the policy's daily cap (or its launch-day cap) | smaller amount or tomorrow |
| BOOK_NOT_FRESH | the book's price is stale or pending | wait for the keeper; `refresh_nav` when it has been stale past the policy's refresh threshold and the keeper is not ok |
| CAP_HEADROOM | amount exceeds the vault caps or idle headroom | smaller amount; tell the owner the caps bind (governance raises them) |
| WITHDRAW_CRON_BLOCKED | withdraw from a cron session | only when the owner asks in chat |
| WITHDRAW_DAILY_CAP | today's withdrawals would pass the policy's daily cap | smaller amount or tomorrow |
| VERB_DENIED | a verb no one may use through the signer | never; it is an owner-wallet action |
| OPS_ONLY | an ops verb with the agent token | tell the owner; they run it with the ops token |
| RATE_LIMITED | write attempts this hour over the policy's ceiling | stop writing; something is looping |
| LOW_SOL | the signer's balance is under the policy's lamport floor | alert the owner to top up the signer |
| SELF_LOCKED | an invariant drifted; every write refused | report the drift; only the ops `unlock` clears it |
| INVARIANT_DRIFT | the drift itself (curator, pending curator, delay, treasury, guardian, lock) | report exactly which invariant; do nothing else |
| PAUSED | the signer is paused | only `cancel` works; the owner resumes |
| INVARIANTS_UNVERIFIED | the signer could not read the accountant or the factory config on its last tick, so writes are held | wait a tick; if it persists, tell the owner (chain read problem, not a drift) |
| PAGED_PROPOSE_UNSUPPORTED | a proposal of more assets than one propose page holds | fewer assets |
| UNAUTHORIZED / BAD_REQUEST / NOT_FOUND | token, body or route wrong | a plugin or config problem; tell the owner |
| UPSTREAM | the api is down or answered a server error | wait; curator-health relays it |
| BUILD_REFUSED | the api refused the build (its code is in `detail`) | read `detail`; usually a policy the api enforces too |
| SEND_FAILED | the chain rejected or lost the send | the program error is named in `detail`; see below |
| NOT_A_TRANSACTION, WRONG_PAYER, FOREIGN_PROGRAM, FOREIGN_LOOKUP_TABLE, UNKNOWN_INSTRUCTION, UNEXPECTED_INSTRUCTIONS, WRONG_PORTFOLIO, TARGETS_MISMATCH, UNEXPECTED_STEP | the api built something the signer would not sign | nothing was signed; report it as an api defect to the owner |

Apply blockers (from `status.apply.lastBlocker` or a forced `apply`):
NO_PENDING_CHANGE (nothing to apply, or a stranger applied first; the loop
verifies), WINDOW_CLOSED (the policy's apply window has passed since
effectiveAt: `cancel {why}` and re-propose), NOTICE_NOT_ELAPSED (wait),
VAULT_PAUSED (BLOCKED: `pause`, then `cancel {why}`; governance unpauses),
LEG_NOT_ACTIVE (BLOCKED: `cancel {why}` and re-propose without the pool),
BOOK_NOT_FRESH / BOOK_PENDING_PRICE / LEG_PENDING_PRICE / LEG_STALE (waiting
on the keeper or a publisher; the loop escalates on the policy's clock),
WITHDRAWALS_PENDING (the keeper fulfils FIFO), APPLY_IN_FLIGHT (a paged apply
is mid-way; the loop restarts at page 0), MISSING_CUSTODY (the api prepends
the custody create; one retry), APPLIED_MISMATCH (a stranger applied
different targets: report to the owner).

## Program errors (chain, after signing)

`portfolio_factory` (`FactoryError`, code 6000 + index). Curator-reachable
first; the rest are create-time, pool-registration or governance checks a
curator verb can never trip. If one appears, the api built the wrong
transaction: report it.

| Code | Name | Meaning | Action |
|---|---|---|---|
| 6004 | PoolNotActive | a targeted pool is not active | drop it, re-propose |
| 6001 | TooManyLegs | more legs than the program allows | reshape |
| 6002 | DuplicatePool | a pool twice in targets | fix the list |
| 6003 | PoolAccountMismatch | pool accounts ≠ targets | api defect; report |
| 6005 | WeightsMustSumToBps | weights ≠ 10000 | fix the arithmetic |
| 6006 | WeightExceedsPoolCap | a weight above the pool's cap | resize |
| 6007 | ZeroWeight | a 0 weight; omit the pool instead | remove the leg |
| 6015 | WrongPortfolioState | the portfolio is not live | report; nothing to do |
| 6017 | CompositionLocked | composition locked for good | invariant drift; report |
| 6018 | TargetsChangePending | a change already pending | wait or cancel |
| 6019 | NoTargetsChangePending | nothing to apply or cancel | a stranger acted first; verify targets |
| 6020 | RebalanceTooSoon | delay since the last apply not elapsed | HOLD until `nextProposeAt` |
| 6021 | RebalanceDelayTooShort | delay under the redemption estimate | ops-only `set-delay`; report |
| 6022 | TargetsNotEffective | notice not elapsed | wait |
| 6023 | TooManyConcurrentPositions | active + exiting legs over the limit | fewer new legs until unwinds finish |
| 6024 | PositionStillTargeted | retiring a pool still targeted | keeper/ops matter; report |
| 6025 | PositionBalanceNonZero | custody not empty before retirement | wait for the unwind |
| 6026 | PositionUnwindPending | an unwind not reconciled | wait for the keeper |
| 6027 | MissingCustodyForNewPool | a new pool has no custody account | the api prepends the create; one retry |
| 6028 | HeldPoolAccountSetInvalid | held/new account set wrong | api defect; report |
| 6029 | ApplyInFlight | a paged apply is mid-way | the loop waits its slots and restarts |
| 6030 | PagedWindowExpired | a paged apply ran past its slots | the loop restarts at page 0 |
| 6031 | NoPendingCurator | no curator transfer pending | rotation matter; report |
| 6032 | PortfolioPriceMissing | the book has no price | report (unreachable by design) |
| 6033 | PortfolioPriceStale | the book's price is stale | wait; `refresh_nav` if the keeper is not ok |
| 6034 | PortfolioPricePending | the book has an unaccepted mark | wait for the publisher / owner |
| 6035 | PoolPriceStale | a required pool price is stale | wait for the keeper's crank |
| 6036 | PoolPricePending | a required pool mark is pending | Pyth: wait, the loop escalates on the policy's clock; publisher: do not wait, report |
| 6037 | VaultPaused | the vault is paused | BLOCKED; `pause` + `cancel`; governance unpauses |
| 6038 | RequiredPoolPaused | a required pool is paused or halted | risk exit; re-propose without it |
| 6039 | AlreadyInThatPauseState | pause/unpause no-op | ops matter |
| 6040 | PendingWithdrawalsBlockTargets | withdrawals queued | wait for the keeper (FIFO) |
| 6064 | Unauthorized | wrong signer for the instruction | invariant drift (curator changed); report |
| 6063 | MathOverflow | arithmetic overflow | report; never retry |
| 6000 | CreationPaused | factory creation paused | create-time only |
| 6008 | FeeExceedsCap | fee above the factory cap | create-time only |
| 6009 | SpreadTooLow | entry + exit spread below minimum | create-time only |
| 6010 | IdleTargetTooLow | idle target below minimum | create-time only |
| 6011 | DriftBandOutOfRange | drift band outside range | create-time only |
| 6012 | CreatorFeeOutOfRange | creator fee not in (0, 10000) | create-time only |
| 6013 | CreatorIsTreasury | creator equals the treasury | create-time only |
| 6014 | InsufficientRent | rent lamports short | create-time only |
| 6016 | ActivationInvariantFailed | activation check failed | create-time only |
| 6041 | PoolReserveRatioOutOfRange | pool reserve ratio outside 1..10000 | governance only |
| 6042 | MaxPriceAgeOutOfRange | pool max price age outside 1..86400 | governance only |
| 6043 | UnauthorizedPoolReserveUpdate | not governance | governance only |
| 6044 | PoolVaultNotOwnedByCore | pool vault owner wrong | pool registration only |
| 6045 | PoolMintMismatch | pool mint wrong | pool registration only |
| 6046 | PoolDecimalsMismatch | pool decimals wrong | pool registration only |
| 6047 | LiquidityTierOutOfRange | liquidity tier out of range | pool registration only |
| 6048 | RiskTierOutOfRange | risk tier out of range | pool registration only |
| 6049 | RiskDisclosureHashMissing | disclosure hash zero | pool registration only |
| 6050 | ExecutionLossPolicyExceeded | pool loss bound above policy | pool registration only |
| 6051 | InvalidSymbol | symbol empty or too long | create / pool registration only |
| 6052 | EscrowMismatch | escrow account or manager wrong | pool registration only |
| 6053 | TokenExtensionMismatch | Token-2022 snapshot wrong | pool registration only |
| 6054 | CustodyPathNotReady | custody readiness proof missing | pool registration only |
| 6055 | ServiceNotPaused | service must be paused before a key change | governance only |
| 6056 | DefaultKeyNotAllowed | default pubkey | governance only |
| 6057 | RoleUnchanged | role already holds the key | governance only |
| 6058 | ServiceRoleCollision | service roles must differ | governance only |
| 6059 | GovernanceIsTreasury | governance equals the treasury | governance only |
| 6060 | InvalidPolicyValue | bad policy value | governance only |
| 6061 | RentMarginNotSet | rent margins zero | governance only |
| 6062 | InvalidAuthorityPda | authority PDA not system-owned | governance only |

Core `stoken` errors (deposit, withdraw, NAV) are named the same way by the
signer (`STOKEN_ERRORS`); the ones a curator verb can meet are the vault
paused, the caps (max total shares / per user / idle), a stale or pending
price, and slippage under `minShares` / `minAmountOut`, all of which the
policy checks before signing, so on chain they mean the state moved between
the check and the send: wait one tick and let the loop or the owner decide.
