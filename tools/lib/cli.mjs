/**
 * Shared command line for the two signers. Output is JSON only, one line, so
 * a text-only agent can read it; transaction bytes are printed only for
 * --tx / --file, the fallback paths.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPrograms, programsFromManifest, EXIT } from './tx-checks.mjs';
import { finishDeployment, makeDeposit, signChecked, transactionsFromFile, weavrClient } from './weavr.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const USAGE = '--address | --deployment <id> | --deposit <ticker> --amount <usd> | --file <walletPayload.json> [--send | --await <deploymentId>] | --tx <encoded>...';

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

export async function runCli(argv, makeSigner, env = process.env) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const vals = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] != null ? [argv[i + 1]] : []));
  const fail = (error, detail, code) => out({ error, ...(detail ? { detail } : {}) }, code);

  try {
    const signer = makeSigner();
    if (has('--address')) return out({ address: signer.wallet });
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
