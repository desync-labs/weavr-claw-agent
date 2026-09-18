# weavr for the Claw Agent

The pieces a self-hosted [Claw Agent](https://github.com/Clawpump/claw-agent) (ClawPump's agent, built on Hermes) needs to create and manage [weavr](https://www.weavr.sh) portfolios from a thesis. weavr creates the portfolio from the thesis; the agent needs a wallet only to create it and to deposit, and there are three ways to sign: the sign link, with no setup, where the owner signs in a browser; the wallet tool with the PayBox CLI, a real wallet a human approves and a key that stays off the box; or the wallet tool with a local keypair file, a dedicated small key on the box.

weavr itself is an MCP server at `https://api.weavr.sh/mcp`. Reads and simulations need nothing from this repo. Creating a portfolio and depositing need a wallet, and that is what is here, plus an autonomous curator for a portfolio you already created (the section near the end).

| Path | What |
|---|---|
| `tools/sign.mjs` | the wallet tool: `--wallet paybox\|local\|link` picks the wallet (else `WEAVR_WALLET`, else what is configured); `--wallet status\|create\|import <keypair.json>` is the local wallet's lifecycle, so the agent can offer the user a new wallet or take an existing one; then `--address`, `--balance`, `--deployment <id>`, `--deposit <ticker> --amount <usd>`, `--withdraw <ticker> --amount <usd>`, `--refresh-nav <ticker>`; signs weavr transactions with PayBox or a local key, or in link mode only watches a deployment the owner signs in a browser |
| `tools/sign-solana.mjs` | an alias of `sign.mjs` that forces `--wallet paybox` |
| `tools/sign-local.mjs` | an alias of `sign.mjs` that forces `--wallet local` (small amounts only: the key is a plain file on this machine) |
| `tools/sign-check.mjs` | a zero-cost check that the wallet can sign, `--wallet` as above; with PayBox it also proves the key, the grant and the client agree and prints the PayBox client id |
| `tools/lib/` | the checks (fee payer must be your wallet, every instruction inside weavr's programs), the weavr flows, the signers, the local wallet's lifecycle, balances |
| `skills/weavr/SKILL.md` | the skill for this host: wallet first (choose or create), balance and funding rules before every money step, then the flows; a superset of `https://api.weavr.sh/hosts/hermes/SKILL.md` |
| `plugins/weavr-wallet-gate/` | a Hermes plugin: every signing run becomes an approval you answer, with a message naming the action and the amount |
| `plugins/weavr-curator/` | a Hermes plugin for the curator: the `weavr_curator` tool, its approval gate and the `/weavr-curator` command; an HTTP client of the signer that never sees a key |
| `curator/` | the autonomous curator: the Hermes profile, the policy presets and the compose stack; `curator/README.md` is its page |
| `patches/` | a one-line fix for Claw Agent releases whose trust gate asks before read-only tools too |
| `manifest.json` | weavr's onchain programs, the allowlist the wallet tool signs for |
| `config.yaml`, `env.example` | the Hermes config block and the environment names |

## Setup

You need a Claw Agent install with a model provider configured and Node.js 20 or newer. A wallet is needed only to create and to deposit; step 3 gives you three ways to sign, and the sign link needs no account and no key on this box. `claw` and `hermes` are the same command.

### 1. Add weavr to the agent

```bash
claw mcp add weavr --url https://api.weavr.sh/mcp      # lists 30 tools, asks to enable them: Y
```

In `~/.hermes/config.yaml`, make the weavr entry match the one in `config.yaml` here (`trust: untrusted`, `resources: false`, `prompts: false`, `exclude: [portfolio_status]`). Check:

```bash
claw mcp test weavr                                     # Connected, 30 tools
```

### 2. This repo

The wallet tool, the approval plugin and this host's skill:

```bash
git clone https://github.com/desync-labs/weavr-claw-agent ~/weavr-wallet/tools/claw-agent
cd ~/weavr-wallet/tools/claw-agent && npm i
mkdir -p ~/.hermes/plugins && cp -r plugins/weavr-wallet-gate ~/.hermes/plugins/ && claw plugins enable weavr-wallet-gate
mkdir -p ~/.hermes/skills/weavr
cp skills/weavr/SKILL.md ~/.hermes/skills/weavr/SKILL.md   # this repo's copy: wallet choice + funding rules (the served one lacks them)
```

### 3. A wallet: PayBox, a local key, or the sign link

Pick one. PayBox is the default for a real wallet: the key is off the box and you approve each signature. A local key is for a dedicated wallet that lives on the box (an autonomous curator, or a small creator wallet). The sign link is for a host with no signer at all: the owner signs in a browser.

**PayBox**

```bash
mkdir -p ~/weavr-wallet/tools && cd ~/weavr-wallet/tools && npm i @paybox-sh/sdk@0.8.5
export PAYBOX_CONFIG_DIR=~/weavr-wallet/paybox PAYBOX_CLI=$PWD/node_modules/@paybox-sh/sdk/dist/cli.js
mkdir -p -m 700 "$PAYBOX_CONFIG_DIR"
node "$PAYBOX_CLI" login --no-provision                 # open the printed URL on your phone, approve with your passkey
node "$PAYBOX_CLI" --json credentials                   # the id of the wallet the agent will use
```

In the PayBox app, on the **Clients** screen, give this client **Full Access** to that one wallet and nothing else. Set `WEAVR_WALLET=paybox`.

**A local key**

A dedicated keypair file that lives on this machine, in a `0600` file under a `0700` directory outside the repo. The tool makes it: only the public key is printed, the path (never the key) goes in the environment, and an existing file is never overwritten. Or leave the file for the agent: with `SIGN_LOCAL_KEYPAIR_FILE` set and no file there, the agent asks in chat whether you want a new wallet or your own, runs `--wallet create` for you, and tells you the address, that a create needs about 0.15 SOL there, and that deposits need USDC. The key is a plain file the agent's shell can read, so keep on that wallet only what you would accept losing. Through the wallet tool a portfolio has up to four assets on the hosted API today, whichever wallet signs: weavr builds wallet-tool creates as legacy transactions (its legacy-only create mode), and a local key, which also signs v0, is ready for larger books once that mode is opened per host. The sign link has no such limit. The tool refuses a key file readable by group or others, or one that is not a 64-byte JSON array (a base58 export from a browser wallet is not accepted; `--wallet import <keypair.json>` takes a Solana CLI keypair file you already have here).

```bash
mkdir -p -m 700 ~/weavr-wallet/keys
export SIGN_LOCAL_KEYPAIR_FILE=~/weavr-wallet/keys/agent.json WEAVR_WALLET=local
cd ~/weavr-wallet/tools/claw-agent
node tools/sign.mjs --wallet create                     # prints the address, nothing else; refuses if a key is already there
node tools/sign.mjs --balance                           # what it holds, and the SOL a create or an action needs
```

**The sign link**

No wallet on this host. Set `WEAVR_WALLET=link`, or set no `WEAVR_SIGN_TOOL` at all: the skill calls `create_portfolio` with wallet `link` and no creator, sends the sign link to the owner in a private chat, and waits with `await_portfolio` until the portfolio is live. Deposits are made on the portfolio's page. `sign-check.mjs` answers `NO_WALLET` here; there is nothing to prove.

Add to `~/.hermes/.env` (`chmod 600`), with your paths:

```
WEAVR_WALLET=paybox                                    # or local, or link
PAYBOX_CONFIG_DIR=/home/you/weavr-wallet/paybox
PAYBOX_CREDENTIAL_ID=<wallet credential id>
PAYBOX_CLI=/home/you/weavr-wallet/tools/node_modules/@paybox-sh/sdk/dist/cli.js
SIGN_LOCAL_KEYPAIR_FILE=                               # local only: the keypair file's path
WEAVR_SIGN_TOOL=/home/you/weavr-wallet/tools/claw-agent/tools/sign.mjs
```

### 4. The proof

```bash
set -a; . ~/.hermes/.env; set +a
node tools/sign-check.mjs
```

The check signs a test message that can never be sent and spends nothing. What it prints depends on the wallet:

- **PayBox.** The first run fails and prints a `clientId`. Mint a key at `https://app.paybox.sh/agent-key?client_id=<clientId>` and save it as the only line of `$PAYBOX_CONFIG_DIR/signing-key.txt` (`chmod 600`). Never paste it into a chat. Run the check again until it prints `{"status":"ok", ...}`: the key, the grant and the client agree.
- **A local key.** It prints `{"status":"ok", ..., "signer":"local"}` on the first run, or a `CONFIG` line naming what is wrong with the file (never the file's contents).
- **The sign link.** It prints `{"status":"failed","error":"NO_WALLET", ...}` and exits 9: this host has no signing wallet and there is nothing to prove.

Then prove the gate:

```bash
claw chat -q "Deposit 5 dollars into my MAJ portfolio."   # must end: BLOCKED ... (Wallet action: deposit ...)
```

### 5. Use it

`claw chat`, or over Telegram after `claw gateway setup` and `claw gateway run`. A thesis, a mix, a name and a ticker, a simulation, "create it". With PayBox or a local key two approvals follow: the first reserves the portfolio (nothing signed yet), the second, **"Wallet action: sign the create for deployment ..."**, is the money step. Answer **once** to each. Deposits are one approval. With the sign link there is no wallet approval on this host: the agent sends you the link in a private chat, you sign in the browser, and deposits are made on the portfolio's page. The four-asset ceiling is the hosted API's for every wallet-tool create today: it builds them as legacy transactions, which is what PayBox needs (four assets means two transactions behind one approval). The sign link has no such limit.

## What the tool refuses

| Answer | Meaning |
|---|---|
| `LEGACY_ONLY` | PayBox only: too many assets for a legacy transaction; use four or fewer, or a local key or the sign link |
| `WRONG_PAYER`, `FOREIGN_PROGRAM` | not this wallet's transaction, or not a weavr program: refused on purpose |
| `WALLET_DECLINED` | PayBox did not sign; run `sign-check.mjs` |
| `CONFIG` | a missing variable, named; an unknown `--wallet` / `WEAVR_WALLET` value; or a local key file that cannot be read, is readable by group or others, or is not a 64-byte JSON array (the file is never quoted) |
| `BUSY` | another signing run holds the lock; wait ten seconds |
| `NO_WALLET` (exit 9) | link mode: this host has no signing wallet. Create with wallet `link` and no creator, send the owner the sign link, then `await_portfolio` with the deploymentId; deposits are made on the portfolio's page |

## The autonomous curator

Everything above is the creator's side: a wallet, a thesis, a portfolio. `curator/README.md` is the other side: an agent that curates one portfolio you created, on your own host, and never holds a key. The signer image is built from the weavr backend `dest` branch (`main` and `demo` have no curator package). The curator key lives in a separate signer process that refuses under a policy document and builds, verifies, signs, sends and journals every write itself; the agent is that signer's HTTP client, and the policy document is the only place a threshold lives. Three commands run it. `weavr-curator init` generates the curator key, hands curation of your portfolio over to it, takes a policy preset (`--policy standard|rehearsal`, standard by default) and renders the agent's home directory and both env files. `weavr-curator doctor` checks the key file, the tokens, the images, the policy against the portfolio's live legs and onchain notice, and once the stack is up the signer and its invariants, without touching chain state. `weavr-curator ops` is the operator's side of the signer, with the token the agent never holds: resume, unlock, request a review, rotate the curator.

## Tests

```bash
npm test                     # the checks on planted violations, the tool through a fake PayBox CLI and a throwaway local key, the sign check, the three wallet modes, the curator profile and its no-thresholds-in-prose gate
npm run gate-test            # the approval plugin
npm run curator-test         # the curator suites alone
python3 plugins/weavr-curator/test_plugin.py   # the curator plugin
```

No key, network or money is involved in the tests.
