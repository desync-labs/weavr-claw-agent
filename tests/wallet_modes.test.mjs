// One wallet tool, three wallets. The mode resolution is proven pure (the flag
// beats the variable beats inference, local beats paybox when both are
// configured, any PayBox variable means paybox so a half configured host gets
// CONFIG and not a sign link, an unknown value is CONFIG), then each mode runs
// through the real entry points: the local key answers and signs, a key file
// in the wrong format or too open is refused without quoting it, PayBox still
// signs through the fake CLI, and link mode signs nothing and touches nothing
// but await_portfolio. No key, network or money involved: the only servers
// here are local, record every hit, and answer 500 to anything they must not
// see; every keypair is Keypair.generate() and thrown away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createPublicKey, randomBytes, verify as verifyEd25519 } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EXIT, LEGACY_ONLY_DETAIL } from '../tools/lib/tx-checks.mjs';
import { PAYBOX_VARIABLES, WALLET_MODES, resolveWalletMode } from '../tools/lib/wallet-mode.mjs';
import { NO_WALLET_DETAIL, linkSigner } from '../tools/lib/link-signer.mjs';
import { KEYPAIR_NOT_ARRAY, KEYPAIR_TOO_OPEN, KEYPAIR_UNREADABLE, localSigner, readKeypairFile, KEYPAIR_MISSING_REMEDY } from '../tools/lib/local-signer.mjs';
import { SETTLED_STATUSES, finishDeployment, makeDeposit, watchDeployment } from '../tools/lib/weavr.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

const SIGN = join(ROOT, 'tools/sign.mjs');
const SIGN_LOCAL = join(ROOT, 'tools/sign-local.mjs');
const SIGN_SOLANA = join(ROOT, 'tools/sign-solana.mjs');
const SIGN_CHECK = join(ROOT, 'tools/sign-check.mjs');
const FAKE_CLI = join(ROOT, 'tests/fixtures/fake-paybox-cli.mjs');
const MANIFEST = join(ROOT, 'manifest.json');
const FACTORY = 'CB1Tw9aB8ju66q9ZVcezyfCbwNJDVLAMn2RpU3K1tVn';
const BLOCKHASH = '11111111111111111111111111111111';

const wallet = Keypair.generate();
const address = wallet.publicKey.toBase58();

function legacy(payer, programId) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
  tx.add(new TransactionInstruction({ programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** A v0 transaction paid by `payer` for `programId`: the shape of a create of five or more assets. */
function v0(payer, programId) {
  const ix = new TransactionInstruction({ programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/** A v0 whose instruction names its program through a lookup table entry (an allowlisted one, so only the index can refuse it). */
function v0ProgramFromTable(payer) {
  const loaded = SystemProgram.programId;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [loaded] },
  });
  const ix = new TransactionInstruction({
    programId: new PublicKey(FACTORY),
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: loaded, isSigner: false, isWritable: false }],
    data: Buffer.from([1]),
  });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([table]);
  msg.compiledInstructions[0].programIdIndex = msg.staticAccountKeys.length; // the first loaded key
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/** A v0 that loads eight throwaway accounts from a fabricated lookup table with the program static: the shape of a create of five to eight assets against weavr's NAV lookup table. */
function v0WithTable(payer, programId) {
  const addresses = Array.from({ length: 8 }, () => Keypair.generate().publicKey);
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });
  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, ...addresses.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i < 5 }))],
    data: Buffer.from([1]),
  });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([table]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/** True when the encoded v0 transaction's first signature is `pubkey`'s ed25519 signature over its message. */
function v0SignedBy(encoded, pubkey) {
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  const sig = Buffer.from(tx.signatures[0]);
  if (sig.every((b) => b === 0)) return false;
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkey.toBytes())]), format: 'der', type: 'spki' });
  return verifyEd25519(null, Buffer.from(tx.message.serialize()), spki, sig);
}

/** process.env without the variables the mode is inferred from, so the shell running the tests cannot tilt it. */
const INFERENCE_KEYS = ['WEAVR_WALLET', 'SIGN_LOCAL_KEYPAIR_FILE', 'PAYBOX_CLI', 'PAYBOX_CONFIG_DIR', 'PAYBOX_CREDENTIAL_ID', 'PAYBOX_SIGNING_KEY_FILE'];
function cleanEnv(extra = {}) {
  const env = { ...process.env, WEAVR_MANIFEST: MANIFEST };
  for (const k of INFERENCE_KEYS) delete env[k];
  return { ...env, ...extra };
}

/** A throwaway keypair file (Keypair.generate(), never a real key), 0600, in a temp dir. */
function keypairDir() {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-modes-'));
  const file = join(dir, 'agent.json');
  writeFileSync(file, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600 });
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The fake PayBox CLI's environment, as sign_solana.test.mjs sets it up. */
function payboxEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-modes-paybox-'));
  writeFileSync(join(dir, 'signing-key.txt'), 'pbxk1.fake-key\n', { mode: 0o600 });
  const env = cleanEnv({ PAYBOX_CONFIG_DIR: dir, PAYBOX_CREDENTIAL_ID: 'cred-1', PAYBOX_CLI: FAKE_CLI, FAKE_PAYBOX_WALLET: address, ...extra });
  return { dir, env, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function runSync(tool, args, env) {
  const r = spawnSync(process.execPath, [tool, ...args], { env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep raw */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** The same, without blocking the event loop, so a local server in this process can answer. */
function run(tool, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* keep raw */ }
      resolve({ code, json, stdout, stderr });
    });
  });
}

/**
 * A local stand-in for api.weavr.sh. Records every request. MCP await_portfolio
 * answers with `statuses` in order (the last one repeats; 'error' is an MCP
 * isError result) and echoes a walletPayload that must never be printed; every
 * other route, the REST rebuild included, answers 500 so a hit is both
 * recorded and loud.
 */
async function fakeWeavr(statuses) {
  const requests = [];
  let n = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* not json */ }
      requests.push({ method: req.method, path: req.url, json });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/mcp' && json?.params?.name === 'await_portfolio') {
        const status = statuses[Math.min(n, statuses.length - 1)];
        n += 1;
        if (status === 'error') {
          const payload = { error: 'deployment not found' };
          res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result: { isError: true, structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
          return;
        }
        const payload = { status, deploymentId: json.params.arguments.deploymentId, walletPayload: { transactions: ['never-printed'] }, ...(status === 'live' ? { portfolio: { ticker: 'LNK' } } : {}) };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result: { structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `${req.method} ${req.url} must not be called in link mode` }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    env: { WEAVR_MCP_URL: `${base}/mcp`, WEAVR_API_URL: base },
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// --- resolution, pure ------------------------------------------------------

test('resolveWalletMode: the flag beats the variable beats inference, and the flag is stripped', () => {
  assert.deepEqual(WALLET_MODES, ['paybox', 'local', 'link']);
  const full = { WEAVR_WALLET: 'paybox', SIGN_LOCAL_KEYPAIR_FILE: '/k', PAYBOX_CLI: '/cli' };
  assert.deepEqual(resolveWalletMode({ argv: ['--wallet', 'link', '--address'], env: full }), { mode: 'link', source: 'flag', rest: ['--address'] });
  assert.deepEqual(resolveWalletMode({ argv: ['--deposit', 'T', '--wallet', 'local', '--amount', '1'], env: full }), { mode: 'local', source: 'flag', rest: ['--deposit', 'T', '--amount', '1'] });
  assert.deepEqual(resolveWalletMode({ argv: ['--address'], env: { WEAVR_WALLET: 'link', SIGN_LOCAL_KEYPAIR_FILE: '/k', PAYBOX_CLI: '/cli' } }), { mode: 'link', source: 'env', rest: ['--address'] });
  // the same flag twice is one choice; an alias prepends its own
  assert.deepEqual(resolveWalletMode({ argv: ['--wallet', 'local', '--wallet', 'local', '--address'], env: {} }), { mode: 'local', source: 'flag', rest: ['--address'] });
});

test('resolveWalletMode: inference picks local over paybox, paybox over nothing, link when nothing is configured; empty means unset', () => {
  assert.deepEqual(resolveWalletMode({ argv: ['--address'], env: { SIGN_LOCAL_KEYPAIR_FILE: '/k', PAYBOX_CLI: '/cli' } }), { mode: 'local', source: 'inferred', rest: ['--address'] });
  assert.deepEqual(resolveWalletMode({ argv: [], env: { PAYBOX_CLI: '/cli' } }), { mode: 'paybox', source: 'inferred', rest: [] });
  assert.deepEqual(resolveWalletMode({ argv: [], env: {} }), { mode: 'link', source: 'inferred', rest: [] });
  assert.deepEqual(resolveWalletMode({ argv: [], env: { WEAVR_WALLET: '', SIGN_LOCAL_KEYPAIR_FILE: '', PAYBOX_CLI: '/cli' } }), { mode: 'paybox', source: 'inferred', rest: [] });
  assert.deepEqual(resolveWalletMode(), { mode: 'link', source: 'inferred', rest: [] });
});

test('planted: any PayBox variable alone infers paybox, so a half configured PayBox host is CONFIG and never a sign link', () => {
  assert.deepEqual(PAYBOX_VARIABLES, ['PAYBOX_CLI', 'PAYBOX_CONFIG_DIR', 'PAYBOX_CREDENTIAL_ID', 'PAYBOX_SIGNING_KEY_FILE']);
  for (const k of PAYBOX_VARIABLES) {
    assert.deepEqual(resolveWalletMode({ argv: [], env: { [k]: '/x' } }), { mode: 'paybox', source: 'inferred', rest: [] }, k);
    assert.deepEqual(resolveWalletMode({ argv: [], env: { [k]: '' } }), { mode: 'link', source: 'inferred', rest: [] }, `${k} empty is unset`);
  }
  assert.deepEqual(resolveWalletMode({ argv: [], env: { PAYBOX_CONFIG_DIR: '/d', PAYBOX_CREDENTIAL_ID: 'c' } }), { mode: 'paybox', source: 'inferred', rest: [] }, 'no PAYBOX_CLI');
  // the keypair file still wins over a PayBox variable
  assert.deepEqual(resolveWalletMode({ argv: [], env: { PAYBOX_CONFIG_DIR: '/d', SIGN_LOCAL_KEYPAIR_FILE: '/k' } }), { mode: 'local', source: 'inferred', rest: [] });
});

test('planted: an unknown wallet, a bare --wallet, or two flags that disagree is CONFIG naming the accepted values', () => {
  const names = /paybox, local, link/;
  assert.throws(() => resolveWalletMode({ argv: ['--wallet', 'ledger'], env: {} }), { code: 'CONFIG', message: names });
  assert.throws(() => resolveWalletMode({ argv: ['--wallet', 'Local'], env: {} }), { code: 'CONFIG' }, 'no case folding');
  assert.throws(() => resolveWalletMode({ argv: ['--address'], env: { WEAVR_WALLET: 'ledger' } }), { code: 'CONFIG', message: /WEAVR_WALLET.*paybox, local, link/ });
  assert.throws(() => resolveWalletMode({ argv: ['--address', '--wallet'], env: {} }), { code: 'CONFIG', message: names });
  assert.throws(() => resolveWalletMode({ argv: ['--wallet', 'local', '--wallet', 'paybox'], env: {} }), { code: 'CONFIG', message: /conflicting/ });
});

test('the link signer has no wallet and refuses to sign, synchronously, with NO_WALLET', () => {
  const s = linkSigner();
  assert.equal(s.wallet, null);
  assert.equal(s.kind, 'link');
  assert.throws(() => s.sign(['AAAA']), { code: 'NO_WALLET', message: NO_WALLET_DETAIL });
  assert.equal(EXIT.NO_WALLET, 9);
  assert.match(NO_WALLET_DETAIL, /create_portfolio with wallet "link" and no creator/);
});

test('watchDeployment: `signed` rides on the first round only and polling stops at a settled status', async () => {
  const calls = [];
  const answers = [{ status: 'awaiting_wallet' }, { status: 'finishing' }, { status: 'live' }, { status: 'never' }];
  const client = { mcpCall: async (name, args) => { calls.push({ name, args }); return { isError: false, payload: answers[calls.length - 1] }; } };
  const last = await watchDeployment(client, 'dep-1', { signed: ['S'], timeoutSecs: 5 });
  assert.equal(last.payload.status, 'live');
  assert.deepEqual(calls.map((c) => c.name), ['await_portfolio', 'await_portfolio', 'await_portfolio']);
  assert.deepEqual(calls[0].args, { deploymentId: 'dep-1', signed: ['S'], timeoutSecs: 5 });
  assert.deepEqual(calls[1].args, { deploymentId: 'dep-1', timeoutSecs: 5 });
  assert.deepEqual(calls[2].args, { deploymentId: 'dep-1', timeoutSecs: 5 });
  assert.deepEqual([...SETTLED_STATUSES], ['live', 'sign_again', 'expired']);
  // no `signed` at all: the deploymentId rides alone from the first round
  calls.length = 0;
  await watchDeployment(client, 'dep-2', { timeoutSecs: 5, awaitRounds: 1 });
  assert.deepEqual(calls[0].args, { deploymentId: 'dep-2', timeoutSecs: 5 });
});

// --- local -----------------------------------------------------------------

test('sign.mjs --wallet local --address prints the keypair file\'s public key with wallet local; the alias and the variable agree', () => {
  const { file, done } = keypairDir();
  try {
    const expected = { address, wallet: 'local' };
    assert.deepEqual(runSync(SIGN, ['--wallet', 'local', '--address'], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file })).json, expected);
    assert.deepEqual(runSync(SIGN_LOCAL, ['--address'], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file })).json, expected);
    assert.deepEqual(runSync(SIGN, ['--address'], cleanEnv({ WEAVR_WALLET: 'local', SIGN_LOCAL_KEYPAIR_FILE: file })).json, expected);
    // inferred: the keypair file is set, and so is the PayBox CLI; the keypair file wins
    assert.deepEqual(runSync(SIGN, ['--address'], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file, PAYBOX_CLI: FAKE_CLI })).json, expected);
    // and it signs, with the key, not a placeholder
    const r = runSync(SIGN, ['--wallet', 'local', '--tx', legacy(wallet.publicKey, new PublicKey(FACTORY))], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.wallet, 'local');
    const tx = Transaction.from(Buffer.from(r.json.signed[0], 'base64'));
    assert.equal(tx.verifySignatures(true), true);
  } finally { done(); }
});

test('sign.mjs --wallet local --tx signs a v0 create (five or more assets) and prints bytes the key really signed; --file with a v0 walletPayload signs too', () => {
  const { dir, file, done } = keypairDir();
  try {
    const env = cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file });
    const factory = new PublicKey(FACTORY);
    // --tx: a v0 and a legacy in one payload, both signed
    const a = runSync(SIGN, ['--wallet', 'local', '--tx', v0(wallet.publicKey, factory), '--tx', legacy(wallet.publicKey, factory)], env);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(a.json.wallet, 'local');
    assert.equal(a.json.signed.length, 2);
    assert.equal(v0SignedBy(a.json.signed[0], wallet.publicKey), true, 'the v0 carries the wallet\'s signature');
    assert.equal(Transaction.from(Buffer.from(a.json.signed[1], 'base64')).verifySignatures(true), true, 'so does the legacy');
    // --file: a saved walletPayload holding a v0
    const payload = join(dir, 'walletPayload.json');
    writeFileSync(payload, JSON.stringify({ walletPayload: { transactions: [v0(wallet.publicKey, factory)] } }), { mode: 0o600 });
    const b = runSync(SIGN, ['--wallet', 'local', '--file', payload], env);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.equal(b.json.wallet, 'local');
    assert.equal(b.json.signed.length, 1);
    assert.equal(v0SignedBy(b.json.signed[0], wallet.publicKey), true);
    // the alias too
    const c = runSync(SIGN_LOCAL, ['--tx', v0(wallet.publicKey, factory)], env);
    assert.equal(c.code, 0, c.stdout + c.stderr);
    assert.equal(v0SignedBy(c.json.signed[0], wallet.publicKey), true);
  } finally { done(); }
});

test('sign.mjs --wallet local --tx and --file sign a v0 that loads its accounts from a lookup table (a five-to-eight-asset create) with the lookup kept; paybox mode still refuses it LEGACY_ONLY', () => {
  const encoded = v0WithTable(wallet.publicKey, new PublicKey(FACTORY));
  const input = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  assert.equal(input.message.addressTableLookups.length, 1, 'one table is consulted');
  assert.equal(input.message.staticAccountKeys.length, 2, 'the payer and the factory are the only static keys');
  const lookupKept = (signed) => VersionedTransaction.deserialize(Buffer.from(signed, 'base64')).message.addressTableLookups.length === 1;
  const { dir, file, done } = keypairDir();
  try {
    const env = cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file });
    const a = runSync(SIGN, ['--wallet', 'local', '--tx', encoded], env);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(a.json.wallet, 'local');
    assert.equal(a.json.signed.length, 1);
    assert.equal(v0SignedBy(a.json.signed[0], wallet.publicKey), true, 'the printed bytes carry the wallet\'s signature');
    assert.equal(lookupKept(a.json.signed[0]), true, 'the lookup rides through');
    const payload = join(dir, 'walletPayload-table.json');
    writeFileSync(payload, JSON.stringify({ walletPayload: { transactions: [encoded] } }), { mode: 0o600 });
    const b = runSync(SIGN, ['--wallet', 'local', '--file', payload], env);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.equal(b.json.signed.length, 1);
    assert.equal(v0SignedBy(b.json.signed[0], wallet.publicKey), true);
    assert.equal(lookupKept(b.json.signed[0]), true);
    const c = runSync(SIGN_LOCAL, ['--tx', encoded], env);
    assert.equal(c.code, 0, c.stdout + c.stderr);
    assert.equal(v0SignedBy(c.json.signed[0], wallet.publicKey), true);
  } finally { done(); }
  const paybox = payboxEnv();
  try {
    const r = runSync(SIGN, ['--wallet', 'paybox', '--tx', encoded], paybox.env);
    assert.equal(r.code, EXIT.LEGACY_ONLY, r.stdout + r.stderr);
    assert.equal(r.json.error, 'LEGACY_ONLY');
    assert.equal(r.json.detail, LEGACY_ONLY_DETAIL);
    assert.equal('signed' in r.json, false);
    assert.equal(existsSync(join(paybox.dir, 'work')), false, 'no intent was ever written for the CLI');
  } finally { paybox.done(); }
});

test('planted: in local mode a v0 for a foreign program, paid by another key, or naming its program through a lookup table is refused (exit 4) and nothing is signed', () => {
  const { file, done } = keypairDir();
  try {
    const env = cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file });
    const cases = [
      { name: 'foreign program', tx: v0(wallet.publicKey, Keypair.generate().publicKey), error: 'FOREIGN_PROGRAM', detail: /not a weavr or core program/ },
      { name: 'another payer', tx: v0(Keypair.generate().publicKey, new PublicKey(FACTORY)), error: 'WRONG_PAYER', detail: /is not the wallet/ },
      { name: 'program from a lookup table', tx: v0ProgramFromTable(wallet.publicKey), error: 'FOREIGN_PROGRAM', detail: /program loaded from a lookup table/ },
    ];
    for (const c of cases) {
      for (const [tool, args] of [[SIGN, ['--wallet', 'local', '--tx', c.tx]], [SIGN_LOCAL, ['--tx', c.tx]]]) {
        const r = runSync(tool, args, env);
        const label = `${c.name}: ${tool.split('/').pop()}`;
        assert.equal(r.code, EXIT.REFUSED, `${label}: ${r.stdout}${r.stderr}`);
        assert.equal(r.json.error, c.error, label);
        assert.match(r.json.detail, c.detail, label);
        assert.equal(r.json.wallet, 'local', label);
        assert.equal('signed' in r.json, false, label);
      }
    }
  } finally { done(); }
});

test('planted: sign.mjs --wallet paybox --tx with the same v0 is still LEGACY_ONLY (exit 2) and the PayBox CLI is never asked to sign', () => {
  const { dir, env, done } = payboxEnv();
  try {
    const encoded = v0(wallet.publicKey, new PublicKey(FACTORY));
    for (const [tool, args] of [[SIGN, ['--wallet', 'paybox', '--tx', encoded]], [SIGN_SOLANA, ['--tx', encoded]], [SIGN, ['--tx', encoded]]]) {
      const r = runSync(tool, args, env);
      const label = `${tool.split('/').pop()} ${args.slice(0, 2).join(' ')}`;
      assert.equal(r.code, EXIT.LEGACY_ONLY, `${label}: ${r.stdout}${r.stderr}`);
      assert.equal(r.json.error, 'LEGACY_ONLY', label);
      assert.equal(r.json.detail, LEGACY_ONLY_DETAIL, label);
      assert.equal(r.json.wallet, 'paybox', label);
      assert.equal('signed' in r.json, false, label);
    }
    assert.equal(existsSync(join(dir, 'work')), false, 'no intent was ever written for the CLI');
  } finally { done(); }
});

test('makeDeposit and finishDeployment sign a v0 payload with the local key, and hand the same payload back as LEGACY_ONLY for a legacy-only signer', async () => {
  const { file, done } = keypairDir();
  try {
    const local = localSigner({ keypairFile: file });
    const legacyOnly = { wallet: address, kind: 'stub', sign: async () => { throw new Error('a legacy-only signer must never see a v0'); } };
    const allowed = new Set([FACTORY]);
    const encoded = v0(wallet.publicKey, new PublicKey(FACTORY));
    // a stand-in weavr: build_deposit and the rebuild hand back the v0; send_signed and await_portfolio record what they were given
    const sent = [];
    const client = {
      async mcpCall(name, args) {
        if (name === 'build_deposit') return { isError: false, payload: { walletPayload: { transactions: [encoded] } } };
        if (name === 'send_signed' || name === 'await_portfolio') { sent.push({ name, signed: args.signed }); return { isError: false, payload: { status: name === 'send_signed' ? 'confirmed' : 'live' } }; }
        throw new Error(`unexpected ${name}`);
      },
      async rest(method, path) {
        assert.equal(`${method} ${path}`, 'POST /v1/deployments/dep-1/rebuild');
        return { status: 200, json: { deployment: { transactions: [{ signer: 'creator', tx: encoded }] } } };
      },
    };
    const d = await makeDeposit(client, 'FIVE', 5, local, allowed);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.output.step, 'send_signed');
    assert.equal(v0SignedBy(sent[0].signed[0], wallet.publicKey), true, 'the deposit went out signed by the key');
    const f = await finishDeployment(client, 'dep-1', local, allowed, { awaitRounds: 1 });
    assert.equal(f.ok, true, JSON.stringify(f));
    assert.equal(f.output.status, 'live');
    assert.equal(v0SignedBy(sent[1].signed[0], wallet.publicKey), true, 'the create went out signed by the key');
    // a signer without allowVersioned (PayBox's shape) gets the refusal before it is asked
    sent.length = 0;
    for (const r of [await makeDeposit(client, 'FIVE', 5, legacyOnly, allowed), await finishDeployment(client, 'dep-1', legacyOnly, allowed, { awaitRounds: 1 })]) {
      assert.equal(r.ok, false);
      assert.equal(r.exit, EXIT.LEGACY_ONLY);
      assert.deepEqual(r.output, { error: 'LEGACY_ONLY', detail: LEGACY_ONLY_DETAIL });
    }
    assert.equal(sent.length, 0, 'nothing was sent');
  } finally { done(); }
});

test('planted: --wallet local without a keypair file is CONFIG (exit 5) naming SIGN_LOCAL_KEYPAIR_FILE', () => {
  const r = runSync(SIGN, ['--wallet', 'local', '--address'], cleanEnv());
  assert.equal(r.code, EXIT.CONFIG);
  assert.equal(r.json.error, 'CONFIG');
  assert.match(r.json.detail, /SIGN_LOCAL_KEYPAIR_FILE/);
  assert.equal(r.json.wallet, 'local');
});

/** A throwaway string in the base58 alphabet, the shape a browser wallet exports a secret in. Never a key. */
function base58Looking(length = 88) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  return Array.from(randomBytes(length), (b) => alphabet[b % alphabet.length]).join('');
}

/** True when no run of six or more characters of `content` appears in `text`. */
function leaksNothingOf(content, text) {
  for (let i = 0; i + 6 <= content.length; i += 1) if (text.includes(content.slice(i, i + 6))) return false;
  return true;
}

test('planted: a keypair file in the wrong format, unreadable, or readable by others is CONFIG with a fixed sentence; the file is never quoted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-modes-badkey-'));
  try {
    const cases = [
      { name: 'base58 export', content: base58Looking(), detail: KEYPAIR_NOT_ARRAY },
      { name: 'letter-leading base58 export', content: 'K' + base58Looking(87), detail: KEYPAIR_NOT_ARRAY },
      { name: 'truncated array', content: JSON.stringify(Array.from(Keypair.generate().secretKey)).slice(0, 40), detail: KEYPAIR_NOT_ARRAY },
      { name: 'wrong length', content: JSON.stringify(Array.from(Keypair.generate().secretKey.slice(0, 32))), detail: KEYPAIR_NOT_ARRAY },
      { name: 'not bytes', content: JSON.stringify(Array(64).fill(300)), detail: KEYPAIR_NOT_ARRAY },
      { name: 'a public key mismatch', content: JSON.stringify([...Array.from(Keypair.generate().secretKey.slice(0, 32)), ...Array.from(Keypair.generate().secretKey.slice(32))]), detail: KEYPAIR_NOT_ARRAY },
      { name: 'readable by others', content: JSON.stringify(Array.from(Keypair.generate().secretKey)), mode: 0o644, detail: KEYPAIR_TOO_OPEN },
      { name: 'readable by the group', content: JSON.stringify(Array.from(Keypair.generate().secretKey)), mode: 0o640, detail: KEYPAIR_TOO_OPEN },
      // a file that is not there yet also names the remedy, the wallet's lifecycle
      { name: 'missing', content: null, detail: `${KEYPAIR_UNREADABLE} (ENOENT): ${KEYPAIR_MISSING_REMEDY}` },
    ];
    for (const c of cases) {
      const file = join(dir, `${c.name.replace(/\W+/g, '-')}.json`);
      if (c.content !== null) { writeFileSync(file, c.content, { mode: 0o600 }); chmodSync(file, c.mode ?? 0o600); }
      // the pure reader
      assert.throws(() => readKeypairFile(file), { code: 'CONFIG', message: c.detail }, c.name);
      assert.throws(() => localSigner({ keypairFile: file }), { code: 'CONFIG', message: c.detail }, c.name);
      // the tool and the check, through the environment; the alias, the inferred mode and a
      // signing run are covered once, on the shape a browser wallet exports
      const env = cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file });
      const runs = [[SIGN, ['--wallet', 'local', '--address']], [SIGN_CHECK, ['--wallet', 'local']]];
      if (c.name === 'base58 export') runs.push([SIGN_LOCAL, ['--address']], [SIGN, ['--address']], [SIGN, ['--wallet', 'local', '--tx', legacy(wallet.publicKey, new PublicKey(FACTORY))]], [SIGN_CHECK, []]);
      for (const [tool, args] of runs) {
        const r = runSync(tool, args, env);
        const label = `${c.name}: ${tool.split('/').pop()} ${args.join(' ').slice(0, 30)}`;
        assert.equal(r.code, EXIT.CONFIG, `${label}: ${r.stdout}${r.stderr}`);
        assert.equal(r.json.error, 'CONFIG', label);
        assert.equal(r.json.detail, c.detail, label);
        assert.equal(r.json.wallet, 'local', label);
        assert.equal('address' in r.json, false, label);
        if (c.content !== null) assert.equal(leaksNothingOf(c.content, r.stdout + r.stderr), true, `${label}: the file's content reached the output`);
      }
    }
    // and a well formed 0600 file, written the way the README writes it, is still read
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(Array.from(wallet.secretKey)), { flag: 'wx', mode: 0o600 });
    assert.equal(readKeypairFile(good).publicKey.toBase58(), address);
    assert.throws(() => writeFileSync(good, '[]', { flag: 'wx', mode: 0o600 }), { code: 'EEXIST' }, 'the README recipe refuses to overwrite a key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planted: an unknown wallet on the flag or in WEAVR_WALLET is CONFIG (exit 5) naming the three values; an alias refuses a contrary flag', () => {
  const { file, done } = keypairDir();
  try {
    const a = runSync(SIGN, ['--wallet', 'ledger', '--address'], cleanEnv());
    assert.equal(a.code, EXIT.CONFIG);
    assert.equal(a.json.error, 'CONFIG');
    assert.match(a.json.detail, /paybox, local, link/);
    const b = runSync(SIGN, ['--address'], cleanEnv({ WEAVR_WALLET: 'Paybox' }));
    assert.equal(b.code, EXIT.CONFIG);
    assert.match(b.json.detail, /WEAVR_WALLET.*paybox, local, link/);
    const c = runSync(SIGN_LOCAL, ['--wallet', 'paybox', '--address'], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file }));
    assert.equal(c.code, EXIT.CONFIG);
    assert.match(c.json.detail, /conflicting/);
    assert.equal('address' in c.json, false);
  } finally { done(); }
});

// --- paybox ----------------------------------------------------------------

test('sign.mjs --wallet paybox --tx still signs through the fake PayBox CLI, as does the alias and the inferred mode', () => {
  const { env, done } = payboxEnv();
  try {
    const encoded = legacy(wallet.publicKey, new PublicKey(FACTORY));
    const a = runSync(SIGN, ['--wallet', 'paybox', '--tx', encoded], env);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.json.signed.length, 1);
    assert.match(a.json.signed[0], /^signed:/);
    assert.equal(a.json.wallet, 'paybox');
    assert.deepEqual(runSync(SIGN_SOLANA, ['--address'], env).json, { address, wallet: 'paybox' });
    // inferred: PAYBOX_CLI is set and no keypair file is
    assert.deepEqual(runSync(SIGN, ['--address'], env).json, { address, wallet: 'paybox' });
    // refusals keep their codes and gain the wallet
    const b = runSync(SIGN, ['--wallet', 'paybox', '--tx', legacy(wallet.publicKey, Keypair.generate().publicKey)], env);
    assert.equal(b.code, EXIT.REFUSED);
    assert.equal(b.json.error, 'FOREIGN_PROGRAM');
    assert.equal(b.json.wallet, 'paybox');
  } finally { done(); }
});

test('planted: a half configured PayBox host (no PAYBOX_CLI) is CONFIG naming PAYBOX_CLI from the bare tool and the bare check, never NO_WALLET', () => {
  const { env, done } = payboxEnv();
  try {
    for (const partial of [
      { ...env, PAYBOX_CLI: '' },
      { ...env, PAYBOX_CLI: undefined, PAYBOX_CREDENTIAL_ID: '' },
      { ...cleanEnv(), PAYBOX_SIGNING_KEY_FILE: join(env.PAYBOX_CONFIG_DIR, 'signing-key.txt') },
    ]) {
      const clean = Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined));
      for (const [tool, args] of [[SIGN, ['--address']], [SIGN, ['--deployment', 'dep-1']], [SIGN_CHECK, []]]) {
        const r = runSync(tool, args, clean);
        const label = `${tool.split('/').pop()} ${args.join(' ')} with ${Object.keys(clean).filter((k) => k.startsWith('PAYBOX') && clean[k]).join(',')}`;
        assert.equal(r.code, EXIT.CONFIG, `${label}: ${r.stdout}${r.stderr}`);
        assert.equal(r.json.error, 'CONFIG', label);
        assert.match(r.json.detail, /PAYBOX_CLI/, label);
        assert.equal(r.json.wallet, 'paybox', label);
        assert.equal(r.stdout.includes('NO_WALLET'), false, label);
        assert.equal(r.stdout.includes('sign link'), false, label);
      }
    }
  } finally { done(); }
});

// --- link ------------------------------------------------------------------

test('sign.mjs --wallet link: --address, --deposit, --tx and --file are NO_WALLET (exit 9) and nothing is contacted', async () => {
  const weavr = await fakeWeavr(['live']);
  try {
    const env = cleanEnv({ ...weavr.env });
    const expected = { error: 'NO_WALLET', detail: NO_WALLET_DETAIL, wallet: 'link' };
    for (const args of [
      ['--wallet', 'link', '--address'],
      ['--wallet', 'link', '--deposit', 'LNK', '--amount', '5'],
      ['--wallet', 'link', '--tx', legacy(wallet.publicKey, new PublicKey(FACTORY))],
      ['--wallet', 'link', '--file', '/nonexistent/walletPayload.json', '--send'],
      ['--address'], // nothing configured: link is what is inferred
    ]) {
      const r = await run(SIGN, args, env);
      assert.equal(r.code, EXIT.NO_WALLET, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.deepEqual(r.json, expected, args.join(' '));
    }
    const r = await run(SIGN, ['--address'], cleanEnv({ ...weavr.env, WEAVR_WALLET: 'link', PAYBOX_CLI: FAKE_CLI }));
    assert.deepEqual(r.json, expected, 'WEAVR_WALLET=link beats a configured PayBox CLI');
    assert.equal(weavr.requests.length, 0, 'no request reached the fake weavr');
  } finally { await weavr.close(); }
});

test('sign.mjs --wallet link --deployment polls await_portfolio with the id alone until live, prints wallet link, never rebuilds, never prints the payload', async () => {
  const weavr = await fakeWeavr(['awaiting_wallet', 'finishing', 'live']);
  try {
    const r = await run(SIGN, ['--wallet', 'link', '--deployment', 'dep-1'], cleanEnv(weavr.env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.step, 'await_portfolio');
    assert.equal(r.json.wallet, 'link');
    assert.equal(r.json.status, 'live');
    assert.equal(r.json.deploymentId, 'dep-1');
    assert.deepEqual(r.json.portfolio, { ticker: 'LNK' });
    assert.equal('walletPayload' in r.json, false, 'scrubbed');
    assert.equal(r.stdout.includes('never-printed'), false);
    assert.equal(weavr.requests.length, 3);
    for (const q of weavr.requests) {
      assert.equal(q.path, '/mcp');
      assert.equal(q.json.params.name, 'await_portfolio');
      assert.deepEqual(q.json.params.arguments, { deploymentId: 'dep-1', timeoutSecs: 50 }, 'the id alone, no signed');
    }
    assert.equal(weavr.requests.some((q) => q.path.includes('/rebuild')), false, 'rebuild is never hit');
  } finally { await weavr.close(); }
});

test('sign.mjs --wallet link --deployment: an expired deployment passes through after one poll; awaiting_wallet gives up after the rounds', async () => {
  const expired = await fakeWeavr(['expired']);
  try {
    const r = await run(SIGN, ['--wallet', 'link', '--deployment', 'dep-2'], cleanEnv(expired.env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'expired');
    assert.equal(r.json.wallet, 'link');
    assert.equal(expired.requests.length, 1);
  } finally { await expired.close(); }
  const waiting = await fakeWeavr(['awaiting_wallet']);
  try {
    const r = await run(SIGN, ['--wallet', 'link', '--deployment', 'dep-3'], cleanEnv(waiting.env));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'awaiting_wallet');
    assert.equal(waiting.requests.length, 6, 'the default rounds, then the status is handed back');
  } finally { await waiting.close(); }
});

test('sign.mjs --wallet link --deployment with no id is USAGE, and a weavr error is WEAVR_ERROR (exit 7)', async () => {
  const weavr = await fakeWeavr(['live']);
  try {
    const a = await run(SIGN, ['--wallet', 'link', '--deployment'], cleanEnv(weavr.env));
    assert.equal(a.code, EXIT.USAGE);
    assert.equal(a.json.error, 'USAGE');
    assert.equal(weavr.requests.length, 0);
  } finally { await weavr.close(); }
  const failing = await fakeWeavr(['error']);
  try {
    const b = await run(SIGN, ['--wallet', 'link', '--deployment', 'dep-9'], cleanEnv(failing.env));
    assert.equal(b.code, EXIT.WEAVR_ERROR);
    assert.equal(b.json.step, 'await_portfolio');
    assert.equal(b.json.error, 'deployment not found');
    assert.equal(b.json.wallet, 'link');
    assert.equal(failing.requests.length, 1, 'an error stops the polling');
  } finally { await failing.close(); }
});

// --- sign-check ------------------------------------------------------------

test('sign-check.mjs --wallet local signs the unsendable memo with the key and answers ok, signer local, wallet local', () => {
  const { file, done } = keypairDir();
  try {
    const r = runSync(SIGN_CHECK, ['--wallet', 'local'], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file }));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { status: 'ok', address, sent: false, signer: 'local', clientId: null, wallet: 'local' });
    // inferred from the keypair file alone
    assert.deepEqual(runSync(SIGN_CHECK, [], cleanEnv({ SIGN_LOCAL_KEYPAIR_FILE: file })).json, { status: 'ok', address, sent: false, signer: 'local', clientId: null, wallet: 'local' });
  } finally { done(); }
});

test('sign-check.mjs --wallet link is NO_WALLET (exit 9); so is nothing configured; an unknown wallet is CONFIG', () => {
  const a = runSync(SIGN_CHECK, ['--wallet', 'link'], cleanEnv());
  assert.equal(a.code, EXIT.NO_WALLET);
  assert.equal(a.json.status, 'failed');
  assert.equal(a.json.error, 'NO_WALLET');
  assert.equal(a.json.detail, NO_WALLET_DETAIL);
  assert.equal(a.json.signer, 'link');
  assert.equal(a.json.wallet, 'link');
  const b = runSync(SIGN_CHECK, [], cleanEnv());
  assert.equal(b.code, EXIT.NO_WALLET);
  assert.equal(b.json.wallet, 'link');
  const c = runSync(SIGN_CHECK, ['--wallet', 'ledger'], cleanEnv());
  assert.equal(c.code, EXIT.CONFIG);
  assert.equal(c.json.error, 'CONFIG');
  assert.match(c.json.detail, /paybox, local, link/);
  assert.equal('wallet' in c.json, false, 'no mode was resolved');
});

test('sign-check.mjs --wallet paybox keeps the PayBox answer and gains wallet paybox', () => {
  const { env, done } = payboxEnv({ FAKE_PAYBOX_KEYPAIR: JSON.stringify(Array.from(wallet.secretKey)) });
  try {
    const r = runSync(SIGN_CHECK, ['--wallet', 'paybox'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.status, 'ok');
    assert.equal(r.json.signer, 'paybox');
    assert.equal(r.json.wallet, 'paybox');
    assert.equal(r.json.address, address);
  } finally { done(); }
});
