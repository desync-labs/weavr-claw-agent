#!/usr/bin/env node
/**
 * The one-shot WEAVR create, run from a laptop by the treasury key — never by
 * the signer process (`create` is in policy `verbs.denied`; the signer has no
 * route for it). The fee recipient of a portfolio is its create signer by
 * construction, so the treasury signs the create itself and names the policy
 * signer as `curator`, a plain argument that may differ from the signer.
 *
 * Flow, in order and never reordered: parse (key material is refused on argv;
 * `--keeper-processor` is required) → load the key (`--keypair-file` or
 * TREASURY_KEYPAIR_JSON) → the lookup-table allowlist → GET /health (a
 * liveness check; its keeper key is a cross-check on the flag, never the
 * source of the reimbursement's payee) → GET /v1/pools (Pool keys for the
 * targets) → POST /v1/portfolios/build in tool mode, operator setup,
 * `rebalanceDelaySecs` explicit (the api defaults to 60 s), through a client
 * that waits 90 s (the api simulates and fronts a durable nonce first) →
 * verify every transaction with `decode.verifyBuilt` under the `create` verb
 * → sign ONLY the creator steps → submit through POST
 * /v1/deployments/:id/await, the route the MCP's `await_portfolio` uses (the
 * api sends the signed creator steps behind its own guard and nudges the
 * keeper, which completes its own steps) → poll the same route until `live`
 * → GET /v1/portfolios/:mint.
 *
 * Every lamport the treasury commits is bounded by the operator, not by the
 * api: the reimbursement pays `--keeper-processor` (the cluster's
 * `config.keeperProcessor`), the reimbursement plus the factory rent and the
 * custodian reserve stay under `--max-lamports`, and each treasury
 * transaction's priority fee stays under `--max-priority-lamports`. The
 * build's `rentLamports` quote must be integers and is cross-checked
 * against the decoded amounts; it never sets the bound.
 *
 * `--dry-run` stops after the verification: nothing is signed, nothing is
 * sent. `--deployment-id` resumes the polling of an earlier run and needs no
 * key at all.
 *
 * Exit codes: 0 live (or a verified dry run); 2 refused — a bad argument, a
 * key that could not be loaded, an api refusal or a verification failure,
 * always before anything was signed or sent, or a send the api answered with
 * a refusal (a 4xx; the message names the deployment id to check); 3 not
 * live in time, or the run stopped once the signed creator transaction had
 * left this process — the api giving no answer to the submit, the api going
 * quiet afterwards, a `sign_again` the verifier or the api refused, a crash —
 * the deployment id is printed for `--deployment-id`, and the create is
 * never run again before the deployment has been checked; 1 an unexpected
 * crash before anything was submitted.
 *
 * Everything that is not the `--json` line goes to stderr. Never printed:
 * key material, tokens, transaction bytes, or the api URL (it may carry
 * credentials; `weavr.js` messages are URL-free by contract).
 */
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { connect, idlFor } from '@composable-portfolios/chain';
import { verifyBuilt } from '../src/decode.js';
import { Refusal } from '../src/errors.js';
import { allowedLookupTableSet, allowedProgramSet, loadLookupTables } from '../src/index.js';
import { loadSigner } from '../src/keys.js';
import { scrubText } from '../src/verbs.js';
import { weavrClient } from '../src/weavr.js';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, REFUSED: 2, TIMEOUT: 3 });

/** The env var the treasury key may come from; the refusal names it, never its value. */
export const KEYPAIR_ENV = 'TREASURY_KEYPAIR_JSON';
/** The api's `/await` long-poll cap (`AWAIT_DEFAULTS.maxTimeoutSecs`). */
export const AWAIT_SECS = 50;
/** Between two polls; the poll itself blocks up to AWAIT_SECS at the api. */
export const POLL_SLEEP_MS = 2_000;
/** How many `sign_again` rebuilds are re-verified and re-signed before giving up. */
export const MAX_RESIGN = 3;
const AWAIT_TIMEOUT_MS = (AWAIT_SECS + 25) * 1000;
/**
 * The build's own client timeout. In operator mode the api reads the treasury
 * balance, simulates, asks the keeper for the treasury's durable nonce (up to
 * three attempts; on a fresh key the keeper first creates and confirms the
 * nonce account on chain) and then builds — well past `weavr.js`'s 20 s
 * default on mainnet. An abort here would leave a deployment record and a
 * fronted nonce behind for nothing, and a retry would leave another.
 */
export const BUILD_TIMEOUT_MS = 90_000;

const DEFAULTS = Object.freeze({
  rebalanceDelaySecs: 86_400,
  depositFeeBps: 20,
  withdrawFeeBps: 20,
  creatorFeeBps: 6000,
  managementFeeBpsPerYear: 0,
  driftBandBps: 200,
  idleTargetBps: 500,
  compositionLocked: false,
  setupSigner: 'operator',
  waitSecs: 600,
  /** The ceiling on the api-set amounts the treasury pays (reimbursement + factory rent + custodian reserve; program-fixed account rent and the base fee are on top); a 3-leg create measures ~0.08 SOL. */
  maxLamports: 200_000_000,
  /** The ceiling on one treasury transaction's priority fee (compute-unit limit × price); the api's default fee is ~600 lamports. */
  maxPriorityLamports: 5_000_000,
});

export const USAGE = `usage: node scripts/create_portfolio.mjs --api <url> --targets '<poolId>:<weightBps>,...' --curator <base58>
         --keeper-processor <base58>   (the cluster's config.keeperProcessor: the only account the reimbursement may pay)
         --name <text> --symbol <ticker>   (at most 32 / 10 bytes; the api builds nothing without both)
         [--metadata-uri <url>]   (at most 128 bytes; the api derives a per-ticker one when absent)
         [--rebalance-delay-secs 86400] [--deposit-fee-bps 20] [--withdraw-fee-bps 20] [--creator-fee-bps 6000]
         [--management-fee-bps-per-year 0] [--drift-band-bps 200] [--idle-target-bps 500] [--composition-locked]
         [--max-lamports 200000000] [--max-priority-lamports 5000000]   (ceilings on what the treasury commits)
         [--setup-signer operator] [--nav-lookup-table <base58>]
         [--keypair-file <path>]   (or env TREASURY_KEYPAIR_JSON — a 64-byte JSON array; never on argv)
         [--dry-run] [--wait-secs 600] [--deployment-id <id>] [--json]

  env: TREASURY_KEYPAIR_JSON (the key when --keypair-file is not given); CURATOR_RPC_URL or SOLANA_RPC_URL
       (optional: resolves the NAV lookup table so a v0 create of four or more assets can be verified);
       NAV_LOOKUP_TABLE (the one table a v0 message may load from, when --nav-lookup-table is not given).
  a dry run still leaves a deployment record at the api and, once per treasury key, costs the keeper the nonce-account rent.
  exit: 0 live (or verified dry run) · 2 refused before signing (or a send the api refused) · 3 not live in time, or stopped after the send (resume with --deployment-id) · 1 crash`;

// ---------------------------------------------------------------- arguments

const FLAGS = Object.freeze({
  '--api': 'api',
  '--name': 'name',
  '--symbol': 'symbol',
  '--metadata-uri': 'metadataUri',
  '--targets': 'targetsRaw',
  '--curator': 'curator',
  '--rebalance-delay-secs': 'rebalanceDelaySecs',
  '--deposit-fee-bps': 'depositFeeBps',
  '--withdraw-fee-bps': 'withdrawFeeBps',
  '--creator-fee-bps': 'creatorFeeBps',
  '--management-fee-bps-per-year': 'managementFeeBpsPerYear',
  '--drift-band-bps': 'driftBandBps',
  '--idle-target-bps': 'idleTargetBps',
  '--max-lamports': 'maxLamports',
  '--max-priority-lamports': 'maxPriorityLamports',
  '--setup-signer': 'setupSigner',
  '--keeper-processor': 'keeperProcessor',
  '--nav-lookup-table': 'navLookupTable',
  '--keypair-file': 'keypairFile',
  '--wait-secs': 'waitSecs',
  '--deployment-id': 'deploymentId',
});
const BOOLEAN_FLAGS = Object.freeze({
  '--composition-locked': 'compositionLocked',
  '--dry-run': 'dryRun',
  '--json': 'json',
  '--help': 'help',
  '-h': 'help',
});
const INTEGERS = Object.freeze({
  rebalanceDelaySecs: [0, 10 * 365 * 86_400],
  depositFeeBps: [0, 10_000],
  withdrawFeeBps: [0, 10_000],
  creatorFeeBps: [0, 10_000],
  managementFeeBpsPerYear: [0, 10_000],
  driftBandBps: [0, 10_000],
  idleTargetBps: [0, 10_000],
  waitSecs: [1, 86_400],
  maxLamports: [0, 10_000_000_000],
  maxPriorityLamports: [0, 1_000_000_000],
});
/** The factory's byte limits on the strings (`create_portfolio.rs`): a longer one is refused, never truncated. */
const NAME_MAX_BYTES = 32;
const SYMBOL_MAX_BYTES = 10;
const METADATA_URI_MAX_BYTES = 128;

/** Flags that would put a key on argv, whatever the spelling: refused before anything is parsed. */
const KEY_FLAG = /^--?(keypair|keypair-json|secret|secret-key|private-key|privatekey|mnemonic|seed|treasury-keypair(-json)?)(=|$)/i;
const KEY_SHAPED_ARRAY = /^\s*\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]\s*$/;
const KEY_SHAPED_HEX = /^(0x)?[0-9a-f]{64}([0-9a-f]{64})?$/i;

const bad = (message) => new Refusal('BAD_REQUEST', message);

function refuseKeyMaterial(token) {
  if (KEY_FLAG.test(token)) {
    throw bad(`${token.split('=')[0]}: key material is never accepted on argv; use --keypair-file <path> or the ${KEYPAIR_ENV} env var`);
  }
  if (KEY_SHAPED_ARRAY.test(token) || KEY_SHAPED_HEX.test(token)) {
    throw bad('an argv value has the shape of key material; keys are never accepted on argv (use --keypair-file or TREASURY_KEYPAIR_JSON)');
  }
}

function base58(value, label) {
  try {
    const key = new PublicKey(String(value));
    if (key.toBytes().length !== 32) throw new Error('length');
    return key.toBase58();
  } catch {
    throw bad(`--${label} must be a base58 public key`);
  }
}

function integer(value, name, [min, max]) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** `'pA@solana:4000,pB@solana:6000'` → `[{ poolId, weightBps }]`; refuses a malformed pair, a non-positive weight, a duplicate pool. */
export function parseTargets(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw bad('--targets is required: <poolId>:<weightBps>,...');
  const seen = new Set();
  const targets = text.split(',').map((pair) => {
    const at = pair.lastIndexOf(':');
    const poolId = at < 0 ? '' : pair.slice(0, at).trim();
    const weight = at < 0 ? NaN : Number(pair.slice(at + 1).trim());
    if (!poolId || !Number.isInteger(weight) || weight <= 0 || weight > 10_000) {
      throw bad(`--targets entry "${pair.trim()}" is not <poolId>:<weightBps> with a weight in 1..10000`);
    }
    if (seen.has(poolId)) throw bad(`--targets names ${poolId} twice`);
    seen.add(poolId);
    return { poolId, weightBps: weight };
  });
  const sum = targets.reduce((total, t) => total + t.weightBps, 0);
  if (sum !== 10_000) throw bad(`--targets weights must sum to 10000 bps; they sum to ${sum}`);
  return targets;
}

/**
 * @param {string[]} argv
 * @returns {object} the parsed options with defaults applied
 * @throws {Refusal} BAD_REQUEST on key material, an unknown flag, a missing required flag, a value out of range
 */
export function parseArgs(argv) {
  const out = { ...DEFAULTS, dryRun: false, json: false, help: false, name: null, symbol: null, metadataUri: null, keypairFile: null, deploymentId: null, keeperProcessor: null, navLookupTable: null, curator: null, targetsRaw: null, api: null };
  const list = [...(argv ?? [])];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    refuseKeyMaterial(token);
    if (BOOLEAN_FLAGS[token]) {
      out[BOOLEAN_FLAGS[token]] = true;
      continue;
    }
    const eq = token.indexOf('=');
    const flag = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    const name = FLAGS[flag];
    if (!name) throw bad(`unknown argument ${flag}`);
    let value;
    if (eq > 0 && token.startsWith('--')) {
      value = token.slice(eq + 1);
    } else {
      i += 1;
      if (i >= list.length) throw bad(`${flag} needs a value`);
      value = String(list[i]);
    }
    refuseKeyMaterial(value);
    out[name] = value;
  }
  if (out.help) return out;

  if (typeof out.api !== 'string' || !/^https?:\/\//.test(out.api)) throw bad('--api <http(s) url> is required');
  for (const [name, range] of Object.entries(INTEGERS)) out[name] = integer(out[name], name, range);
  if (out.setupSigner !== 'operator') {
    throw bad('--setup-signer must be operator: the verifier describes the operator-setup create (the treasury signs create_portfolio only)');
  }
  if (out.keeperProcessor != null) out.keeperProcessor = base58(out.keeperProcessor, 'keeper-processor');
  if (out.navLookupTable != null) out.navLookupTable = base58(out.navLookupTable, 'nav-lookup-table');
  if (out.deploymentId != null) {
    out.deploymentId = String(out.deploymentId).trim();
    if (!out.deploymentId) throw bad('--deployment-id needs a value');
    out.targets = out.targetsRaw == null ? null : parseTargets(out.targetsRaw);
    return out;
  }
  out.targets = parseTargets(out.targetsRaw);
  if (out.curator == null) throw bad('--curator <base58> is required: the policy signer that will curate the book');
  out.curator = base58(out.curator, 'curator');
  if (out.keeperProcessor == null) {
    throw bad("--keeper-processor <base58> is required: the cluster's keeper processor (config.keeperProcessor in the handoff runbook), the only account the keeper reimbursement may pay; the api's /health is a cross-check, never the source");
  }
  // The api builds nothing without a name and a ticker (`namingErrors`: NAME_REQUIRED /
  // SYMBOL_REQUIRED), so both are refused here, before /health and /v1/pools are called;
  // whitespace is what the api trims away.
  if (out.name == null || String(out.name).trim() === '') throw bad('--name <text> is required: the api builds no create without a name (NAME_REQUIRED)');
  out.name = String(out.name);
  if (Buffer.byteLength(out.name, 'utf8') > NAME_MAX_BYTES) throw bad(`--name must be at most ${NAME_MAX_BYTES} bytes of UTF-8; it is ${Buffer.byteLength(out.name, 'utf8')}`);
  if (out.symbol == null || String(out.symbol).trim() === '') throw bad('--symbol <ticker> is required: the api builds no create without a ticker (SYMBOL_REQUIRED)');
  out.symbol = String(out.symbol);
  if (Buffer.byteLength(out.symbol, 'utf8') > SYMBOL_MAX_BYTES) throw bad(`--symbol must be at most ${SYMBOL_MAX_BYTES} bytes of UTF-8; it is ${Buffer.byteLength(out.symbol, 'utf8')}`);
  // The factory refuses metadata_uri.len() > 128 and the api does not check it: a longer URI
  // would be built, verified, signed and sent, then fail on chain (the nonce advance and the
  // base fee paid, a deployment record left behind), so it is refused before the build.
  if (out.metadataUri != null) {
    out.metadataUri = String(out.metadataUri);
    if (Buffer.byteLength(out.metadataUri, 'utf8') > METADATA_URI_MAX_BYTES) throw bad(`--metadata-uri must be at most ${METADATA_URI_MAX_BYTES} bytes of UTF-8 (the factory's limit, which the api does not check); it is ${Buffer.byteLength(out.metadataUri, 'utf8')}`);
  }
  return out;
}

// ---------------------------------------------------------------- helpers

const errorLine = (error) => {
  if (error instanceof Refusal) {
    const detail = error.detail && typeof error.detail === 'object' ? error.detail : null;
    const apiCode = detail?.code && detail.code !== error.code ? ` (api ${detail.code})` : '';
    const errors = Array.isArray(detail?.errors) && detail.errors.length
      ? `; api errors: ${detail.errors.map((e) => `${e.code ?? '?'}${e.field ? ` ${e.field}` : ''}: ${e.message ?? ''}`).join(' | ')}`
      : '';
    return `${error.code}${apiCode}: ${scrubText(error.message)}${scrubText(errors, 2000)}`;
  }
  return `INTERNAL: ${scrubText(error?.message ?? String(error))}`;
};

/** The build, through `request()` so the api's `errors` list survives a 4xx (settle keeps `{ code, message }` only). */
async function buildCreate(client, body) {
  const { status, json } = await client.request('POST', '/v1/portfolios/build', body);
  if (status >= 200 && status < 300) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.transactions)) {
      throw new Refusal('UPSTREAM', 'api POST /v1/portfolios/build answered without a transactions list');
    }
    return json;
  }
  const error = json?.error && typeof json.error === 'object' ? json.error : {};
  const detail = { status, code: error.code ?? `HTTP_${status}`, message: error.message ?? `api answered ${status}`, errors: Array.isArray(json?.errors) ? json.errors : [] };
  if (status >= 400 && status < 500) throw new Refusal('BUILD_REFUSED', `api POST /v1/portfolios/build refused: ${detail.message}`, detail);
  throw new Refusal('UPSTREAM', `api POST /v1/portfolios/build answered ${status}`, detail);
}

/**
 * The lookup tables a v0 create may load from: `--nav-lookup-table`, else the
 * run's NAV_LOOKUP_TABLE, else — only when the run's env is the process's —
 * the chain package's allowlist (which falls back to its NAV-table cache
 * file). Resolved through the RPC when one is configured, else
 * allowed-but-unresolved (a loaded account then refuses UNKNOWN_INSTRUCTION).
 */
async function defaultLookupTables(env, navLookupTable) {
  let allowlist;
  if (navLookupTable) {
    allowlist = new Set([navLookupTable]);
  } else if (typeof env.NAV_LOOKUP_TABLE === 'string' && env.NAV_LOOKUP_TABLE.trim() !== '') {
    try {
      allowlist = new Set([new PublicKey(env.NAV_LOOKUP_TABLE.trim()).toBase58()]);
    } catch {
      throw new Refusal('CONFIG', 'NAV_LOOKUP_TABLE must be a base58 address');
    }
  } else {
    allowlist = env === process.env ? allowedLookupTableSet() : new Set();
  }
  const rpcUrl = env.CURATOR_RPC_URL ?? env.SOLANA_RPC_URL ?? null;
  if (!rpcUrl || allowlist.size === 0) return allowlist;
  return loadLookupTables(connect(rpcUrl), allowlist);
}

const defaultIdls = () => ({ portfolio_factory: idlFor('portfolio_factory'), stoken: idlFor('stoken'), accountant: idlFor('accountant') });

const resultOf = ({ deploymentId, mint, row, addresses, creator, curator, rebalanceDelaySecs, status }) => ({
  deploymentId: deploymentId ?? null,
  mint: row?.mint ?? mint ?? addresses?.sharesMint ?? null,
  portfolio: row?.portfolio ?? addresses?.portfolio ?? null,
  vaultKey: row?.vaultKey ?? addresses?.vault ?? null,
  creator: row?.creator ?? creator ?? null,
  curator: row?.curator ?? curator ?? null,
  // The fee recipient is the create signer by construction; the row says so once live.
  feeRecipient: row?.feeRecipient ?? creator ?? null,
  rebalanceDelaySecs: row?.rebalanceDelaySecs != null ? Number(row.rebalanceDelaySecs) : (rebalanceDelaySecs ?? null),
  status,
});

// ---------------------------------------------------------------- the run

/**
 * @param {{ argv: string[], env?: object, fetchImpl?: typeof fetch, stdout?: { write }, stderr?: { write }, now?: () => number, sleep?: (ms) => Promise,
 *   loadSignerImpl?: typeof loadSigner, lookupTables?: Set | Map, allowedPrograms?: Set, idls?: object }} opts
 *   `loadSignerImpl`, `lookupTables`, `allowedPrograms` and `idls` are test seams; the defaults are the real modules.
 * @returns {Promise<number>} the exit code
 */
export async function runCreate(opts) {
  const {
    argv,
    env = process.env,
    fetchImpl = globalThis.fetch,
    stdout = process.stdout,
    stderr = process.stderr,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    loadSignerImpl = loadSigner,
  } = opts;
  const log = (line) => stderr.write(`create: ${scrubText(line, 4000)}\n`);
  const emit = (args, result) => {
    if (args?.json) stdout.write(`${JSON.stringify(result)}\n`);
    else log(`result ${JSON.stringify(result)}`);
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(errorLine(error));
    stderr.write(`${USAGE}\n`);
    return EXIT.REFUSED;
  }
  if (args.help) {
    stderr.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  try {
    const client = weavrClient({ apiUrl: args.api, fetchImpl });
    const waiter = weavrClient({ apiUrl: args.api, fetchImpl, timeoutMs: AWAIT_TIMEOUT_MS });
    const deadline = now() + args.waitSecs * 1000;

    // One poll: the await route (it nudges the keeper); a plain read when another await holds the lock.
    const poll = async (id) => {
      try {
        return await waiter.post(`/v1/deployments/${encodeURIComponent(id)}/await`, { timeoutSecs: AWAIT_SECS }, { refusalCode: 'UPSTREAM' });
      } catch (error) {
        if (error instanceof Refusal && error.detail?.status === 409) return client.get(`/v1/deployments/${encodeURIComponent(id)}`);
        throw error;
      }
    };
    const finish = async (id, addresses, intent) => {
      const mint = addresses?.sharesMint ?? null;
      let row = null;
      if (mint) {
        try {
          row = await client.portfolio(mint);
        } catch (error) {
          log(`live, but the portfolio row could not be read (${errorLine(error)}); reporting the deployment's addresses`);
        }
      }
      const result = resultOf({ deploymentId: id, mint, row, addresses, ...intent, status: 'live' });
      log(`live: mint ${result.mint} portfolio ${result.portfolio} curator ${result.curator} feeRecipient ${result.feeRecipient}`);
      emit(args, result);
      return EXIT.OK;
    };
    // The addresses this run verified (the signed accounts, the derived mint) whenever it
    // has them; the api's unverified echo only on a resume, which passes null.
    const timedOut = (id, body, addresses, intent, reason) => {
      log(`${reason}; resume with --deployment-id ${id}`);
      emit(args, resultOf({ deploymentId: id, addresses: addresses ?? body?.expectedAddresses ?? null, ...intent, status: body?.status ?? 'in_progress' }));
      return EXIT.TIMEOUT;
    };
    // Whatever stops the run once the signed creator transaction has left this process —
    // the submit getting no answer, the api going quiet afterwards, a sign_again the
    // verifier or the api refuses, a crash — is exit 3 with the id, never exit 2: exit 2
    // reads as "nothing was signed or sent", and an operator or a script keyed on it
    // would run the create again and pay for a second book.
    const stoppedAfterSubmit = (error, id, body, addresses, intent, what) => {
      log(`${errorLine(error)}; ${what} (deployment ${id}) and this run stopped before it was seen live — resume with --deployment-id ${id}; never run the create again before checking the deployment`);
      emit(args, resultOf({ deploymentId: id, addresses, ...intent, status: body?.status ?? 'unknown' }));
      return EXIT.TIMEOUT;
    };

    // ---- resume: poll only, no key
    if (args.deploymentId) {
      const id = args.deploymentId;
      log(`resuming deployment ${id}: polling until live (no key loaded)`);
      for (;;) {
        const body = await poll(id);
        if (body.status === 'live') return finish(id, body.expectedAddresses ?? null, {});
        if (body.status === 'expired') return timedOut(id, body, null, {}, 'the deployment expired before it went live');
        if (body.status === 'sign_again') return timedOut(id, body, null, {}, 'the creator transaction expired; a resume never signs again (run the create again once you have checked nothing landed)');
        log(`deployment ${id}: ${body.status ?? 'unknown'}, waiting on ${body.waitingOn ?? 'nobody'}`);
        if (now() >= deadline) return timedOut(id, body, null, {}, `not live after ${args.waitSecs} s`);
        await sleep(POLL_SLEEP_MS);
      }
    }

    // ---- the key: a file or the env var, never both, never argv
    const inline = typeof env[KEYPAIR_ENV] === 'string' && env[KEYPAIR_ENV].trim() !== '';
    if (inline && args.keypairFile) throw bad(`give the key once: --keypair-file or ${KEYPAIR_ENV}, not both`);
    let signer;
    try {
      signer = loadSignerImpl(inline ? { text: env[KEYPAIR_ENV], env: KEYPAIR_ENV, kind: 'treasury' } : { file: args.keypairFile, env: `--keypair-file / ${KEYPAIR_ENV}`, kind: 'treasury' });
    } catch (error) {
      if (error instanceof Refusal && error.code === 'CONFIG' && !inline && !args.keypairFile) {
        throw new Refusal('CONFIG', `no key: pass --keypair-file <path> or set ${KEYPAIR_ENV} (a 64-byte JSON array)`);
      }
      throw error;
    }
    const creator = signer.wallet;
    log(`treasury ${creator} will create as creator (fee recipient by construction) with curator ${args.curator}`);

    // ---- the lookup tables a v0 create may load from (a config error stops here, before the api is touched)
    const lookupTables = opts.lookupTables ?? await defaultLookupTables(env, args.navLookupTable);

    // ---- the keeper processor: the flag is the only account the reimbursement
    // may pay; /health is a liveness check and a cross-check, never the source
    // (it may report the keeper's hot key rather than config.keeperProcessor).
    const keeperProcessor = args.keeperProcessor;
    const health = await client.health();
    const reported = typeof health?.signers?.keeper?.pubkey === 'string' ? health.signers.keeper.pubkey : null;
    if (reported == null) {
      log(`note: the api /health names no keeper signer; the reimbursement payee is --keeper-processor ${keeperProcessor} alone`);
    } else if (reported !== keeperProcessor) {
      log(`note: the api /health reports keeper ${reported}, --keeper-processor is ${keeperProcessor}; the flag must be the cluster's config.keeperProcessor (/health may show the keeper's hot key) and the built transfer must pay the flag`);
    } else {
      log(`keeper processor ${keeperProcessor} (matches the api /health)`);
    }

    // ---- the Pool keys the targets resolve to (exact poolId, else a unique symbol)
    const pools = await client.pools();
    const poolKeys = {};
    const targets = args.targets.map((target) => {
      const exact = pools.find((pool) => pool?.poolId === target.poolId);
      const bySymbol = exact ? [] : pools.filter((pool) => typeof pool?.symbol === 'string' && pool.symbol.toLowerCase() === target.poolId.toLowerCase());
      const pool = exact ?? (bySymbol.length === 1 ? bySymbol[0] : null);
      const key = pool?.addresses?.pool;
      if (!pool || typeof key !== 'string') {
        throw new Refusal('INPUTS_INCOMPLETE', `no catalogue row with a Pool key for ${target.poolId}; the built targets could not be verified`, { poolId: target.poolId });
      }
      poolKeys[pool.poolId] = key;
      return { poolId: pool.poolId, weightBps: target.weightBps };
    });

    // ---- build (tool mode, operator setup, the delay explicit)
    const intent = {
      creator,
      curator: args.curator,
      targets,
      name: args.name,
      symbol: args.symbol,
      ...(args.metadataUri != null ? { metadataUri: args.metadataUri } : {}),
      depositFeeBps: args.depositFeeBps,
      withdrawFeeBps: args.withdrawFeeBps,
      managementFeeBpsPerYear: args.managementFeeBpsPerYear,
      creatorFeeBps: args.creatorFeeBps,
      driftBandBps: args.driftBandBps,
      idleTargetBps: args.idleTargetBps,
      compositionLocked: args.compositionLocked,
      rebalanceDelaySecs: args.rebalanceDelaySecs,
    };
    const builder = weavrClient({ apiUrl: args.api, fetchImpl, timeoutMs: BUILD_TIMEOUT_MS });
    const built = await buildCreate(builder, { ...intent, wallet: 'tool', setupSigner: args.setupSigner });
    const id = String(built.deploymentId ?? '');
    if (!id) throw new Refusal('UPSTREAM', 'the build answered without a deploymentId');
    // The quote is cross-checked against the decoded amounts; a quote that is
    // not an integer would disable that check, so it is refused instead.
    const quoted = (name) => {
      const value = built.rentLamports?.[name];
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Refusal('UPSTREAM', `the build's rentLamports.${name} is ${value === undefined ? 'absent' : JSON.stringify(value)}, not a lamport amount; the treasury's outlay cannot be cross-checked, nothing is signed (deployment ${id})`);
      }
      return value;
    };
    const rentQuote = { keeper: quoted('keeper'), factory: quoted('factory'), custodian: quoted('custodian') };
    const mine = built.transactions.filter((step) => step?.signer === 'creator');
    const theirs = built.transactions.filter((step) => step?.signer !== 'creator');
    log(`built deployment ${id}: ${built.transactions.length} step(s) — mine: ${mine.map((s) => s.step).join(', ') || 'none'}; keeper: ${theirs.map((s) => s.step).join(', ') || 'none'}${built.durableNonce ? '; nonce-backed' : ''}`);

    // ---- verify before anything is signed
    const expect = {
      payer: creator,
      curator: args.curator,
      rebalanceDelaySecs: args.rebalanceDelaySecs,
      targets,
      poolKeys,
      name: args.name,
      symbol: args.symbol,
      ...(args.metadataUri != null ? { metadataUri: args.metadataUri } : {}),
      depositFeeBps: args.depositFeeBps,
      withdrawFeeBps: args.withdrawFeeBps,
      managementFeeBpsPerYear: args.managementFeeBpsPerYear,
      creatorFeeBps: args.creatorFeeBps,
      driftBandBps: args.driftBandBps,
      idleTargetBps: args.idleTargetBps,
      compositionLocked: args.compositionLocked,
      keeperProcessor,
      keeperLamports: rentQuote.keeper,
      factoryRentLamports: rentQuote.factory,
      custodianReserveLamports: rentQuote.custodian,
      maxLamports: args.maxLamports,
      maxPriorityLamports: args.maxPriorityLamports,
      addresses: built.addresses,
      allowedPrograms: opts.allowedPrograms ?? allowedProgramSet(),
      lookupTables,
      idls: opts.idls ?? defaultIdls(),
    };
    const verify = (transactions) => {
      const verdict = verifyBuilt({ transactions, verb: 'create', expect });
      if (!verdict.ok) {
        let hint = '';
        if (/lookup table/i.test(verdict.message) && !(lookupTables instanceof Map)) {
          hint = ' (a v0 create loads accounts from the NAV lookup table: set CURATOR_RPC_URL or SOLANA_RPC_URL so it can be resolved, and NAV_LOOKUP_TABLE or --nav-lookup-table to allow it)';
        } else if (verdict.code === 'WRONG_ACCOUNT' && /system\.transfer pays/.test(verdict.message)) {
          hint = " (the reimbursement must pay --keeper-processor, the cluster's config.keeperProcessor from the handoff runbook; the api's /health may report the keeper's hot key instead — check the flag before running again)";
        } else if (/above the approved ceiling/.test(verdict.message)) {
          hint = ' (raise --max-lamports / --max-priority-lamports only after checking why the create costs more than expected)';
        }
        throw new Refusal(verdict.code, `${verdict.message}${hint}`);
      }
      return verdict.summary;
    };
    const summary = verify(built.transactions);
    const c = summary.create;
    log(`verified ${summary.mine.length} treasury step(s) (${summary.mine.map((i) => built.transactions[i].step).join(', ')}) and ${summary.theirs.length} keeper step(s) (${summary.theirs.map((t) => t.step).join(', ')})`);
    log(`create_portfolio: name "${c.name}" symbol "${c.symbol}" metadata ${c.metadataUri} curator ${c.curator} rebalance_delay_secs ${c.rebalanceDelaySecs} fees deposit ${c.depositFeeBps} / withdraw ${c.withdrawFeeBps} / creator ${c.creatorFeeBps} / mgmt ${c.managementFeeBpsPerYear} drift ${c.driftBandBps} idle ${c.idleTargetBps} locked ${c.compositionLocked}`);
    log(`targets: ${c.targets.map((t) => `${Object.entries(poolKeys).find(([, k]) => k === t.pool)?.[0] ?? t.pool} ${t.weightBps}`).join(', ')}`);
    log(`rent: factory ${c.factoryRentLamports} lamports, custodian reserve ${c.custodianReserveLamports}, keeper reimbursement ${c.keeperLamports ?? 'none'} lamports to ${keeperProcessor}`);
    log(`outlay: ${c.outlayLamports} lamports of api-set amounts (reimbursement + factory rent + custodian reserve), within --max-lamports ${args.maxLamports}; program-fixed account rent and the base fee are on top and cannot be set by the api; priority fees ${c.priorityLamports} lamports, each transaction within --max-priority-lamports ${args.maxPriorityLamports}`);
    // What the CLI reports is what the treasury signs for — the accounts of the
    // decoded create and the mint derived from its vault — never the api's echo.
    for (const [name, value] of [['portfolio', c.portfolio], ['vault', c.vault], ['sharesMint', c.sharesMint]]) {
      if (!value) throw new Refusal('UNKNOWN_INSTRUCTION', `the create's ${name} could not be taken from the signed instruction (${name === 'sharesMint' ? 'stoken is not pinned in the manifest this process reads' : 'the account is unresolved'}); the api's echo is not reported in its place`);
    }
    log(`addresses: portfolio ${c.portfolio} vault ${c.vault} mint ${c.sharesMint}`);
    const addresses = { ...(built.addresses ?? {}), sharesMint: c.sharesMint, portfolio: c.portfolio, vault: c.vault };
    const fixed = { creator, curator: args.curator, rebalanceDelaySecs: args.rebalanceDelaySecs };

    if (args.dryRun) {
      log('dry run: nothing signed, nothing sent');
      emit(args, resultOf({ deploymentId: id, addresses, ...fixed, status: 'dry-run' }));
      return EXIT.OK;
    }

    // ---- sign the treasury's steps only, submit through the await route
    const sign = async (transactions, indexes) => {
      const list = indexes.map((i) => transactions[i].tx);
      const signed = await signer.sign(list);
      log(`signed ${signed.length} transaction(s)`);
      return signed;
    };
    let signed = await sign(built.transactions, summary.mine);
    let resigns = 0;
    let body;
    try {
      body = await waiter.post(`/v1/deployments/${encodeURIComponent(id)}/await`, { signed, timeoutSecs: AWAIT_SECS }, { refusalCode: 'SEND_FAILED' });
    } catch (error) {
      if (error instanceof Refusal && error.code === 'SEND_FAILED') {
        // The api answered with a 4xx: it refused the signed transactions, or a send failed under its guard.
        log(`${errorLine(error)}; the deployment is ${id} — check it before running again, or resume polling with --deployment-id ${id}`);
        return EXIT.REFUSED;
      }
      // No answer (a timeout, a 5xx, a network error): the signed transactions left this
      // process and the api may have sent them — never reported as refused before signing.
      return stoppedAfterSubmit(error, id, null, addresses, fixed, 'the signed creator transaction was posted to /await and the api gave no answer, so it may have been sent');
    }
    log(`submitted; deployment ${id} is ${body.status ?? 'unknown'}`);

    // From here on /await has accepted the signed creator transaction: nothing below
    // may end in exit 2.
    try {
      for (;;) {
        if (body.status === 'live') return finish(id, addresses, fixed);
        if (body.status === 'expired') return timedOut(id, body, addresses, fixed, 'the deployment expired before it went live');
        if (body.status === 'sign_again') {
          // The creator transaction expired (a blockhash build, never a nonce-backed
          // one): the api rebuilt the pending creator steps. They go through the
          // same verification; a partial rebuild (no create_portfolio) stops here.
          resigns += 1;
          if (resigns > MAX_RESIGN) return timedOut(id, body, addresses, fixed, `the creator transaction expired ${MAX_RESIGN} times`);
          let again;
          try {
            again = verify(body.transactions ?? []);
          } catch (error) {
            return timedOut(id, body, addresses, fixed, `sign_again refused: ${errorLine(error)}; nothing more was signed`);
          }
          signed = await sign(body.transactions, again.mine);
          // A refusal of the re-signed transactions is exit 3 like every other failure here.
          body = await waiter.post(`/v1/deployments/${encodeURIComponent(id)}/await`, { signed, timeoutSecs: AWAIT_SECS }, { refusalCode: 'SEND_FAILED' });
          continue;
        }
        log(`deployment ${id}: ${body.status ?? 'unknown'}, waiting on ${body.waitingOn ?? 'nobody'}`);
        if (now() >= deadline) return timedOut(id, body, addresses, fixed, `not live after ${args.waitSecs} s`);
        await sleep(POLL_SLEEP_MS);
        body = await poll(id);
      }
    } catch (error) {
      return stoppedAfterSubmit(error, id, body, addresses, fixed, 'the creator transaction was submitted');
    }
  } catch (error) {
    log(errorLine(error));
    return error instanceof Refusal ? EXIT.REFUSED : EXIT.ERROR;
  }
}

export async function main() {
  const code = await runCreate({ argv: process.argv.slice(2) });
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`create: INTERNAL: ${scrubText(error?.message ?? String(error))}\n`);
    process.exit(EXIT.ERROR);
  });
}
