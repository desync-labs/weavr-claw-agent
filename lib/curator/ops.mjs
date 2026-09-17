/**
 * `weavr-curator ops`: the signer's ops-token routes, the ones the agent can
 * never call. A port of the ops repo's scripts/ops/curator_ops.mjs with the
 * token read from <home>/curator/ops-token (mode 0600, at least 32 bytes)
 * and never from the command line: argv is visible to every process on the
 * machine and lands in shell history, and this is the one credential that
 * can unlock a self-locked signer. `--token` is refused outright.
 *
 * Every request carries `X-Curator-Session: chat` (the ops verbs are never a
 * cron path) and `X-Curator-Caller: weavr-curator-cli` so the journal names
 * who did it. Prints `<METHOD> <path> -> <status>` and the reply, never the
 * token; a non-2xx is `signer refused <command>: <status> <code> <message>`.
 */
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { requireOpt, usage } from './args.mjs';
import { homePaths, readTokenFile } from './home.mjs';

const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');

export const DEFAULT_URL = 'http://127.0.0.1:8091';
export const CALLER = 'weavr-curator-cli';
export const COMMANDS = Object.freeze(['status', 'resume', 'unlock', 'request-review', 'rotate-curator', 'set-delay']);
export const REQUEST_REVIEW_MAX_CHARS = 200;
export const TIMEOUT_MS = 30_000;

/** The ops token from <home>/curator/ops-token, or an error naming the file (never its content). */
export function readOpsToken(home, fs = nodeFs) {
  const file = homePaths(home).opsToken;
  const r = readTokenFile(file, fs);
  if (!r.ok) throw new Error(`ops token: ${r.reason}`);
  return r.token;
}

/**
 * The request each command makes; pure. `{ method, path, body? }` is exactly
 * what the signer receives. Throws a usage error for an unknown verb, a
 * missing `--why` on the verbs that journal one, a `--new-curator` that is
 * not a key, a `--rebalance-delay-secs` that is not a positive integer, or a
 * `--text` that is empty or over 200 characters.
 */
export function buildRequest(command, opts = {}) {
  const why = (required) => {
    const value = opts.why;
    if (required && (value === undefined || value === true || String(value).trim() === '')) {
      throw usage(`${command} needs --why <text> (journaled by the signer)`);
    }
    return value === undefined || value === true ? undefined : String(value);
  };
  switch (command) {
    case 'status':
      return { method: 'GET', path: '/status' };
    case 'resume':
      return { method: 'POST', path: '/resume', body: opts.why ? { why: why(false) } : {} };
    case 'unlock':
      return { method: 'POST', path: '/unlock', body: { why: why(true) } };
    case 'rotate-curator': {
      const raw = requireOpt(opts, 'new-curator', '--new-curator <pubkey>');
      let newCurator;
      try {
        newCurator = new PublicKey(raw).toBase58();
      } catch {
        throw usage(`--new-curator ${raw} is not a public key`);
      }
      return { method: 'POST', path: '/rotate-curator', body: { newCurator, why: why(true) } };
    }
    case 'set-delay': {
      const raw = requireOpt(opts, 'rebalance-delay-secs', '--rebalance-delay-secs <secs>');
      const secs = Number(raw);
      if (!Number.isInteger(secs) || secs <= 0) throw usage(`--rebalance-delay-secs ${raw} must be a positive integer`);
      return { method: 'POST', path: '/set-delay', body: { rebalanceDelaySecs: secs, why: why(true) } };
    }
    case 'request-review': {
      if (opts.clear === true) return { method: 'POST', path: '/operator-request', body: { clear: true, why: why(true) } };
      const raw = requireOpt(opts, 'text', '--text <text>');
      const text = String(raw).trim();
      if (text === '') throw usage('--text must not be empty (or pass --clear to withdraw a pending request)');
      if (text.length > REQUEST_REVIEW_MAX_CHARS) throw usage(`--text must be at most ${REQUEST_REVIEW_MAX_CHARS} characters; the signer refuses more`);
      return { method: 'POST', path: '/operator-request', body: { text, why: why(true) } };
    }
    default:
      throw usage(`ops <${COMMANDS.join('|')}> [flags]${command === undefined ? '' : `; unknown command ${JSON.stringify(command)}`}`);
  }
}

/** A client bound to one signer URL and token; the token never leaves `headers`. */
export function opsClient({ url = DEFAULT_URL, token, fetchImpl = fetch, caller = CALLER, timeoutMs = TIMEOUT_MS }) {
  const base = String(url).replace(/\/$/, '');
  return {
    async call({ method, path, body }) {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-curator-session': 'chat',
          'x-curator-caller': caller,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      return { status: res.status, json };
    },
  };
}

/**
 * Run one ops command. `command` is the verb, `opts` its parsed switches
 * (`--url`, `--home` and the verb's own), `deps` the seams: `home` (already
 * resolved), `fs`, `fetchImpl`, `log`. Returns `{ command, status, json }`
 * on a 2xx; throws before any request on `--token`, a bad switch or a bad
 * token file, and after it when the signer refuses.
 */
export async function ops(command, opts = {}, deps = {}) {
  const { home, fs = nodeFs, fetchImpl = fetch, log = console.log } = deps;
  if (opts.token !== undefined) throw usage('refusing --token: the ops token is read from <home>/curator/ops-token, never the command line');
  const request = buildRequest(command, opts);
  if (!home) throw new Error('ops needs a home (pass --home <dir>)');
  const token = readOpsToken(home, fs);
  const client = opsClient({ url: opts.url ?? DEFAULT_URL, token, fetchImpl });
  const { status, json } = await client.call(request);
  log(`${request.method} ${request.path} -> ${status}`);
  log(JSON.stringify(json, null, 2));
  if (status < 200 || status >= 300) {
    const code = json?.error?.code ?? 'HTTP';
    const message = json?.error?.message ?? json?.raw ?? '';
    throw new Error(`signer refused ${command}: ${status} ${code}${message ? ` ${message}` : ''}`);
  }
  return { command, status, json };
}
