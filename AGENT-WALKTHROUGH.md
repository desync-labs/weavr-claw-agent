# Set up a weavr curator with an agent

The same path as `WALKTHROUGH.md`, written for an agent to run: every step
is a command with the output to check, and the points where only a human
can act are marked. Hand this page and the inputs table to an agent that
has a shell on the machine; it runs to the first `STOP`, reports, and
continues when the operator says so. Written 18 September 2026 against the
signer image `intothefathom/curator-public:0.1.0` and Hermes `v2026.8.27`.

## How to read this page

- `STOP` marks a step only the operator can do: sending money, providing a
  key or token, pressing a button in Telegram, approving a signature. Do
  the step's check afterwards; never take the operator's word for a balance.
- `EXPECT` is what a correct run prints. Anything else: stop, show the
  output, do not retry more than once, do not improvise around it.
- Secrets never pass through the chat or a command line. The operator
  writes them into the files named here (mode 0600), or names a 0600 file
  you copy them from. You never print, echo or log a key, a token, a URL
  with a key in it, or the contents of a keypair file.
- Run the wallet tool as one plain command, exactly as shown: never inside
  `if`, `&&`, `;`, `$(...)` or a subshell. Its JSON already reports errors.
- Every command is idempotent or says what a re-run does. `init` keeps the
  key, the tokens, the policy and the values the operator typed.
- Real money on Solana mainnet, small amounts. Nothing here withdraws user
  funds through the curator: it cannot.

## Inputs from the operator

Collect these before the first command. Ask once, in one message.

| Input | Used in | Notes |
|---|---|---|
| `TICKER` | create, curator | 1 to 10 letters or digits, not carried by any portfolio yet (`get_portfolio TICKER` answers not found) |
| `NAME` | create | up to 32 characters, the operator's words |
| the thesis and the mix | create | the operator's words; 4 assets at most through the wallet tool, percents adding to 100 |
| deposit amount | deposit | at least $60 for a first pass |
| withdrawal amount | withdraw | at most $2 for a first pass: larger exits wait for the keeper |
| model provider key | agent, curator | `OPENAI_API_KEY` for the default config; the operator writes it into the files below |
| Telegram bot token | curator | from `@BotFather`; the operator writes it |
| Telegram numeric user id | curator | from `@userinfobot`; both `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_HOME_CHANNEL` |
| Solana RPC URL | signer | a private endpoint; the operator writes it into `~/weavr-wallet/secrets.env` |
| funding | wallet, curator key | about 0.15 SOL and the deposit's USDC to the agent wallet; 0.1 SOL to the curator key, when asked |

## 0. Preflight

```bash
node --version            # EXPECT v20 or newer
python3 --version         # EXPECT any 3.x
docker version --format '{{.Server.Version}}'   # EXPECT a version; an error means the daemon is down: STOP, the operator starts Docker
docker compose version    # EXPECT v2
command -v claw           # EXPECT a path; else install the Claw Agent first: npx @clawpump/claw-agent, or the macOS app
```

Make the secrets file the operator fills. `STOP`: the operator writes the
RPC URL into it.

```bash
mkdir -p -m 700 ~/weavr-wallet
touch ~/weavr-wallet/secrets.env && chmod 600 ~/weavr-wallet/secrets.env
# the operator adds one line: SOLANA_RPC_URL=<their private RPC URL>
grep -c '^SOLANA_RPC_URL=.\+' ~/weavr-wallet/secrets.env   # EXPECT 1
```

## 1. The chat agent

Clone this repository, install, copy the gate plugin and the skill:

```bash
git clone https://github.com/desync-labs/weavr-claw-agent ~/weavr-wallet/tools/claw-agent
cd ~/weavr-wallet/tools/claw-agent && npm i
mkdir -p ~/.hermes/plugins && cp -r plugins/weavr-wallet-gate ~/.hermes/plugins/ && claw plugins enable weavr-wallet-gate
mkdir -p ~/.hermes/skills/weavr && cp skills/weavr/SKILL.md ~/.hermes/skills/weavr/SKILL.md
```

Add weavr's MCP server. `claw mcp add weavr --url https://api.weavr.sh/mcp`
asks a question on a terminal; without one, write the entry yourself:
merge this block under `mcp_servers:` in `~/.hermes/config.yaml` (create the
file from this repository's `config.yaml` if it does not exist), and make
the `model:` block name the operator's provider (`openai-api` and `gpt-5.4`
by default).

```yaml
mcp_servers:
  weavr:
    url: "https://api.weavr.sh/mcp"
    enabled: true
    trust: "untrusted"
    tools:
      resources: false
      prompts: false
      exclude: [portfolio_status]
```

```bash
claw mcp test weavr       # EXPECT: Connected, 30 tools
```

## 2. The wallet

A local key that lives on this machine. The tool makes it and prints only
the address.

```bash
mkdir -p -m 700 ~/weavr-wallet/keys
export SIGN_LOCAL_KEYPAIR_FILE=~/weavr-wallet/keys/agent.json WEAVR_WALLET=local
cd ~/weavr-wallet/tools/claw-agent
node tools/sign.mjs --wallet create      # EXPECT {"created":true,"address":"..."}; {"error":"CONFIG",...} with "already" means a key is there: keep it
node tools/sign.mjs --balance            # EXPECT {"address","sol","usdc","minSol":{...},"ok":{"create":false,...}} before funding
```

Write the chat agent's env. `STOP`: the operator puts the provider key on
the first line; you write the other three from the paths above.

```bash
touch ~/.hermes/.env && chmod 600 ~/.hermes/.env
# the operator adds: OPENAI_API_KEY=<key>
cat >> ~/.hermes/.env <<EOT
WEAVR_WALLET=local
SIGN_LOCAL_KEYPAIR_FILE=$HOME/weavr-wallet/keys/agent.json
WEAVR_SIGN_TOOL=$HOME/weavr-wallet/tools/claw-agent/tools/sign.mjs
EOT
```

`STOP`: the operator sends about 0.15 SOL and the deposit amount in USDC to
the address `--wallet create` printed. Then check; do not continue on the
operator's word:

```bash
set -a; . ~/.hermes/.env; set +a
node tools/sign.mjs --balance            # EXPECT "ok":{"create":true,...} and "usdc" at least the deposit amount
node tools/sign-check.mjs                # EXPECT {"status":"ok",...,"signer":"local",...}, exit 0; a CONFIG line names what is wrong with the file
claw chat -q "Deposit 5 dollars into my MAJ portfolio."   # EXPECT the answer ends with BLOCKED ... (Wallet action: deposit ...): the gate holds
```

## 3. Create the portfolio

Two ways. With weavr's MCP tools attached to you (an MCP host that lists
`list_assets`, `simulate_portfolio`, `create_portfolio`), drive them
directly. Without them, the create is the operator's step in `claw chat`
(section 2 of `WALKTHROUGH.md`), because the approvals it needs are
terminal prompts; ask for the `mint` and the `url` when it is live and
continue at section 4.

With the tools:

1. `list_assets` with the operator's thesis, in their words. Pick the
   tickers the operator named from the answer; never substitute.
2. `node tools/sign.mjs --address` → the creator address. Never ask the
   operator for an address.
3. `simulate_portfolio` with `name`, `ticker`, `mix` (4 entries at most,
   percents adding to 100) and `creator`. EXPECT `valid: true` and
   `problems: []`; `networkCostSol` is what the wallet spends. Any problem: report it, do not
   change the mix on your own.
4. `create_portfolio` with the same `name`, `ticker`, `mix`, `creator` and
   `wallet: "tool"`. Take `deploymentId` from the answer. Never print
   `walletPayload`.
5. Sign and wait:

```bash
node tools/sign.mjs --deployment <deploymentId>   # EXPECT {"status":"live","mint":"...","url":"..."}; sign_again: run the same command once more
```

Record `mint` and `url`; the mint is `TICKER` from here on. Do not call
`await_portfolio` yourself in wallet-tool mode, and never accept a sign
link for this create: a link-signed book makes the browser wallet the
creator, and the handover below no longer fits.

## 4. Deposit

```bash
node tools/sign.mjs --deposit TICKER --amount 60   # EXPECT {"status":"confirmed",...}; BUSY: wait a moment, run once more
```

Then `get_portfolio TICKER` (or the `url`) after two minutes: the legs are
filled; the keeper ticks every 60 seconds.

## 5. The curator

`init` needs the RPC in the shell (never on the command line) and the
creator key, which is the portfolio's current curator and signs the
handover. `--yes` answers the prompts a terminal would show; `--json` prints
exactly one object and never prompts; `--wait` polls for the funding and
the handover. Save the output.

```bash
cd ~/weavr-wallet/tools/claw-agent && npm link    # `weavr-curator`; or node bin/weavr-curator.mjs
set -a; . ~/weavr-wallet/secrets.env; set +a
export SIGN_LOCAL_KEYPAIR_FILE=~/weavr-wallet/keys/agent.json
weavr-curator init --portfolio TICKER --transfer-wallet local --wait --wait-secs 900 --yes --json > ~/weavr-wallet/init.json; echo "exit $?"
H=$(node -p "require(process.env.HOME + '/weavr-wallet/init.json').home"); echo "$H"   # EXPECT a path: the home, named after the book's onchain symbol
```

`$H` is the curator's home from here on; take it from the JSON, not from a
guess, because the directory is named after the symbol as it is onchain.

Exit codes, read with `.exit` and `.steps[]` (`kind`, `name`, `detail`,
`fix`) in the JSON:

- `3`: the curator key needs SOL. `.key` is its address. `STOP`: the
  operator sends 0.1 SOL there. With `--wait` the run polls up to
  `--wait-secs`; if it timed out, run the same command again.
- `2`: a cross; the step with `kind: "cross"` names the fix. On the first
  run the expected cross is `policy vs book`: the standard preset refuses
  legs it does not list. That is the guardrail working. Continue below.
- `0`: done; skip to "Fill the agent's env".

Write the book's policy. `.portfolio.legs[].symbol` in `init.json` are the
pool symbols the document must admit. Start from the document below (a
book of five Solana legs on the standard preset with the universe opened):
put each leg's symbol on `universe.allowlist` and in exactly one
`universe.categories` entry, keep `pUSDS` in `stable` so a stable category
exists with a zero floor, set `universe.maxExecutionLossBps` to the highest
catalogue cost among the legs (`get_asset` shows it; 200 covers the pre-IPO
legs), leave `requirePythFeedId` false if any leg lacks a feed, and leave
`invariants.rebalanceDelaySecs` as it is: `init` rewrites it to the book's
notice. Everything else stays as written.

```bash
cat > $H/curator/policy.json <<'EOT'
{
  "version": 1,
  "universe": {
    "chains": ["solana"], "requireStatus": "active", "requirePythFeedId": false,
    "maxRiskTier": 4, "maxExecutionLossBps": 200,
    "allowlist": ["pNVDA", "pANTHROPIC", "pTOPENAI", "pJUPSOL", "pCBBTC", "pUSDS"],
    "categories": { "equity": ["pNVDA"], "preipo": ["pANTHROPIC", "pTOPENAI"], "lst": ["pJUPSOL"], "btc": ["pCBBTC"], "stable": ["pUSDS"] }
  },
  "shape": { "minLegs": 3, "maxLegs": 8, "pageLimit": 8, "minLegWeightBps": 500, "maxLegWeightBps": 4000,
             "stableCategory": "stable", "stableMinBps": 0, "stableMaxBps": 4000, "categoryMaxBps": 6000, "sumBps": 10000 },
  "turnover": { "maxTurnoverBps": 3000 },
  "cost": { "maxEstimatedCostBps": 100 },
  "cadence": { "minSecsSinceLastRebalance": 0, "maxProposalsPer30d": 10, "quotaWindowSecs": 2592000,
               "requireInputsComplete": false, "riskExitExemptFromInputs": true, "proposeWindowUtc": { "fromHour": 0, "toHour": 24 } },
  "reason": { "required": true, "maxChars": 500 },
  "deposit": { "dailyCapUsd": 1000, "launchDayCapUsd": 2500, "launchDay": null, "requireBookFresh": true },
  "withdraw": { "chatOnly": true, "dailyCapUsd": 500, "toSignerAtaOnly": true },
  "verbs": {
    "agent": ["status", "review", "policy", "alerts", "simulate", "propose", "apply", "cancel", "deposit", "withdraw", "refresh-nav", "pause", "note", "journal", "hermes-heartbeat"],
    "ops": ["resume", "unlock", "rotate-curator", "set-delay", "set-metadata"],
    "denied": ["transfer-curator", "accept-curator", "cancel-curator", "propose-fee-recipient", "accept-fee-recipient", "revive", "create"],
    "cronDenied": ["withdraw"]
  },
  "rate": { "maxWriteAttemptsPerHour": 20, "minSignerLamports": 20000000 },
  "invariants": { "rebalanceDelaySecs": 60, "compositionLocked": false, "pendingCuratorMustBeNone": true },
  "apply": { "tickSecs": 30, "armBeforeEffectiveSecs": 120, "windowAfterEffectiveSecs": 21600, "maxSendsPerTick": 3,
             "sendFailedTicksBeforeEscalate": 3, "refreshNavWhenBookStaleSecs": 900, "applyInFlightWaitSlots": 320,
             "applyInFlightMaxAttempts": 3, "missingCustodyRetries": 1,
             "escalateAfterSecs": { "BOOK_NOT_FRESH": 1800, "BOOK_PENDING_PRICE": 1200, "LEG_PENDING_PRICE_PYTH": 600, "LEG_PENDING_PRICE_PUBLISHER": 0,
                                    "LEG_STALE": 1800, "WITHDRAWALS_PENDING": 3600, "LEG_NOT_ACTIVE": 0, "VAULT_PAUSED": 0, "WINDOW_CLOSED": 0 } },
  "review": { "monthlyReviewWeekday": 1, "legNeedsInflowGates": 3, "legNoInflowDays": 7, "publisherParkHours": 6, "drawdown30dPct": -35, "briefMaxChars": 4096 }
}
EOT
weavr-curator init --portfolio TICKER --transfer-wallet local --yes --json > ~/weavr-wallet/init.json; echo "exit $?"   # EXPECT exit 0; .steps has "policy file" ok as "edited by hand"
```

A re-run without `--policy` keeps the file and validates it; the handover
already made is not made again.

Fill the agent's env. `init` wrote `$H/hermes-home/.env` with four empty
lines the operator owns. `STOP`: the operator fills
`OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` and
`TELEGRAM_HOME_CHANNEL` (the last two are the same numeric user id), or
names a 0600 file you copy the four values from. Then pin the agent image
in `compose.env` and check:

```bash
sed -i 's#^HERMES_IMAGE=.*#HERMES_IMAGE=nousresearch/hermes-agent:v2026.8.27#' $H/compose.env
grep -cE '^(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USERS|TELEGRAM_HOME_CHANNEL)=.+' $H/hermes-home/.env   # EXPECT 4
grep -E '^(CURATOR_SIGNER_IMAGE|HERMES_IMAGE)=' $H/compose.env   # EXPECT intothefathom/curator-public:0.1.0 and nousresearch/hermes-agent:v2026.8.27
```

`STOP`: the operator opens a chat with the bot in Telegram and presses
Start once; without it the bot cannot message them.

Start, check, resume, check:

```bash
cd ~/weavr-wallet/tools/claw-agent
docker pull intothefathom/curator-public:0.1.0 && docker pull nousresearch/hermes-agent:v2026.8.27
docker compose --env-file $H/compose.env -f curator/compose/curator.yml up -d
sleep 40
weavr-curator doctor --home $H --json > ~/weavr-wallet/doctor.json; echo "exit $?"
```

EXPECT exit 1 with exactly two steps of `kind: "cross"`: `signer paused`
(the stack boots paused) and `agent heartbeat` (the health job runs every
quarter hour). Every other step is `ok` or `skip`. Any other cross: its
`fix` says what to do; report it. Then:

```bash
weavr-curator ops resume --home $H          # EXPECT ok
sleep 40
weavr-curator doctor --home $H --json > ~/weavr-wallet/doctor.json; echo "exit $?"   # EXPECT only agent heartbeat crossed, and none after the next quarter hour
```

Leave the curator a request and run the review now instead of waiting for
09:00 UTC:

```bash
weavr-curator ops request-review --home $H --text "First review of TICKER: is an equal start the right shape? Simulate, then propose or hold." --why "first run"
docker compose --env-file $H/compose.env -f curator/compose/curator.yml exec -T agent hermes cron run curator-review
sleep 120
weavr-curator ops status --home $H         # the /status body: apply.state, portfolio.pendingTargets, ledger.lastProposalAt
```

The brief lands in the operator's Telegram chat; a proposal shows as
`pendingTargets` with its `effectiveAt`, and the signer applies it after the
book's notice. A HOLD with a reason is also a correct outcome. Ask the
operator to confirm the brief arrived: you cannot read their chat.

## 6. Withdraw

The creator's side, with the agent wallet:

```bash
cd ~/weavr-wallet/tools/claw-agent && set -a; . ~/.hermes/.env; set +a
node tools/sign.mjs --withdraw TICKER --amount 2    # EXPECT {"status":"confirmed","amountUsd":...,"fullExit":false,...}
```

`list_withdrawals` (or the portfolio page) shows the request; the keeper
pays it from idle at its next tick, and `node tools/sign.mjs --balance`
shows the USDC back. Never ask the curator bot to withdraw: its `withdraw`
moves only shares the signer itself holds, and it holds none of the
operator's.

## 7. Done when

`weavr-curator doctor --home $H --json` exits 0, which means every step
below is `ok` or `skip` and none is `cross`:

`home`, `key file`, `tokens`, `policy file`, `compose env`, `signer SOL`,
`portfolio row`, `mint`, `curator`, `notice`, `policy vs book`, `treasury`,
`guardian`, `signer health`, `signer status`, `signer paused`, `signer lock`,
`signer invariants`, `signer policy`, `signer wallet`, `agent config`,
`agent provider`, `agent jobs`, `agent env`, `agent plugin`, `telegram env`,
`telegram bot`, `provider key`, `agent heartbeat`, `docker`, `containers`.

Report to the operator: the mint and the url, the curator key's address,
the deposit and withdrawal signatures the tool printed, and the doctor's
verdict. Nothing else from the files.

## Teardown and rollback

```bash
docker compose --env-file $H/compose.env -f curator/compose/curator.yml down      # the stack; the key, tokens, policy and journal stay in $H
```

To hand curation back to the operator's wallet, `weavr-curator ops
rotate-curator --new-curator <their pubkey> --why "..."` proposes it; the
new curator accepts from their wallet. Leaving the stack running is fine:
the policy caps everything.

## Do not

- Do not print, echo, `cat` or quote a keypair file, a token file, an env
  file with values in it, or an RPC URL. Report only what this page says to
  report.
- Do not put a secret on a command line: the RPC goes through the shell
  environment from the secrets file, the tokens are read from files.
- Do not wrap the wallet tool in shell logic, and do not retry a refusal:
  `WALLET_DECLINED`, `WRONG_PAYER`, `FOREIGN_PROGRAM` and `CONFIG` are stops.
- Do not build or submit a transaction by hand when the wallet tool
  refuses: the refusal is the answer.
- Do not accept a sign link for the create, and do not change the operator's
  mix, name or ticker.
- Do not pass `--yes` to `init --policy` over an edited policy, and do not
  loosen a policy number to get past `policy vs book`: open the universe to
  the book's legs, as above, and leave the caps.
- Do not resume the signer before the doctor shows every other line green.
