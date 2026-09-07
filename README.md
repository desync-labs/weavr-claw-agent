# weavr for the Claw Agent

The pieces a self-hosted [Claw Agent](https://github.com/Clawpump/claw-agent) (ClawPump's agent, built on Hermes) needs to create and manage [weavr](https://www.weavr.sh) portfolios from a thesis, with PayBox's command-line tool signing on your own machine and you approving every signature.

weavr itself is an MCP server at `https://api.weavr.sh/mcp`. Reads and simulations need nothing from this repo. Creating a portfolio and depositing need a wallet, and that is what is here.

| Path | What |
|---|---|
| `tools/sign-solana.mjs` | the wallet tool: signs weavr transactions with the PayBox CLI (`--address`, `--deployment <id>`, `--deposit <ticker> --amount <usd>`) |
| `tools/sign-check.mjs` | a zero-cost check that the key, the grant and the client agree; prints the PayBox client id |
| `tools/sign-local.mjs` | the same tool with a local keypair file, for testing with a throwaway wallet |
| `tools/lib/` | the checks (fee payer must be your wallet, every instruction inside weavr's programs), the weavr flows, the two signers |
| `plugins/weavr-wallet-gate/` | a Hermes plugin: every signing run becomes an approval you answer, with a message naming the action and the amount |
| `patches/` | a one-line fix for Claw Agent releases whose trust gate asks before read-only tools too |
| `manifest.json` | weavr's onchain programs, the allowlist the wallet tool signs for |
| `config.yaml`, `env.example` | the Hermes config block and the environment names |

## Setup

You need a Claw Agent install with a model provider configured, Node.js 20 or newer, and a PayBox account with a **dedicated, small** Solana wallet for the agent. `claw` and `hermes` are the same command.

### 1. Add weavr to the agent

```bash
claw mcp add weavr --url https://api.weavr.sh/mcp      # lists 30 tools, asks to enable them: Y
```

In `~/.hermes/config.yaml`, make the weavr entry match the one in `config.yaml` here (`trust: untrusted`, `resources: false`, `prompts: false`, `exclude: [portfolio_status]`). Then give the agent the skill:

```bash
mkdir -p ~/.hermes/skills/weavr
curl -s https://api.weavr.sh/hosts/hermes/SKILL.md -o ~/.hermes/skills/weavr/SKILL.md
claw mcp test weavr                                     # Connected, 30 tools
```

### 2. PayBox

```bash
mkdir -p ~/weavr-wallet/tools && cd ~/weavr-wallet/tools && npm i @paybox-sh/sdk@0.8.5
export PAYBOX_CONFIG_DIR=~/weavr-wallet/paybox PAYBOX_CLI=$PWD/node_modules/@paybox-sh/sdk/dist/cli.js
mkdir -p -m 700 "$PAYBOX_CONFIG_DIR"
node "$PAYBOX_CLI" login --no-provision                 # open the printed URL on your phone, approve with your passkey
node "$PAYBOX_CLI" --json credentials                   # the id of the wallet the agent will use
```

In the PayBox app, on the **Clients** screen, give this client **Full Access** to that one wallet and nothing else.

### 3. This repo

```bash
git clone https://github.com/desync-labs/weavr-claw-agent ~/weavr-wallet/tools/claw-agent
cd ~/weavr-wallet/tools/claw-agent && npm i
cp -r plugins/weavr-wallet-gate ~/.hermes/plugins/ && claw plugins enable weavr-wallet-gate
```

Add to `~/.hermes/.env` (`chmod 600`), with your paths:

```
PAYBOX_CONFIG_DIR=/home/you/weavr-wallet/paybox
PAYBOX_CREDENTIAL_ID=<wallet credential id>
PAYBOX_CLI=/home/you/weavr-wallet/tools/node_modules/@paybox-sh/sdk/dist/cli.js
WEAVR_SIGN_TOOL=/home/you/weavr-wallet/tools/claw-agent/tools/sign-solana.mjs
```

### 4. The signing key, and the proof

```bash
set -a; . ~/.hermes/.env; set +a
node tools/sign-check.mjs
```

The first run fails and prints a `clientId`. Mint a key at `https://app.paybox.sh/agent-key?client_id=<clientId>` and save it as the only line of `$PAYBOX_CONFIG_DIR/signing-key.txt` (`chmod 600`). Never paste it into a chat. Run the check again until it prints `{"status":"ok", ...}`: it signs a test message that can never be sent and spends nothing.

Then prove the gate:

```bash
claw chat -q "Deposit 5 dollars into my MAJ portfolio."   # must end: BLOCKED ... (Wallet action: deposit ...)
```

### 5. Use it

`claw chat`, or over Telegram after `claw gateway setup` and `claw gateway run`. A thesis, a mix, a name and a ticker, a simulation, "create it". Two approvals follow: the first reserves the portfolio (nothing signed yet), the second, **"Wallet action: sign the create for deployment ..."**, is the money step. Answer **once** to each. Deposits are one approval. Up to four assets per portfolio with PayBox; four means two transactions behind one approval.

## What the tool refuses

| Answer | Meaning |
|---|---|
| `LEGACY_ONLY` | too many assets for this wallet; use four or fewer |
| `WRONG_PAYER`, `FOREIGN_PROGRAM` | not this wallet's transaction, or not a weavr program: refused on purpose |
| `WALLET_DECLINED` | PayBox did not sign; run `sign-check.mjs` |
| `CONFIG` | a missing variable, named |
| `BUSY` | another signing run holds the lock; wait ten seconds |

## Tests

```bash
npm test                     # the checks on planted violations, the tool through a fake PayBox CLI, the sign check
npm run gate-test            # the approval plugin
```

No key, network or money is involved in the tests.
