// One local HTTP server standing in for everything the curator CLI talks to:
// the weavr REST api (/v1/...), the curator signer (/healthz, /metrics,
// /status, /policy and the ops routes), Telegram (/bot<token>/getMe), a
// model provider (/provider/models) and Solana JSON-RPC (/rpc, answered by
// the fake rpc table). It records every hit, builds real legacy transactions
// for the curator handover with the right fee payer, verifies the signature
// on what comes back through /v1/transactions/send and moves the row the way
// the chain would. `state.build = { feePayer?, programId? }` makes the
// handover builds come back with another fee payer or against another
// program, so a test can prove the CLI's own checks refuse them before
// signing; `state.sendStatus` makes a send answer that status with no
// signatures. Nothing here leaves 127.0.0.1.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');

export const FACTORY = 'CB1Tw9aB8ju66q9ZVcezyfCbwNJDVLAMn2RpU3K1tVn';
export const BLOCKHASH = '11111111111111111111111111111111';
export const SIGNER_ROUTES = ['/healthz', '/metrics', '/status', '/policy', '/resume', '/unlock', '/rotate-curator', '/set-delay', '/operator-request', '/pause', '/hermes-heartbeat'];
export const OPS_ROUTES = ['/resume', '/unlock', '/rotate-curator', '/set-delay', '/operator-request'];

/** One legacy transaction paid by `feePayer` whose single instruction carries `data` to `programId`. */
export function buildTx(feePayer, data, programId = FACTORY) {
  programId = programId ?? FACTORY;
  const payer = new PublicKey(feePayer);
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
  tx.add(new TransactionInstruction({ programId: new PublicKey(programId), keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from(data, 'utf8') }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** The Prometheus text the fake signer serves for `gauges`. */
export function metricsText(gauges) {
  return `${Object.entries(gauges).map(([k, v]) => `# TYPE ${k} gauge\n${k} ${v}`).join('\n')}\n`;
}

export async function startFakeServer(state) {
  const hits = [];
  const readBody = (req) => new Promise((resolve) => {
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; } resolve(json); });
  });
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  // The single-row route resolves a mint or the exact ticker, like the api;
  // the CLI's case-insensitive match runs over the list.
  const rowFor = (id) => state.portfolios.find((r) => r.mint === id || r.symbol === id) ?? null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
    hits.push({ method: req.method, path, body, headers: { ...req.headers } });

    // Solana JSON-RPC.
    if (path === '/rpc') {
      try {
        const result = await state.rpc(body.method, body.params ?? []);
        return send(res, 200, { jsonrpc: '2.0', id: body.id, result });
      } catch (e) {
        return send(res, 200, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: e.message } });
      }
    }

    // Telegram.
    const tg = /^\/bot([^/]+)\/getMe$/.exec(path);
    if (tg) {
      const t = state.telegram ?? { ok: true, username: 'weavr_curator_bot' };
      if (t.ok === false) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      return send(res, 200, { ok: true, result: { id: 1, is_bot: true, username: t.username, first_name: 'weavr curator' } });
    }

    // The model provider.
    if (path === '/provider/models') {
      const status = state.provider?.status ?? 200;
      return send(res, status, status === 200 ? { object: 'list', data: [] } : { error: { message: 'invalid key' } });
    }

    // The signer.
    if (SIGNER_ROUTES.includes(path)) {
      const s = state.signer;
      if (!s || (s.absent && path !== '/rpc')) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
      if (path === '/healthz') return send(res, s.healthz?.ok === false ? 503 : 200, s.healthz ?? { ok: true, at: Math.floor(Date.now() / 1000), lastTickAgeSecs: 5, running: true });
      if (path === '/metrics') return send(res, 200, typeof s.metrics === 'string' ? s.metrics : metricsText(s.metrics ?? {}), 'text/plain; version=0.0.4');
      if (path === '/status' && s.noStatus) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
      const auth = String(req.headers.authorization ?? '');
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      const isAgent = token && token === s.agentToken;
      const isOps = token && token === s.opsToken;
      if (!isAgent && !isOps) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'unknown token' } });
      if (OPS_ROUTES.includes(path) && !isOps) return send(res, 403, { error: { code: 'OPS_ONLY', message: `${path} needs the ops token` } });
      if (path === '/status') return send(res, 200, s.status);
      if (path === '/policy') return send(res, 200, { version: 1, sha256: s.status?.policy?.sha256, policy: {} });
      const reply = s.replies?.[path] ?? { status: 200, json: { ok: true, at: Math.floor(Date.now() / 1000) } };
      return send(res, reply.status, reply.json);
    }

    // The weavr api.
    if (path === '/v1/pools' && req.method === 'GET') return send(res, 200, { pools: state.pools });
    if (path === '/v1/portfolios' && req.method === 'GET') return send(res, 200, { portfolios: state.portfolios.map(({ holdings, ...rest }) => rest) });
    let m = /^\/v1\/portfolios\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      state.rowReads = (state.rowReads ?? 0) + 1;
      if (state.onRowRead) state.onRowRead(state.rowReads, id);
      const row = rowFor(id);
      if (!row) return send(res, 404, { error: { code: 'NOT_FOUND', message: `portfolio ${id} not found` } });
      return send(res, 200, row);
    }
    m = /^\/v1\/portfolios\/([^/]+)\/curator(\/accept|\/cancel)?$/.exec(path);
    if (m && req.method === 'POST') {
      const row = rowFor(decodeURIComponent(m[1]));
      if (!row) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'portfolio not found' } });
      if (!body || typeof body !== 'object') return send(res, 400, { error: { code: 'MALFORMED_BODY', message: 'expected a JSON object' } });
      if (!body.signer) return send(res, 400, { error: { code: 'SIGNER_REQUIRED', message: 'signer must be the public key that will sign' } });
      if (m[2] === '/accept') {
        if (row.pendingCurator !== body.signer) return send(res, 400, { error: { code: 'NOT_PENDING_CURATOR', message: `${body.signer} is not the pending curator` } });
        return send(res, 200, { transactions: [{ step: 'accept_curator', signer: 'pending_curator', signerKey: body.signer, tx: buildTx(state.build?.feePayer ?? body.signer, `accept_curator:${row.mint}`, state.build?.programId) }] });
      }
      if (m[2] === '/cancel') return send(res, 200, { transactions: [{ step: 'cancel_curator', signer: 'curator', signerKey: body.signer, tx: buildTx(body.signer, `cancel_curator:${row.mint}`) }] });
      if (row.curator !== body.signer) return send(res, 400, { error: { code: 'NOT_CURATOR', message: `${body.signer} is not the curator` } });
      if (!body.newCurator) return send(res, 400, { error: { code: 'MALFORMED_BODY', message: 'newCurator required' } });
      return send(res, 200, { transactions: [{ step: 'propose_curator', signer: 'curator', signerKey: body.signer, tx: buildTx(state.build?.feePayer ?? body.signer, `propose_curator:${row.mint}:${body.newCurator}`, state.build?.programId) }] });
    }
    if (path === '/v1/transactions/send' && req.method === 'POST') {
      const signed = Array.isArray(body?.signed) ? body.signed : [];
      if (!signed.length) return send(res, 400, { error: { code: 'SIGNED_REQUIRED', message: 'signed must carry what the wallet returned' } });
      const signatures = [];
      for (const encoded of signed) {
        let tx;
        try {
          tx = Transaction.from(Buffer.from(encoded, 'base64'));
        } catch {
          return send(res, 400, { error: { code: 'SEND_FAILED', message: 'not a transaction' } });
        }
        if (!tx.verifySignatures()) return send(res, 400, { error: { code: 'SEND_FAILED', message: 'signature missing' } });
        const payer = tx.feePayer.toBase58();
        const [step, mint, arg] = Buffer.from(tx.instructions[0].data).toString('utf8').split(':');
        const row = rowFor(mint);
        state.sends = state.sends ?? [];
        state.sends.push({ step, mint, payer, arg });
        if (state.sendStatus) return send(res, 200, { status: state.sendStatus, signatures: [] });
        if (step === 'propose_curator' && row && row.curator === payer) row.pendingCurator = arg;
        if (step === 'accept_curator' && row && row.pendingCurator === payer) { row.curator = payer; row.pendingCurator = null; }
        signatures.push(`sig${state.sends.length}${payer.slice(0, 6)}`);
      }
      return send(res, 200, { status: 'confirmed', signatures });
    }
    return send(res, 404, { error: { code: 'NOT_FOUND', message: `no route ${req.method} ${path}` } });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    state,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
}
