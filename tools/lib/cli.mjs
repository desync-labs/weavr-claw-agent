/**
 * Shared command line for the wallet tool. Output is JSON only, one line, so
 * a text-only agent can read it; transaction bytes are printed only for
 * --tx / --file, the fallback paths. The wallet mode (paybox, local, link)
 * is resolved first, from `--wallet <x>`, WEAVR_WALLET or inference (see
 * wallet-mode.mjs), and the flag is stripped before the rest of the command
 * line is read. Every line printed carries `wallet: <mode>`.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPrograms, programsFromManifest, EXIT } from './tx-checks.mjs';
import { finishDeployment, makeDeposit, scrub, signChecked, transactionsFromFile, watchDeployment, weavrClient } from './weavr.mjs';
import { resolveWalletMode } from './wallet-mode.mjs';
import { payboxSigner } from './paybox-signer.mjs';
import { localSigner } from './local-signer.mjs';
import { linkSigner, noWalletError } from './link-signer.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const USAGE = '[--wallet paybox|local|link] --address | --deployment <id> | --deposit <ticker> --amount <usd> | --file <walletPayload.json> [--send | --await <deploymentId>] | --tx <encoded>...';

export function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

/** The signer for a resolved wallet mode. */
export function signerFor(mode, env = process.env) {
  if (mode === 'paybox') return payboxSigner({ env });
  if (mode === 'local') return localSigner({ env });
  if (mode === 'link') return linkSigner();
  const err = new Error(`unknown wallet mode ${JSON.stringify(mode)}`);
  err.code = 'CONFIG';
  throw err;
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
 * Run the tool. `makeSigner(mode, env)` builds the signer for the resolved
 * mode (signerFor by default); an alias forces its mode by prepending
 * `--wallet <x>` to argv. Every output line gains `wallet: <mode>` once the
 * mode is known; a field of that name already in a weavr payload is kept.
 */
export async function runCli(argv, makeSigner = signerFor, env = process.env) {
  let mode;
  const emit = (obj, code = 0) => out(mode && !('wallet' in obj) ? { ...obj, wallet: mode } : obj, code);
  const fail = (error, detail, code) => emit({ error, ...(detail ? { detail } : {}) }, code);

  try {
    const resolved = resolveWalletMode({ argv, env });
    mode = resolved.mode;
    const args = resolved.rest;
    const has = (f) => args.includes(f);
    const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    const vals = (f) => args.flatMap((a, i) => (a === f && args[i + 1] != null ? [args[i + 1]] : []));
    const signer = makeSigner(mode, env);
    const client = () => weavrClient({ mcpUrl: env.WEAVR_MCP_URL, apiUrl: env.WEAVR_API_URL });

    if (mode === 'link') {
      // No signer on this host. The only thing to do is watch a deployment the
      // owner signs from the sign link: no rebuild, no check, nothing signed.
      if (has('--deployment')) {
        const id = val('--deployment');
        if (!id) return fail('USAGE', '--deployment <deploymentId>', EXIT.USAGE);
        const w = await watchDeployment(client(), id, { timeoutSecs: 50 });
        return emit({ step: 'await_portfolio', wallet: mode, ...scrub(w.payload) }, w.isError ? EXIT.WEAVR_ERROR : 0);
      }
      if (has('--address') || has('--tx') || has('--file') || has('--deposit')) throw noWalletError();
      return fail('USAGE', USAGE, EXIT.USAGE);
    }

    if (has('--address')) return emit({ address: signer.wallet });
    const allowed = resolveAllowed(env);
    const finish = (r) => emit(r.output ?? { signed: r.signed }, r.exit ?? 0);

    if (has('--tx')) {
      const r = await signChecked(vals('--tx'), signer, allowed);
      return r.ok ? emit({ signed: r.signed }) : finish(r);
    }
    if (has('--file')) {
      const txs = transactionsFromFile(val('--file'));
      const r = await signChecked(txs, signer, allowed);
      if (!r.ok) return finish(r);
      if (has('--send')) {
        const sent = await client().mcpCall('send_signed', { signed: r.signed });
        return emit({ step: 'send_signed', ...sent.payload }, sent.isError ? EXIT.WEAVR_ERROR : 0);
      }
      if (has('--await')) {
        const w = await client().mcpCall('await_portfolio', { deploymentId: val('--await'), signed: r.signed, timeoutSecs: 50 });
        return emit({ step: 'await_portfolio', ...scrub(w.payload) }, w.isError ? EXIT.WEAVR_ERROR : 0);
      }
      return emit({ signed: r.signed });
    }
    if (has('--deposit')) {
      const portfolio = val('--deposit'); const amountUsd = Number(val('--amount'));
      if (!portfolio || !(amountUsd > 0)) return fail('USAGE', '--deposit <ticker> --amount <usd>', EXIT.USAGE);
      return finish(await makeDeposit(client(), portfolio, amountUsd, signer, allowed));
    }
    if (has('--deployment')) {
      const id = val('--deployment');
      if (!id) return fail('USAGE', '--deployment <deploymentId>', EXIT.USAGE);
      return finish(await finishDeployment(client(), id, signer, allowed));
    }
    return fail('USAGE', USAGE, EXIT.USAGE);
  } catch (e) {
    const code = e.code === 'CONFIG' ? EXIT.CONFIG : e.code === 'BUSY' ? EXIT.BUSY : e.code === 'WALLET_DECLINED' ? EXIT.WALLET_DECLINED : e.code === 'NO_WALLET' ? EXIT.NO_WALLET : EXIT.FAILED;
    // NO_WALLET carries a fixed sentence the agent must see whole; anything else is capped.
    const detail = e.code === 'NO_WALLET' ? e.message : String(e.message).slice(0, 200);
    return fail(e.code && EXIT[e.code] !== undefined ? e.code : 'FAILED', detail, code);
  }
}
