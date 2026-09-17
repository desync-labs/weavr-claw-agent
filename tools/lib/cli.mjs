/**
 * Shared command line for the two signers. Output is JSON only, one line, so
 * a text-only agent can read it; transaction bytes are printed only for
 * --tx / --file, the fallback paths.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPrograms, programsFromManifest, EXIT } from './tx-checks.mjs';
import { finishDeployment, makeDeposit, makeRefreshNav, makeWithdraw, signChecked, transactionsFromFile, weavrClient } from './weavr.mjs';
import { connectionFor, readBalances } from './balance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const USAGE = '--wallet status|create|import <keypair.json> | --address | --balance | --deployment <id> | --deposit <ticker> --amount <usd> | --withdraw <ticker> --amount <usd> | --shares all [--min-out <usd>] | --refresh-nav <ticker> | --file <walletPayload.json> [--send | --await <deploymentId>] | --tx <encoded>...';

export function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

/** The ops manifest, or a WEAVR_PROGRAM_IDS override for installs without the ops checkout. */
export function resolveAllowed(env = process.env) {
  if (env.WEAVR_PROGRAM_IDS) return allowedPrograms(env.WEAVR_PROGRAM_IDS.split(',').map((s) => s.trim()).filter(Boolean));
  // the ops checkout (four levels up) or the standalone weavr-claw-agent repo (two levels up)
  const candidates = [env.WEAVR_MANIFEST, join(HERE, '../../../../manifest.json'), join(HERE, '../../manifest.json')].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    const err = new Error('no manifest.json found; set WEAVR_MANIFEST or WEAVR_PROGRAM_IDS');
    err.code = 'CONFIG';
    throw err;
  }
  return allowedPrograms(programsFromManifest(found));
}

/**
 * `walletOps` (status/create/importFrom) manages a key file on this machine;
 * the PayBox tool passes none, its wallet lives in the PayBox app.
 */
export async function runCli(argv, makeSigner, env = process.env, { wallet: walletOps } = {}) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const vals = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] != null ? [argv[i + 1]] : []));
  const fail = (error, detail, code) => out({ error, ...(detail ? { detail } : {}) }, code);

  try {
    // Wallet lifecycle runs before a signer exists: there may be no key yet.
    if (has('--wallet')) {
      const sub = val('--wallet');
      if (sub === 'status') {
        if (walletOps) return out(walletOps.status());
        try { const s = makeSigner(); return out({ configured: true, signer: s.kind, address: s.wallet }); }
        catch (e) { return out({ configured: false, detail: String(e.message).slice(0, 200) }); }
      }
      if (!walletOps) return fail('UNSUPPORTED', 'this wallet is managed in the PayBox app; --wallet create/import apply to sign-local.mjs', EXIT.USAGE);
      if (sub === 'create') return out(walletOps.create());
      if (sub === 'import') return out(walletOps.importFrom(argv[argv.indexOf('--wallet') + 2]));
      return fail('USAGE', '--wallet status | create | import <keypair.json>', EXIT.USAGE);
    }

    const signer = makeSigner();
    if (has('--address')) return out({ address: signer.wallet });
    if (has('--balance')) {
      try {
        return out(await readBalances(signer.wallet, connectionFor(env)));
      } catch (e) {
        return fail('RPC_UNAVAILABLE', `could not read balances: ${String(e.message).slice(0, 160)}`, EXIT.FAILED);
      }
    }
    const allowed = resolveAllowed(env);
    const client = weavrClient({ mcpUrl: env.WEAVR_MCP_URL, apiUrl: env.WEAVR_API_URL });
    const finish = (r) => out(r.output ?? { signed: r.signed }, r.exit ?? 0);

    if (has('--tx')) {
      const r = await signChecked(vals('--tx'), signer, allowed);
      return r.ok ? out({ signed: r.signed }) : finish(r);
    }
    if (has('--file')) {
      const txs = transactionsFromFile(val('--file'));
      const r = await signChecked(txs, signer, allowed);
      if (!r.ok) return finish(r);
      if (has('--send')) {
        const sent = await client.mcpCall('send_signed', { signed: r.signed });
        return out({ step: 'send_signed', ...sent.payload }, sent.isError ? EXIT.WEAVR_ERROR : 0);
      }
      if (has('--await')) {
        const w = await client.mcpCall('await_portfolio', { deploymentId: val('--await'), signed: r.signed, timeoutSecs: 50 });
        const { walletPayload, ...rest } = w.payload ?? {};
        return out({ step: 'await_portfolio', ...rest }, w.isError ? EXIT.WEAVR_ERROR : 0);
      }
      return out({ signed: r.signed });
    }
    if (has('--deposit')) {
      const portfolio = val('--deposit'); const amountUsd = Number(val('--amount'));
      if (!portfolio || !(amountUsd > 0)) return fail('USAGE', '--deposit <ticker> --amount <usd>', EXIT.USAGE);
      return finish(await makeDeposit(client, portfolio, amountUsd, signer, allowed));
    }
    if (has('--withdraw')) {
      const portfolio = val('--withdraw'); const shares = val('--shares'); const amount = val('--amount'); const minOut = val('--min-out');
      if (!portfolio || (shares == null && amount == null) || (shares != null && amount != null)) {
        return fail('USAGE', '--withdraw <ticker> --amount <usd>  (or --shares all)', EXIT.USAGE);
      }
      if (amount != null && !(Number(amount) > 0)) return fail('USAGE', '--withdraw <ticker> --amount <usd>', EXIT.USAGE);
      if (minOut !== undefined && !(Number(minOut) >= 0)) return fail('USAGE', '--min-out <usd>', EXIT.USAGE);
      return finish(await makeWithdraw(client, portfolio, shares, signer, allowed, {
        ...(amount != null ? { amountUsd: amount } : {}),
        ...(minOut !== undefined ? { minAmountOut: minOut } : {}),
        connection: connectionFor(env),
      }));
    }
    if (has('--refresh-nav')) {
      const portfolio = val('--refresh-nav');
      if (!portfolio) return fail('USAGE', '--refresh-nav <ticker>', EXIT.USAGE);
      return finish(await makeRefreshNav(client, portfolio, signer, allowed));
    }
    if (has('--deployment')) {
      const id = val('--deployment');
      if (!id) return fail('USAGE', '--deployment <deploymentId>', EXIT.USAGE);
      return finish(await finishDeployment(client, id, signer, allowed));
    }
    return fail('USAGE', USAGE, EXIT.USAGE);
  } catch (e) {
    const code = e.code === 'CONFIG' ? EXIT.CONFIG : e.code === 'BUSY' ? EXIT.BUSY : e.code === 'WALLET_DECLINED' ? EXIT.WALLET_DECLINED : EXIT.FAILED;
    return fail(e.code && EXIT[e.code] !== undefined ? e.code : 'FAILED', String(e.message).slice(0, 200), code);
  }
}
