#!/usr/bin/env node
/**
 * sign-solana.mjs — the wallet tool for a text-only agent (Claw Agent / Hermes).
 *
 * Signs weavr transactions with the PayBox CLI using a signing key that lives
 * in a file, never in the chat. The agent never sees or copies transaction
 * bytes: this tool fetches them, checks them, signs them and hands the result
 * straight back to weavr.
 *
 *   --address                              → {"address": "..."}
 *   --deployment <deploymentId>            → rebuild → check → sign → await_portfolio → {"status": "live", ...}
 *   --deposit <ticker> --amount <usd>      → build_deposit → check → sign → send_signed → {"status": "confirmed", ...}
 *   --file <walletPayload.json> [--send | --await <deploymentId>]
 *   --tx <encoded> [--tx ...]              → {"signed": [...]}   (fallback; prints signed bytes)
 *
 * Refusals, before anything is signed: v0 transactions (exit 2 LEGACY_ONLY —
 * PayBox decodes legacy only), fee payer ≠ wallet or an instruction outside the
 * weavr programs of manifest.json plus the core programs (exit 4), a PayBox
 * status without a signature (exit 3 WALLET_DECLINED), a concurrent run (exit
 * 6 BUSY). See ../../../runbooks/CLAW_AGENT.md.
 *
 * Environment: PAYBOX_CONFIG_DIR, PAYBOX_CREDENTIAL_ID, PAYBOX_CLI (path to the
 * SDK's dist/cli.js); optional PAYBOX_SIGNING_KEY_FILE (default
 * $PAYBOX_CONFIG_DIR/signing-key.txt), WEAVR_MCP_URL, WEAVR_API_URL,
 * WEAVR_MANIFEST or WEAVR_PROGRAM_IDS.
 */
import { runCli } from './lib/cli.mjs';
import { payboxSigner } from './lib/paybox-signer.mjs';

runCli(process.argv.slice(2), () => payboxSigner());
