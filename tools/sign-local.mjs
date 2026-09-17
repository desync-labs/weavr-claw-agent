#!/usr/bin/env node
/**
 * sign-local.mjs — the wallet tool with a keypair file on this machine: same
 * commands, same checks and same weavr flows as sign-solana.mjs, plus the
 * wallet's lifecycle (`--wallet status|create|import <keypair.json>`) and a
 * read-only `--balance`. Dust wallets only: the key is a plain 0600 file.
 * SIGN_LOCAL_KEYPAIR_FILE points at it; the path, never the key, is in the
 * environment. Also the bisecting control for the PayBox signer (it signs
 * legacy and v0).
 */
import { runCli } from './lib/cli.mjs';
import { localSigner } from './lib/local-signer.mjs';
import { localWalletOps } from './lib/local-wallet.mjs';

runCli(process.argv.slice(2), () => localSigner(), process.env, { wallet: localWalletOps() });
