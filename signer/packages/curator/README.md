# @composable-portfolios/curator — the WEAVR curator signer

The only process that holds the WEAVR curator key. The Hermes agent talks to it
over HTTP with a bearer token; it decides (policy), builds (REST at the api),
verifies (IDL decode of every instruction), signs, sends and journals. It
runs a 30 s loop that applies an announced rebalance once the notice has
elapsed, checks the on-chain invariants and exposes Prometheus metrics.

Plan: `composable-portfolios-ops/11-09-2026-weavr-curator-plan.md` §4.2–4.9,
§5, §7. Sections below are the contract between the modules; each module is
owned by one implementer and touches no other file.

Repo rule: a gate that has only ever been seen to pass is indistinguishable
from a gate that cannot fail. Every refusal code below gets a unit test on a
PLANTED violation (`test/*.test.js`, `node --test 'test/*.test.js'`). Happy
paths use fakes (fake `fetchImpl`, fake `connection`), never the network.

```
signer/packages/curator/
  bin/start.mjs     the image entrypoint: CURATOR_KEYPAIR_JSON → a 0600 file when a deployment hands the key over as env, then boot()
  src/index.js      boot: env guards (exit 1 when a token is missing/short), ctx, loop, server
  src/server.js     HTTP :8091, fail-closed bearer auth, routes → verbs
  src/verbs.js      one async function per verb: policy → build → decode → sign → send → journal
  src/loop.js       30 s tick: snapshot → invariants (self-lock) → apply state machine → alerts → gauges
  src/preflight.js  readSnapshot (the only impure function) + pure gates: applyGates, proposeGates, checkInvariants
  src/policy.js     pure: loadPolicy, verbAllowed, evaluateWrite, evaluateProposal, evaluateDeposit, evaluateWithdraw
  src/decode.js     pure: verifyBuilt — every instruction of every built tx, legacy and v0
  src/metrics.js    pure: deriveReview (brief + triggers + wakeAgent), renderPrometheus
  src/errors.js     FACTORY_ERRORS, STOKEN_ERRORS, nameProgramError, Refusal, REFUSAL_STATUS
  src/keys.js       loadSigner: 0600 keypair file → { wallet, kind:'curator', sign(base64[]) }
  src/journal.js    Journal: append-only JSONL on the PVC, tail, rebuildLedger
  src/weavr.js      REST client with injectable fetch: get/post/build*/send
  scripts/create_portfolio.mjs  the one-shot WEAVR create, run from a laptop by the treasury key (§9) — never by this process
  test/             one planted violation per refusal code; the api-built decode fixtures are the backend's contract suite (§8)
```

## 1. Environment (read once at boot by `index.js`)

`readConfig(env)` in `index.js` is the list; both spellings of a variable are
read, the first named wins.

| Variable | Required | Meaning |
|---|---|---|
| `CURATOR_SIGNER_TOKEN` | yes, ≥ 32 bytes, no whitespace | agent bearer token (Hermes plugin) |
| `CURATOR_OPS_TOKEN` | yes, ≥ 32 bytes, no whitespace | ops bearer token (laptop via port-forward); must differ from the agent token |
| `CURATOR_KEYPAIR` | yes | path to the 64-byte JSON keypair. The compose stack mounts it read-only at `/keys/curator.json`. A deployment that hands the key over as `CURATOR_KEYPAIR_JSON` instead gets it written by `bin/start.mjs` to `$COMPOSABLE_PORTFOLIOS_KEY_DIR/solana/curator.json` at 0600, and `CURATOR_KEYPAIR` defaulted to that path |
| `CURATOR_PORTFOLIO_MINT` | yes, base58 | the WEAVR shares mint (the only portfolio the signer will touch) |
| `CURATOR_TREASURY` | yes, base58 | pubkey that must equal `accountant.recipient1` |
| `CURATOR_EXPECTED_GUARDIAN` | yes, base58 | pubkey that must equal `factoryConfig.guardian` |
| `CURATOR_POLICY_JSON` or `CURATOR_POLICY_FILE` | one of the two | the policy document inline (rendered from `ops/config/curator/policy.v1.json`) or a path to it |
| `CURATOR_API_URL` | yes, `http(s)://` | the api base, e.g. `https://api.weavr.sh` |
| `CURATOR_RPC_URL` or `SOLANA_RPC_URL` | one of the two, `http(s)://` or `ws(s)://` | Solana RPC — never logged, never journaled, never in an error message |
| `CURATOR_JOURNAL` or `CURATOR_JOURNAL_PATH` | no | JSONL path, default `/app/.cache/curator/journal.jsonl` (the 1Gi PVC the chart mounts at `/app/.cache`, plan §5); renamed to `<file>.1` at 50 MB |
| `CURATOR_PORT` or `CURATOR_SIGNER_PORT` | no | default `8091`, bound on `0.0.0.0` |
| `CURATOR_TICK_MS` | no | default `30000`, minimum `1000` |
| `CURATOR_START_PAUSED` or `CURATOR_PAUSED` | no | `1` boots paused (launch procedure, plan §7.5); it adds a pause, it never clears one the journal recorded |
| `CURATOR_REBALANCE_DELAY_SECS` | no | default `86400`: the expected `portfolio.rebalanceDelaySecs` invariant; `policy.invariants.rebalanceDelaySecs` overrides it |
| `NAV_LOOKUP_TABLE` | no | the one v0 lookup table a built transaction may load from (`readNavLookupTableAddress()` from `@composable-portfolios/chain`: this env, else the chain package's cache file). Its contents are read from the chain at boot and every tick so the decoder can resolve a v0 apply page. Unset ⇒ no table is allowed and a v0 apply is refused `FOREIGN_LOOKUP_TABLE` |

Boot exits 1, with a plain reason on stderr and no secret, when any required
variable is missing, a token is shorter than 32 bytes or contains whitespace,
the two tokens are equal, a pubkey variable is not base58, a URL variable has
no scheme, an integer variable is out of range, the keypair file is unreadable
or not a 64-byte array (`Refusal('CONFIG')` from `keys.js`), or `loadPolicy`
throws. `boot()` rebuilds the ledger from the journal before it listens, so a
restart keeps a recorded pause or self-lock, a standing operator request and
the last review's state (§4.5). The boot record and the boot log line carry
`policySha256`, the digest of the policy as loaded (§2 `GET /policy`).

## 2. HTTP API (plan §4.2)

JSON only, compact, never a `walletPayload`, never a transaction body, never
key material or an RPC URL. Every response is `application/json`.

### Auth headers

| Header | Value | Rule |
|---|---|---|
| `Authorization` | `Bearer <token>` | required on every route except `/healthz` and `/metrics`; compared with `crypto.timingSafeEqual` against both tokens; missing, malformed or unknown ⇒ `401 {error:{code:'UNAUTHORIZED'}}`. **Fails closed**: there is no "token unset ⇒ allow" path (the keeper's `completeCreate.js authorized()` is the anti-pattern). |
| `X-Curator-Session` | `cron` \| `chat` | which Hermes session made the call. Missing or any other value ⇒ treated as `cron` (the more restrictive). Journaled. |
| `X-Curator-Caller` | free text ≤ 64 chars | who is calling (`hermes-plugin`, `curator-health.sh`, `ops-laptop`); journaled on every request; missing ⇒ `unknown`. |

Token kind is decided by which token matched: `agent` or `ops`. Ops routes
called with the agent token ⇒ `403 {error:{code:'OPS_ONLY'}}`. Agent routes
called with the ops token are allowed (ops is a superset).

### Routes — agent token

| Method | Path | Request body | 200 response |
|---|---|---|---|
| GET | `/status` | — | `{ ok, at, error?, paused, selfLocked:{at,reason}\|null, apply:{state,deploymentId,effectiveAt,attempts,since,lastBlocker}, portfolio:{mint,symbol,state,priceState,pendingPrice,withdrawalsPending,curator,pendingCurator,rebalanceDelaySecs,lastRebalanceAt,applyNextPage,compositionLocked,pendingTargets}\|null, signer:{wallet,lamports,usdcBaseUnits,shares}, invariants:{ok,drift:[{invariant,expected,actual}]}, ledger:{lastProposalAt,proposalsLast30d,depositsTodayUsd,withdrawalsTodayUsd,writeAttemptsLastHour,lastDepositAt,topUpBudgetSpent}, policy:{version,sha256,review}, lastTick:{at,ok,error} }` — when the snapshot read fails the last good one is answered with `ok:false` and `error` set; `invariants.ok` is `null` with no snapshot. `ledger.lastDepositAt` is the newest ok deposit in the journal, whatever its day (`null` when there never was one); `ledger.topUpBudgetSpent` is true when the policy denies `deposit`, when the day's cap is zero, or when today's deposits have reached it (the day's cap is `deposit.launchDayCapUsd` on `deposit.launchDay` and `deposit.dailyCapUsd` otherwise, the same switch `evaluateDeposit` makes); `policy.sha256` is the digest `GET /policy` serves and `policy.review` is the loaded `review` section whole, which is how `deriveReview` gets the thresholds in force (it reads `status.policy.review` and falls back to constants of its own without it, so the counts the agent reads from `GET /policy` are the ones that wake it) |
| GET | `/review` | `?mode=universe` or `?mode=weekly`, else the plain review | `{ brief, triggers:[{code,detail}], wakeAgent, holdReason }` — `brief` ≤ `policy.review.briefMaxChars` (4096) plain text whose last line is `{"wakeAgent":<bool>}` for the Hermes wake gate; `holdReason:'STATUS_UNAVAILABLE'` when no snapshot exists. Every mode reads the review state (§4.5); only the plain review consumes an operator request, and only the first cron plain review of a UTC day on a fresh snapshot advances the drift streak, stores the risk tiers and journals a `review` record |
| GET | `/policy` | — | `{ version, sha256, policy }`: the policy document as loaded (`loadPolicy`, comments stripped), whole, with its version and the sha256 hex of its canonical JSON (keys sorted at every level, `journal.canonicalSha256`). The document holds no secret: no key, no URL, no token. A read: never journaled, never a write attempt. The digest is the one `/status` quotes as `policy.sha256` and the boot record as `policySha256`, so an agent that reads a threshold here can name the document it read it from |
| GET | `/alerts` | — | `{ since, alerts:[{key,code,at,message,count?,resolved?}] }` — anomalies not yet delivered since the last `/alerts` call; a `key` is delivered once, again after 6 h if still raised (`count`), and once more as `resolved: …` when it clears; `alerts:[]` means silent |
| POST | `/simulate` | `{ targets:[{poolId,weightBps}], why? }` | `{ ok, refusals:[{code,message}], summary:{turnoverBps,estimatedCostBps,legs:[{poolId,symbol,fromBps,toBps,deltaBps,maxExecutionLossBps}],categories:{<name>:bps},nextProposeAt}\|null }` — `evaluateProposal` refusals plus `proposeGates` blockers, nothing built, nothing signed; `WHY_REQUIRED` is dropped when `why` is omitted |
| POST | `/propose` | `{ targets:[{poolId,weightBps}], why }` | `{ ok:true, verb:'propose', deploymentId, signatures:[...], effectiveAt, journalId }` — arms the apply machine |
| POST | `/apply` | `{}` | `{ ok:true, verb:'apply', state:'DONE'\|'SENT', signatures:[...], steps? }`, or `{ ok:false, verb:'apply', state, blockers:[...] }` with the first blocker's `REFUSAL_STATUS` (default 422; `409` with `APPLIED_MISMATCH` when the pending change is gone and the chain differs from the proposal) — one forced attempt through the same gates as the loop |
| POST | `/cancel` | `{ why }` | `{ ok:true, verb:'cancel', signatures:[...], journalId }` — allowed while paused, never while self-locked; resets the apply machine to `IDLE` |
| POST | `/deposit` | `{ amountUsd }` | `{ ok:true, verb:'deposit', amountBaseUnits, minShares, signatures:[...] }` |
| POST | `/withdraw` | `{ amountUsd }` | `{ ok:true, verb:'withdraw', shares, minAmountOut, signatures:[...] }` — `chat` sessions only |
| POST | `/refresh-nav` | `{}` | `{ ok:true, verb:'refresh-nav', pages, signatures:[...] }` |
| POST | `/pause` | `{ why? }` | `{ ok:true, paused:true }` — disarms apply, refuses every write except `cancel`; idempotent |
| POST | `/note` | `{ text }` (≤ 2048 bytes) | `{ ok:true, journalId }` |
| GET | `/journal?n=` | — | `{ records:[...] }` oldest first (newest last), `n` default 50, max 500, `BAD_REQUEST` when not a non-negative integer |
| POST | `/hermes-heartbeat` | `{}` | `{ ok:true, at }` — sets `curator_hermes_heartbeat_ts` |

### Routes — ops token

| Method | Path | Request body | 200 response |
|---|---|---|---|
| POST | `/resume` | `{ why? }` | `{ ok:true, paused:false }` |
| POST | `/unlock` | `{ why }` | `{ ok:true, selfLocked:null, note? }` — clears a self-lock after the operator has fixed the drift; refuses (`INVARIANT_DRIFT`, 503) while the drift is still present; a no-op with `note` when not locked |
| POST | `/rotate-curator` | `{ newCurator, why }` | `{ ok:true, verb:'rotate-curator', signatures:[...], newCurator, next:{ step:'accept_curator', signedBy, build:{method,path,body}, send:{…}, then:[…] } }` — `propose_curator` signed by the current key; the accept is signed by the new key outside this process, and this signer self-locks on its next tick by design |
| POST | `/set-delay` | `{ rebalanceDelaySecs, why }` | `{ ok:true, verb:'set-delay', rebalanceDelaySecs, signatures:[...], warning? }` — REST `POST /v1/portfolios/:mint/rebalance-delay`; `warning` when the new delay differs from the invariant (self-lock follows) |
| POST | `/set-metadata` | `{ uri (≤ 128 chars), why }` | `{ ok:true, verb:'set-metadata', uri, signatures:[...] }` — REST `POST /v1/portfolios/:mint/metadata` |

### Unauthenticated

| Method | Path | Response |
|---|---|---|
| GET | `/healthz` | `200 {ok:true, at, lastTickAgeSecs, running?}`; `503 {ok:false, …}` before the first tick or when the last tick is older than 3 × `CURATOR_TICK_MS` |
| GET | `/metrics` | Prometheus text (`renderPrometheus(gaugesOf(ctx))`): `curator_last_tick_ts`, `curator_hermes_heartbeat_ts`, `curator_pending_effective_at`, `curator_apply_state{state=…}` (1 on the current state), `curator_book_price_fresh`, `curator_signer_lamports`, `curator_self_locked`, `curator_paused`, `curator_write_attempts_1h` |

Route matching is exact on method and path (a trailing slash is tolerated);
anything else is `404 NOT_FOUND` before authentication.

### Errors

Every refusal and failure is `{ error: { code, message, detail? } }` with the
status from `REFUSAL_STATUS` (errors.js). Default `422`; overrides:

| Status | Codes |
|---|---|
| 400 | `BAD_REQUEST` (malformed JSON, a non-object or > 64 KB body, a wrong argument type or range, `n` not an integer, `newCurator` already the curator), `WHY_REQUIRED` |
| 401 | `UNAUTHORIZED` |
| 403 | `OPS_ONLY`, `VERB_DENIED`, `WITHDRAW_CRON_BLOCKED`, `PORTFOLIO_NOT_ALLOWED` |
| 404 | `NOT_FOUND` |
| 409 | `TARGETS_PENDING`, `SELF_LOCKED`, `PAUSED`, `NO_PENDING_CHANGE`, `APPLY_IN_FLIGHT`, `VAULT_PAUSED`; `/apply` also answers 409 for `APPLIED_MISMATCH` (a body, not a `Refusal`) |
| 429 | `RATE_LIMITED`, `PROPOSAL_QUOTA`, `DEPOSIT_DAILY_CAP`, `WITHDRAW_DAILY_CAP` |
| 502 | `UPSTREAM` (api HTTP ≥ 500, unreachable, timed out or non-JSON), `BUILD_REFUSED` (api 4xx on a build — its `error.code` is in `detail`), `SEND_FAILED`, and the decode.js codes `NOT_A_TRANSACTION`, `WRONG_PAYER`, `FOREIGN_PROGRAM`, `FOREIGN_LOOKUP_TABLE`, `UNKNOWN_INSTRUCTION`, `UNEXPECTED_INSTRUCTIONS`, `WRONG_PORTFOLIO`, `WRONG_ACCOUNT`, `TARGETS_MISMATCH`, `UNEXPECTED_STEP`, `PAGED_PROPOSE_UNSUPPORTED` — the api built something the signer would not sign |
| 503 | `LOW_SOL`, `INVARIANT_DRIFT`, `INVARIANTS_UNVERIFIED` (writes held while the accountant or FactoryConfig could not be read on the last tick), `BOOK_NOT_FRESH`, `MISSING_CUSTODY` |
| 500 | `INTERNAL` — a verb crashed; the message is URL-scrubbed and carries no stack |
| 422 | `CAP_HEADROOM`, `INSUFFICIENT_SHARES` (listed), and by default everything else: the remaining §4.4 policy codes, `INPUTS_INCOMPLETE`, the `proposeGates` codes `COMPOSITION_LOCKED` / `WRONG_PORTFOLIO_STATE` / `REBALANCE_TOO_SOON`. `CONFIG` (keys.js, weavr.js) is a boot-time refusal that never reaches HTTP |

A refusal is journaled (`kind:'refusal'`) before it is answered, with the
caller and session. Response bodies are scrubbed of `tx`, `signed`,
`walletPayload` and any `transactions` list at any depth before they leave
the process.

## 3. Refusal codes (plan §4.4, verbatim) — each owns one planted-violation test

```
PORTFOLIO_NOT_ALLOWED
CHAIN_DENIED  POOL_DENIED  POOL_NOT_ACTIVE  POOL_COST_TOO_HIGH
MIN_LEGS  MAX_LEGS  PAGE_LIMIT  LEG_WEIGHT_CAP  CATEGORY_CAP  WEIGHTS_SUM
TURNOVER_CAP
COST_CAP
PROPOSAL_TOO_SOON  PROPOSAL_QUOTA  TARGETS_PENDING  INPUTS_INCOMPLETE  OUTSIDE_WINDOW
WHY_REQUIRED
DEPOSIT_DAILY_CAP  BOOK_NOT_FRESH  CAP_HEADROOM
WITHDRAW_CRON_BLOCKED  WITHDRAW_DAILY_CAP
VERB_DENIED  OPS_ONLY
RATE_LIMITED  LOW_SOL
SELF_LOCKED  INVARIANT_DRIFT
```

Additions the landed code makes (not in the §4.4 table; report if the owner
disagrees):

- `STABLE_BAND` — the "stablecoins 10–40% combined" rule has no code in §4.4
  (`CATEGORY_CAP` covers only "any category ≤ 60%"). `STABLE_BAND` covers both
  bounds; its message says which.
- `PAUSED` — §4.9 step 1 ("refuses writes; cancel stays allowed") needs a code
  distinct from `SELF_LOCKED` (which also refuses cancel).
- `LEG_WEIGHT_CAP` covers both bounds of "per leg 5%–min(40%, pool maxWeightBps)".
- `POOL_DENIED` covers: not in the catalogue, not in the allowlist, `riskTier`
  unknown or above the cap, or no `pythFeedId`. `POOL_COST_TOO_HIGH` is
  `maxExecutionLossBps` unknown or above the cap. `POOL_NOT_ACTIVE` is
  `status !== 'active'`. `CHAIN_DENIED` is chain not in the policy's chain list.
- `BAD_REQUEST` — an argument that has the wrong shape (targets not a
  non-empty unique list, `amountUsd` not positive, `uri` empty, …) is refused
  before any policy rule runs: policy (`validateTargets`, `amountOf`), verbs
  and server all use it.
- `INSUFFICIENT_SHARES` — `evaluateWithdraw`: the signer holds fewer shares
  than the amount needs, or the balance is unknown.
- `WRONG_ACCOUNT` — decode: an account that is not the portfolio but must be
  the signer or the signer's own ATA (deposit user / beneficiary, ATA rent
  payer or owner, crank payer) is someone else.
- `PAGED_PROPOSE_UNSUPPORTED` — decode: a proposal of more than 8 legs, or a
  built `propose_targets_page`; named so the journal never shows a paged
  proposal as a generic mismatch (unreachable while policy `MAX_LEGS` is 8).
- `COMPOSITION_LOCKED`, `WRONG_PORTFOLIO_STATE`, `REBALANCE_TOO_SOON` —
  `proposeGates` mirrors `validate_proposal` in the program; the 7-day cadence
  is policy's `PROPOSAL_TOO_SOON`, the on-chain `rebalance_delay_secs` floor is
  `REBALANCE_TOO_SOON`.
- `NO_PENDING_CHANGE`, `MISSING_CUSTODY` — the api's own build refusals kept
  by name (`verbs.refuseFromClient`) because the apply machine reacts to them;
  `APPLIED_MISMATCH` — a stranger applied something else (an `ESCALATED` body
  or alert, never a `Refusal`).
- `CONFIG` — `keys.loadSigner` / `weavr.weavrClient` at boot: unreadable or
  malformed keypair file, bad api URL. Exit 1, never an HTTP answer.
- The `create` verb (`scripts/create_portfolio.mjs`, §9) adds no code: the
  decoder reuses `WRONG_PAYER`, `FOREIGN_PROGRAM`, `FOREIGN_LOOKUP_TABLE`,
  `UNKNOWN_INSTRUCTION`, `UNEXPECTED_STEP`, `UNEXPECTED_INSTRUCTIONS`,
  `WRONG_PORTFOLIO`, `WRONG_ACCOUNT`, `TARGETS_MISMATCH` (an argument the
  intent fixed — `curator`, `rebalance_delay_secs`, a fee, the name — the
  targets, and the two ceilings: an outlay above `maxLamports`, a priority
  fee above `maxPriorityLamports`) and `NOT_A_TRANSACTION`; the CLI turns
  them into exit 2, never an HTTP answer. `create` itself stays in policy
  `verbs.denied` (`VERB_DENIED` for any token).
- `UPSTREAM`, `BUILD_REFUSED`, `SEND_FAILED`, `UNAUTHORIZED`, `NOT_FOUND`,
  `INTERNAL` — transport and server codes (§2 Errors).

Which module raises which:

| Module | Codes |
|---|---|
| `policy.verbAllowed` | `VERB_DENIED`, `OPS_ONLY`, `WITHDRAW_CRON_BLOCKED` |
| `policy.evaluateWrite` | `PORTFOLIO_NOT_ALLOWED`, `SELF_LOCKED`, `PAUSED`, `RATE_LIMITED`, `LOW_SOL` |
| `policy.evaluateProposal` | `BAD_REQUEST` (shape, returned alone), then every violation collected: `INPUTS_INCOMPLETE`, `CHAIN_DENIED`, `POOL_DENIED`, `POOL_NOT_ACTIVE`, `POOL_COST_TOO_HIGH`, `MIN_LEGS`, `MAX_LEGS`, `PAGE_LIMIT`, `LEG_WEIGHT_CAP`, `STABLE_BAND`, `CATEGORY_CAP`, `WEIGHTS_SUM`, `TURNOVER_CAP`, `COST_CAP`, `PROPOSAL_TOO_SOON`, `PROPOSAL_QUOTA`, `TARGETS_PENDING`, `OUTSIDE_WINDOW`, `WHY_REQUIRED` |
| `policy.evaluateDeposit` | `BAD_REQUEST`, `DEPOSIT_DAILY_CAP`, `BOOK_NOT_FRESH`, `CAP_HEADROOM` |
| `policy.evaluateWithdraw` | `BAD_REQUEST`, `WITHDRAW_CRON_BLOCKED`, `WITHDRAW_DAILY_CAP`, `BOOK_NOT_FRESH`, `INSUFFICIENT_SHARES` |
| `policy.evaluateInvariants` | `INVARIANT_DRIFT` (pure twin of `preflight.checkInvariants` over `{ policy, chain, config }`; exported, not on the runtime path) |
| `preflight.checkInvariants` | no code: `{ ok, drift, unverified }`; the loop turns `ok:false` into a self-lock + alert `INVARIANT_DRIFT`, `/unlock` refuses `INVARIANT_DRIFT` while it holds |
| `preflight.applyGates` | blocker codes, §5 below (`NO_PENDING_CHANGE`, `WINDOW_CLOSED`, `NOTICE_NOT_ELAPSED`, `VAULT_PAUSED`, `LEG_STALE`, `LEG_NOT_ACTIVE`, `LEG_PENDING_PRICE`, `BOOK_NOT_FRESH`, `BOOK_PENDING_PRICE`, `WITHDRAWALS_PENDING`, `APPLY_IN_FLIGHT`, `MISSING_CUSTODY`) |
| `preflight.proposeGates` | six blocker codes: `COMPOSITION_LOCKED`, `WRONG_PORTFOLIO_STATE`, `TARGETS_PENDING`, `REBALANCE_TOO_SOON`, `APPLY_IN_FLIGHT`, `VAULT_PAUSED` |
| `decode.verifyBuilt` | `NOT_A_TRANSACTION`, `FOREIGN_LOOKUP_TABLE`, `FOREIGN_PROGRAM`, `UNKNOWN_INSTRUCTION`, `WRONG_PAYER`, `UNEXPECTED_STEP`, `UNEXPECTED_INSTRUCTIONS`, `PAGED_PROPOSE_UNSUPPORTED`, `WRONG_PORTFOLIO`, `WRONG_ACCOUNT`, `TARGETS_MISMATCH` — §6 below |
| `keys.loadSigner` | `CONFIG` at load; `NOT_A_TRANSACTION` from `sign()` |
| `weavr.weavrClient` | `CONFIG`, `BAD_REQUEST`, `UPSTREAM`, `BUILD_REFUSED`, `SEND_FAILED` |
| `verbs` | the four hard rules re-checked before the policy (`PORTFOLIO_NOT_ALLOWED`, `WITHDRAW_CRON_BLOCKED`, `SELF_LOCKED`, `PAUSED`), `WHY_REQUIRED`, `BAD_REQUEST`, `NO_PENDING_CHANGE`, `MISSING_CUSTODY`, `INVARIANT_DRIFT` (`/unlock`), `expectFor`'s `UPSTREAM` (row without keys) / `INPUTS_INCOMPLETE` (a targeted pool with no Pool key), and the passthroughs `UPSTREAM`, `BUILD_REFUSED`, `NOT_A_TRANSACTION`, `UNKNOWN_INSTRUCTION` (a decode crash), `SEND_FAILED` (named by program error where possible) |
| `loop` | alerts, not refusals: `INVARIANT_DRIFT`, `LOW_SOL`, `SEND_FAILED`, `WINDOW_CLOSED`, `APPLIED_MISMATCH`, `MISSING_CUSTODY`, and any blocker or decode code the machine escalates or blocks on (`alert:<code>`) |
| `server` | `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND`, `OPS_ONLY`, `INTERNAL` |
| `scripts/create_portfolio.mjs` (§9, exit codes, never HTTP) | `BAD_REQUEST` (argv: key material, an unknown flag, malformed targets, a missing `--keeper-processor`, a missing `--name` or `--symbol`, a name, symbol or metadata URI wider than the factory's bytes, both key sources), `CONFIG` (no key or a malformed one, a malformed `NAV_LOOKUP_TABLE`), `INPUTS_INCOMPLETE` (a target without a Pool key), `BUILD_REFUSED` / `UPSTREAM` (also a `rentLamports` quote that is not integers), every `decode.verifyBuilt` code under the `create` verb (`TARGETS_MISMATCH` also for an outlay above `--max-lamports` or a priority fee above `--max-priority-lamports`), `SEND_FAILED` |

## 4. Shared shapes — copy these

### 4.1 `ctx` (built once by `index.js`; every verb and the loop take it)

```js
ctx = {
  policy,   // loadPolicy(CURATOR_POLICY_JSON) — frozen, validated (policy.js)
  policyDigest, // sha256 hex of the canonical JSON of `policy` (verbs.policyDigestOf), computed once at boot;
                // a ctx built without index.js gets it on first use
  signer,   // { wallet: base58, kind: 'curator', sign: async (base64[]) => base64[] } (keys.js)
  client,   // weavrClient({ apiUrl, fetchImpl }) (weavr.js)
  journal,  // new Journal({ file }) (journal.js)
  chain: {
    connection,        // @solana/web3.js Connection (connect(rpcUrl) from @composable-portfolios/chain)
    programs: Set,     // allowed program ids: manifest programs + core (index.js allowedProgramSet())
    lookupTableAllowlist: Set,  // the v0 lookup tables a message may load from: the NAV table only (allowedLookupTableSet())
    lookupTables: Map, // address → AddressLookupTableAccount | null: the allowed tables' CONTENTS, so the decoder can
                       // resolve the accounts of a v0 apply page; null = allowed but unread ⇒ an asserted account refuses
    refreshLookupTables: async () => Map, // re-reads the contents (loadLookupTables); the loop calls it every tick,
                       // a write verb once more on a decode miss (UNKNOWN_INSTRUCTION / FOREIGN_LOOKUP_TABLE) before refusing
    idls: { portfolio_factory, stoken, accountant }, // idlFor(name) results, for decode + account reads
    lib?,              // tests only: the chain package's functions readSnapshot uses (fetchDecoded, …), faked
  },
  config: {
    mint,               // base58 — CURATOR_PORTFOLIO_MINT (the only allowed portfolio)
    treasury,           // base58 — CURATOR_TREASURY (== accountant.recipient1)
    expectedCurator,    // base58 — signer.wallet (== portfolio.curator)
    guardian,           // base58 — CURATOR_EXPECTED_GUARDIAN (== factoryConfig.guardian)
    rebalanceDelaySecs, // policy.invariants.rebalanceDelaySecs ?? CURATOR_REBALANCE_DELAY_SECS (86400)
    apiUrl, port, tickMs, journalFile,
  },
  state: {              // mutable, shared by server + loop, persisted through the journal
    paused: bool,
    selfLocked: null | { at, reason, drift: [...] },
    operatorRequest: null | { at, text },   // POST /operator-request (ops); the plain review consumes it
    reviewState: null | { at, driftStreak: { poolId: reviews }, riskTiers: { poolId: tier } }, // §4.5: the last plain
                        // review's carry-over, replayed from the journal at boot and rewritten after every plain review
    apply: { state: APPLY_STATE, deploymentId, effectiveAt, targets, proposedAt, attempts, since, lastBlocker,
             escalatedAt, sendFailures, refreshNavSent, custodyRetries, lastSentAt, signatures },
    ledger,             // journal.rebuildLedger() result, rebuilt after every append
    ledgerFromJournal,  // true once the ledger comes from the file (the verbs then skip in-memory bumps)
    alerts: Map,        // key → { key, code, at, lastAlertedAt, message, delivered, resolvedAt, count }
    alertsSince,        // unix secs of the last GET /alerts
    hermesHeartbeatAt: unix secs | null,
    lastTick: { at, ok, error },
    lastSnapshot,       // the last snapshot read (status falls back to it when a read fails; gauges read it)
    snapshotKeys,       // { portfolio, vaultKey, accountant } cached from the api row for an api outage
  },
  deps?,                // tests: fakes for policy / decode / preflight / metrics functions (verbs.depsOf)
  sleep?,               // tests: the loop's sleep
  now: () => Date.now(),       // ms; tests inject a fake clock
  log: (level, event, fields) => void, // JSON line to stdout; never a secret, an RPC URL or a tx body
};
```

`meta` — the third argument of every verb: `{ session: 'cron' | 'chat', caller: string, tokenKind: 'agent' | 'ops' }`.

### 4.2 `snapshot` (pure data; `preflight.readSnapshot(ctx)` builds it, every gate consumes it)

Field names are what `fetchDecoded` returns (Anchor's BorshAccountsCoder emits camelCase; pubkeys are `PublicKey` — gates compare with `.toBase58()`; `u64`/`i64` are `BN` — gates convert with `.toString()`/`BigInt`).

```js
snapshot = {
  at: unix secs,                      // ctx.now()/1000 at the start of the read
  slot: number,                       // connection.getSlot()
  portfolioRow: {                     // GET /v1/portfolios/:mint, unfiltered
    mint, symbol, state, priceState, pendingPrice, withdrawalsPending,
    pendingTargets: { targets:[{poolId,weightBps}], proposedAt, effectiveAt } | null,
    holdings: { legs:[{poolId,symbol,targetWeightBps,weightBps,valueUsdc}], idleWeightBps },
    curator, feeRecipient, rebalanceDelaySecs, compositionLocked, vaultKey, accountant, portfolio,
  },
  portfolioAccount: {                 // fetchDecoded(connection,'portfolio_factory','Portfolio', row.portfolio)
    curator, pendingCurator, accountant, sharesMint, compositionLocked, rebalanceDelaySecs,
    lastRebalanceAt, pendingTargets, applyNextPage, state, vault, creator, legCount, pageCount,
  },
  vaultAccount: {                     // fetchDecoded(connection,'stoken','VaultConfig', row.vaultKey)
    totalShares, totalIdle, totalWithdrawalsPending, maxTotalShares, maxSharesPerUser, maxTotalIdle,
    pendingPrice, paused, price, lastPriceUpdateTimestamp, maxPriceStalenessSecs, underlyingMint,
  },
  accountantAccount: {                // fetchDecoded(connection,'accountant','Accountant', row.accountant)
    recipient1, recipient2, weight1, weight2, manager, pendingRecipients,
  },
  factoryConfig: {                    // fetchDecoded(connection,'portfolio_factory','FactoryConfig', factoryConfigKey())
    governance, guardian, treasury, keeperProcessor, policy, creationPaused, keeperRiskPaused, underlyingMint,
  },
  applyScratch,                       // fetchDecoded(…,'ApplyScratch') only while applyNextPage !== 0, else null
  pools: [                            // GET /v1/pools rows (every row, not only held)
    { poolId, symbol, chain, status, priceState, pendingPrice, tvlUsdc, riskTier, maxWeightBps,
      maxExecutionLossBps, trailingYieldBps, pythFeedId },
  ],
  health: { ... },                    // GET /health json; `keeper.ok` or `processes.keeper.status === 'ok'` decides the refresh-nav gate
  pendingUnwinds: string[] | null,    // poolIds with an unwind in flight, when the row carries them
  custody: null,                      // { poolId: bool } when a caller knows the custody ATAs; readSnapshot leaves it null
  signer: {
    lamports: number,                 // connection.getBalance(signer)
    usdcBaseUnits: string | null,     // signer USDC ATA balance (deposit source)
    shares: string | null,            // signer WEAVR shares ATA balance (withdraw source)
  },
};
```

`readSnapshot` never throws on a missing optional read: a failed REST or
chain read leaves the field `null`, and every gate treats `null` as "unknown ⇒
wait" (never as "fine"). `portfolioAccount` and `vaultAccount` are required —
their absence is a tick error, not a pass. The portfolio, vault and accountant
keys come from the api row and are cached in `state.snapshotKeys`, so an api
outage still lets the loop read the chain.

### 4.3 `ledger` (rebuilt at boot by `journal.rebuildLedger()`, so a restart cannot reset a cap)

```js
ledger = {
  lastProposalAt: unix secs | null,     // max(journal propose ok, chain lastRebalanceAt) — the loop merges chain in
  proposalsLast30d: number,             // ok propose records with at > now - 30 d
  proposals: [{ at, effectiveAt, targets, signatures, why }],
  depositsTodayUsd: number,             // UTC day
  withdrawalsTodayUsd: number,
  writeAttempts: [unix secs],           // every write verb attempt (ok or refused) in the last hour
  writeAttemptsLastHour: number,
  paused: bool,                         // last pause/resume record wins
  selfLocked: null | { at, reason, drift? },  // last lock/unlock record wins
  operatorRequest: null | { at, text }, // last operator-request record, cleared by operator-request-consumed
  applied: [{ at, deploymentId, signatures }],
  reviewState: null | { at, driftStreak, riskTiers },  // the last review record wins, whatever its age (§4.5)
  lastDepositAt: unix secs | null,      // the newest ok deposit record, any day (a refusal never counts)
};
```

### 4.4 Journal records (JSONL, one object per line, never a secret or a tx body)

```js
{ id, at, kind, caller?, session?, tokenKind?, ...fields }
// kind: 'boot' | 'verb' | 'refusal' | 'apply' | 'tick' | 'alert' | 'note' | 'lock' | 'unlock' | 'pause' | 'resume' | 'heartbeat'
//     | 'operator-request' | 'operator-request-consumed' | 'review'
// boot:    { wallet, mint, policyVersion, policySha256, paused, selfLocked, reviewState: { at } | null, port, tickMs, programs, lookupTables, lookupTablesResolved }
// verb:    { verb (camelCase: refreshNav, setDelay, …), route, ok:true, args (targets/amountUsd/why/newCurator/uri only),
//            signatures, deploymentId, steps, + the verb's own fields (effectiveAt, summary, amountBaseUnits, shares, …) }
// refusal: { verb, route, ok:false, code, message, args, detail? }
// apply:   { from, to, deploymentId, effectiveAt?, blockers, attempts, signatures }
// alert:   { key, code, message, state: 'raised' | 're-raised' | 'resolved' }
// lock:    { reason:'INVARIANT_DRIFT', drift }      tick: { ok:false, error } (a failed tick, once until it recovers)
// review:  { driftStreak: { poolId: reviews }, riskTiers: { poolId: tier }, triggers: [code] }   written by the cron plain review only, at most once a UTC day, on a fresh snapshot (§4.5)
```

`journal.scrub` redacts, whatever the record: the keys `tx`, `signed`,
`walletPayload`, `secretKey`, `privateKey`, `mnemonic`, `keypair`, `seed`,
`rpcUrl`, `authorization`, `token`; 32/64-byte arrays; 200+ char base64/58
blobs; 32-byte hex; URLs with credentials, a query string or a key-shaped
path segment. `LEDGER_WRITE_VERBS` counts attempts by the camelCase name.

### 4.5 The review state: the drift streak and the stored risk tiers

Two of `deriveReview`'s wake triggers need what one review cannot know on
its own. `LEG_NEEDS_INFLOW` fires for an asset that has sat under target for
`policy.review.legNeedsInflowGates` consecutive reviews, with no deposit for
`policy.review.legNoInflowDays` and the top-up budget spent; `RISK_TIER_RAISED`
fires when a held pool's `riskTier` is above the one the previous review saw.
`metrics.js` reads both from its notepad argument (`drift_streak`,
`risk_tiers`) and hands the next values back as `metrics.driftStreak` and
`metrics.riskTiers`. Until this section landed the verb passed no notepad, so
the streak restarted at one on every review and no tier was ever stored: both
triggers were unreachable on a live signer while the unit tests on
`deriveReview`, which wrote the notepad by hand, stayed green.

The counts are the policy's, not `metrics.js`'s. `deriveReview` takes its
thresholds from `status.policy.review` and keeps defaults of its own for
when that is absent; `statusBody` hands it the loaded `review` section
whole, so the document `GET /policy` serves is the one in force. The test
plants a variant policy (one gate more, a longer no-inflow window) and
proves the wake moves with it: a fixture that happened to equal the
defaults would prove nothing.

The notepad is now the signer's own journal. Three decisions, each pinned by
a test in `test/verbs.test.js`:

1. **Signer-side, never agent-supplied.** The streak and the stored tiers
   come from the journal's last `review` record (`ledger.reviewState`,
   `ctx.state.reviewState`), never from anything the agent sends. There is
   no request parameter for them and none is read: a streak the agent could
   send is a wake the agent could grant itself. The other two inputs are
   signer-side too: `status.ledger.lastDepositAt` is the newest ok deposit
   in the journal and `status.ledger.topUpBudgetSpent` is derived from the
   policy and today's deposits (§2 `/status`).
2. **Only the daily gate advances and persists: a cron session, at most
   once per UTC day, on a fresh snapshot.** The three cron jobs all call
   `GET /review`: the daily review bare, curator-universe with
   `?mode=universe`, curator-weekly with `?mode=weekly`. Only the plain
   review may act, so only it takes: it consumes an operator request, and,
   when the session is `cron`, it appends a `review` record and rewrites
   `ctx.state.reviewState`. Universe and weekly read the same state (their
   brief and triggers count on from it) and change nothing, so plain,
   universe, weekly, plain is a streak of two. The agent's own `review` tool
   is the same plain `GET /review` (the Claw Agent plugin sends no mode, and
   its skill calls it on every owner message), so a plain review that
   advanced the streak on every call would let the model mint a streak in
   seconds from chat. A chat review therefore never persists, whatever the
   day: if it did, an owner's 03:00 question would become the day's record
   and the 09:00 gate would find a tier raised overnight already stored and
   never wake on it. The session header is set by the plugin, not by the
   model, and a caller that claims `cron` gains nothing the gate does not
   already have: one record a day. The model's tool call inside the cron run
   reports `cron` too, and by then the gate script's review has taken the
   day. A review over a stale snapshot (this call's read failed and the last
   snapshot was reused) reads but does not persist, and a review whose
   journal write failed leaves the state as it was: the journal is the
   source and memory follows it. Three cron reviews in one second are one
   review; three on three UTC days are three; chat reviews are none.
3. **Across a gap the streak carries.** The last journaled review record
   seeds the next plain review whatever its age. A pod down for a week or a
   paused cron does not reset the count: the asset was under target before
   the gap and nothing during it healed the asset without a review seeing
   it, and a review that sees the asset back on target drops its streak to
   zero by itself. Resetting on age would let every outage buy the asset
   another full run of reviews before anyone is woken.

The record carries no secret and is not scrubbed; `rebuildLedger` replays
the last one (a malformed `driftStreak` or `riskTiers` reads as an empty
map, never as a crash), and `boot()` seeds `ctx.state.reviewState` from it.
A `deriveReview` that returns no `metrics` (a test fake) journals nothing.

## 5. Apply state machine and gates (plan §4.5)

```js
export const APPLY_STATES = ['IDLE','ARMED','WAIT_NOTICE','PREFLIGHT','SEND','CONFIRM','DONE','BLOCKED','ESCALATED'];
```

- `IDLE` → `ARMED` when the snapshot shows `pendingTargets` (own proposal or a stranger's — the loop applies whatever is pending on WEAVR, since apply is permissionless). A terminal state re-arms only for a different proposal (other targets, or another `effectiveAt`).
- `ARMED` → `WAIT_NOTICE` from `effectiveAt − policy.apply.armBeforeEffectiveSecs` (120 s).
- `PREFLIGHT` runs `applyGates` each tick; `wait` blockers re-run next tick, `blocked` ⇒ `BLOCKED` at once (the LLM must `cancel --why`), `escalate` — or a wait that exceeds its `escalateAfterSecs` — ⇒ `ESCALATED` + `alert:<code>`. `APPLY_IN_FLIGHT` escalates after `applyInFlightMaxAttempts` (3). `BOOK_NOT_FRESH` with the keeper down sends one `refresh-nav` after `refreshNavWhenBookStaleSecs` (900).
- `SEND`: build (`buildApply`) → `verifyBuilt` → sign → send (`verbs.applySend`, gates already run on the loop's snapshot), ≤ `policy.apply.maxSendsPerTick` (3) per tick; `applyOutcome` then: ok ⇒ `CONFIRM`; a decode code (`loop.DECODE_CODES`) ⇒ `ESCALATED` at once (a rebuild would build the same thing); `MISSING_CUSTODY` ⇒ retry once, then `ESCALATED`; `NO_PENDING_CHANGE` ⇒ `CONFIRM`; `LOW_SOL` / `RATE_LIMITED` ⇒ `PREFLIGHT` + alert; `PAUSED` / `SELF_LOCKED` ⇒ hold; anything else ⇒ `SEND_FAILED`, `ESCALATED` after `sendFailedTicksBeforeEscalate` (3).
- `CONFIRM`: the pending change gone and the holdings' targets equal to the proposal (or `lastRebalanceAt` advanced) ⇒ `DONE`; gone but the chain differs ⇒ `ESCALATED` (`APPLIED_MISMATCH`); gone and nothing moved ⇒ `IDLE` (cancelled).
- Window closes `policy.apply.windowAfterEffectiveSecs` (6 h) after `effectiveAt` ⇒ `ESCALATED` (`WINDOW_CLOSED`).
- `paused` or `selfLocked` ⇒ the machine holds in its state and does nothing (`tick-held`).

`applyGates(snapshot, policy, now, slot = snapshot.slot)` blockers, in evaluation order — every blocker is collected so `/apply` shows the LLM the whole list, except `NO_PENDING_CHANGE`, which stands alone:

| Code | action | waitSecs / escalateAfterSecs (`policy.apply.escalateAfterSecs[<code>]` overrides) |
|---|---|---|
| `NO_PENDING_CHANGE` | done (nothing else is evaluated) | — |
| `WINDOW_CLOSED` | escalate | immediately |
| `NOTICE_NOT_ELAPSED` (also when `effectiveAt` is unreadable) | wait | until `effectiveAt` |
| `VAULT_PAUSED` | blocked | immediately |
| per held-or-new leg, unless retirable (omitted from the proposal, custody 0, no pending unwind): `LEG_STALE` (no catalogue row or `priceState !== 'fresh'`) | wait | 30 min |
| … `LEG_NOT_ACTIVE` (`status !== 'active'`; `escalate` instead when the leg is omitted with empty custody but its unwind state is unknown) | blocked | immediately |
| … `LEG_PENDING_PRICE` (`pendingPrice` set or `priceState === 'pending_acceptance'`; Pyth-cranked pools wait, publisher-marked escalate at once) | wait / escalate | 10 min / immediately |
| `BOOK_NOT_FRESH` (the chain's own rule `now − lastPriceUpdateTimestamp > maxPriceStalenessSecs`, or the row's `priceState` not fresh/pending_acceptance/paused, or no row at all); carries `refreshNav:true` when stale > 15 min past the window and the keeper is not ok | wait | 30 min |
| `BOOK_PENDING_PRICE` (`vaultAccount.pendingPrice` set) | wait | 20 min |
| `WITHDRAWALS_PENDING` (`totalWithdrawalsPending > 0` or unreadable) | wait | 60 min |
| `APPLY_IN_FLIGHT` (`applyNextPage !== 0`) | wait ≥ 320 slots from `applyScratch.startedSlot`, restart at page 0 | 3 attempts (`maxAttempts`) |
| `MISSING_CUSTODY` (`snapshot.custody[poolId] === false` for a new pool — `readSnapshot` leaves `custody` null, so today this row comes from the api's `MissingCustodyForNewPool` build refusal via `verbs.refuseFromClient`, not from the gate) | wait; retry once after the ATA is confirmed | then escalate |

`proposeGates(snapshot, policy, now)` — chain-state checks that are not policy, mirroring `validate_proposal` in order, then the two that would make the proposal un-applyable; same blocker shape, always `blocked` with `escalateAfterSecs: 0`:
`COMPOSITION_LOCKED`, `WRONG_PORTFOLIO_STATE` (`state !== 'live'`), `TARGETS_PENDING`, `REBALANCE_TOO_SOON` (`now − lastRebalanceAt < rebalanceDelaySecs`, or either unreadable), `APPLY_IN_FLIGHT`, `VAULT_PAUSED`. `/propose` refuses with the first blocker's code and all of them in `detail.blockers`; `/simulate` appends them to `refusals`.

`checkInvariants(snapshot, config, policy)` → `{ ok:true, unverified:[…] } | { ok:false, drift:[{ invariant, expected, actual }], unverified:[…] }` over:
`portfolio.curator == config.expectedCurator`, `portfolio.pendingCurator == null` (unless `policy.invariants.pendingCuratorMustBeNone === false`), `portfolio.rebalanceDelaySecs == policy.invariants.rebalanceDelaySecs ?? config.rebalanceDelaySecs`, `portfolio.compositionLocked == policy.invariants.compositionLocked ?? false`, `accountant.recipient1 == config.treasury`, `factory.guardian == config.guardian`. The last two are listed under `unverified` — neither drift nor proof — when their (optional) account could not be read: a transient RPC failure must not need an operator unlock. Any drift ⇒ the loop sets `state.selfLocked`, journals `lock`, raises alert `INVARIANT_DRIFT`; only `POST /unlock` (ops) clears it, and only once the drift is gone. The loop and `/status` act on `ok` only; `unverified` is returned for callers and not surfaced by them today.

## 6. Transaction verification (`decode.verifyBuilt`, plan §4.3)

```js
verifyBuilt({ transactions, verb, expect })
  → { ok:true, summary:{ txCount, transactions, steps:[step], instructions:[{ step, program, name }], bytes, pages:[n] } }
  | { ok:false, code, message }
```

`transactions` is the api's build list (`[{ step, signer?, signerKey?, tx, pageIndex? }]`);
`verb` is the route name (`propose`, `apply`, `cancel`, `deposit`, `withdraw`,
`refresh-nav`, `rotate-curator`, `set-delay`, `set-metadata`; `refreshNav` /
`refresh_nav` style aliases are accepted), or `create`, which only the laptop
CLI (§9) calls — the signer process has no route for it. `expect` is the approved intent plus
the allowlists. `verbs.expectFor(ctx, { snapshot, targets, intent })` builds
it for every write from the snapshot the policy just saw: `payer` is the
signer, `portfolio` / `vault` are the row's `portfolio` / `vaultKey`,
`poolKeys` is `pools[].addresses.pool` by poolId, `intent` is the verb's fixed
arguments, and `lookupTables` is `ctx.chain.lookupTables` read at verify time
(a row without the keys is `UPSTREAM`, a targeted pool without a key is
`INPUTS_INCOMPLETE` — nothing is built). A decode miss on a table
(`UNKNOWN_INSTRUCTION` / `FOREIGN_LOOKUP_TABLE`) gets one
`refreshLookupTables()` and one retry, never a pass.

| `expect.` | Needed by | Meaning |
|---|---|---|
| `payer` | every verb | base58 curator key: the fee payer of every transaction and the signer-side account of every program instruction |
| `portfolio` | propose, apply, cancel, rotate-curator, set-delay, set-metadata | base58 Portfolio PDA every factory instruction must name |
| `vault` | deposit, withdraw (required); apply, refresh-nav (checked when given) | base58 VaultConfig: `vault_config` of stoken instructions, `vault` of `apply_targets` / `crank_nav_page`; also derives the allocator's `custodian` PDA a `create_custody` ATA may be owned by |
| `allowedPrograms` | every verb | `Set<base58>`: the manifest's programs plus the core ones (`ctx.chain.programs`) |
| `lookupTables` | v0 messages | the tables a v0 message may load from: a `Set<base58>` (loaded addresses stay unresolved), or a `Map` / object `{ table: base58[] }` / `AddressLookupTableAccount[]` so loaded addresses can be resolved and asserted |
| `idls` | factory / stoken instructions | `{ portfolio_factory, stoken, … }` (`ctx.chain.idls`); a pinned program with no IDL here cannot be decoded ⇒ `UNKNOWN_INSTRUCTION` |
| `programIds` / `programNames` | optional | `{ name: base58 }` or `Map(base58 → name)`; default: the manifest's pins for `KNOWN_PROGRAMS` (`portfolio_factory`, `stoken`, `portfolio_nav`, `portfolio_allocator`, `accountant`, `asset_manager_escrow`) |
| `targets` (+ `poolKeys`) | propose | `[{ poolId, weightBps }]` with `poolKeys: { poolId: base58 }`, or `[{ pool: base58, weightBps }]`; must equal the decoded targets in order and value |
| `amount`, `minShares` | deposit (optional) | base-unit strings the decoded `deposit` must carry |
| `shares`, `minAmountOut` | withdraw (optional) | base-unit strings the decoded `withdraw_request` must carry |
| `newCurator`, `rebalanceDelaySecs`, `uri` | ops verbs (optional) | the argument of `propose_curator` / `update_portfolio_rebalance_delay` / `set_portfolio_metadata` |
| `curator`, `rebalanceDelaySecs`, `targets` (+ `poolKeys`) | create (required) | the `create_portfolio` arguments the treasury agreed to: `curator` (the policy signer — a plain argument, it may differ from the signer), `rebalance_delay_secs` (explicit: the api defaults to 60 s), and the targets in the header or across the `create_portfolio_page` chunks |
| `keeperProcessor` | create | base58 the one `system:transfer` (the keeper reimbursement, inside `create_portfolio` or as `fund_operator`) may pay; a payload with a transfer and no `keeperProcessor` is `WRONG_ACCOUNT` (fail closed) |
| `keeperLamports`, `factoryRentLamports`, `custodianReserveLamports` | create (optional) | the build's `rentLamports` quote, a cross-check only: the transfer's lamports and the `factory_rent_lamports` / `custodian_reserve_lamports` arguments must equal it when given. The quote never sets the bound — `maxLamports` does |
| `maxLamports` | create (required) | the ceiling, in lamports, on the **api-set** amounts the treasury pays when the create lands: the keeper reimbursement transfer + the `factory_rent_lamports` + the `custodian_reserve_lamports` of the decoded `create_portfolio` (the program moves both out of `creator`); above it `TARGETS_MISMATCH` ("above the approved ceiling"). Program-fixed amounts are on top and cannot be set by the api: the Portfolio account rent (`init, payer = creator`), the position-page rents (the page count is pinned on chain, `remaining_accounts.len()` is validated) and the 5 000-lamport base fee per signature. The CLI's `--max-lamports`, default 200 000 000 (a three-leg create measures ~79M of api-set amounts) |
| `maxPriorityLamports` | create (required) | the ceiling on each treasury transaction's priority fee: `set_compute_unit_limit` (u32; the runtime's 1.4M cap is assumed when absent) × `set_compute_unit_price` (u64 µlamports), rounded up the way the runtime prices it; above it `TARGETS_MISMATCH`. Both instructions are `ALWAYS_ALLOWED` by name, so the create verb bounds them by value. The CLI's `--max-priority-lamports`, default 5 000 000 (the api's own fee on a nonce-backed create is ~600) |
| `addresses` | create (optional) | the build's `addresses`: `portfolio` / `vault` (`WRONG_PORTFOLIO`), `custodian` / `accountant` (`WRONG_ACCOUNT`) must be the accounts the create names; `sharesMint` must equal the mint derived from the signed vault (`WRONG_ACCOUNT`) — the mint the CLI reports is that derivation, never the api's echo |
| `name`, `symbol`, `metadataUri`, `depositFeeBps`, `withdrawFeeBps`, `managementFeeBpsPerYear`, `creatorFeeBps`, `driftBandBps`, `idleTargetBps`, `compositionLocked` | create (optional) | the remaining `create_portfolio` arguments; given ⇒ must match exactly |

An intent field that is `undefined` is not checked; one that is given must
match exactly. A missing `payer`, `allowedPrograms`, `portfolio` (where
needed), `vault` (deposit/withdraw), `targets` (propose), or `curator` /
`rebalanceDelaySecs` / `targets` / `maxLamports` / `maxPriorityLamports`
(create) is a caller bug and throws a plain `Error`, never a refusal.

What is checked, in order, for every transaction of the payload:

1. **Step** — `tx.step` must be one of the verb's steps (`EXPECTED_STEPS`), else `UNEXPECTED_STEP`; a `pre` step (`create_custody`) comes before the primary step and at most once; a non-paged verb has exactly one primary transaction; a `signerKey` that is not `payer` is `WRONG_PAYER`. An empty payload is `UNEXPECTED_INSTRUCTIONS`.
2. **Parse** — legacy and v0 (`parseTransaction`); anything else is `NOT_A_TRANSACTION`. A v0 message may load addresses only from `expect.lookupTables` (`FOREIGN_LOOKUP_TABLE`, also when a *program id* comes from a table); an address loaded from a table whose contents were not given stays `null`, and any check that needs it refuses `UNKNOWN_INSTRUCTION` — never a pass.
3. **Fee payer** — `== payer`, else `WRONG_PAYER`.
4. **Programs** — every program id in `allowedPrograms` (`FOREIGN_PROGRAM`). A core program (`CORE_PROGRAMS`: System, ComputeBudget, Token, Token-2022, ATA, Memo) is named from its data prefix. A pinned weavr program is decoded with `new anchor.BorshInstructionCoder(idl).decode(data)`; `null`, an allowed-but-unnamed program, a missing IDL, or fewer accounts than the IDL declares ⇒ `UNKNOWN_INSTRUCTION`. `portfolio_nav` ships no IDL and is matched by discriminator: `crank_pool` (8 bytes) and `crank_nav_page` (8 bytes + `u16 page_index`); anything else on it is `UNKNOWN_INSTRUCTION`.
5. **Paged propose** — `PAGED_PROPOSE_UNSUPPORTED`, named so it never reads as a generic mismatch: for `propose`, an intent of more than `PROPOSE_MAX_LEGS` (8, the chain package's `PAGE_LEGS`) targets refuses before anything is parsed, and a `propose_targets_page` in any propose transaction refuses before the instruction-set walk. The api builds a proposal above 8 legs as `propose_targets_page` transactions that still carry `step: 'propose_targets'`; this signer verifies single-page proposals only. Policy `MAX_LEGS` (8) makes the case unreachable today.
6. **Instruction set** — `STEP_RULES[step]`: each `required` instruction exactly once, `optional` ones any number of times, `ALWAYS_ALLOWED` anywhere, anything else `UNEXPECTED_INSTRUCTIONS`. Core programs are **not** a free pass: only `compute_budget:set_compute_unit_limit` / `set_compute_unit_price` / `request_heap_frame` / `set_loaded_accounts_data_size_limit`, `system:advance_nonce_account` (a durable-nonce build) and `memo:memo` are accepted in any step, plus `associated_token:create_idempotent` in the steps that list it. A `system:transfer` or `token:transfer` in any step is `UNEXPECTED_INSTRUCTIONS` — with one exception, the create's keeper reimbursement (`create_portfolio` / `fund_operator`, below), whose payer, payee and amount are checked and which may appear once across the payload.
7. **Accounts and arguments** (`checkProgramInstruction`) — the portfolio / vault account must be the intent's (`WRONG_PORTFOLIO`); the signer-side account (`curator`, `caller`, `signer`, `user`, crank `payer`) must be `payer` (`WRONG_ACCOUNT`); a stoken `deposit` must use the payer's own USDC and shares ATAs and name the payer's shares ATA as `beneficiary_s_token_account` (`WRONG_ACCOUNT` — a stranger beneficiary is the curator's USDC minting shares to someone else); `withdraw_request` the payer's own shares ATA; an ATA `create_idempotent` must be paid by `payer`, at the derived address, for the payer (deposit/withdraw) or for the allocator's `custodian` PDA of `vault` (`create_custody`) — else `WRONG_ACCOUNT`; decoded `targets` must equal the intent byte for byte, same order, and `amount` / `min_shares` / `shares` / `min_amount_out` / `new_curator` / `new_secs` / `uri` the intent's value (`TARGETS_MISMATCH`, which also names a `poolId` with no key in `poolKeys`).
8. **Pages** — a paged step (`apply_targets`, `crank_nav`) must carry a `pageIndex` equal to the decoded `page_index`, and the primary pages must run `0..n−1` across the payload (`UNEXPECTED_INSTRUCTIONS`).

Checking only "instruction 0's discriminator" is wrong: instruction 0 is `setComputeUnitLimit`.

Steps (`STEP_RULES`; steps are the api's `transactions[].step` values):

| step | required, exactly once | optional | paged |
|---|---|---|---|
| `propose_targets` | factory `propose_targets` | — | no; `propose_targets_page` ⇒ `PAGED_PROPOSE_UNSUPPORTED` |
| `create_custody` | — (at least one ATA `create_idempotent`) | ATA `create_idempotent` | no |
| `apply_targets` | factory `apply_targets` | — | yes |
| `cancel_targets` | factory `cancel_targets` | — | no |
| `deposit` | stoken `deposit` | ATA `create_idempotent`, nav `crank_pool`, nav `crank_nav_page` | no |
| `withdraw_request` | stoken `withdraw_request` | ATA `create_idempotent`, nav `crank_pool`, nav `crank_nav_page` | no |
| `crank_nav` | nav `crank_nav_page` | nav `crank_pool` | yes |
| `propose_curator` | factory `propose_curator` | — | no |
| `update_portfolio_rebalance_delay` | factory `update_portfolio_rebalance_delay` | — | no |
| `set_portfolio_metadata` | factory `set_portfolio_metadata` | — | no |
| `create_portfolio` (create, treasury) | factory `create_portfolio` | `system:transfer` (the keeper reimbursement: from `payer`, to `keeperProcessor`, `keeperLamports`) | no; first, exactly once. Payload-wide: reimbursement + `factory_rent_lamports` + `custodian_reserve_lamports` ≤ `maxLamports`; per treasury transaction: compute-unit limit × price ≤ `maxPriorityLamports` |
| `create_portfolio_page` (create, treasury) | factory `create_portfolio_page` | — | yes (a paged create of more than 8 legs: `pageIndex` = `page_index`, pages `0..n−1`, `total_legs` = the intent's length, chunks concatenate to the intent) |
| `fund_operator` (create, treasury) | `system:transfer` (as above) | — | no; at most once, only when the packet was full |
| `init_portfolio_shares`, `init_custody`, `init_vault_atas`, `whitelist_custodian`, `activate_portfolio` (create, keeper) | not mine: not decoded | — | after every treasury step; `signer` must be `keeper_processor`, `signerKey` and the fee payer must not be the treasury (`WRONG_PAYER`), every program in the allowlist (`FOREIGN_PROGRAM`), else nothing is vouched for |

Verb → steps (`EXPECTED_STEPS`):

| verb | steps |
|---|---|
| `propose` | `propose_targets` |
| `apply` | `create_custody`? then `apply_targets` (paged, `pageIndex`; the api compiles a page as v0 against the NAV lookup table when the accounts do not fit a legacy message) |
| `cancel` | `cancel_targets` |
| `deposit` | `deposit` — there is no `whitelist_depositor` step and no `add_user_to_deposit_whitelist`: the api's deposit is one transaction |
| `withdraw` | `withdraw_request` |
| `refresh-nav` | `crank_nav` (paged); an `eth_pool_crank` step signed by the oracle publisher is `UNEXPECTED_STEP` |
| `rotate-curator` (ops) | `propose_curator` |
| `set-delay` (ops) | `update_portfolio_rebalance_delay` |
| `set-metadata` (ops) | `set_portfolio_metadata` |
| `create` (laptop CLI, §9; `verifyCreate`, not the single-primary walk) | treasury: `create_portfolio` first and once, then `create_portfolio_page`* (more than 8 legs), then `fund_operator`? — every treasury step before the first keeper step, a treasury step elsewhere or a step relabelled to the other signer is `UNEXPECTED_STEP`; keeper: `init_portfolio_shares`, `init_custody`*, `init_vault_atas`, `whitelist_custodian`*, `activate_portfolio`* (operator setup, the api's `manifest()`); the summary lists `mine` (positions the treasury signs), `theirs` (`{ position, step, programs }`) and `create` (the decoded arguments, the derived `sharesMint`, `keeperLamports`, `outlayLamports` — what the ceiling bounded — and `priorityLamports`, the treasury transactions' fees summed) |

Fixtures: nothing is captured or checked in. `test/decode.test.js` builds
every payload at test time with the api's real builders
(`packages/api/src/curator.js`) over a fake connection (fixed blockhash, a
fake NAV table) and generated keys, so a builder change is felt by the
verifier's tests at once; deposit / withdraw / crank payloads are assembled
from the chain package's instruction helpers the api uses. Planted violations:
a foreign program, the wrong payer (by message and by `signerKey`), tampered /
reordered / extra targets, an extra factory instruction, a System and a Token
transfer, a bare compute-budget transaction, a duplicated propose, a nine-leg
proposal (paged — refused by name, and the eight-leg boundary accepted),
another portfolio or vault, undecodable data, an allowed-but-unnamed program,
an unexpected step, a non-transaction, a `create_custody` after the page /
twice / empty, an ATA for a stranger / at a non-derived address / paid by a
stranger, a stranger beneficiary, a different amount, a page that skips 0 or
disagrees with its `pageIndex`, a foreign lookup table, an unresolved table.
`test/create.test.js` does the same for `create` with the api's real
`buildCreatePortfolio` (`packages/api/src/build.js`, operator setup, with and
without a durable nonce, legacy and v0, the packet-full `fund_operator`, a
sixteen-leg paged create): another curator, another delay, another fee payer,
a foreign program, tampered / reordered / extra targets, an extra
treasury-signed step, a treasury step that is not a transaction, a keeper step
naming the treasury, a reimbursement to or from a stranger or of another
amount, an api echo of addresses that disagrees with the signed accounts, and
the outlay: a 5 SOL reimbursement with no quote, with a matching quote and as
its own `fund_operator`, a 5 SOL factory rent or custodian reserve the api
quotes itself, a 1 SOL priority fee, a price with no compute-unit limit, and a
ceiling one lamport under the honest create.

## 7. Module signatures

### `src/policy.js` (pure)

```js
/** Parse + validate the policy document (JSON string or object). Throws `Error('policy: …')` on a missing or unknown key, a wrong type, version !== 1, an allowlisted pool outside every category, or any pool in two categories; `_comment` keys are dropped. Returns a deep-frozen object. */
export function loadPolicy(jsonOrObject) → policy

/** Is `verb` allowed for this token kind and session? `verb` is the route name without the slash. */
export function verbAllowed(policy, verb, { session, tokenKind }) → { ok:true } | { ok:false, code, message }

/** The pre-check every write verb runs first: portfolio, lock, pause, rate, SOL. `cancel` passes `PAUSED`. A missing `allowedPortfolio` refuses PORTFOLIO_NOT_ALLOWED (fail closed). */
export function evaluateWrite({ policy, verb, portfolio, allowedPortfolio, state, ledger, lamports, now }) → { ok:true } | { ok:false, code, message }

/** §4.4 universe, shape, turnover, cost, cadence and reason rules. A malformed `targets` is BAD_REQUEST alone; otherwise `refusals` lists every violation and `code`/`message` are the first. */
export function evaluateProposal({ policy, targets, why, snapshot, ledger, now, session }) → { ok:true, summary, intent } | { ok:false, code, message, refusals:[{code,message}], summary }
// summary = { turnoverBps, estimatedCostBps, legs:[{poolId,symbol,fromBps,toBps,deltaBps,maxExecutionLossBps}], categories:{<name>:bps}, nextProposeAt }

/** Deposit caps and headroom. `amountUsd` → base units via 1e6; shares headroom from `vaultAccount` fields, never from the REST row. */
export function evaluateDeposit({ policy, amountUsd, snapshot, ledger, now }) → { ok:true, summary:{ amountBaseUnits, minShares, headroomBaseUnits } } | { ok:false, code, message }

/** Withdraw caps; chat sessions only; the signer must hold the shares (INSUFFICIENT_SHARES). */
export function evaluateWithdraw({ policy, amountUsd, session, snapshot, ledger, now }) → { ok:true, summary:{ shares, minAmountOut } } | { ok:false, code, message }

/** The every-tick invariants as a pure function of chain facts; exported for tests and the ops twin script — the runtime uses preflight.checkInvariants. */
export function evaluateInvariants({ policy, chain:{ curator, pendingCurator, rebalanceDelaySecs, recipient1, guardian, compositionLocked }, config }) → { ok:true, drift:[] } | { ok:false, code:'INVARIANT_DRIFT', message, drift:[{ invariant, expected, actual }] }

export const MIN_OUT_TOLERANCE_BPS   // 50: minShares / minAmountOut slippage floor
export function toSecs(now), toNumber(v), toBigInt(v), toBase58(v), utcDay(nowSecs)   // BN / PublicKey / string-safe helpers
```

### `src/decode.js` (pure) — see §6.

```js
export function verifyBuilt({ transactions, verb, expect }) → { ok:true, summary:{ txCount, transactions, steps, instructions:[{ step, program, name }], bytes, pages } } | { ok:false, code, message }
export function decodeInstructions(base64, { idls, allowedPrograms, lookupTables?, programIds? | programNames? }) → [{ program, programId, name, accounts:(base58|null)[], accountsByName, data, core }] // throws Refusal
export function parseTransaction(base64, lookupTables) → { version:'legacy'|0, payer, bytes, tables:[base58], instructions:[{ programId, accounts, data:Buffer }] } // throws Refusal NOT_A_TRANSACTION | FOREIGN_LOOKUP_TABLE
export function plain(decodedAnchorValue) → JSON   // PublicKey → base58, BN → decimal string, bytes → hex
export const EXPECTED_STEPS    // { [verb]: { steps: Set, instructions: Set, primary, pre:[step], paged } }
export const STEP_RULES        // { [step]: { required:[name], optional:[name], paged?, atLeastOne? } } — includes the treasury's create steps
export const CREATE_STEPS      // { [step]: 'creator' | 'keeper_processor' }: the api's create manifest (operator setup) and who signs each
export const ALWAYS_ALLOWED    // Set: the core instructions accepted in any step
export const CORE_PROGRAMS     // { system, compute_budget, token, token_2022, associated_token, memo } → base58
export const KNOWN_PROGRAMS    // the pinned programs this module can name
export const PROPOSE_MAX_LEGS  // 8 (= the chain package's PAGE_LEGS); more ⇒ PAGED_PROPOSE_UNSUPPORTED
```

### `src/preflight.js`

```js
/** The only impure function here: REST + chain reads into the §4.2 snapshot. Never throws on an optional read; throws when the portfolio keys, Portfolio or VaultConfig cannot be read. */
export async function readSnapshot(ctx) → snapshot
export function applyGates(snapshot, policy, now, slot = snapshot.slot) → { ok:true } | { ok:false, blockers:[{ code, action:'wait'|'blocked'|'escalate'|'done', waitSecs?, escalateAfterSecs: number|null, message, …extra }] }
export function proposeGates(snapshot, policy, now) → same shape, every blocker `blocked`
export function checkInvariants(snapshot, config, policy) → { ok:true, unverified:[string] } | { ok:false, drift:[{ invariant, expected, actual }], unverified:[string] }
```

### `src/metrics.js` (pure)

```js
/** The daily brief and the wake triggers (plan §4.6 curator-review). `triggers` codes: MONTHLY_REVIEW, LEG_NEEDS_INFLOW, HELD_POOL_NOT_ACTIVE, PUBLISHER_PARK, DRAWDOWN_30D, RISK_TIER_RAISED, OPERATOR_REQUEST. `brief` ≤ policy.review.briefMaxChars (4096), last line `{"wakeAgent": bool}`; `metrics.driftStreak` and `metrics.riskTiers` are what the plain review journals for the next one (§4.5). verbs.review passes the six-argument form with a notepad built from `ctx.state.reviewState` (`drift_streak` and `risk_tiers` as JSON strings, `{}` when nothing is stored); the five-argument form `(row, pools, health, status, now)` is still accepted and means an empty notepad. */
export function deriveReview(row, pools, health, status, notepad, now) → { brief, triggers:[{ code, detail }], wakeAgent, holdReason, metrics }
/** Prometheus text exposition for GET /metrics (§2). Reads camelCase gauge names. */
export function renderPrometheus({ lastTickTs, hermesHeartbeatTs, pendingEffectiveAt, applyState, bookPriceFresh, signerLamports, selfLocked, paused, writeAttempts1h }) → string
export function deltaCostBps(row, pools, candidate, { from, fallbackLossBps = 100 }) → number | null
export function isMonthlyReviewDay(now, weekday) → boolean
```

### `src/errors.js`

```js
export const FACTORY_ERRORS  // 65 names, enum order from programs/portfolio_factory/src/errors.rs; code 6000 + index (program-errors.generated.js, `scripts/generate-program-errors.mjs`)
export const STOKEN_ERRORS   // 122 names, enum order from splyce-composable-core/programs/stoken/src/errors.rs; 6000 + index
export const ANCHOR_CUSTOM_ERROR_BASE // 6000
/** Name a program error out of any text (simulation log, send message, api `error.message`): "custom program error: 0x1772", "Error Number: 6002", {"Custom":6002}, "Error Code: RebalanceTooSoon". Both enums start at 6000, so attribution is: the `program` hint, a known program id in the text, a name that exists in one table, a name+number that fits one table; otherwise `program:'unknown'` with `candidates` per program. */
export function nameProgramError(text, { program?, programIds? } = {}) → { code, name, program:'portfolio_factory'|'stoken'|'unknown', candidates? } | null
export async function loadKnownProgramIds()   // warms the manifest-derived id map (boot calls it once)
export class Refusal extends Error { constructor(code, message, detail?) ; code; status; detail }
export const REFUSAL_STATUS  // { [code]: httpStatus }, default 422 (§2 Errors)
```

### `src/keys.js`

```js
/** A 64-byte JSON array — a file (`file`) or the JSON text itself (`text`, what an env var carries; the create CLI's TREASURY_KEYPAIR_JSON) → signer; whitespace-only `text` counts as absent. Legacy: partialSign; v0: sign([keypair]). Never logs the source or the key; throws `Refusal('CONFIG', …)` naming the env var (default CURATOR_KEYPAIR) when neither source is set, when both are (the key is given once), or the source is unreadable, not JSON, not a 64-byte array or not a valid secret key. `sign` refuses NOT_A_TRANSACTION for anything it cannot decode. */
export function loadSigner({ file?, text?, env = 'CURATOR_KEYPAIR', kind = 'curator' }) → Object.freeze({ wallet, kind, sign: async (base64[]) => base64[] })
export function isVersioned(rawBytes) → boolean   // v0 version prefix after the signature block
export const KEYPAIR_ENV   // 'CURATOR_KEYPAIR'
```

### `src/journal.js`

```js
export class Journal {
  constructor({ file, now = Date.now })
  append(record) → record            // assigns id (uuid) and at (unix secs), scrubs (§4.4), fsync-appends one JSONL line; rotates at ROTATE_BYTES
  tail(n) → record[]                 // read backwards in chunks
  rebuildLedger({ now }) → ledger    // §4.3 shape, from the file alone
}
export function scrub(value) → { value, redacted:[path] }
export function canonicalSha256(value) → hex    // sha256 of the canonical JSON (keys sorted at every level); the policy digest
export function argsSha256(args) → hex          // canonicalSha256 of the args; the Hermes approval rule_key derives from it
export const DEFAULT_JOURNAL_FILE, ROTATE_BYTES, LEDGER_WRITE_VERBS
```

### `src/weavr.js`

```js
/** REST client for the api. Throws `Refusal('CONFIG')` on a bad `apiUrl`, `Refusal('UPSTREAM')` on ≥ 500 / unreachable / timeout / non-JSON, `Refusal('BUILD_REFUSED')` on a 4xx build (`SEND_FAILED` on a 4xx send); `detail` carries the api's `{ code, message }`. `fetchImpl` is injectable for tests; every message is URL-free and never carries a body. */
export function weavrClient({ apiUrl, fetchImpl = fetch, partnerKey = null, timeoutMs = 20000 }) → {
  request(method, path, body?) → { status, json },    // never throws on an HTTP status
  get(path) → json,
  post(path, body, { refusalCode = 'BUILD_REFUSED' }?) → json,
  portfolio(mint), pools(), health(),
  buildPropose(mint, { curator, targets }), buildApply(mint, { caller }), buildCancel(mint, { signer }),
  buildRefreshNav(mint, { payer }), buildDeposit(mint, { user, amount, minShares }), buildWithdraw(mint, { user, shares, minAmountOut }),
  buildProposeCurator(mint, { signer, newCurator }), buildRebalanceDelay(mint, { curator, rebalanceDelaySecs }), buildMetadata(mint, { signer, uri }),
  simulateRebalance(mint, { targets }),
  send(signedBase64[]) → { ok, status, signatures, error:{ code, message } | null },   // ok === (status === 'confirmed'); ≤ MAX_SIGNED_PER_SEND (16)
}
```

### `src/verbs.js`

Every verb: `async (ctx, args, meta) → result` and throws `Refusal`. Order inside a write verb (`runWrite`), never reordered: the four hard rules → `verbAllowed` → snapshot → `evaluateWrite` → the verb's policy or gates → `client.build*` → `verifyBuilt` → `signer.sign` → `client.send` → `journal.append` → the verb's bookkeeping. A write attempt is counted in the ledger before anything else. `ctx.deps` overrides any of the pure functions (tests plant fakes there).

```js
export async function status(ctx, args, meta)
export async function review(ctx, { mode? }, meta)         // the plain review (no mode, or mode=review) consumes; the first plain review of a UTC day persists; universe/weekly read
export async function policy(ctx, args, meta)              // { version, sha256, policy }: a read, never journaled
export async function alerts(ctx, args, meta)
export async function simulate(ctx, { targets, why? }, meta)
export async function propose(ctx, { targets, why }, meta)
export async function apply(ctx, args, meta)                        // one forced, gated attempt
export async function applySend(ctx, meta, { snapshot })            // the loop's SEND: gates already run
export async function cancel(ctx, { why }, meta)
export async function deposit(ctx, { amountUsd }, meta)
export async function withdraw(ctx, { amountUsd }, meta)
export async function refreshNav(ctx, args, meta)
export async function pause(ctx, { why }, meta)
export async function note(ctx, { text }, meta)
export async function journal(ctx, { n }, meta)
export async function hermesHeartbeat(ctx, args, meta)
export async function resume(ctx, { why }, meta)          // ops
export async function unlock(ctx, { why }, meta)          // ops
export async function rotateCurator(ctx, { newCurator, why }, meta) // ops
export async function setDelay(ctx, { rebalanceDelaySecs, why }, meta) // ops
export async function setMetadata(ctx, { uri, why }, meta) // ops
export function statusBody(ctx, snapshot, error = null)   // the /status body from a snapshot (loop and /review reuse it)
export function expectFor(ctx, { snapshot, targets?, intent? }) → decode `expect` (§6)   // throws Refusal UPSTREAM | INPUTS_INCOMPLETE
export function appliedVerdict(applyState, snapshot) → { none } | { done } | { mismatch, onChain, lastRebalanceAt } | { cancelled }
export function policyDigestOf(ctx) → hex                  // canonicalSha256(ctx.policy), once per policy object, remembered as ctx.policyDigest
export function depsOf(ctx), initialState({ paused, selfLocked, operatorRequest, reviewState, ledger }), initialApplyState(), emptyLedger(), normMeta(meta), scrubText(text, max), plain(v), num(v)
export function raiseAlert(ctx, key, code, message) → bool, clearAlert(ctx, key), clearApplyAlerts(ctx)
export function pendingOf(snapshot), pendingTargetsOf(snapshot), currentTargetsOf(snapshot), targetsEqual(a, b), keeperOkOf(health), writeAttemptsLastHour(ledger, nowSecs), describeSendFailure(text, verb, deps, detail)
export const VERBS       // { 'status': status, 'policy': policy, 'refresh-nav': refreshNav, 'hermes-heartbeat': hermesHeartbeat, … } keyed by route name
export const OPS_VERBS   // Set(['resume','unlock','rotate-curator','set-delay','set-metadata','operator-request'])
export const WRITE_VERBS // Set(['propose','apply','cancel','deposit','withdraw','refresh-nav','rotate-curator','set-delay','set-metadata'])
export const JOURNAL_VERB // route → camelCase journal verb; REALERT_SECS (6 h), NOTE_MAX_CHARS (2048), JOURNAL_DEFAULT_N (50), JOURNAL_MAX_N (500), CALLER_MAX_CHARS (64), METADATA_URI_MAX_CHARS (128)
```

### `src/loop.js`

```js
export const APPLY_STATES   // ['IDLE','ARMED','WAIT_NOTICE','PREFLIGHT','SEND','CONFIRM','DONE','BLOCKED','ESCALATED']
export const DECODE_CODES   // Set of the decode codes a SEND never retries (a rebuild would build the same thing)
export function createLoop({ ctx, intervalMs = ctx.config.tickMs }) → { start(), stop() → Promise, tick() → Promise<{ at, ok, applyState, blockers, alerts, error? }>, state() → { running, … } }
/** One pure step of the machine: `(state.apply, gate, now, policy) → next apply state + actions`; `gate` is the applyGates result plus `pending`, `currentTargets`, `lastRebalanceAt`, `keeperOk` from the snapshot. */
export function stepApply(applyState, gate, now, policy) → { next, actions:[ 'send' | 'refresh-nav' | 'alert:<code>' | 'journal' ] }
/** The machine after a SEND attempt (`{ ok, code?, signatures?, message? }`). */
export function applyOutcome(applyState, outcome, now, policy) → { next, actions }
/** The /metrics gauges from ctx.state (snake_case `curator_*` keys). */
export function gaugesOf(ctx) → { curator_last_tick_ts, curator_hermes_heartbeat_ts, curator_pending_effective_at, curator_apply_state, curator_book_price_fresh, curator_signer_lamports, curator_self_locked, curator_paused, curator_write_attempts_1h }
```

### `src/server.js`

```js
export function createServer({ ctx, loop?, tokens: { agent, ops } }) → http.Server   // not listening; index.js listens; re-validates the tokens
export function validateTokens({ agent, ops })                                        // throws a plain Error naming the variable, never its value
export function authenticate(headerValue, tokens) → { kind:'agent'|'ops' } | null   // timingSafeEqual over both tokens; null when unset, short or unmatched
export function readBody(req, { maxBytes = 64 * 1024 }) → Promise<object>          // rejects ⇒ Refusal BAD_REQUEST; an empty body is {}
export function scrubResponse(body) → body                                          // drops tx / signed / walletPayload / transactions[] / httpStatus at any depth
export function metaOf(headers) → { session, caller, tokenKind:'agent' }            // tokenKind is filled after auth
export const ROUTES  // [[method, path, verb, { tokenKind:'agent'|'ops'|'none' }], …] — 23 rows; the route table is the contract, §2 lists the same rows
export const MIN_TOKEN_BYTES (32), MAX_BODY_BYTES (64 KB), HEALTHZ_STALE_TICKS (3)
```

### `src/index.js`

```js
/** The environment, validated (§1). Throws a plain Error naming the variable, never a value. */
export function readConfig(env = process.env) → { tokens, keypairFile, mint, treasury, guardian, apiUrl, rpcUrl, policyJson, policyFile, journalFile, port, tickMs, startPaused, rebalanceDelaySecs }
/** Validate env, build ctx, rebuild the ledger (pause, self-lock, operator request and review state replayed into ctx.state), compute the policy digest once (ctx.policyDigest, journaled and logged as policySha256), start the loop and the server. Rejects with a plain reason (never a secret) on any guard; the CLI wrapper turns that into exit 1. `overrides` are the test seams (fake connection, client, signer, journal, policy, deps, clock; `listen:false`, `signals:false`). */
export async function boot({ env = process.env, overrides = {} } = {}) → { ctx, loop, server, stop() }
export function allowedProgramSet() → Set<base58>          // manifest programs + CORE_PROGRAMS
export function allowedLookupTableSet() → Set<base58>      // the NAV table when this host knows it, else empty
export async function loadLookupTables(connection, allowlist) → Map<base58, AddressLookupTableAccount | null>   // never throws; unread stays null
export function jsonLogger(stream = process.stdout) → (level, event, fields) => void
export const CORE_PROGRAMS, DEFAULT_PORT (8091), DEFAULT_TICK_MS (30000), DEFAULT_REBALANCE_DELAY_SECS (86400)
```

## 8. Tests

`test/<module>.test.js`, `node --test 'test/*.test.js'` (Node 24: quote the
glob), or `npm test` from `signer/` for this package and the chain subset
together. Per plan §7.1: one test per refusal code on a planted violation;
pre-flight fakes per blocker row; token unset ⇒ exit 1; ops verb with the
agent token ⇒ `OPS_ONLY`; ledger rebuilt after restart. A test that only
proves the happy path is not finished.

Three suites are not here: `decode`, `create` and `integration.contract`
verify this package's decoder and create CLI against transactions the weavr
api's real builders produce, and those builders are in the private backend.
They live there, as the api's curator contract suite, and run against this
repository at the commit the backend pins; a builder change that the decoder
would refuse fails the backend's CI before it ships. Two tests here read
private trees only when told to: the policy fixture against the ops repo's
document (`CURATOR_POLICY_FILE`) and the embedded error tables against the
Rust enums (`COMPOSABLE_PORTFOLIOS_UMBRELLA`); unset, each skips and says so.

## 9. Create CLI (`scripts/create_portfolio.mjs`)

The one create the signer process never performs: WEAVR's own. The fee
recipient of a portfolio is its create signer by construction
(`create_portfolio.rs`), so the **treasury** key signs the create once, from a
laptop, and names the policy signer as `curator` — a plain argument that may
differ from the signer. `create` stays in policy `verbs.denied`; the server
has no route for it; `VERBS` gains nothing. The CLI reuses `weavr.js`
(HTTP), `keys.js` (signing) and `decode.js` (verification) — nothing is
duplicated, and the same planted-violation discipline applies
(the backend's `create` contract suite, §8).

```
node scripts/create_portfolio.mjs --api <url> --targets '<poolId>:<weightBps>,...' --curator <base58> --keeper-processor <base58>
  --name <text> --symbol <ticker> [--metadata-uri <url>]
  [--rebalance-delay-secs 86400] [--deposit-fee-bps 20] [--withdraw-fee-bps 20] [--creator-fee-bps 6000]
  [--management-fee-bps-per-year 0] [--drift-band-bps 200] [--idle-target-bps 500] [--composition-locked]
  [--max-lamports 200000000] [--max-priority-lamports 5000000]
  [--setup-signer operator] [--nav-lookup-table <base58>]
  [--keypair-file <path>] [--dry-run] [--wait-secs 600] [--deployment-id <id>] [--json]
```

What the treasury commits is bounded by the operator, never by the api's own
numbers — the decoder's threat model ("trusted to build well, not trusted
absolutely") holds for the create exactly as for every signer verb:

| Flag | Bounds |
|---|---|
| `--keeper-processor <base58>` (required) | the only account the keeper reimbursement (`system:transfer`, inside `create_portfolio` or as `fund_operator`) may pay. It is the cluster's `config.keeperProcessor` from the handoff runbook (`runbooks/TEAM_HANDOFF_*.md`), the key `build.js` pays. `/health` is a cross-check only: `signers.keeper.pubkey` may be the keeper's hot key (`healthSignals.js`) rather than `config.keeperProcessor`, so a difference is noted, not trusted; a built transfer that pays anything but the flag refuses `WRONG_ACCOUNT` with a hint to check the flag |
| `--max-lamports` (default 200 000 000) | the ceiling on the api-set amounts the treasury pays when the create lands: the reimbursement + the `factory_rent_lamports` + the `custodian_reserve_lamports` of the decoded `create_portfolio` (`expect.maxLamports`). Program-fixed amounts — the Portfolio and position-page account rents, the base fee per signature — are on top and cannot be set by the api (§6). A three-leg create measures ~79M of api-set amounts; sixteen legs more. Above it `TARGETS_MISMATCH`, nothing signed |
| `--max-priority-lamports` (default 5 000 000) | the ceiling on each treasury transaction's priority fee, compute-unit limit × price as the runtime prices it (`expect.maxPriorityLamports`); the api's own fee on a nonce-backed create is ~600 lamports |

The build's `rentLamports` quote is a cross-check on top (the decoded amounts
must equal it) and must be three non-negative integers — a quote that is not
is refused `UPSTREAM` rather than passed as `undefined`, which would silence
the cross-check.

| Env | Meaning |
|---|---|
| `TREASURY_KEYPAIR_JSON` | the treasury key as a 64-byte JSON array, when `--keypair-file` is not given (one source or the other, never both). **Never on argv**: `--keypair`, `--keypair-json`, `--secret-key`, `--private-key`, `--mnemonic`, `--seed` and any argv value shaped like a 32+-byte array or a 32/64-byte hex string are refused `BAD_REQUEST` before anything is parsed |
| `CURATOR_RPC_URL` or `SOLANA_RPC_URL` | optional. A create of four or more assets compiles to v0 against the NAV lookup table, and the verifier resolves loaded accounts only from the table's contents; with an RPC they are read (`index.loadLookupTables`), without one the table stays allowed-but-unresolved and the verification refuses `UNKNOWN_INSTRUCTION` with a hint. Never printed |
| `NAV_LOOKUP_TABLE` | the one table a v0 message may load from, unless `--nav-lookup-table` is given (the flag wins); read from the run's own env (a malformed value is `CONFIG`). Unset ⇒ the chain package's allowlist (`index.allowedLookupTableSet`: `NAV_LOOKUP_TABLE` in the process env, else the NAV-table **cache file** `@composable-portfolios/chain` keeps under its cache dir when one exists), and only when neither names a table is no table allowed (`FOREIGN_LOOKUP_TABLE` for any v0) |

Flow, in order and never reordered:

1. **Parse** — key material on argv refused; `--targets` must be unique pools whose weights sum to 10000; `--curator` and `--keeper-processor` base58 and required; `--name` and `--symbol` **required** (the api's build refuses an intent without both — `namingErrors`: `NAME_REQUIRED` / `SYMBOL_REQUIRED` — so the CLI refuses first, before `/health` and `/v1/pools` are called and before any deployment record exists), `--name` at most 32 bytes, `--symbol` at most 10 bytes and `--metadata-uri` at most 128 bytes of UTF-8 (the factory's limits — a longer one is refused, never truncated; the api checks the first two by slicing and the URI not at all, and an over-long URI would otherwise be signed, sent and fail on chain; when `--metadata-uri` is absent the api derives a per-ticker one, `routes.metadataUriFor`); `--setup-signer` must be `operator` (the verifier describes the operator-setup create, where the treasury signs `create_portfolio` only and the keeper fronts and is reimbursed for the rest).
2. **Key** — `keys.loadSigner` over the file or the env var; the public key becomes `creator`. Then the lookup-table allowlist (`NAV_LOOKUP_TABLE` / `--nav-lookup-table`), so a config error stops before the api is touched.
3. **`GET /health`** — a liveness check and a cross-check: `signers.keeper.pubkey` equal to `--keeper-processor` is confirmed, absent or different is **noted** (it may be the keeper's hot key), never used as the payee. The flag is the only source.
4. **`GET /v1/pools`** — every target resolves to a row (exact `poolId`, else a unique `symbol`) with `addresses.pool`; otherwise `INPUTS_INCOMPLETE`, nothing built.
5. **`POST /v1/portfolios/build`** `{ creator, curator, targets, name, symbol, metadataUri?, depositFeeBps, withdrawFeeBps, managementFeeBpsPerYear, creatorFeeBps, driftBandBps, idleTargetBps, compositionLocked, rebalanceDelaySecs, wallet:'tool', setupSigner:'operator' }` — `rebalanceDelaySecs` is always sent (the api's `CREATE_DEFAULTS` is 60 s; the factory floor refuses too short a delay on chain with `RebalanceDelayTooShort`). The call goes through a client that waits `BUILD_TIMEOUT_MS` (90 s), not `weavr.js`'s 20 s default: in operator mode the api reads the treasury balance, simulates, asks the keeper for the treasury's durable nonce (up to three attempts; on the first build for that key the keeper creates and confirms the nonce account on chain) and only then builds — an abort at 20 s would leave the record and the fronted nonce behind, and a retry would leave another. A 4xx is `BUILD_REFUSED` with the api's `errors` list printed. **Every build has side effects, dry run included**: the api persists a deployment record, and once per treasury key the keeper fronts the nonce-account rent (`completeCreate.js`; it is repaid only by a create that lands, which a dry run never signs). Run one dry run, not many. The `rentLamports` quote must be three non-negative integers, else `UPSTREAM`.
6. **Verify** — `verifyBuilt({ verb:'create' })` over every transaction with the §6 `expect`: `payer` = the treasury, `curator`, `rebalanceDelaySecs`, the targets by Pool key, the fee/band fields, `keeperProcessor` = the flag, `maxLamports` / `maxPriorityLamports` = the flags, the build's `rentLamports` (cross-check) and `addresses`, `allowedPrograms` = `index.allowedProgramSet()`, the IDLs, the lookup tables. Any refusal ⇒ exit 2 with the code and message (a transfer paying something else, or an amount over a ceiling, carries a hint naming the flag); nothing has been signed.
7. **Summary** (stderr) — from the decoded instruction, not the api's echo: name, symbol, curator, `rebalance_delay_secs`, fees, targets, rent, the reimbursement and its payee, the outlay of api-set amounts against `--max-lamports` (with the note that program-fixed account rent and the base fee are on top) and the priority fees against `--max-priority-lamports`, the portfolio / vault / mint (the mint derived from the signed vault; a mint, portfolio or vault that cannot be taken from the signed instruction refuses `UNKNOWN_INSTRUCTION` rather than falling back to the api's echo). `--dry-run` stops here: nothing signed, nothing sent (exit 0).
8. **Sign** — only the steps the summary lists as `mine` (`create_portfolio`, any `create_portfolio_page`, `fund_operator` when present), through `signer.sign`; the keeper's steps are never handed to the key.
9. **Submit** — `POST /v1/deployments/:id/await { signed, timeoutSecs: 50 }`, exactly the route the MCP's `await_portfolio` uses: the api sends the signed creator steps behind its own `sendGuard` (fee payer = the creator, the nonce advance first), records the signatures and nudges the keeper's `/complete`; the keeper completes every `keeper_processor` step on its own. A `SEND_REFUSED` / `SEND_FAILED` **answer** (a 4xx: the api refused the signed transactions, or a send failed under its guard) is exit 2 with the deployment id to check. **No answer** — a timeout, a 5xx, a network error — is exit 3 with the deployment id: the signed transactions left this process and the api may have sent them, so the run never reports them as "refused before signing".
10. **Poll** — the same route without `signed` (a `409 AWAIT_IN_PROGRESS` falls back to `GET /v1/deployments/:id`) until `status:'live'` or `--wait-secs` (600) elapse. A `sign_again` (a blockhash build whose creator transaction expired — never a nonce-backed one) is re-verified under the same `expect` and re-signed, at most 3 times; a partial rebuild (no `create_portfolio`) is refused and the run stops with exit 3. **Once `/await` has accepted the signed transactions nothing ends in exit 2**: the api going quiet (a timeout, a 5xx, a network error on a poll), a `sign_again` whose re-signed transactions the api refuses, a crash — every one is exit 3 with the deployment id and `resume with --deployment-id`, because exit 2 reads as "nothing was signed or sent" and a script keyed on it would run the create again and pay for a second book.
11. **Report** — `GET /v1/portfolios/<mint>`; with `--json` one line on stdout: `{ deploymentId, mint, portfolio, vaultKey, creator, curator, feeRecipient, rebalanceDelaySecs, status }` (`feeRecipient` = the creator by construction; `status` is `live`, `dry-run`, or the deployment's status on a timeout). On the live, dry-run and timeout paths the addresses are the verified ones (the signed accounts, the derived mint) whenever this run verified them; only on a resume does the line carry the deployment's `expectedAddresses` — the api's echo, which nothing in that run verified. Everything else goes to stderr, URL-scrubbed; never key material, tokens, transaction bytes or the api URL.

`--deployment-id <id>` resumes step 10 for an earlier run: no key is loaded, nothing is built, nothing is signed — a `sign_again` on a resume is reported, never signed.

| Exit | Meaning |
|---|---|
| 0 | live, or a verified dry run |
| 2 | refused: a bad argument, a key that could not be loaded, an api refusal, a verification failure — nothing was signed or sent, unless the message names the deployment id (a send the api **answered** with a refusal after signing, a 4xx: check it before running again) |
| 3 | not live within `--wait-secs`, `expired`, an unsignable `sign_again` — or the run stopped once the signed creator transaction had left this process: the submit got no answer, the api stopped answering after the send, the api refused a re-signed `sign_again`, a crash while polling. The deployment id is printed for `--deployment-id`; never run the create again before checking the deployment |
| 1 | an unexpected crash before anything was submitted |
