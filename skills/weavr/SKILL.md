---
name: weavr
description: Create and manage onchain portfolios from a thesis.
version: 0.1.0
author: weavr
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [weavr, portfolio, solana, defi, mcp]
    requires_toolsets: [terminal]
    category: finance
    required_environment_variables:
      - { name: PAYBOX_CONFIG_DIR, optional: true, required_for: signing with PayBox }
      - { name: PAYBOX_CREDENTIAL_ID, optional: true, required_for: signing with PayBox }
      - { name: PAYBOX_CLI, optional: true, required_for: signing with PayBox }
      - { name: WEAVR_SIGN_TOOL, optional: true, required_for: signing with PayBox }
---

# weavr

Weavr creates onchain portfolios from a thesis. The weavr MCP server is attached to this agent; this host exposes its tools as `mcp__weavr__<name>` (for example `mcp__weavr__list_assets`), and the names below are the bare ones. The wallet is a separate command-line tool run with the terminal tool (see Wallet); without one, the user signs through a link (see Sign link). Say asset, portfolio, thesis, rebalance, deposit, shares, agent and onchain.

## When to use
The user wants to create a portfolio, deposit into one, check one, or rebalance one.

## Procedure
Flow: the user types a thesis → list_assets (never before they have typed one) → suggest_mix if they ask for a recommendation → wallet check (see step 2) → ask for a name, a ticker and any rules → simulate_portfolio with the wallet's address as `creator` → show the result → create_portfolio once they confirm → hand the result to the wallet tool, or send the sign link → the portfolio goes live.

1. Never invent a name or ticker; use theirs exactly as typed.
2. Wallet first. Before the first action that needs a wallet (a create, deposit, withdrawal or valuation refresh), run `node $WEAVR_SIGN_TOOL --wallet status`.
   - `configured: true`: use that wallet. Its `address` is the creator, depositor or payer; pass it as `creator` to simulate_portfolio and create_portfolio. Never ask the user for an address.
   - `configured: false`: no wallet has been chosen yet. Ask the user which they want, in plain words, and wait for the answer: (a) **a new agent wallet on this machine** — you create it with `node $WEAVR_SIGN_TOOL --wallet create`; they fund its address; you sign every action for them, each one after their approval; (b) **their own wallet** — creates go through a sign link they open in Phantom or another wallet (see Sign link), and deposits and withdrawals are then done on the portfolio's page on weavr.sh, not in chat; (c) **a Solana keypair file they already have on this machine** — `node $WEAVR_SIGN_TOOL --wallet import <path>`, path only. Never ask for, accept or print a private key or seed phrase in chat; if they paste one, tell them to consider it compromised and move the funds.
   - If `WEAVR_SIGN_TOOL` is not set on this host there is no wallet tool at all: only option (b) exists (see Sign link).
2b. Funding. Right after a wallet is created or imported, and before every create, deposit, withdrawal or valuation refresh, run `node $WEAVR_SIGN_TOOL --balance` and tell the user the address and what it holds. The rules, from the tool's output: SOL pays network fees only — a create needs at least `minSol.create` SOL in the wallet (about 0.08 of it is spent; simulate_portfolio prints the exact cost), any other action needs at least `minSol.action` SOL; deposits are paid in USDC on Solana, so a deposit of $X needs at least X USDC in the wallet, plus the SOL above. If the wallet is short, say exactly what to send and to which address (for example "send at least 0.15 SOL to <address>"; for a deposit also the USDC), then stop. Continue only after they say it is funded, and run `--balance` again first: do not take their word for it. A wallet that already has enough needs no more than one line about it.
3. With the wallet tool, keep create_portfolio to 4 assets or fewer on this host (see Limits). Two or three assets are one signature; four are two, which the wallet tool handles in one run. A sign link has no such limit.
4. After create_portfolio returns a `deploymentId` in wallet-tool mode, run `node $WEAVR_SIGN_TOOL --deployment <deploymentId>` with the terminal tool. It signs and waits; its output is the portfolio status. When it prints `"status":"live"`, tell the user the portfolio is live and give the `url`. Do not call await_portfolio yourself. In link mode the wallet tool is not run at all.
5. Deposits: run `node $WEAVR_SIGN_TOOL --deposit <ticker> --amount <usd>`. It builds, signs and sends; report what it prints. Do not call build_deposit or send_signed yourself. Without a wallet tool, deposits are made on the portfolio's page on weavr.sh.
5b. Withdrawals are in dollars, same as deposits. Run `node $WEAVR_SIGN_TOOL --withdraw <ticker> --amount <usd>`. The tool converts at the live price; never mention share counts, on-chain units, or a minimum share floor unless they ask. If they want everything, or the leftover would be too small to exit later, the tool takes the whole position — say so in dollars (`fullExit: true`). `BELOW_MINIMUM` means the dollar amount is smaller than the vault will accept right now (about $0.001); tell them that figure, not a share count. `--shares all` is only for "withdraw everything" if they said that. It builds, signs and sends the request; report what it prints. The request joins the exit queue and is paid in order (list_withdrawals shows its place; legs on another chain take longer). Do not call build_withdraw or send_signed yourself.
5c. Valuation refresh (what users call a crank): keepers refresh live portfolios on their own, so this is rarely needed. If the user asks to crank or refresh a portfolio, run `node $WEAVR_SIGN_TOOL --refresh-nav <ticker>`; the wallet pays the network fee. Do not call build_refresh_nav yourself.
6. Never print walletPayload, never ask whether they signed, and never ask them to check again. Wallets sign but do not send: the wallet tool passes what it signed to weavr, which sends it and watches the chain.
7. Reads (get_portfolio, list_portfolios, get_asset, the histories, simulate_rebalance) need no wallet.

Fees: 0.40% round trip (0.20% in, 0.20% out), 60% of the fee stream to the creator, no management fee, 5% idle, 2% rebalance band. Amounts are in USD; percents are percents.

## Wallet
The wallet is the command `node $WEAVR_SIGN_TOOL ...`, run with the terminal tool only (never with code execution, which strips the variables it needs). It reads its own keys from files; you never see or handle them. Run it as one plain command, exactly `node $WEAVR_SIGN_TOOL --address` and so on: never wrap it in `if`, `&&`, `;`, `$(...)` or a subshell, and never add echo or checks around it. Compound commands trip the host's security scanner and the user gets a scary prompt for a harmless read; the tool's own JSON already reports every error.

- `--wallet status` → `{"configured": true, "address": ...}` or `{"configured": false, ...}`: whether a wallet has been chosen on this machine. Read-only.
- `--wallet create` → `{"created": true, "address": ...}`: a new agent wallet; refuses if one exists. `--wallet import <path>` → `{"imported": true, "address": ...}` from a 64-byte JSON keypair file the user already has here.
- `--balance` → `{"address", "sol", "usdc", "minSol": {"create", "action"}, "ok": {"create", "action"}}`: what the wallet holds and the minimums. Read-only, no approval.
- `--address` → `{"address": "..."}`: the creator or depositor address to pass to weavr.
- `--deployment <deploymentId>` → signs the create and waits until it is live; prints `{"status":"live","mint":...,"url":...}` or an error.
- `--deposit <ticker> --amount <usd>` → builds, signs and sends a deposit; prints `{"status":"confirmed",...}` or an error.
- `--withdraw <ticker> --amount <usd>` → builds, signs and sends a withdrawal request in dollars; prints `{"status":"confirmed","amountUsd":...,"fullExit":...}` or an error. `BELOW_MINIMUM` is a dollar floor. `--shares all` exits the whole position.
- `--refresh-nav <ticker>` → builds, signs and sends a valuation refresh paid by the wallet; prints `{"status":"confirmed",...}` or an error.

It refuses transactions it should not sign. Its errors mean: `LEGACY_ONLY` = too many assets for this wallet (use 4 or fewer and try again, or send a sign link); `WALLET_DECLINED` = the wallet did not sign, tell the user and stop; `FOREIGN_PROGRAM` or `WRONG_PAYER` = the transaction was not for this user, stop and tell the user; `BUSY` = another signing run is in progress, wait a moment and run the same command once more.

## Sign link
When this host has no wallet tool, or the user chose their own wallet (step 2, option b), the user signs in their own wallet on a page weavr hosts. create_portfolio with `wallet: "link"` (and no creator) answers `awaiting_wallet` with a `signUrl`. Send the link to the user once, in a private chat; say that it shows the portfolio before anything is signed and that it closes after 30 minutes. Whoever opens it, connects a wallet and signs pays the network cost and becomes the creator. Then call await_portfolio with only the deploymentId: `awaiting_wallet` means they have not signed yet (say so and stop; call again when they say they have), `finishing` means weavr is finishing the setup (call again), `live` is done (give the `url`), `expired` means nobody signed in time (offer to create again). Never paste the link twice and never ask whether they signed.

## Pitfalls
- `sign_again` from the wallet tool means the transaction expired before it was signed; run the same `--deployment` command once more.
- `OPERATOR_BUSY` or `AWAIT_IN_PROGRESS` from weavr: wait a moment and run the same command once more.
- `INSUFFICIENT_SOL`: the wallet needs more SOL for the network cost; tell the user the amount and the address, and stop. It should not happen if `--balance` was checked first.
- `CONFIG` with "no wallet at ...": no wallet has been chosen yet; go back to step 2.
- `RPC_UNAVAILABLE` from `--balance`: the balance could not be read right now; say so and try once more before going on.
- `BELOW_MINIMUM` from `--withdraw`: the dollar amount is smaller than the vault will accept at this price (about $0.001). Tell them that figure; do not convert it to shares.
- Only act in a private chat with the wallet's owner. In a group, explain that portfolio actions are private.
- Send a sign link only in a private chat with the wallet's owner; never post one in a group.

## Limits on this host
- The wallet tool signs portfolios with up to 4 assets. If the user wants more, use a sign link: browser wallets are not bound by that limit.
- One signature per create up to three assets, two at four; deposits are one signature each.

## Verification
The create is done when the wallet tool prints `"status":"live"` with a `url`, or when await_portfolio over a sign link answers `live`. A deposit, a withdrawal request or a valuation refresh is done when the wallet tool prints `"status":"confirmed"`.
