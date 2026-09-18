# Run your own weavr curator: a Claw Agent, a portfolio, and a curator with its cron

A walkthrough from a clean machine to a portfolio you created from chat, a
deposit, an autonomous curator reviewing it on a schedule, and a withdrawal.
It follows this repository's two READMEs (the root one for the chat agent,
`curator/README.md` for the curator) and adds the order, the waits and the
checks that matter. Commands are the READMEs' own. Written 18 September 2026
against the signer image `intothefathom/curator-public:0.1.0` and Hermes
`v2026.8.27`.

> **Who can run this today.** Anyone. Every step is public: the chat agent,
> the create, the deposit and the withdrawal need nothing private, and the
> curator's signer is a published image (`intothefathom/curator-public`,
> built from `signer/` in the same repository), which compose pulls.

Real money on Solana mainnet throughout, small amounts.

Handing this to an agent? `AGENT-WALKTHROUGH.md` is the same path with the
non-interactive commands, the checks, and the steps only you can do.

## 0. Before you start

- **Machine:** Linux or macOS, Node 20 or newer, Python 3, Docker with compose
  v2 running, a Claw Agent install (`npx @clawpump/claw-agent`, or the macOS
  app) with a model provider configured. `claw` and `hermes` are the same
  command.
- **Accounts:** an OpenAI API key (the curator's jobs pin gpt-5.4 on the
  OpenAI provider; any provider Hermes supports works with a config change);
  a Telegram bot token from `@BotFather`; your numeric Telegram user id (ask
  `@userinfobot`); a private Solana RPC URL (the public endpoint is fine for
  the chat agent, not for the signer's polling).
- **Money:** about 0.15 SOL and the USDC you will deposit for the creator
  wallet; 0.1 SOL for the curator key. Deposit at least $60 and withdraw no
  more than $2 in the first pass: the keeper pays exits from the book's idle
  cash, which is 5% of the book, and an exit larger than idle waits for a
  slower path.
- **Secrets stay in files, mode 600.** Make one env file for the values you
  will need in a shell, and source it, never type the values on a command
  line:

```bash
mkdir -p -m 700 ~/weavr-wallet
cat > ~/weavr-wallet/secrets.env <<'EOT'
SOLANA_RPC_URL=<your private RPC URL>
EOT
chmod 600 ~/weavr-wallet/secrets.env
```

- **Pick a ticker** that no portfolio carries yet (`get_portfolio <ticker>` in
  chat must answer "not found"). Two books with one ticker make both
  unreachable by name. This page uses `<TICKER>`.

## 1. The chat agent

```bash
claw mcp add weavr --url https://api.weavr.sh/mcp      # 30 tools, enable: Y
```

In `~/.hermes/config.yaml` make the weavr entry match the repo's `config.yaml`
(`trust: untrusted`, `resources: false`, `prompts: false`,
`exclude: [portfolio_status]`), and set the model block the same way (the
repo's file names the OpenAI API and gpt-5.4; `claw setup` does the same
interactively). Then:

```bash
claw mcp test weavr                                     # Connected, 30 tools
git clone https://github.com/desync-labs/weavr-claw-agent ~/weavr-wallet/tools/claw-agent
cd ~/weavr-wallet/tools/claw-agent && npm i
mkdir -p ~/.hermes/plugins && cp -r plugins/weavr-wallet-gate ~/.hermes/plugins/ && claw plugins enable weavr-wallet-gate
mkdir -p ~/.hermes/skills/weavr && cp skills/weavr/SKILL.md ~/.hermes/skills/weavr/SKILL.md
mkdir -p -m 700 ~/weavr-wallet/keys
export SIGN_LOCAL_KEYPAIR_FILE=~/weavr-wallet/keys/agent.json WEAVR_WALLET=local
node tools/sign.mjs --wallet create                     # prints the address, nothing else
node tools/sign.mjs --balance                           # 0 SOL, 0 USDC, and the minimums
```

`~/.hermes/.env` (create it if the install did not; `chmod 600`):

```
OPENAI_API_KEY=<your key>
WEAVR_WALLET=local
SIGN_LOCAL_KEYPAIR_FILE=/home/you/weavr-wallet/keys/agent.json
WEAVR_SIGN_TOOL=/home/you/weavr-wallet/tools/claw-agent/tools/sign.mjs
```

Fund the printed address with 0.15 SOL and 60 USDC, then prove the wallet and
the gate:

```bash
set -a; . ~/.hermes/.env; set +a
node tools/sign.mjs --balance                           # ok.create true
node tools/sign-check.mjs                               # {"status":"ok", ..., "signer":"local"}
claw chat -q "Deposit 5 dollars into my MAJ portfolio."   # must end: BLOCKED ... (Wallet action: deposit ...)
```

## 2. Create the portfolio in chat

`claw chat`, then in your words, for example:

> My thesis: the companies building AI, with hard assets beside them.
> Nvidia, Anthropic through PreStocks, Jupiter staked SOL and Bitcoin, 25%
> each. Name it <NAME>, ticker <TICKER>. Create it with the wallet tool.

The agent checks the wallet and its balance, lists the assets, simulates with
your address as creator, and on your "create it" calls `create_portfolio` and
then `node $WEAVR_SIGN_TOOL --deployment <id>`. Two prompts: the trust panel
for `create_portfolio`, then **"Wallet action: sign the create for deployment
..."**. Answer once to each. The tool prints `"status":"live"` and the `url`.

**Four assets at most through the wallet tool.** weavr builds wallet-tool
creates as legacy transactions today, whichever wallet signs, and four assets
are two transactions behind that one approval. If the agent offers the sign
link instead, refuse: a link-signed book makes the browser wallet the
creator and the deposit and handover steps below no longer fit.

Show the portfolio page at the `url`; the mint is on it and on Solscan.

## 3. Deposit

In the same chat: *"Deposit 60 dollars into <TICKER>."* One approval; the tool
prints `"status":"confirmed"` with the signature. A minute or two later the
page shows the legs filled: the keeper ticks every 60 seconds.

## 4. The curator

Two images and the CLI. The signer image is public and compose pulls it
on `up`; the agent image is the one you built or pulled for the chat agent:

```bash
docker pull intothefathom/curator-public:0.1.0            # the tag curator/compose/curator.yml pins
docker pull nousresearch/hermes-agent:v2026.8.27
cd ~/weavr-wallet/tools/claw-agent && npm link          # `weavr-curator`; or node bin/weavr-curator.mjs
docker image ls intothefathom/curator-public nousresearch/hermes-agent  # both tags listed
```

If you ran `init` for this ticker before the image was published, its
`compose.env` keeps the old `CURATOR_SIGNER_IMAGE`; set it to the tag above.

The first `init`. A new terminal knows neither the creator key nor the RPC,
so set both first: the creator key is the current curator, which is what lets
`--transfer-wallet local` sign the handover, and the RPC goes into the
signer's env:

```bash
export SIGN_LOCAL_KEYPAIR_FILE=~/weavr-wallet/keys/agent.json
set -a; . ~/weavr-wallet/secrets.env; set +a
weavr-curator init --portfolio <TICKER> --transfer-wallet local --wait
```

Expect, in order: the book read from chain; the curator key generated and its
address printed with the SOL to send (send 0.1; `--wait` polls); the transfer
announced and signed by the creator key after your `y`, the accept by the new
key after your `y`; the guardian, treasury and notice derived from chain,
`y`; then the policy step. With a book like the one above the **standard
preset crosses**: legs not on its allowlist, a route cost above its ceiling,
no stablecoin leg. That is the guardrail working. Each cross names the fix.

Write the book's policy and run `init` again; a re-run keeps the file and
validates it against the legs:

```bash
nano ~/.config/weavr-curator/<TICKER>/curator/policy.json    # paste the document below, then adapt it
weavr-curator init --portfolio <TICKER> --transfer-wallet local
```

The document for a book of Nvidia, Anthropic, OpenAI via Tessera, JupSOL and
BTC in any subset. It is the standard preset with the universe opened, and
every difference is on purpose: the allowlist and categories name the legs
(plus pUSDS so a stable category exists with a zero floor); the Pyth
requirement is off because pJUPSOL has no feed; the route cost ceiling is 200
bps because the pre-IPO legs are catalogued at that; the proposal cost cap is
100 bps because a 25 bps cap admits almost no move touching a 200 bps leg;
cadence is open so a review can propose on the first day. For another book:
put each of your legs' pool symbols (`p` plus the asset) on the allowlist and
in exactly one category, raise `universe.maxExecutionLossBps` to the highest
catalogue cost among them, and leave `stableMinBps` at 0 unless you hold a
stablecoin. Tighten `cadence` and `cost` again before leaving it unattended.

```json
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
```

`init` rewrites `invariants.rebalanceDelaySecs` to the book's own notice, so
that number does not need to match yours.

The second run reports the policy as "edited by hand", validates it, writes
the tokens, `signer.env` and `compose.env`, and renders `hermes-home/` with
its `.env`. Pin the agent image and fill the four secrets:

```bash
echo 'HERMES_IMAGE=nousresearch/hermes-agent:v2026.8.27' >> ~/.config/weavr-curator/<TICKER>/compose.env
nano ~/.config/weavr-curator/<TICKER>/hermes-home/.env    # OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, TELEGRAM_HOME_CHANNEL
```

`TELEGRAM_ALLOWED_USERS` and `TELEGRAM_HOME_CHANNEL` are both your numeric
user id: the curator talks only in a private chat with you. Open a chat with
your bot and press Start once, or it cannot message you.

Start, check, resume, check:

```bash
cd ~/weavr-wallet/tools/claw-agent
docker compose --env-file ~/.config/weavr-curator/<TICKER>/compose.env -f curator/compose/curator.yml up -d
weavr-curator doctor --home ~/.config/weavr-curator/<TICKER>    # green except "signer paused"
weavr-curator ops resume --home ~/.config/weavr-curator/<TICKER>
weavr-curator doctor --home ~/.config/weavr-curator/<TICKER>    # green; "agent heartbeat" clears after the first quarter-hour health run
```

In the Telegram chat: `/weavr-curator status`, then `/weavr-curator policy`,
which prints the document the signer enforces with its digest.

The daily review runs at 09:00 UTC and is silent on a quiet day. To see it
act now, leave it a request and fire the job:

```bash
weavr-curator ops request-review --home ~/.config/weavr-curator/<TICKER> --text "First review of <TICKER>: is an equal start the right shape? Simulate, then propose or hold." --why "first run"
docker compose --env-file ~/.config/weavr-curator/<TICKER>/compose.env -f curator/compose/curator.yml exec agent hermes cron run curator-review
```

The brief lands in your chat. In a cron run the policy is the only gate: a
proposal needs no approval, is announced onchain with its reason, and the
signer applies it after the book's notice. `/weavr-curator status` shows the
apply state, `/weavr-curator journal` the record. A HOLD with a reason is a
fine outcome too.

## 5. Withdraw

Back in the chat agent, the creator's side: *"Withdraw 2 dollars from
<TICKER>."* One approval; the request is confirmed with its signature. The
keeper pays it from idle at its next tick; `list_withdrawals` in chat shows it
processed and `--balance` shows the USDC back.

Do not ask the curator bot to withdraw. Its `withdraw` moves only shares the
signer itself holds, and it holds none of yours: the curator cannot touch
user money, by design.

## 6. What to look at

- The portfolio page: size, holders, targets, holdings, the queue.
- Solscan: the mint, the create, the deposit, the withdrawal request and its
  fulfilment, the curator handover (transfer and accept), and any propose and
  apply the journal carries.

## 7. Afterwards

`/weavr-curator pause` from the chat, or `weavr-curator ops status` from the
laptop; `docker compose --env-file ... -f curator/compose/curator.yml down`.
Leaving it running is fine: the policy caps everything. An exit larger than
idle (`--withdraw <TICKER> --shares all`) depends on the keeper unwinding
legs, which can take long; give it time or leave the float.

## Known limits, today

- Four assets at most for a create through any wallet tool; the sign link has
  no such limit but changes who the creator is.
- Exits larger than the book's idle cash wait for the keeper to unwind legs.
- The doctor is red on one line, "signer paused", until you resume, and on
  "agent heartbeat" until the first quarter-hour health run.
- A quiet day is silent: without a request or a manual run there is nothing to
  see from the cron.
