#!/usr/bin/env node
/**
 * sign-local.mjs — the bisecting control for sign-solana.mjs: same commands,
 * same checks, same weavr flows, but a local keypair file signs (legacy and
 * v0). Dust wallets only. SIGN_LOCAL_KEYPAIR_FILE points at a 64-byte JSON
 * keypair under the key dir; the path, never the key, is in the environment.
 */
import { runCli } from './lib/cli.mjs';
import { localSigner } from './lib/local-signer.mjs';

runCli(process.argv.slice(2), () => localSigner());
