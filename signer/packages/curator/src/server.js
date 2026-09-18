/**
 * The HTTP surface (plan §4.2) on :8091. Auth fails closed: no token
 * configured is a boot failure, not an open door (the keeper's
 * `completeCreate.js authorized()` returns true when its token is unset —
 * do not copy it). Tokens are compared with `crypto.timingSafeEqual`; the
 * matched token decides the kind (agent or ops); the caller name and the
 * session header are journaled on every request, refusals included.
 *
 * Why `createServer` re-validates the tokens although `index.js` already
 * did: a server built by anything else (a test, a future CLI) must not be
 * able to come up without both tokens either. The check is the same
 * function, so the two cannot disagree.
 *
 * Why a missing `X-Curator-Session` is cron, not chat: cron is the more
 * restrictive session (withdraw refused), and a caller that forgot the
 * header should get less, never more.
 *
 * Why every response body is walked for `tx` / `signed` / `walletPayload`
 * before it is written: the verbs never return them, but the server is the
 * last line before the agent's transcript, and a transaction body in a
 * transcript is a transaction body in Loki.
 */
import { createServer as httpCreateServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Refusal, REFUSAL_STATUS } from './errors.js';
import { VERBS, OPS_VERBS, depsOf, scrubText, normMeta, CALLER_MAX_CHARS } from './verbs.js';
import { gaugesOf } from './loop.js';

export const MIN_TOKEN_BYTES = 32;
export const MAX_BODY_BYTES = 64 * 1024;
export const HEALTHZ_STALE_TICKS = 3;

/** Keys that never leave this process in a response body. */
const STRIPPED_KEYS = new Set(['walletPayload', 'tx', 'signed']);

/**
 * `[[method, path, verb, { tokenKind: 'agent' | 'ops' | 'none' }], …]`
 * matched exactly on method and path.
 */
export const ROUTES = Object.freeze([
  ['GET', '/healthz', 'healthz', { tokenKind: 'none' }],
  ['GET', '/metrics', 'metrics', { tokenKind: 'none' }],
  ['GET', '/status', 'status', { tokenKind: 'agent' }],
  ['GET', '/review', 'review', { tokenKind: 'agent' }],
  ['GET', '/policy', 'policy', { tokenKind: 'agent' }],
  ['GET', '/alerts', 'alerts', { tokenKind: 'agent' }],
  ['GET', '/journal', 'journal', { tokenKind: 'agent' }],
  ['POST', '/simulate', 'simulate', { tokenKind: 'agent' }],
  ['POST', '/propose', 'propose', { tokenKind: 'agent' }],
  ['POST', '/apply', 'apply', { tokenKind: 'agent' }],
  ['POST', '/cancel', 'cancel', { tokenKind: 'agent' }],
  ['POST', '/deposit', 'deposit', { tokenKind: 'agent' }],
  ['POST', '/withdraw', 'withdraw', { tokenKind: 'agent' }],
  ['POST', '/refresh-nav', 'refresh-nav', { tokenKind: 'agent' }],
  ['POST', '/pause', 'pause', { tokenKind: 'agent' }],
  ['POST', '/note', 'note', { tokenKind: 'agent' }],
  ['POST', '/hermes-heartbeat', 'hermes-heartbeat', { tokenKind: 'agent' }],
  ['POST', '/resume', 'resume', { tokenKind: 'ops' }],
  ['POST', '/unlock', 'unlock', { tokenKind: 'ops' }],
  ['POST', '/rotate-curator', 'rotate-curator', { tokenKind: 'ops' }],
  ['POST', '/set-delay', 'set-delay', { tokenKind: 'ops' }],
  ['POST', '/set-metadata', 'set-metadata', { tokenKind: 'ops' }],
  ['POST', '/operator-request', 'operator-request', { tokenKind: 'ops' }],
].map((row) => Object.freeze([row[0], row[1], row[2], Object.freeze(row[3])])));

/**
 * Both tokens present, ≥ 32 bytes and different. Throws a plain Error
 * naming the variable — never its value.
 * @param {{ agent?: string, ops?: string }} tokens
 */
export function validateTokens(tokens) {
  const check = (name, value) => {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is not set`);
    if (Buffer.byteLength(value, 'utf8') < MIN_TOKEN_BYTES) throw new Error(`${name} must be at least ${MIN_TOKEN_BYTES} bytes`);
    if (/\s/.test(value)) throw new Error(`${name} must not contain whitespace`);
  };
  check('CURATOR_SIGNER_TOKEN', tokens?.agent);
  check('CURATOR_OPS_TOKEN', tokens?.ops);
  if (tokens.agent === tokens.ops) throw new Error('CURATOR_SIGNER_TOKEN and CURATOR_OPS_TOKEN must differ');
}

/**
 * Which token, if any, an `Authorization` header carries.
 * @param {string | undefined} headerValue
 * @param {{ agent: string, ops: string }} tokens
 * @returns {{ kind: 'agent' | 'ops' } | null} null when missing, malformed, short or unmatched
 */
export function authenticate(headerValue, tokens) {
  if (typeof headerValue !== 'string') return null;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(headerValue);
  if (!match) return null;
  const given = Buffer.from(match[1], 'utf8');
  let kind = null;
  // Both tokens are always compared so the timing does not say which one matched.
  for (const [name, token] of [['agent', tokens?.agent], ['ops', tokens?.ops]]) {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < MIN_TOKEN_BYTES) continue;
    const expected = Buffer.from(token, 'utf8');
    if (expected.length !== given.length) {
      timingSafeEqual(expected, expected);
      continue;
    }
    if (timingSafeEqual(given, expected) && kind === null) kind = name;
  }
  return kind ? { kind } : null;
}

/**
 * Parse a JSON body, bounded.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<object>} rejects with Refusal('BAD_REQUEST')
 */
export function readBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const fail = (message) => {
      if (done) return;
      done = true;
      reject(new Refusal('BAD_REQUEST', message));
    };
    req.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Answer now and drain the rest: destroying the socket here would
        // close the connection before the 400 is written, and the caller
        // would see "connection closed" instead of BAD_REQUEST.
        chunks.length = 0;
        fail(`body exceeds ${maxBytes} bytes`);
        req.resume?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        done = true;
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail('body is not valid JSON');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('body must be a JSON object');
        return;
      }
      done = true;
      resolve(parsed);
    });
    req.on('error', (error) => fail(`body could not be read (${error?.code ?? 'error'})`));
  });
}

/** Remove transaction material from a response body, at any depth. */
export function scrubResponse(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => scrubResponse(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (STRIPPED_KEYS.has(key)) continue;
    if (key === 'transactions' && Array.isArray(entry)) continue;
    if (key === 'httpStatus') continue;
    out[key] = scrubResponse(entry, depth + 1);
  }
  return out;
}

const PRINTABLE = /^[\x20-\x7e]+$/;

/** Session and caller out of the request headers (token kind is filled after auth). */
export function metaOf(headers) {
  const session = String(headers?.['x-curator-session'] ?? '').trim().toLowerCase();
  const rawCaller = String(headers?.['x-curator-caller'] ?? '').trim();
  const caller = rawCaller !== '' && PRINTABLE.test(rawCaller) ? rawCaller.slice(0, CALLER_MAX_CHARS) : 'unknown';
  return normMeta({ session: session === 'chat' ? 'chat' : 'cron', caller, tokenKind: 'agent' });
}

/**
 * Build the server (not listening; index.js listens).
 * @param {{ ctx: object, loop?: object, tokens: { agent: string, ops: string } }} opts
 * @returns {import('node:http').Server}
 */
export function createServer(opts) {
  const { ctx, loop = null, tokens } = opts ?? {};
  if (!ctx) throw new Error('createServer: ctx is required');
  validateTokens(tokens);
  const agentToken = tokens.agent;
  const opsToken = tokens.ops;
  const tickMs = Number(ctx.config?.tickMs ?? 30000);

  const journalRefusal = (record) => {
    try {
      ctx.journal?.append({ kind: 'refusal', ok: false, ...record });
    } catch (error) {
      ctx.log?.('error', 'journal-append-failed', { kind: 'refusal', error: scrubText(error?.message) });
    }
  };

  async function handle(req, res) {
    const send = (status, body, contentType = 'application/json; charset=utf-8') => {
      if (res.headersSent) return;
      const text = contentType.startsWith('application/json') ? JSON.stringify(body) : String(body);
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    const refusalBody = (code, message, detail) => ({ error: { code, message: scrubText(message), ...(detail !== undefined ? { detail: scrubResponse(detail) } : {}) } });

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://curator.invalid');
    } catch {
      return send(400, refusalBody('BAD_REQUEST', 'malformed request url'));
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method ?? 'GET').toUpperCase();
    const route = ROUTES.find((row) => row[0] === method && row[1] === path);
    const meta = metaOf(req.headers);

    if (!route) {
      return send(404, refusalBody('NOT_FOUND', `no route ${method} ${path}`));
    }
    const [, , verb, { tokenKind }] = route;

    if (tokenKind === 'none') {
      if (verb === 'healthz') {
        const nowSecs = Math.floor(ctx.now() / 1000);
        const lastAt = ctx.state?.lastTick?.at ?? null;
        const ageSecs = lastAt == null ? null : Math.max(0, nowSecs - lastAt);
        const staleAfter = (HEALTHZ_STALE_TICKS * tickMs) / 1000;
        const healthy = ageSecs !== null && ageSecs <= staleAfter;
        return send(healthy ? 200 : 503, { ok: healthy, at: nowSecs, lastTickAgeSecs: ageSecs, ...(loop ? { running: loop.state?.().running ?? null } : {}) });
      }
      try {
        const text = depsOf(ctx).renderPrometheus(gaugesOf(ctx));
        return send(200, text, 'text/plain; version=0.0.4; charset=utf-8');
      } catch (error) {
        ctx.log?.('error', 'metrics-failed', { error: scrubText(error?.message) });
        return send(500, '# metrics unavailable\n', 'text/plain; charset=utf-8');
      }
    }

    const auth = authenticate(req.headers.authorization, { agent: agentToken, ops: opsToken });
    if (!auth) {
      journalRefusal({ verb, route: path, caller: meta.caller, session: meta.session, code: 'UNAUTHORIZED', message: 'missing or unknown bearer token' });
      return send(401, refusalBody('UNAUTHORIZED', 'missing or unknown bearer token'));
    }
    meta.tokenKind = auth.kind;
    if ((tokenKind === 'ops' || OPS_VERBS.has(verb)) && auth.kind !== 'ops') {
      journalRefusal({ verb, route: path, caller: meta.caller, session: meta.session, tokenKind: auth.kind, code: 'OPS_ONLY', message: `${verb} needs the ops token` });
      return send(403, refusalBody('OPS_ONLY', `${verb} needs the ops token`));
    }

    let args = {};
    if (method === 'GET') {
      args = Object.fromEntries(url.searchParams);
    } else {
      try {
        args = await readBody(req, { maxBytes: MAX_BODY_BYTES });
      } catch (error) {
        const message = error instanceof Refusal ? error.message : 'body could not be read';
        journalRefusal({ verb, route: path, caller: meta.caller, session: meta.session, tokenKind: auth.kind, code: 'BAD_REQUEST', message });
        return send(400, refusalBody('BAD_REQUEST', message));
      }
    }

    const fn = VERBS[verb];
    if (typeof fn !== 'function') return send(404, refusalBody('NOT_FOUND', `no verb ${verb}`));
    try {
      const result = await fn(ctx, args, meta);
      const status = Number.isInteger(result?.httpStatus) ? result.httpStatus : 200;
      return send(status, scrubResponse(result ?? { ok: true }));
    } catch (error) {
      if (error instanceof Refusal) {
        if (!error.journaled) {
          journalRefusal({ verb, route: path, caller: meta.caller, session: meta.session, tokenKind: auth.kind, code: error.code, message: scrubText(error.message), ...(error.detail !== undefined ? { detail: error.detail } : {}) });
        }
        const status = Number.isInteger(error.status) ? error.status : (REFUSAL_STATUS[error.code] ?? 422);
        return send(status, refusalBody(error.code, error.message, error.detail));
      }
      ctx.log?.('error', 'verb-crashed', { verb, caller: meta.caller, error: scrubText(error?.message ?? String(error)) });
      return send(500, refusalBody('INTERNAL', `${verb} failed: ${error?.message ?? 'error'}`));
    }
  }

  const server = httpCreateServer((req, res) => {
    handle(req, res).catch((error) => {
      ctx.log?.('error', 'request-crashed', { error: scrubText(error?.message ?? String(error)) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'request failed' } }));
      }
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 30_000;
  return server;
}
