#!/usr/bin/env node
/**
 * sign-local.mjs: an alias of sign.mjs that forces the local wallet, a
 * dedicated keypair file that lives on this box (SIGN_LOCAL_KEYPAIR_FILE, a
 * 64-byte JSON array; the path, never the key, is in the environment). Same
 * commands, same checks, same weavr flows, same output; it calls the same entry
 * with `--wallet local` prepended, so WEAVR_WALLET and inference do not apply
 * and a contrary `--wallet <mode>` on its command line is a CONFIG refusal.
 * The wallet's lifecycle (`--wallet status|create|import <keypair.json>`) and
 * the read-only `--balance` work here as in sign.mjs. A local key signs v0 as
 * well as legacy transactions, where sign-solana.mjs refuses v0 (LEGACY_ONLY);
 * today the hosted API builds every wallet-tool create as legacy, four assets
 * at most, so that matters for --file and --tx and for the day the API opens
 * v0 creates per host; the key is a plain 0600 file the
 * agent's shell can read, so keep on that wallet only what it needs. See
 * sign.mjs for the commands and the environment.
 */
import { runCli } from './lib/cli.mjs';

runCli(['--wallet', 'local', ...process.argv.slice(2)]);
