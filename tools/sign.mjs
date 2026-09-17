#!/usr/bin/env node
/**
 * sign.mjs: the wallet tool for a text-only agent (Claw Agent / Hermes).
 *
 * One tool, three wallets. `--wallet paybox|local|link` picks the wallet, else
 * WEAVR_WALLET, else what is configured: local when SIGN_LOCAL_KEYPAIR_FILE is
 * set, paybox when any PAYBOX_* variable is set (a missing one is then CONFIG,
 * named), link when nothing is configured. The agent never sees or
 * copies transaction bytes: this tool fetches them, checks them, signs them
 * and hands the result straight back to weavr. Every answer is one JSON line
 * carrying `wallet: <mode>`.
 *
 *   paybox  the PayBox CLI signs with a signing key that lives in a file; the
 *           key is off the box and a human approves each signature
 *   local   a dedicated keypair file on this box signs (legacy and v0); the
 *           path, never the key, is in the environment
 *   link    this host has no signer: create_portfolio is called with wallet
 *           "link", the owner signs from the signUrl in a browser, and this
 *           tool only watches the deployment (--deployment); everything else
 *           answers NO_WALLET (exit 9)
 *
 *   --wallet status                        -> {"configured": true|false, "signer": "...", "address": "..."}   (read-only)
 *   --wallet create                        -> {"created": true, "address": "..."}   (local: a new key at SIGN_LOCAL_KEYPAIR_FILE, never overwrites)
 *   --wallet import <keypair.json>         -> {"imported": true, "address": "..."}  (local: copies a 64-byte JSON keypair into place)
 *   --address                              -> {"address": "...", "wallet": "..."}
 *   --balance                              -> {"address", "sol", "usdc", "minSol", "ok"}   (read-only, over SOLANA_RPC_URL)
 *   --deployment <deploymentId>            -> rebuild -> check -> sign -> await_portfolio -> {"status": "live", ...}
 *                                             (link: await_portfolio only, nothing rebuilt or signed)
 *   --deposit <ticker> --amount <usd>      -> build_deposit -> check -> sign -> send_signed -> {"status": "confirmed", ...}
 *   --withdraw <ticker> --amount <usd>     -> build_withdraw -> check -> sign -> send_signed -> {"status": "confirmed", ...}
 *                                             (or --shares all; a dollar request is sized at the live price)
 *   --refresh-nav <ticker>                 -> build_refresh_nav -> check -> sign -> send_signed (the wallet pays the fee)
 *   --file <walletPayload.json> [--send | --await <deploymentId>]
 *   --tx <encoded> [--tx ...]              -> {"signed": [...]}   (fallback; prints signed bytes)
 *
 * Refusals, before anything is signed: a v0 transaction in paybox mode (exit 2
 * LEGACY_ONLY: the PayBox CLI decodes legacy only; a local key signs v0 as well
 * as legacy, and link mode signs nothing), fee payer not the wallet or an
 * instruction outside the weavr programs of manifest.json plus the core
 * programs (exit 4), a PayBox status without a signature (exit 3
 * WALLET_DECLINED), a missing or unknown setting (exit 5 CONFIG), a concurrent
 * run (exit 6 BUSY), no wallet on this host (exit 9 NO_WALLET). The lifecycle
 * verbs and --balance move no money and are not gated by the approval plugin.
 *
 * Environment: WEAVR_WALLET; for paybox PAYBOX_CONFIG_DIR, PAYBOX_CREDENTIAL_ID,
 * PAYBOX_CLI (path to the SDK's dist/cli.js) and optional
 * PAYBOX_SIGNING_KEY_FILE (default $PAYBOX_CONFIG_DIR/signing-key.txt); for
 * local SIGN_LOCAL_KEYPAIR_FILE; for all WEAVR_MCP_URL, WEAVR_API_URL,
 * WEAVR_MANIFEST or WEAVR_PROGRAM_IDS. sign-solana.mjs and sign-local.mjs are
 * aliases of this tool that force paybox and local.
 */
import { runCli } from './lib/cli.mjs';

runCli(process.argv.slice(2));
