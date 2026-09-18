/**
 * What init renders and the doctor reads back: the agent home (the profile,
 * the plugin and .env), the signer's env, the compose variables. The two
 * readers of config.yaml here are deliberately tiny: the profile's `model`
 * block and `plugins.enabled` are the only keys the commands need, and the
 * runtime has no YAML parser (the CLI's one dependency is @solana/web3.js).
 */
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { exists, renderEnv } from './home.mjs';

/**
 * Provider -> the credential variable and the models endpoint that proves
 * the key (hermes_cli/auth.py). Anything else is unknown to the doctor.
 */
export const PROVIDERS = Object.freeze({
  'openai-api': { variable: 'OPENAI_API_KEY', alternates: [], baseUrl: 'https://api.openai.com/v1', auth: 'bearer' },
  anthropic: { variable: 'ANTHROPIC_API_KEY', alternates: ['ANTHROPIC_TOKEN'], baseUrl: 'https://api.anthropic.com/v1', auth: 'x-api-key' },
});

export const providerFor = (name) => PROVIDERS[name] ?? null;

/** The value of one `key:` line: quotes stripped, a trailing comment cut. */
function scalar(raw) {
  let v = String(raw).trim();
  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

/** The indented lines of one top-level block of a YAML file. */
function topLevelBlock(text, key) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !/^#/.test(line)) break;
    body.push(line);
  }
  return body;
}

function scalarIn(block, key) {
  const line = (block ?? []).find((l) => new RegExp(`^\\s+${key}:\\s*\\S`).test(l));
  return line ? scalar(line.replace(new RegExp(`^\\s+${key}:`), '')) : null;
}

/** `{ provider, model }` from the profile's `model:` block; null fields when absent. */
export function readConfigModel(yamlText) {
  const block = topLevelBlock(yamlText, 'model');
  return { provider: scalarIn(block, 'provider'), model: scalarIn(block, 'default') };
}

/** The names in `plugins: enabled: [a, b]` (flow form) or a dash list. */
export function readPluginsEnabled(yamlText) {
  const block = topLevelBlock(yamlText, 'plugins');
  if (!block) return [];
  const idx = block.findIndex((l) => /^\s+enabled:/.test(l));
  if (idx < 0) return [];
  const rest = block[idx].replace(/^\s+enabled:/, '').trim();
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    return rest.slice(1, end < 0 ? undefined : end).split(',').map((s) => scalar(s)).filter(Boolean);
  }
  const names = [];
  for (const line of block.slice(idx + 1)) {
    const m = /^\s+-\s*(.+)$/.exec(line);
    if (!m) break;
    names.push(scalar(m[1]));
  }
  return names;
}

/**
 * Every `${NAME}`, `${NAME:-default}` and `${NAME:?message}` a compose file
 * references, in order of first appearance, with the default when it has one.
 */
export function composeVariables(ymlText) {
  const seen = new Map();
  const re = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*)|:\?[^}]*)?\}/g;
  for (const m of String(ymlText).matchAll(re)) {
    if (!seen.has(m[1])) seen.set(m[1], { name: m[1], fallback: m[2] ?? null });
  }
  return [...seen.values()];
}

/**
 * One compose project per book. The default project name is the compose
 * file's directory (`compose`), so two homes started from the same checkout
 * share a journal volume and can mount the wrong key. `weavr-` plus the
 * onchain symbol (letters and digits only) keeps them apart.
 */
export function composeProjectName(symbol) {
  const s = String(symbol ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s ? `weavr-${s}` : 'weavr-curator';
}

/**
 * The non-secret compose variables for one home. `values` are the ones init
 * derived; any variable the compose file references and `values` does not
 * name gets its compose default (or an empty line) so the stack still starts.
 */
export function renderComposeEnv(ymlText, values) {
  const items = [
    { comment: 'weavr-curator: the non-secret variables curator/compose/curator.yml expects. Written by weavr-curator init; re-run init to re-derive.' },
    { comment: 'Start the stack with: docker compose --env-file <this file> -f curator/compose/curator.yml up -d' },
  ];
  for (const { name, fallback } of composeVariables(ymlText)) {
    items.push({ key: name, value: values[name] ?? fallback ?? '' });
  }
  return renderEnv(items);
}

/** The signer's secret env file: the two tokens and the RPC endpoint. */
export function renderSignerEnv({ signerToken, opsToken, rpcUrl }) {
  return renderEnv([
    { comment: 'The curator signer\'s secrets (mode 0600). Written by weavr-curator init; never copy a value anywhere else.' },
    { key: 'CURATOR_SIGNER_TOKEN', value: signerToken, comment: 'Bearer the agent uses; the same value is in hermes-home/.env.' },
    { key: 'CURATOR_OPS_TOKEN', value: opsToken, comment: 'Bearer for resume, unlock, rotate-curator, set-delay and operator requests; only this machine holds it.' },
    rpcUrl
      ? { key: 'SOLANA_RPC_URL', value: rpcUrl, comment: 'Solana RPC endpoint. Never logged, never journaled, never in an error.' }
      : { key: 'SOLANA_RPC_URL', commentedOut: true, comment: 'Set a private Solana RPC endpoint here (a paid provider URL): the public endpoint rate-limits the signer\'s tick. Or re-run init with --rpc <url>.' },
  ]);
}

/** The keys the owner fills by hand; a non-empty value there survives a re-run. */
export const OWNER_KEYS = Object.freeze(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL']);

/**
 * The agent's .env. Derived values are written afresh; the provider variable
 * and the three Telegram lines keep whatever non-empty value the owner typed
 * before (`existing`), and extra keys the owner added are kept at the end.
 */
export function renderAgentEnv({ provider, providerVariable, signerToken, signerUrl = 'http://signer:8091', mcpUrl, apiUrl, symbol, rebalanceDelaySecs, existing = {} }) {
  const keep = (key) => (existing[key] && String(existing[key]).trim() !== '' ? existing[key] : '');
  const providerKey = providerVariable ?? null;
  const items = [
    { comment: 'The curator agent\'s environment (mode 0600). Written by weavr-curator init; the four lines the owner fills keep their values on a re-run.' },
    { blank: true },
    providerKey
      ? { key: providerKey, value: keep(providerKey), comment: `Model provider key: config.yaml model.provider "${provider}" reads ${providerKey}.` }
      : { comment: `config.yaml names the provider "${provider}", which this tool does not know: add its credential variable here by hand.` },
    { key: 'TELEGRAM_BOT_TOKEN', value: keep('TELEGRAM_BOT_TOKEN'), comment: 'Telegram: the bot token from BotFather.' },
    { key: 'TELEGRAM_ALLOWED_USERS', value: keep('TELEGRAM_ALLOWED_USERS'), comment: 'Telegram: the numeric user ids allowed to talk to the bot, comma-separated. An empty list is fail-open; the doctor refuses it.' },
    { key: 'TELEGRAM_HOME_CHANNEL', value: keep('TELEGRAM_HOME_CHANNEL'), comment: 'Telegram: the chat id the briefs land in.' },
    { blank: true },
    { key: 'CURATOR_SIGNER_URL', value: signerUrl, comment: 'The signer as reached from inside the compose network (curator.yml).' },
    { key: 'CURATOR_SIGNER_TOKEN', value: signerToken, comment: 'The same value as CURATOR_SIGNER_TOKEN in the signer\'s env file.' },
    { key: 'WEAVR_MCP_URL', value: mcpUrl, comment: 'weavr\'s MCP server (the read tools).' },
    { key: 'WEAVR_API_URL', value: apiUrl, comment: 'weavr\'s api, for the universe watch\'s fallback.' },
    { key: 'CURATOR_PORTFOLIO_SYMBOL', value: symbol, comment: 'The portfolio\'s ticker and its onchain notice, copied from chain by init; they shape the approval text the owner reads.' },
    { key: 'CURATOR_REBALANCE_DELAY_SECS', value: String(rebalanceDelaySecs) },
  ];
  const known = new Set(items.filter((i) => i.key).map((i) => i.key));
  const extras = Object.entries(existing).filter(([k]) => !known.has(k));
  if (extras.length) {
    items.push({ blank: true }, { comment: 'Kept from the previous file.' });
    for (const [key, value] of extras) items.push({ key, value });
  }
  return { text: renderEnv(items), ownerKeys: [...(providerKey ? [providerKey] : []), ...OWNER_KEYS] };
}

/**
 * The fields of a cron job the gateway writes as it runs; a re-render keeps
 * them and takes everything else (the prompt, the schedule, the model) from
 * the profile.
 */
export const JOB_STATE_FIELDS = Object.freeze(['enabled', 'state', 'paused_at', 'paused_reason', 'next_run_at', 'last_run_at', 'last_status', 'last_error', 'last_delivery_error', 'failure_streak', 'monitor_state', 'created_at']);

/**
 * The profile's cron/jobs.json over the one already in the agent home:
 * definitions from the profile, per-job state from the home, and any job
 * the owner added (an id the profile does not know) kept after them.
 */
export function mergeJobs(profileDoc, existingDoc) {
  const previous = new Map((existingDoc?.jobs ?? []).filter((j) => j && j.id).map((j) => [j.id, j]));
  const jobs = (profileDoc.jobs ?? []).map((job) => {
    const prev = previous.get(job.id);
    if (!prev) return job;
    const merged = { ...job };
    for (const field of JOB_STATE_FIELDS) if (field in prev) merged[field] = prev[field];
    if (prev.repeat && typeof prev.repeat === 'object') merged.repeat = { ...(job.repeat ?? {}), completed: prev.repeat.completed ?? job.repeat?.completed ?? 0 };
    return merged;
  });
  const known = new Set(jobs.map((j) => j.id));
  for (const j of existingDoc?.jobs ?? []) if (j && j.id && !known.has(j.id)) jobs.push(j);
  return { ...profileDoc, jobs };
}

/** Files under the profile that are the agent's own once it runs: never replaced when present. */
export const AGENT_STATE_PREFIXES = Object.freeze(['memories/']);

/**
 * Render the profile into the agent home and the plugin beside it (Python
 * caches skipped). Every profile file is written afresh except the agent's
 * own state: a memories/ file already there is kept, and cron/jobs.json is
 * merged so the gateway's per-job state (enabled, last run, streaks)
 * survives. Returns `{ written, replaced, kept, merged }` (paths relative to
 * the agent home) so the caller can say what a re-run changed.
 */
export function copyProfile({ profileDir, pluginDir, hermesHome, pluginTarget }, fs = nodeFs) {
  const out = { written: [], replaced: [], kept: [], merged: [] };
  const walk = (rel) => {
    for (const entry of fs.readdirSync(join(profileDir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const src = join(profileDir, relPath);
      const dst = join(hermesHome, relPath);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        walk(relPath);
        continue;
      }
      const present = exists(dst, fs);
      if (present && AGENT_STATE_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
        out.kept.push(relPath);
        continue;
      }
      if (present && relPath === 'cron/jobs.json') {
        let previous = null;
        try { previous = JSON.parse(fs.readFileSync(dst, 'utf8')); } catch { previous = null; }
        if (previous && Array.isArray(previous.jobs)) {
          fs.writeFileSync(dst, `${JSON.stringify(mergeJobs(JSON.parse(fs.readFileSync(src, 'utf8')), previous), null, 2)}\n`);
          out.merged.push(relPath);
          continue;
        }
      }
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
      (present ? out.replaced : out.written).push(relPath);
    }
  };
  fs.mkdirSync(hermesHome, { recursive: true });
  walk('');
  fs.mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
  fs.cpSync(pluginDir, pluginTarget, {
    recursive: true,
    force: true,
    filter: (src) => !/__pycache__|\.pyc$/.test(src),
  });
  return out;
}
