#!/usr/bin/env node
/**
 * sign-local.mjs: an alias of sign.mjs that forces the local wallet, a
 * dedicated keypair file that lives on this box (SIGN_LOCAL_KEYPAIR_FILE, a
 * 64-byte JSON array; the path, never the key, is in the environment). Same
 * commands, same checks, same weavr flows, same output; it calls the same entry
 * with `--wallet local` prepended, so WEAVR_WALLET and inference do not apply
 * and a contrary `--wallet` on its command line is a CONFIG refusal. See
 * sign.mjs for the commands and the environment.
 */
import { runCli } from './lib/cli.mjs';

runCli(['--wallet', 'local', ...process.argv.slice(2)]);
