#!/usr/bin/env node
/**
 * sign-solana.mjs: an alias of sign.mjs that forces the PayBox wallet. Same
 * commands, same checks, same weavr flows, same output; it calls the same entry
 * with `--wallet paybox` prepended, so WEAVR_WALLET and inference do not apply
 * and a contrary `--wallet` on its command line is a CONFIG refusal. See
 * sign.mjs for the commands and the environment.
 */
import { runCli } from './lib/cli.mjs';

runCli(['--wallet', 'paybox', ...process.argv.slice(2)]);
