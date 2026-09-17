#!/usr/bin/env node
/**
 * sign-solana.mjs: an alias of sign.mjs that forces the PayBox wallet. Same
 * commands, same checks, same weavr flows, same output; it calls the same entry
 * with `--wallet paybox` prepended, so WEAVR_WALLET and inference do not apply
 * and a contrary `--wallet <mode>` on its command line is a CONFIG refusal. The
 * PayBox CLI decodes legacy transactions only, so a v0 transaction is refused
 * here (exit 2 LEGACY_ONLY) where sign-local.mjs signs it; `--wallet create`
 * and `--wallet import` are UNSUPPORTED here, the PayBox wallet lives in the
 * PayBox app. See sign.mjs for the commands and the environment.
 */
import { runCli } from './lib/cli.mjs';

runCli(['--wallet', 'paybox', ...process.argv.slice(2)]);
