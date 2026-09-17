# weavr-curator (Hermes plugin)

The Hermes side of the weavr curator. The curator key, the policy, the
transaction verification and the journal all live in the signer (the weavr
curator signer, HTTP `:8091`). This plugin is the thin client the agent uses,
plus the two things only the Hermes side can know: which session is calling,
and the human approval gate. It also gives the model the one thing prose
cannot: the policy the signer is enforcing right now.

| File | What |
|---|---|
| `plugin.yaml` | manifest (`hooks: [pre_tool_call]`) |
| `__init__.py` | `register(ctx)`: the `weavr_curator` tool, the `pre_tool_call` gate, the `/weavr-curator` command |
| `test_plugin.py` | planted cases, pure Python, no Hermes import: `python3 test_plugin.py` |

Install: the curator profile (`curator/profile/`) ships it; `weavr-curator init`
renders the profile into `$HERMES_HOME` with this directory under
`plugins/weavr-curator` and `plugins.enabled: [weavr-curator]` in
`config.yaml`. By hand: copy or symlink it to `$HERMES_HOME/plugins/weavr-curator`
and `hermes plugins enable weavr-curator`.

## Environment

| Variable | Read | Meaning |
|---|---|---|
| `CURATOR_SIGNER_URL` | every call | base URL of the signer; `http://signer:8091` on the compose network |
| `CURATOR_SIGNER_TOKEN` | every call | agent bearer token; read at call time so a rotation needs no restart |
| `CURATOR_OPS_TOKEN` | `/weavr-curator resume` only | **never set on the agent**; without it `resume` refuses and points at `weavr-curator ops resume` |
| `CURATOR_PORTFOLIO_SYMBOL` | approval text | the portfolio's ticker; unset, the text says "the portfolio" |
| `CURATOR_REBALANCE_DELAY_SECS` | approval text | the portfolio's onchain notice; unset, the text announces no notice rather than guessing one |
| `CURATOR_POLICY_JSON` | `policy` fallback only | the document, for a signer too old to serve `/policy`; the live signer is preferred whenever it answers |
| `HERMES_CRON_SESSION` | gate + headers | set by Hermes for cron jobs (context variable first, env fallback) |

The tool is hidden (`check_fn`) until both signer variables are set; the
handler still answers a clear error, without secrets, if it is called anyway.

## The tool: `weavr_curator`

`{ verb, mix?, why?, amountUsd?, text?, n? }` → compact JSON from the signer.

| verb | signer route | body built from the args |
|---|---|---|
| `status` | `GET /status` | none |
| `review` | `GET /review` | none |
| `policy` | `GET /policy` | none (see below) |
| `simulate` | `POST /simulate` | `{ targets }` |
| `propose` | `POST /propose` | `{ targets, why }` |
| `apply` | `POST /apply` | `{}` |
| `cancel` | `POST /cancel` | `{ why }` |
| `deposit` | `POST /deposit` | `{ amountUsd }` |
| `withdraw` | `POST /withdraw` | `{ amountUsd }` (chat only) |
| `refresh_nav` | `POST /refresh-nav` | `{}` |
| `pause` | `POST /pause` | `{ why? }` |
| `note` | `POST /note` | `{ text }` |
| `journal` | `GET /journal?n=` | none |

`mix:[{asset, percent}]` becomes `targets:[{poolId, weightBps}]`: `asset` is
the pool symbol with or without the leading `p` (`SOL`, `sol`, `pSOL` →
`pSOL`), `poolId` is the api's `<symbol>@<chain>` with `chain = solana`
unless the asset spells one (`pWSTETH@ethereum`), `weightBps = round(percent × 100)`.
Sums, caps and the universe are the signer's to refuse; the plugin only
rejects shape errors (missing `why`, non-numeric percent, a duplicate asset)
locally so a typo never lands in the journal as a refusal.

### `policy`: the live document

`GET /policy` answers `{ version, sha256, policy }`: the document the signer
loaded at boot, its schema version and its digest. The tool returns that
compact JSON plus `source: "signer"`. The skill reads it once per run before
deciding, because no page the model can read states a threshold; the
document does.

An older signer answers 404 on the route. The plugin then falls back, and
says so in `source` and `hint`: `CURATOR_POLICY_JSON` on the agent host when
it is set and parses (`source: "env"`, the digest is of that text, and the
hint warns it may differ from the signer's), else the `policy` block of
`GET /status` (`source: "status"`, version only). Any other error from
`/policy` (a 401, a 500) is returned as the signer's own error; nothing is
worked around.

Headers on every call: `Authorization: Bearer $CURATOR_SIGNER_TOKEN`,
`X-Curator-Session: cron|chat`, `X-Curator-Caller: hermes`; 30 s timeout.
A non-2xx answer is returned, not raised, as `{ok:false, status, error:{code,message}}`
so the model sees the signer's refusal code verbatim. Keys named `tx`,
`transactions`, `walletPayload` or `signed` are dropped at any depth before
the text reaches the model: the signer never returns them, this is the belt
to that brace.

## The gate: `pre_tool_call`

Only `tool_name == "weavr_curator"`; every other tool passes untouched.

| verb | cron session | chat session |
|---|---|---|
| `status` `review` `policy` `simulate` `journal` `note` `pause` | pass | pass |
| `propose` `apply` `cancel` `refresh_nav` `deposit` | pass (the signer's policy still applies) | **approve**: escalated to the human gate |
| `withdraw` | **block** | **approve** |
| anything else | **block** | **block** |

The approval message names the action (`propose 40% SOL / 30% CBBTC / 30%
JITOSOL on <ticker> with a <notice> notice: "why"`, `withdraw $250 from
<ticker> to the curator wallet`, …); the ticker and the notice come from
`CURATOR_PORTFOLIO_SYMBOL` and `CURATOR_REBALANCE_DELAY_SECS`, and unset they
are left out rather than guessed. Nothing else the model puts in the args
reaches the text: a turnover or cost figure is not in the schema, is not
validated and never goes to the signer, so rendering one would show the
human a model-supplied number as fact. The human sees the mix and the why;
the turnover that counts is the signer's own, from `simulate`, and the
signer refuses on its own numbers. `rule_key` is
`weavr-curator:<verb>:<sha256(canonical args)[:12]>`, so an `[a]lways`
answer covers exactly that mix and amount, never every propose. Hermes
ignores an exception from a hook, which would let a broken gate approve
everything; the gate catches its own failures and blocks.

`pause` counts as a read on purpose: the agent must always be able to pause
itself without a human in the loop (kill ladder step 1). `policy` is a read
because a cron review that could not read the policy would decide from prose.

## The command: `/weavr-curator`

`status | review | journal [n] | policy | pause [why] | resume [why] | cancel <why> | apply | note <text>`

The fork already has a built-in `/curator` ("Background skill maintenance")
and `register_command` skips a name that resolves to a built-in, so the
command is `/weavr-curator`. A human typed it, so it is sent as a `chat`
session and no approval gate runs. `resume` needs the ops token (see above).

`policy` fetches the document the same way the tool does and renders one
line per section, every number taken from the document itself (universe,
categories, shape, turnover, cost, cadence with its UTC window, reason,
deposit, withdraw, verbs, rate, invariants, apply, review), then
`sha256 <first 12>` and the source. On the `/status` fallback it prints the
version block and the hint, as before.

## What the plugin does not do

- It never sees, prints or forwards a transaction, a key or an RPC URL; error
  text carries the failure reason, never the URL or the token.
- It cannot strip `CURATOR_SIGNER_TOKEN` from the terminal tool's children:
  the fork has no `ctx.register_env`/strip-key API (only a registered
  `TerminalEnvironmentProvider.strip_env_keys`, and `register_redaction_patterns`
  takes token-format regexes and logs a rejected pattern verbatim). The
  curator profile disables the `terminal` and `code_execution` toolsets
  instead; keep it that way.

## Tests

```
python3 plugins/weavr-curator/test_plugin.py      # or: npm run curator-test
```

Twenty-three planted cases: cron passes the allowlisted verbs, cron blocks
`withdraw` and unknown verbs, chat escalates with a per-args `rule_key` (two
mixes → two keys, key order → same key), read verbs never escalate and
`policy` is one of them in both sessions, other tools untouched, the gate
fails closed when it breaks, the approval text announces no notice without
the env (proven by planting one) and never renders a turnover the model
planted in the args, the handler posts the right body and
headers (fake `urlopen`, no network), drops transaction-bearing keys at any
depth, returns a signer refusal verbatim, rejects bad input before any
request, answers a missing `CURATOR_SIGNER_URL` clearly without secrets;
`policy` GETs the route and posts nothing, falls back on a 404 to the env and
then to `/status` and never on any other error; the command renders the
numbers of a fake `/policy` body (and none of the standard preset's), shows
the digest prefix, and refuses `resume` without the ops token; and the two
policy presets (`curator/policy/`) settle every route the plugin calls,
keep every read verb in `verbs.agent` and name nothing the agent does not
call (proven by dropping `policy` from a copy of each).
