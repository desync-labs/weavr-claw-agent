/**
 * `weavr-curator doctor`: every check the handoff's failure list asks for,
 * against one home, editing nothing. A check prints a check mark, a cross
 * with the fix under it, or a note when it cannot run here (no docker, no
 * key to read against). Exit 1 on any cross. Every network call has a
 * timeout and reports its failure class; the Telegram URL, which carries the
 * bot token, is never printed.
 */
import * as nodeFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readKeypairFile } from '../../tools/lib/local-signer.mjs';
import { makeReport } from './report.mjs';
import { exists, homePaths, modeOf, readEnvFile, readTokenFile, tooOpen } from './home.mjs';
import { factoryProgramFrom, failureClass, lamportsToSol, readBalance, readFactoryConfig } from './chain.mjs';
import { apiClient, legsText, legsOf, listPools, resolvePortfolio } from './weavr-api.mjs';
import { policyDigest, presetOf, validatePolicyAgainstBook } from './policy-check.mjs';
import { PROVIDERS, composeVariables, providerFor, readConfigModel, readPluginsEnabled } from './render.mjs';
import { REPO_ROOT } from './init.mjs';

export const DEFAULT_SIGNER_URL = 'http://127.0.0.1:8091';
/** The jobs curator/profile/cron/jobs.json ships; a home lacking one runs less than the profile says. */
export const PROFILE_JOB_IDS = Object.freeze(['curator-review', 'curator-universe', 'curator-weekly', 'curator-health']);
/**
 * The compose variables that name paths on the host: the container mounts
 * what they say. Each must be the file or directory the doctor's own checks
 * read (`homePaths` names them), not merely somewhere under the home: the
 * home itself as HERMES_HOME would mount the key, both tokens and signer.env
 * into the agent, and a sibling file would run a stack the doctor never saw.
 */
export const COMPOSE_HOME_PATH_OF = Object.freeze({ CURATOR_KEY_FILE: 'keyFile', CURATOR_POLICY_FILE: 'policyFile', CURATOR_SIGNER_ENV: 'signerEnv', HERMES_HOME: 'hermesHome' });
export const COMPOSE_HOME_PATHS = Object.freeze(Object.keys(COMPOSE_HOME_PATH_OF));
export const HEARTBEAT_MAX_SECS = 45 * 60;
export const NET_TIMEOUT_MS = 10_000;
export const DEFAULT_TICK_MS = 30_000;
export const TELEGRAM_API = 'https://api.telegram.org';

/** `spawnSync` as the doctor uses it; a missing binary reads as status null. */
export function realExec(cmd, args, { timeoutMs = 20_000 } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Parse the two gauges the doctor reads out of Prometheus text. */
export function parseMetrics(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(curator_[a-z0-9_]+)(?:\{[^}]*\})?\s+(-?[\d.eE+-]+)\s*$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = Number(m[2]);
  }
  return out;
}

const NUMERIC_CSV = /^\s*-?\d+\s*(,\s*-?\d+\s*)*$/;

export async function doctor(opts, deps = {}) {
  const {
    fs = nodeFs,
    fetchImpl = fetch,
    rpc,
    now = Date.now,
    log = console.log,
    exec = realExec,
    repoRoot = REPO_ROOT,
    telegramApi = TELEGRAM_API,
    providerBases = {},
  } = deps;
  if (typeof rpc !== 'function') throw new Error('doctor needs an rpc seam');
  const signerUrl = String(opts.signerUrl ?? DEFAULT_SIGNER_URL).replace(/\/$/, '');
  const home = String(opts.home);
  const paths = homePaths(home);
  const report = makeReport({ log, json: Boolean(opts.json) });
  const done = () => {
    const exit = report.hasCross() ? 1 : 0;
    return { exit, ...report.json({ ok: exit === 0, exit, home }) };
  };

  const http = async (url, { headers = {}, timeoutMs = NET_TIMEOUT_MS } = {}) => {
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: res.status, json, text };
    } catch (e) {
      return { failure: failureClass(e) };
    }
  };

  // The home and its files.
  const homeMode = modeOf(home, fs);
  if (homeMode === null) {
    report.cross('home', `${home} does not exist`, { fix: 'run weavr-curator init --portfolio <ticker> first, or pass --home <dir>' });
    return done();
  }
  if ((homeMode & 0o077) !== 0) report.cross('home', `${home} is mode ${homeMode.toString(8)}`, { fix: `chmod 700 ${home}` });
  else report.ok('home', home);

  let key = null;
  const keyMode = modeOf(paths.keyFile, fs);
  if (keyMode === null) {
    report.cross('key file', `${paths.keyFile} is missing`, { fix: 'run weavr-curator init again; it generates the key' });
  } else if (tooOpen(keyMode)) {
    report.cross('key file', `${paths.keyFile} is mode ${keyMode.toString(8)}, readable by group or others`, { fix: `chmod 600 ${paths.keyFile}` });
  } else {
    try {
      key = readKeypairFile(paths.keyFile).publicKey.toBase58();
      report.ok('key file', `${paths.keyFile} (0600), curator ${key}`);
    } catch (e) {
      report.cross('key file', `${paths.keyFile}: ${String(e.message).replace('SIGN_LOCAL_KEYPAIR_FILE', 'the key file')}`, { fix: 'a 64-byte JSON array; move it away and run init again to generate one' });
    }
  }

  const signerTok = readTokenFile(paths.signerToken, fs);
  const opsTok = readTokenFile(paths.opsToken, fs);
  // The stack runs on the copies in curator/signer.env (the signer) and
  // hermes-home/.env (the agent), not on the token files; a copy that
  // differs is a 401 on every call, so each copy is compared with its token
  // file, by file name, never by value.
  const agentEnv = readEnvFile(paths.agentEnv, fs).values;
  if (!signerTok.ok || !opsTok.ok) {
    report.cross('tokens', [signerTok, opsTok].filter((t) => !t.ok).map((t) => t.reason).join('; '), { fix: 'run weavr-curator init again (it generates a missing token) or chmod 600 the file' });
  } else if (signerTok.token === opsTok.token) {
    report.cross('tokens', 'the agent token and the ops token are equal; the signer refuses to boot', { fix: `move ${paths.opsToken} away and run init again` });
  } else {
    const signerEnvValues = readEnvFile(paths.signerEnv, fs).values;
    const copies = [
      ['CURATOR_SIGNER_TOKEN', paths.signerEnv, signerEnvValues.CURATOR_SIGNER_TOKEN, signerTok.token, paths.signerToken],
      ['CURATOR_OPS_TOKEN', paths.signerEnv, signerEnvValues.CURATOR_OPS_TOKEN, opsTok.token, paths.opsToken],
      ['CURATOR_SIGNER_TOKEN', paths.agentEnv, agentEnv.CURATOR_SIGNER_TOKEN, signerTok.token, paths.signerToken],
    ];
    const off = [];
    for (const [label, file, value, token, tokenFile] of copies) {
      const copy = String(value ?? '').trim();
      if (!copy) off.push(`${label} is empty in ${file}`);
      else if (copy !== token) off.push(`${label} in ${file} is not the value in ${tokenFile}`);
    }
    if (off.length) report.cross('tokens', off.join('; '), { fix: 'one value per token: the token file is what init writes both env files from, so put the value you want there (mode 0600, no newline), run weavr-curator init again, then restart the stack' });
    else report.ok('tokens', 'agent and ops tokens present, 0600, distinct, and the copies in curator/signer.env and hermes-home/.env match them');
  }

  // The policy file, and which shipped preset it is: init writes a preset
  // over it on a re-run, so a fix that says to run init must name the preset
  // the home runs, and a file that matches none (edited by hand) gets a fix
  // that edits the file instead.
  let policy = null;
  let preset = null;
  try {
    policy = JSON.parse(fs.readFileSync(paths.policyFile, 'utf8'));
    preset = presetOf(policy, { repoRoot, fs });
    report.ok('policy file', `${paths.policyFile} (version ${policy.version}, ${preset ? `the ${preset} preset` : 'matches no shipped preset: edited by hand'})`, { preset });
  } catch (e) {
    report.cross('policy file', `${paths.policyFile}: ${e.code === 'ENOENT' ? 'missing' : 'not valid JSON'}`, { fix: 'run weavr-curator init again; it writes the preset' });
  }

  // Every variable the compose file references must be set: the stack starts
  // from this file alone. Each path variable must be the file or directory
  // the checks here read, or the container mounts a key, a policy, a signer
  // env or an agent home other than the ones the doctor inspected, and a
  // green doctor would say nothing about the running stack. Under the home
  // is not enough: the home itself, or a sibling beside the right file, is a
  // different mount. Another spelling of the same path (a trailing slash, a
  // `..` that comes back) is the same mount.
  const compose = readEnvFile(paths.composeEnv, fs).values;
  if (!exists(paths.composeEnv, fs)) {
    report.cross('compose env', `${paths.composeEnv} is missing`, { fix: 'run weavr-curator init again' });
  } else {
    const referenced = composeVariables(fs.readFileSync(join(repoRoot, 'curator', 'compose', 'curator.yml'), 'utf8')).map((v) => v.name);
    const composeMissing = referenced.filter((k) => String(compose[k] ?? '').trim() === '');
    const homeAbs = resolve(home);
    const problems = [];
    if (composeMissing.length) problems.push(`lacks ${composeMissing.join(', ')}`);
    for (const [k, pathKey] of Object.entries(COMPOSE_HOME_PATH_OF)) {
      if (composeMissing.includes(k)) continue;
      const value = String(compose[k]).trim();
      const expected = resolve(paths[pathKey]);
      const target = isAbsolute(value) ? resolve(value) : null;
      if (target === expected) continue;
      const why = target === null ? `not an absolute path under ${home}`
        : target === homeAbs || target.startsWith(homeAbs + sep) ? `not ${expected}`
          : `outside ${home}`;
      problems.push(`${k} is ${value}, ${why}: the container would mount a different directory than the one the doctor inspected`);
    }
    if (problems.length) report.cross('compose env', `${paths.composeEnv} ${problems.join('; ')}`, { fix: `run weavr-curator init again with --home ${home}; it re-derives the chain facts and writes every variable curator.yml references, the path variables as the files and the agent home under the home` });
    else report.ok('compose env', `${paths.composeEnv}: mint ${compose.CURATOR_PORTFOLIO_MINT}, every variable curator.yml references set, the path variables the files and the agent home the doctor inspected`);
  }

  // SOL.
  if (key && policy?.rate) {
    try {
      const lamports = await readBalance(rpc, key);
      const floor = Number(policy.rate.minSignerLamports);
      if (lamports < floor) report.cross('signer SOL', `${lamportsToSol(lamports)} SOL, under the policy floor of ${lamportsToSol(floor)} SOL`, { fix: `fund ${key} with at least ${lamportsToSol(floor - lamports)} SOL more` });
      else report.ok('signer SOL', `${lamportsToSol(lamports)} SOL (floor ${lamportsToSol(floor)} SOL)`);
    } catch (e) {
      report.cross('signer SOL', String(e.message).slice(0, 160), { fix: 'check the RPC endpoint (SOLANA_RPC_URL in curator/signer.env, or --rpc)' });
    }
  } else {
    report.skip('signer SOL', 'needs the key and the policy');
  }

  // The portfolio row.
  let row = null;
  let pools = [];
  const mint = compose.CURATOR_PORTFOLIO_MINT;
  if (mint) {
    try {
      const api = apiClient({ apiUrl: compose.CURATOR_API_URL, fetchImpl, timeoutMs: NET_TIMEOUT_MS });
      row = await resolvePortfolio(api, mint);
      if (!row) report.cross('portfolio row', `no portfolio ${mint} at ${compose.CURATOR_API_URL}`, { fix: 'the mint in compose.env is not a weavr portfolio; run init again with the right ticker' });
      else pools = await listPools(api);
    } catch (e) {
      report.cross('portfolio row', String(e.message).slice(0, 160), { fix: 'check CURATOR_API_URL in compose.env and the network' });
    }
  } else {
    report.skip('portfolio row', 'needs CURATOR_PORTFOLIO_MINT in compose.env');
  }
  if (row) {
    if (row.mint === mint) report.ok('mint', `${row.symbol} is ${mint}`);
    else report.cross('mint', `compose.env names ${mint} but the api answered ${row.mint}`, { fix: 'run weavr-curator init again' });
    if (key) {
      if (row.curator === key && row.pendingCurator) {
        report.cross('curator', `a handover away from ${key} is pending: ${row.pendingCurator} is the pending curator of ${row.symbol}`, {
          fix: `if you did not start it (weavr-curator ops rotate-curator), the key has leaked: cancel it with the key, POST /v1/portfolios/${mint}/curator/cancel { signer: "${key}" } (build_cancel_curator on an MCP host) signed by ${paths.keyFile} and sent through /v1/transactions/send, then rotate the key; if you did, finish the accept from the new key`,
        });
      } else if (row.curator === key) report.ok('curator', `${key} curates ${row.symbol}, no handover pending`);
      else if (row.pendingCurator === key) report.cross('curator', `handover pending: ${row.curator} still curates, ${key} is the pending curator`, { fix: `weavr-curator init --portfolio ${mint} --home ${home} accepts it with the key` });
      else report.cross('curator', `${row.curator} curates ${row.symbol}, not ${key}${row.pendingCurator ? ` (pending curator ${row.pendingCurator})` : ''}`, { fix: `hand curation to ${key}: weavr-curator init --portfolio ${mint} --home ${home} --wait prints the transfer the current curator must sign and accepts it once it lands` });
    } else {
      report.skip('curator', 'needs the key');
    }
    if (policy?.invariants) {
      const want = Number(policy.invariants.rebalanceDelaySecs);
      const have = Number(row.rebalanceDelaySecs);
      if (want === have) report.ok('notice', `${have}s onchain and in policy.invariants.rebalanceDelaySecs`);
      else {
        // init writes a preset over the file, so the init it tells the owner
        // to run names the preset the home runs; a file that matches none
        // holds the owner's edits, and the one number is changed by hand.
        const rewrite = preset
          ? `weavr-curator init --portfolio ${mint} --home ${home} --policy ${preset} again (it rewrites invariants.rebalanceDelaySecs to the chain's ${have}s and keeps the ${preset} preset)`
          : `set invariants.rebalanceDelaySecs to ${have} in ${paths.policyFile} by hand (the file matches no shipped preset, so init would write a preset over your edits)`;
        report.cross('notice', `${row.symbol} announces ${have}s; policy.invariants.rebalanceDelaySecs is ${want}; the signer self-locks on this and, while locked, refuses every write, set-delay included`, { fix: `${rewrite}, restart the signer, then weavr-curator ops unlock --why "<reason>" --home ${home}. To move the notice onchain to ${want}s instead, run weavr-curator ops set-delay --rebalance-delay-secs ${want} --why "<reason>" --home ${home} from an unlocked signer whose policy file already carries ${want}s (it locks on its next tick), then restart it and unlock` });
      }
      const items = validatePolicyAgainstBook(policy, row, pools, { presetName: 'the policy' });
      if (items.length) report.cross('policy vs book', `the policy refuses ${row.symbol} as it stands (${items.length} item${items.length === 1 ? '' : 's'})`, { details: items.flatMap((i) => [`${i.code}: ${i.message}`, `  fix: ${i.fix}`]), items });
      else report.ok('policy vs book', `the policy admits ${legsText(legsOf(row, pools))}`);
    } else {
      report.skip('notice', 'needs the policy file');
      report.skip('policy vs book', 'needs the policy file');
    }
    if (compose.CURATOR_TREASURY) {
      if (row.feeRecipient === compose.CURATOR_TREASURY) report.ok('treasury', compose.CURATOR_TREASURY);
      else report.cross('treasury', `compose.env CURATOR_TREASURY is ${compose.CURATOR_TREASURY}; the fee recipient onchain is ${row.feeRecipient}`, { fix: 'run weavr-curator init again to re-derive it (the signer self-locks on this)' });
    }
  } else {
    for (const name of ['mint', 'curator', 'notice', 'policy vs book', 'treasury']) report.skip(name, 'needs the portfolio row');
  }

  // The guardian.
  if (compose.CURATOR_EXPECTED_GUARDIAN) {
    let factoryProgram;
    try {
      factoryProgram = factoryProgramFrom(JSON.parse(fs.readFileSync(join(repoRoot, 'manifest.json'), 'utf8')));
    } catch {
      factoryProgram = factoryProgramFrom(null);
    }
    try {
      const factory = await readFactoryConfig(rpc, factoryProgram);
      if (!factory.ok) report.cross('guardian', `FactoryConfig ${factory.address}: ${factory.reason}`, { fix: 'not guessing; check the RPC endpoint and the factory program id in manifest.json' });
      else if (factory.guardian === compose.CURATOR_EXPECTED_GUARDIAN) report.ok('guardian', factory.guardian);
      else report.cross('guardian', `compose.env CURATOR_EXPECTED_GUARDIAN is ${compose.CURATOR_EXPECTED_GUARDIAN}; the factory says ${factory.guardian}`, { fix: 'run weavr-curator init again to re-derive it (the signer self-locks on this)' });
    } catch (e) {
      report.cross('guardian', String(e.message).slice(0, 160), { fix: 'check the RPC endpoint' });
    }
  } else {
    report.skip('guardian', 'needs CURATOR_EXPECTED_GUARDIAN in compose.env');
  }

  // The signer.
  const tickMs = Number(compose.CURATOR_TICK_MS) > 0 ? Number(compose.CURATOR_TICK_MS) : DEFAULT_TICK_MS;
  const healthz = await http(`${signerUrl}/healthz`);
  let signerUp = false;
  if (healthz.failure) {
    report.cross('signer health', `no signer at ${signerUrl} (${healthz.failure})`, { fix: 'start the stack: docker compose --env-file <home>/compose.env -f curator/compose/curator.yml up -d, or pass --signer-url' });
  } else if (healthz.status === 404) {
    report.cross('signer health', `no signer at ${signerUrl} (404 on /healthz)`, { fix: 'something else answers on that port; pass --signer-url' });
  } else if (!healthz.json?.ok) {
    report.cross('signer health', `/healthz ${healthz.status}: ${healthz.json?.error ?? 'not ok'}${healthz.json?.lastTickAgeSecs != null ? ` (last tick ${healthz.json.lastTickAgeSecs}s ago)` : ''}`, { fix: 'docker compose logs signer; a boot refusal names its reason on one line' });
  } else {
    const age = Number(healthz.json.lastTickAgeSecs);
    const maxAge = (3 * tickMs) / 1000;
    if (Number.isFinite(age) && age > maxAge) report.cross('signer health', `last tick ${age}s ago, over three ticks (${maxAge}s)`, { fix: 'docker compose logs signer; the loop has stalled' });
    else { signerUp = true; report.ok('signer health', `${signerUrl} up, last tick ${Number.isFinite(age) ? `${age}s ago` : 'unknown'}`); }
  }
  if (signerUp && signerTok.ok) {
    const status = await http(`${signerUrl}/status`, { headers: { authorization: `Bearer ${signerTok.token}`, 'x-curator-session': 'chat', 'x-curator-caller': 'weavr-curator-cli' } });
    if (status.failure) {
      report.cross('signer status', `${status.failure}`, { fix: 'the signer answered /healthz but not /status; docker compose logs signer' });
    } else if (status.status === 401) {
      report.cross('signer status', 'token mismatch: the running signer does not accept the token in curator/signer-token', { fix: `${paths.signerToken}, CURATOR_SIGNER_TOKEN in ${paths.signerEnv} and in ${paths.agentEnv} must be one value (the tokens check above names any copy that differs); then restart the signer with ${paths.signerEnv}` });
    } else if (status.status === 404) {
      report.cross('signer status', `no signer at ${signerUrl} (404 on /status)`, { fix: 'something else answers on that port; pass --signer-url' });
    } else if (status.status < 200 || status.status >= 300 || !status.json) {
      report.cross('signer status', `HTTP ${status.status}`, { fix: 'docker compose logs signer' });
    } else {
      const s = status.json;
      if (s.ok === true) report.ok('signer status', 'answers with a fresh snapshot');
      else report.cross('signer status', `the signer answers ok:false${s.error ? `: ${String(s.error).slice(0, 160)}` : ''} (its snapshot read failed; the fields below are its last good snapshot)`, { fix: 'docker compose logs signer; the tick names what it could not read (the api or the rpc)' });
      if (s.paused) report.cross('signer paused', 'the signer is paused; it applies nothing and refuses every write except cancel', { fix: `weavr-curator ops resume --home ${home}` });
      else report.ok('signer paused', 'no');
      if (s.selfLocked) {
        const drift = Array.isArray(s.invariants?.drift) ? s.invariants.drift : [];
        report.cross('signer lock', `self-locked${s.selfLocked.reason ? `: ${s.selfLocked.reason}` : ''}${s.selfLocked.at ? ` (since ${s.selfLocked.at})` : ''}`, {
          details: drift.map((d) => `${d.invariant}: expected ${d.expected}, actual ${d.actual}`),
          drift,
          fix: `clear the drift above, then weavr-curator ops unlock --why "<reason>" --home ${home}`,
        });
      } else {
        report.ok('signer lock', 'not self-locked');
      }
      if (s.invariants?.ok === true) report.ok('signer invariants', 'hold');
      else report.cross('signer invariants', s.invariants?.ok === null || s.invariants?.ok === undefined ? 'no snapshot yet' : `drift: ${(s.invariants.drift ?? []).map((d) => `${d.invariant} expected ${d.expected}, actual ${d.actual}`).join('; ')}`, { fix: 'the checks above name what drifted; the signer re-checks every tick' });
      if (policy) {
        const local = policyDigest(policy);
        if (s.policy?.sha256 === local) report.ok('signer policy', `sha256 ${local.slice(0, 12)} matches ${paths.policyFile}`);
        else report.cross('signer policy', `the running signer loaded another document (sha256 ${String(s.policy?.sha256 ?? 'none').slice(0, 12)}, local ${local.slice(0, 12)})`, { fix: 'restart the signer: docker compose --env-file <home>/compose.env -f curator/compose/curator.yml restart signer' });
      }
      if (key) {
        if (s.signer?.wallet === key) report.ok('signer wallet', key);
        else report.cross('signer wallet', `the signer holds ${s.signer?.wallet ?? 'no key'}, not ${key}`, { fix: 'CURATOR_KEY_FILE in compose.env must be the key file above; restart the signer' });
      }
    }
  } else {
    for (const name of ['signer status', 'signer paused', 'signer lock', 'signer invariants', 'signer policy', 'signer wallet']) report.skip(name, signerUp ? 'needs the agent token' : 'needs the signer');
  }

  // The agent home.
  let cfgModel = { provider: null, model: null };
  let pluginsEnabled = [];
  if (exists(paths.configYaml, fs)) {
    const yaml = fs.readFileSync(paths.configYaml, 'utf8');
    cfgModel = readConfigModel(yaml);
    pluginsEnabled = readPluginsEnabled(yaml);
  } else {
    report.cross('agent config', `${paths.configYaml} is missing`, { fix: 'run weavr-curator init again; it renders the profile' });
  }
  const provider = providerFor(cfgModel.provider);
  let providerKey = '';
  if (!cfgModel.provider) {
    report.cross('agent provider', 'config.yaml names no model.provider', { fix: 'set model.provider in hermes-home/config.yaml' });
  } else if (!provider) {
    report.skip('agent provider', `config.yaml names "${cfgModel.provider}", which this tool does not know (Hermes knows ${Object.keys(PROVIDERS).join(', ')} here); its credential is not checked`);
  } else {
    const variable = [provider.variable, ...provider.alternates].find((v) => agentEnv[v] && String(agentEnv[v]).trim() !== '') ?? null;
    providerKey = variable ? String(agentEnv[variable]).trim() : '';
    if (variable) report.ok('agent provider', `${cfgModel.provider} reads ${variable}, set in hermes-home/.env`);
    else report.cross('agent provider', `config.yaml model.provider "${cfgModel.provider}" reads ${provider.variable}, which is empty in hermes-home/.env`, { fix: `set ${provider.variable} in ${paths.agentEnv}` });
  }
  if (exists(paths.jobsJson, fs)) {
    // A file with no jobs, or with fewer than the profile ships, would pass a
    // check that only compares what is there: the profile's ids are required
    // by name first, then the agent jobs' provider and model.
    let doc;
    try { doc = JSON.parse(fs.readFileSync(paths.jobsJson, 'utf8')); } catch { doc = undefined; }
    const jobs = Array.isArray(doc) ? doc : Array.isArray(doc?.jobs) ? doc.jobs : null;
    if (doc === undefined) {
      report.cross('agent jobs', `${paths.jobsJson} is not valid JSON`, { fix: 'run weavr-curator init again; it renders the profile' });
    } else if (!jobs) {
      report.cross('agent jobs', `${paths.jobsJson} holds no jobs array`, { fix: 'run weavr-curator init again; it renders the profile' });
    } else {
      const rows = jobs.filter((j) => j && typeof j === 'object');
      const ids = new Set(rows.map((j) => j.id));
      const missing = PROFILE_JOB_IDS.filter((id) => !ids.has(id));
      const agentJobs = rows.filter((j) => j.no_agent !== true);
      const off = agentJobs.filter((j) => j.provider !== cfgModel.provider || j.model !== cfgModel.model);
      if (missing.length) report.cross('agent jobs', `${paths.jobsJson} lacks ${missing.join(', ')} (the profile ships ${PROFILE_JOB_IDS.join(', ')}; a job that is not there never runs, and nothing reports its absence)`, { fix: 'run weavr-curator init again; it merges the profile\'s jobs into the file and keeps the state of the ones already there' });
      else if (off.length) report.cross('agent jobs', `${off.map((j) => `${j.id ?? j.name} pins ${j.provider ?? 'no provider'} / ${j.model ?? 'no model'}`).join('; ')}; config.yaml runs ${cfgModel.provider} / ${cfgModel.model} (a job on a provider with no credential fails inside cron, invisible in chat)`, { fix: `set provider and model on those jobs in ${paths.jobsJson} to match config.yaml` });
      else report.ok('agent jobs', `${PROFILE_JOB_IDS.join(', ')} present; ${agentJobs.length} agent job${agentJobs.length === 1 ? '' : 's'} pin ${cfgModel.provider} / ${cfgModel.model} like config.yaml`);
    }
  } else {
    report.cross('agent jobs', `${paths.jobsJson} is missing`, { fix: 'run weavr-curator init again; it renders the profile' });
  }
  // The two values the plugin reads to build the approval text the owner
  // sees; init copies them from chain, and a set-delay since then leaves them stale.
  if (row) {
    const envNotice = String(agentEnv.CURATOR_REBALANCE_DELAY_SECS ?? '').trim();
    const envSymbol = String(agentEnv.CURATOR_PORTFOLIO_SYMBOL ?? '').trim();
    const off = [];
    if (envNotice === '' || Number(envNotice) !== Number(row.rebalanceDelaySecs)) off.push(`CURATOR_REBALANCE_DELAY_SECS is ${envNotice || 'empty'}; ${row.symbol} announces ${row.rebalanceDelaySecs}s`);
    if (envSymbol !== String(row.symbol)) off.push(`CURATOR_PORTFOLIO_SYMBOL is ${envSymbol || 'empty'}; the row says ${row.symbol}`);
    if (off.length) report.cross('agent env', `${off.join('; ')} (the approval text the agent shows reads these)`, { fix: 'run weavr-curator init again; it rewrites them from chain; then restart the agent' });
    else report.ok('agent env', `${row.symbol} and its ${row.rebalanceDelaySecs}s notice in hermes-home/.env, as onchain`);
  } else {
    report.skip('agent env', 'needs the portfolio row');
  }
  const pluginPresent = exists(join(paths.pluginDir, '__init__.py'), fs);
  if (!pluginsEnabled.includes('weavr-curator')) report.cross('agent plugin', 'config.yaml plugins.enabled does not list weavr-curator', { fix: 'add weavr-curator to plugins.enabled in hermes-home/config.yaml' });
  else if (!pluginPresent) report.cross('agent plugin', `${paths.pluginDir} is missing`, { fix: 'run weavr-curator init again; it copies the plugin' });
  else report.ok('agent plugin', `weavr-curator enabled and present in ${paths.pluginDir}`);

  const botToken = String(agentEnv.TELEGRAM_BOT_TOKEN ?? '').trim();
  const allowed = String(agentEnv.TELEGRAM_ALLOWED_USERS ?? '').trim();
  const homeChannel = String(agentEnv.TELEGRAM_HOME_CHANNEL ?? '').trim();
  const telegramProblems = [];
  if (!botToken) telegramProblems.push('TELEGRAM_BOT_TOKEN is empty');
  if (!allowed) telegramProblems.push('TELEGRAM_ALLOWED_USERS is empty (an empty allow-list is fail-open)');
  else if (!NUMERIC_CSV.test(allowed)) telegramProblems.push('TELEGRAM_ALLOWED_USERS is not a comma-separated list of numeric ids');
  if (!homeChannel) telegramProblems.push('TELEGRAM_HOME_CHANNEL is empty');
  if (telegramProblems.length) report.cross('telegram env', telegramProblems.join('; '), { fix: `set them in ${paths.agentEnv}` });
  else report.ok('telegram env', `bot token, ${allowed.split(',').length} allowed id${allowed.includes(',') ? 's' : ''}, home channel set`);
  if (botToken) {
    const me = await http(`${telegramApi}/bot${botToken}/getMe`);
    if (me.failure) report.cross('telegram bot', `getMe: ${me.failure}`, { fix: 'check the network; the Telegram api did not answer' });
    else if (me.json?.ok && me.json.result?.username) report.ok('telegram bot', `@${me.json.result.username}`);
    else report.cross('telegram bot', `getMe answered ${me.status}${me.json?.description ? `: ${me.json.description}` : ''}`, { fix: `check TELEGRAM_BOT_TOKEN in ${paths.agentEnv} against BotFather` });
  } else {
    report.skip('telegram bot', 'needs TELEGRAM_BOT_TOKEN');
  }
  if (provider && providerKey) {
    const base = String(providerBases[cfgModel.provider] ?? provider.baseUrl).replace(/\/$/, '');
    const headers = provider.auth === 'x-api-key' ? { 'x-api-key': providerKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${providerKey}` };
    const models = await http(`${base}/models`, { headers });
    if (models.failure) report.cross('provider key', `GET /models: ${models.failure}`, { fix: 'check the network; the provider did not answer' });
    else if (models.status >= 200 && models.status < 300) report.ok('provider key', `${cfgModel.provider} answers HTTP ${models.status}`);
    else report.cross('provider key', `${cfgModel.provider} answers HTTP ${models.status}`, { fix: `check ${provider.variable} in ${paths.agentEnv}` });
  } else {
    report.skip('provider key', provider ? 'needs the provider variable' : 'unknown provider');
  }

  // The heartbeat.
  if (signerUp) {
    const metrics = await http(`${signerUrl}/metrics`, { headers: { accept: 'text/plain' } });
    if (metrics.failure || metrics.status !== 200) {
      report.cross('agent heartbeat', `GET /metrics ${metrics.failure ?? `HTTP ${metrics.status}`}`, { fix: 'docker compose logs signer' });
    } else {
      const g = parseMetrics(metrics.text);
      const lastTick = Number(g.curator_last_tick_ts ?? 0);
      const heartbeat = Number(g.curator_hermes_heartbeat_ts ?? 0);
      if (!('curator_last_tick_ts' in g)) {
        // A 200 with no gauge to read is not a signer that has not ticked; it is a body this check cannot read.
        const others = Object.keys(g).length;
        report.cross('agent heartbeat', others ? `/metrics answered but carries no curator_last_tick_ts gauge (${others} other curator gauges): an older signer image` : '/metrics answered but carries no curator gauges: not this signer, or an older image', { fix: 'pass --signer-url for the curator signer, or rebuild the signer image from a current checkout of the weavr backend and restart it' });
      } else if (!(lastTick > 0)) {
        report.skip('agent heartbeat', 'the signer has not ticked yet');
      } else if (lastTick - heartbeat > HEARTBEAT_MAX_SECS) {
        report.cross('agent heartbeat', `curator-health has not ticked: the gateway is not running the cron (${heartbeat > 0 ? `last heartbeat ${Math.round((lastTick - heartbeat) / 60)} min before the signer's last tick` : 'no heartbeat yet; the health job runs every quarter hour, so a stack up longer than that has a gateway problem'})`, { fix: 'docker compose logs agent; the gateway must be running with the curator-health job enabled in hermes-home/cron/jobs.json' });
      } else {
        report.ok('agent heartbeat', `curator-health ticked ${Math.round((lastTick - heartbeat) / 60)} min before the signer's last tick`);
      }
    }
  } else {
    report.skip('agent heartbeat', 'needs the signer');
  }

  // Docker.
  const docker = exec('docker', ['--version']);
  if (docker.status !== 0) {
    for (const name of ['docker', 'signer image', 'agent image', 'containers']) report.skip(name, 'docker is not on PATH here');
  } else {
    report.ok('docker', String(docker.stdout).trim().split('\n')[0] || 'present');
    const images = [['signer image', compose.CURATOR_SIGNER_IMAGE || 'weavr-backend:curator-local'], ['agent image', compose.HERMES_IMAGE || 'hermes-agent']];
    for (const [name, image] of images) {
      const r = exec('docker', ['image', 'inspect', image]);
      if (r.status === 0) report.ok(name, image);
      else report.cross(name, `${image} is not a local image`, { fix: name === 'signer image' ? 'build it from a checkout of the weavr backend: docker build -t weavr-backend:curator-local <backend> (or set CURATOR_SIGNER_IMAGE in compose.env)' : 'build the agent image from the Claw Agent checkout (docker compose build there), or set HERMES_IMAGE in compose.env' });
    }
    if (exists(paths.composeEnv, fs)) {
      const yml = join(repoRoot, 'curator', 'compose', 'curator.yml');
      const ps = exec('docker', ['compose', '--env-file', paths.composeEnv, '-f', yml, 'ps', '--format', 'json']);
      if (ps.status !== 0) {
        report.cross('containers', `docker compose ps failed${ps.stderr ? `: ${String(ps.stderr).trim().split('\n')[0].slice(0, 120)}` : ''}`, { fix: `docker compose --env-file ${paths.composeEnv} -f ${yml} up -d` });
      } else {
        const rows = [];
        for (const line of String(ps.stdout).split(/\r?\n/)) {
          const t = line.trim();
          if (!t) continue;
          try {
            const parsed = JSON.parse(t);
            rows.push(...(Array.isArray(parsed) ? parsed : [parsed]));
          } catch { /* not a row */ }
        }
        const running = new Set(rows.filter((r) => String(r.State ?? r.state ?? '').toLowerCase() === 'running').map((r) => r.Service ?? r.service));
        const missing = ['signer', 'agent'].filter((s) => !running.has(s));
        if (missing.length) report.cross('containers', `${missing.join(' and ')} not running`, { fix: `docker compose --env-file ${paths.composeEnv} -f ${yml} up -d` });
        else report.ok('containers', 'signer and agent running');
      }
    } else {
      report.skip('containers', 'needs compose.env');
    }
  }
  return done();
}
