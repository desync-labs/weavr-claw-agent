#!/usr/bin/env node
/**
 * weavr-curator: init, doctor, ops. This file parses the command line and
 * wires the real dependencies (fetch, JSON-RPC, the file system, the clock,
 * readline, docker); every check and step lives in lib/curator/*.mjs behind
 * injected seams so the tests run on fakes.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DOCTOR_BOOLEANS, INIT_BOOLEANS, OPS_BOOLEANS, USAGE_TEXT, parseArgs } from '../lib/curator/args.mjs';
import { homePaths, readEnvFile, resolveHome } from '../lib/curator/home.mjs';
import { PUBLIC_RPC, jsonRpc } from '../lib/curator/chain.mjs';
import { init } from '../lib/curator/init.mjs';
import { doctor } from '../lib/curator/doctor.mjs';
import { ops } from '../lib/curator/ops.mjs';

const [command, ...rest] = process.argv.slice(2);
const print = (text) => process.stdout.write(text);

if (!command || ['--help', '-h', 'help'].includes(command)) {
  print(USAGE_TEXT);
  process.exit(0);
}

const fail = (message, code = 1) => {
  process.stderr.write(`weavr-curator: ${message}\n`);
  process.exit(code);
};

const emitJson = (result) => {
  print(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.exit);
};

try {
  if (command === 'init') {
    const { opts } = parseArgs(rest, { booleans: INIT_BOOLEANS });
    const rpcUrl = opts.rpc ?? process.env.SOLANA_RPC_URL ?? PUBLIC_RPC;
    // --json owns stdout: no prompt is ever written before the one object it prints.
    const interactive = Boolean(stdin.isTTY && stdout.isTTY) && opts.json !== true;
    const prompt = interactive
      ? async (question) => {
        const rl = createInterface({ input: stdin, output: stdout });
        try { return await rl.question(question); } finally { rl.close(); }
      }
      : null;
    const result = await init({
      portfolio: opts.portfolio,
      home: opts.home,
      policy: opts.policy,
      api: opts.api,
      mcp: opts.mcp,
      rpc: opts.rpc,
      transferWallet: opts['transfer-wallet'],
      wait: opts.wait === true,
      waitSecs: opts['wait-secs'],
      yes: opts.yes === true,
      json: opts.json === true,
    }, { rpc: jsonRpc(rpcUrl), prompt, interactive });
    if (opts.json) emitJson(result);
    process.exit(result.exit);
  } else if (command === 'doctor') {
    const { opts } = parseArgs(rest, { booleans: DOCTOR_BOOLEANS });
    const home = resolveHome(opts.home);
    const fromSigner = readEnvFile(homePaths(home).signerEnv).values.SOLANA_RPC_URL;
    const rpcUrl = opts.rpc ?? process.env.SOLANA_RPC_URL ?? (fromSigner && fromSigner.trim()) ?? PUBLIC_RPC;
    const result = await doctor({ home, signerUrl: opts['signer-url'], json: opts.json === true }, { rpc: jsonRpc(rpcUrl) });
    if (opts.json) emitJson(result);
    process.exit(result.exit);
  } else if (command === 'ops') {
    const { opts, positional } = parseArgs(rest, { booleans: OPS_BOOLEANS });
    const [verb] = positional;
    const home = opts.token === undefined ? resolveHome(opts.home) : null;
    await ops(verb, opts, { home });
    process.exit(0);
  } else {
    print(USAGE_TEXT);
    fail(`unknown command ${JSON.stringify(command)}`);
  }
} catch (e) {
  if (e.code === 'USAGE') {
    process.stderr.write(`weavr-curator: ${e.message}\n\n${USAGE_TEXT}`);
    process.exit(1);
  }
  fail(String(e.message ?? e).slice(0, 300));
}
