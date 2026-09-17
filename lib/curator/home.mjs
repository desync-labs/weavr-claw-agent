/**
 * The curator home: one directory per portfolio, mode 0700, holding the key,
 * the two tokens, the policy, the two env files and the rendered agent home.
 * Every write of a secret goes through `writeSecret` (0600, and chmod after,
 * so a re-run repairs a loosened mode); nothing here prints a value. `fs` is
 * injectable everywhere so the tests can run on temp homes.
 */
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_ROOT = () => join(homedir(), '.config', 'weavr-curator');
export const MIN_TOKEN_BYTES = 32;

/** Every path the commands read or write under one home. */
export function homePaths(home) {
  const hermesHome = join(home, 'hermes-home');
  return {
    home,
    solanaDir: join(home, 'solana'),
    curatorDir: join(home, 'curator'),
    keyFile: join(home, 'solana', 'curator.json'),
    signerToken: join(home, 'curator', 'signer-token'),
    opsToken: join(home, 'curator', 'ops-token'),
    policyFile: join(home, 'curator', 'policy.json'),
    signerEnv: join(home, 'curator', 'signer.env'),
    composeEnv: join(home, 'compose.env'),
    hermesHome,
    agentEnv: join(hermesHome, '.env'),
    configYaml: join(hermesHome, 'config.yaml'),
    jobsJson: join(hermesHome, 'cron', 'jobs.json'),
    pluginDir: join(hermesHome, 'plugins', 'weavr-curator'),
  };
}

/**
 * The home a command works on: `--home` when given, else the one directory
 * under the default root, else an error that lists what is there (or says
 * nothing is, and how init makes one).
 */
export function resolveHome(given, { root = DEFAULT_ROOT(), fs = nodeFs } = {}) {
  if (given) return resolve(String(given));
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    entries = [];
  }
  if (entries.length === 1) return join(root, entries[0]);
  if (entries.length === 0) throw new Error(`no curator home under ${root}; run weavr-curator init --portfolio <ticker> first, or pass --home <dir>`);
  throw new Error(`several curator homes under ${root} (${entries.join(', ')}); pass --home ${join(root, '<TICKER>')}`);
}

/** mkdir -p with an exact mode (mkdir's own mode is subject to the umask). */
export function ensureDir(dir, mode, fs = nodeFs) {
  fs.mkdirSync(dir, { recursive: true, mode });
  fs.chmodSync(dir, mode);
}

/** Write a secret file at 0600, replacing what is there. */
export function writeSecret(file, text, fs = nodeFs) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Write a secret file at 0600 only if it does not exist (flag wx). */
export function writeNewSecret(file, text, fs = nodeFs) {
  fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

export const exists = (file, fs = nodeFs) => {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
};

/** The permission bits of a file, or null when it cannot be stat'ed. */
export function modeOf(file, fs = nodeFs) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

export const tooOpen = (mode) => mode === null || (mode & 0o077) !== 0;

/** A fresh bearer token: 32 random bytes as 64 hex chars. */
export const generateToken = () => randomBytes(32).toString('hex');

/**
 * Read a token file. Returns `{ ok: true, token }` or `{ ok: false, reason }`
 * naming the file and never its content: missing, too open (group or world
 * bits), under 32 bytes, or carrying whitespace inside (the signer refuses
 * that at boot).
 */
export function readTokenFile(file, fs = nodeFs) {
  const mode = modeOf(file, fs);
  if (mode === null) return { ok: false, reason: `${file} is missing` };
  if (tooOpen(mode)) return { ok: false, reason: `${file} must be mode 0600 (is ${mode.toString(8)})` };
  let text;
  try {
    text = String(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: `${file} cannot be read` };
  }
  const token = text.trim();
  if (Buffer.byteLength(token) < MIN_TOKEN_BYTES) return { ok: false, reason: `${file} holds no usable token (need at least ${MIN_TOKEN_BYTES} bytes)` };
  if (/\s/.test(token)) return { ok: false, reason: `${file} holds whitespace inside the token` };
  return { ok: true, token };
}

/** `KEY=value` lines to a map; comments and blank lines skipped, quotes stripped, `export` allowed. */
export function parseEnv(text) {
  const values = {};
  const order = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(m[1] in values)) order.push(m[1]);
    values[m[1]] = value;
  }
  return { values, order };
}

/** Read and parse an env file; `{ values: {}, order: [] }` when absent. */
export function readEnvFile(file, fs = nodeFs) {
  if (!exists(file, fs)) return { values: {}, order: [] };
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

/**
 * Render env lines: each item is `{ comment }` (a `# ` line), `{ blank: true }`
 * or `{ key, value, comment? }` (the comment goes on the line above).
 */
export function renderEnv(items) {
  const out = [];
  for (const item of items) {
    if (item.blank) { out.push(''); continue; }
    if (item.key === undefined) { out.push(`# ${item.comment}`); continue; }
    if (item.comment) out.push(`# ${item.comment}`);
    if (item.commentedOut) out.push(`# ${item.key}=`);
    else out.push(`${item.key}=${item.value ?? ''}`);
  }
  return `${out.join('\n')}\n`;
}
