// The wallet tool for text-only agents refuses what it must and signs only
// what weavr built for this wallet. Each refusal is proven on a planted
// violation; the happy path runs against a fake PayBox CLI so no key, network
// or money is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const OPS_ROOT = fileURLToPath(new URL('..', import.meta.url));
import { CORE_PROGRAMS, EXIT, allowedPrograms, checkAll, checkTransaction, isVersioned, programsFromManifest } from '../tools/lib/tx-checks.mjs';
import { localSigner } from '../tools/lib/local-signer.mjs';
import { makeRefreshNav, makeWithdraw, weavrClient } from '../tools/lib/weavr.mjs';

const require = createRequire(import.meta.url);
const { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

const MANIFEST = join(OPS_ROOT, 'manifest.json');
const FACTORY = 'CB1Tw9aB8ju66q9ZVcezyfCbwNJDVLAMn2RpU3K1tVn';
const TOOL = join(OPS_ROOT, 'tools/sign-solana.mjs');
const LOCAL_TOOL = join(OPS_ROOT, 'tools/sign-local.mjs');
const FAKE_CLI = join(OPS_ROOT, 'tests/fixtures/fake-paybox-cli.mjs');
const BLOCKHASH = '11111111111111111111111111111111';

const wallet = Keypair.generate();
const other = Keypair.generate();

function legacy(payer, programId) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH });
  tx.add(new TransactionInstruction({ programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}
function v0(payer) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

const allowed = allowedPrograms(programsFromManifest(MANIFEST));
const opts = { wallet: wallet.publicKey.toBase58(), allowed };

test('the allowlist is the manifest plus the core programs', () => {
  assert.ok(allowed.has(FACTORY), 'portfolio_factory from manifest.json');
  assert.ok(allowed.has(CORE_PROGRAMS.system));
  assert.ok(allowed.has(CORE_PROGRAMS.associatedToken));
  assert.ok(programsFromManifest(MANIFEST).length >= 5);
});

test('a weavr-shaped legacy transaction for this wallet passes', () => {
  const r = checkTransaction(legacy(wallet.publicKey, new PublicKey(FACTORY)), opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.programs, [FACTORY]);
});

test('planted: a v0 transaction is refused as LEGACY_ONLY (exit 2)', () => {
  const encoded = v0(wallet.publicKey);
  assert.equal(isVersioned(Buffer.from(encoded, 'base64')), true);
  const r = checkTransaction(encoded, opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'LEGACY_ONLY');
  assert.equal(r.exit, EXIT.LEGACY_ONLY);
});

test('planted: an instruction for a foreign program is refused (exit 4)', () => {
  const r = checkTransaction(legacy(wallet.publicKey, Keypair.generate().publicKey), opts);
  assert.equal(r.error, 'FOREIGN_PROGRAM');
  assert.equal(r.exit, EXIT.REFUSED);
});

test('planted: a fee payer other than the wallet is refused (exit 4)', () => {
  const r = checkTransaction(legacy(other.publicKey, new PublicKey(FACTORY)), opts);
  assert.equal(r.error, 'WRONG_PAYER');
  assert.equal(r.exit, EXIT.REFUSED);
});

test('planted: garbage is NOT_A_TRANSACTION, never a crash', () => {
  assert.equal(checkTransaction('', opts).error, 'NOT_A_TRANSACTION');
  assert.equal(checkTransaction('AAAA', opts).error, 'NOT_A_TRANSACTION');
});

test('checkAll stops at the first refusal of a multi-transaction payload', () => {
  const r = checkAll([legacy(wallet.publicKey, new PublicKey(FACTORY)), v0(wallet.publicKey)], opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'LEGACY_ONLY');
});

function toolEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'paybox-cli-'));
  return {
    dir,
    env: {
      ...process.env,
      PAYBOX_CONFIG_DIR: dir,
      PAYBOX_CREDENTIAL_ID: 'cred-1',
      PAYBOX_CLI: FAKE_CLI,
      PAYBOX_SIGNING_KEY_FILE: join(dir, 'signing-key.txt'),
      FAKE_PAYBOX_WALLET: wallet.publicKey.toBase58(),
      WEAVR_MANIFEST: MANIFEST,
      ...extra,
    },
  };
}
function runTool(args, env) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* keep raw */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('sign-solana.mjs --address prints the granted wallet and nothing else', () => {
  const { dir, env } = toolEnv();
  writeFileSync(env.PAYBOX_SIGNING_KEY_FILE, 'pbxk1.fake-key\n', { mode: 0o600 });
  const r = runTool(['--address'], env);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json, { address: wallet.publicKey.toBase58() });
  rmSync(dir, { recursive: true, force: true });
});

test('sign-solana.mjs --tx signs a good transaction through the CLI, via a 0600 intent file, and releases its lock', () => {
  const { dir, env } = toolEnv();
  writeFileSync(env.PAYBOX_SIGNING_KEY_FILE, 'pbxk1.fake-key\n', { mode: 0o600 });
  const r = runTool(['--tx', legacy(wallet.publicKey, new PublicKey(FACTORY))], env);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.signed.length, 1);
  assert.match(r.json.signed[0], /^signed:/);
  assert.equal(existsSync(join(dir, 'work', '.lock')), false, 'lock released');
  assert.equal(existsSync(join(dir, 'work')) && require('node:fs').readdirSync(join(dir, 'work')).some((f) => f.startsWith('intent-')), false, 'intent file removed');
  rmSync(dir, { recursive: true, force: true });
});

test('sign-solana.mjs refuses before the CLI is ever called (v0 → exit 2, foreign → exit 4) and leaves no lock', () => {
  const { dir, env } = toolEnv();
  writeFileSync(env.PAYBOX_SIGNING_KEY_FILE, 'pbxk1.fake-key\n', { mode: 0o600 });
  const a = runTool(['--tx', v0(wallet.publicKey)], env);
  assert.equal(a.code, EXIT.LEGACY_ONLY);
  assert.equal(a.json.error, 'LEGACY_ONLY');
  const b = runTool(['--tx', legacy(wallet.publicKey, Keypair.generate().publicKey)], env);
  assert.equal(b.code, EXIT.REFUSED);
  assert.equal(b.json.error, 'FOREIGN_PROGRAM');
  assert.equal(existsSync(join(dir, 'work', '.lock')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a PayBox status without a signature is WALLET_DECLINED (exit 3)', () => {
  const { dir, env } = toolEnv({ FAKE_PAYBOX_DECLINE: '1' });
  writeFileSync(env.PAYBOX_SIGNING_KEY_FILE, 'pbxk1.fake-key\n', { mode: 0o600 });
  const r = runTool(['--tx', legacy(wallet.publicKey, new PublicKey(FACTORY))], env);
  assert.equal(r.code, EXIT.WALLET_DECLINED);
  assert.equal(r.json.error, 'WALLET_DECLINED');
  assert.match(r.json.detail, /pending_signature/);
  rmSync(dir, { recursive: true, force: true });
});

test('missing configuration is CONFIG (exit 5), with the names, never a stack trace', () => {
  const r = runTool(['--address'], { ...process.env, PAYBOX_CONFIG_DIR: '', PAYBOX_CREDENTIAL_ID: '', PAYBOX_CLI: '' });
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.json.detail, /PAYBOX_CONFIG_DIR/);
});

test('the local signer signs legacy and v0 (the bisecting control), from a keypair file path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sign-local-'));
  const file = join(dir, 'dust.json');
  writeFileSync(file, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600 });
  const s = localSigner({ keypairFile: file });
  assert.equal(s.wallet, wallet.publicKey.toBase58());
  return s.sign([legacy(wallet.publicKey, new PublicKey(FACTORY)), v0(wallet.publicKey)]).then((signed) => {
    const l = Transaction.from(Buffer.from(signed[0], 'base64'));
    assert.ok(l.signatures[0].signature, 'legacy signed');
    const v = VersionedTransaction.deserialize(Buffer.from(signed[1], 'base64'));
    assert.ok(v.signatures[0].some((b) => b !== 0), 'v0 signed');
    const r = spawnSync(process.execPath, [LOCAL_TOOL, '--address'], { env: { ...process.env, SIGN_LOCAL_KEYPAIR_FILE: file }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), { address: wallet.publicKey.toBase58() });
    rmSync(dir, { recursive: true, force: true });
  });
});

// The one-signature user flows (deposit, withdraw, refresh valuation) run
// against a stub weavr: build_* answers a walletPayload for this wallet,
// send_signed records what it was handed. The local signer signs; nothing
// leaves the process.
function stubWeavr(buildTool, txs, { buildError = false, book = { mint: 'Gh5onqzay9n33wshnBoD52vxM4cdUQEXRvNfhk2jTP1W', price: '1000000' } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (!init?.body) {
      calls.push({ name: 'REST', url: String(url) });
      return { status: 200, text: async () => JSON.stringify(book) };
    }
    const body = JSON.parse(init.body);
    const name = body.params.name;
    calls.push({ name, args: body.params.arguments });
    let payload;
    let isError = false;
    if (name === buildTool) {
      if (buildError) { payload = { error: 'NO_SUCH_PORTFOLIO' }; isError = true; }
      else payload = { walletPayload: { signer: 'user', transactions: txs }, portfolio: 'MAJB' };
    } else if (name === 'send_signed') {
      payload = { status: 'confirmed', signatures: body.params.arguments.signed.map((s, i) => `sig${i}`) };
    } else {
      payload = { error: `unexpected ${name}` }; isError = true;
    }
    return { json: async () => ({ jsonrpc: '2.0', id: 1, result: { isError, structuredContent: payload } }) };
  };
  return { client: weavrClient({ fetchImpl }), calls };
}

function localSignerFor(kp) {
  const dir = mkdtempSync(join(tmpdir(), 'sign-local-flow-'));
  const file = join(dir, 'kp.json');
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return { signer: localSigner({ keypairFile: file }), dir };
}

test('makeWithdraw builds with the wallet as user, signs after the checks, sends, and never leaks walletPayload', async () => {
  const { signer, dir } = localSignerFor(wallet);
  const { client, calls } = stubWeavr('build_withdraw', [legacy(wallet.publicKey, new PublicKey(FACTORY))]);
  const r = await makeWithdraw(client, 'MAJB', '12', signer, allowed, { minAmountOut: '5' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls[0], { name: 'build_withdraw', args: { portfolio: 'MAJB', user: wallet.publicKey.toBase58(), shares: '12000000', minAmountOut: '5' } });
  assert.equal(calls[1].name, 'send_signed');
  assert.equal(calls[1].args.signed.length, 1);
  assert.ok(Transaction.from(Buffer.from(calls[1].args.signed[0], 'base64')).signatures[0].signature, 'sent bytes carry the wallet signature');
  assert.equal(r.output.step, 'send_signed');
  assert.equal(r.output.shares, '12');
  assert.equal(r.output.status, 'confirmed');
  assert.equal('walletPayload' in r.output, false);
  rmSync(dir, { recursive: true, force: true });
});

test('makeRefreshNav builds with the wallet as payer and sends what it signed', async () => {
  const { signer, dir } = localSignerFor(wallet);
  const { client, calls } = stubWeavr('build_refresh_nav', [legacy(wallet.publicKey, new PublicKey(FACTORY))]);
  const r = await makeRefreshNav(client, 'MAJB', signer, allowed);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls[0], { name: 'build_refresh_nav', args: { portfolio: 'MAJB', payer: wallet.publicKey.toBase58() } });
  assert.equal(calls[1].name, 'send_signed');
  assert.equal(r.output.portfolio, 'MAJB');
  rmSync(dir, { recursive: true, force: true });
});

test('the user flows refuse a payload for another wallet before signing, and surface a weavr build error without walletPayload', async () => {
  const { signer, dir } = localSignerFor(wallet);
  const foreign = stubWeavr('build_withdraw', [legacy(other.publicKey, new PublicKey(FACTORY))]);
  const a = await makeWithdraw(foreign.client, 'MAJB', '1', signer, allowed);
  assert.equal(a.ok, false);
  assert.equal(a.output.error, 'WRONG_PAYER');
  assert.equal(foreign.calls.some((c) => c.name === 'send_signed'), false, 'nothing sent');
  const failing = stubWeavr('build_refresh_nav', [], { buildError: true });
  const b = await makeRefreshNav(failing.client, 'NOPE', signer, allowed);
  assert.equal(b.ok, false);
  assert.equal(b.exit, EXIT.WEAVR_ERROR);
  assert.equal(b.output.step, 'build_refresh_nav');
  assert.equal(b.output.error, 'NO_SUCH_PORTFOLIO');
  rmSync(dir, { recursive: true, force: true });
});

test('makeWithdraw sizes a dollar request at the live price and snaps leftover dust to a full exit', async () => {
  const { signer, dir } = localSignerFor(wallet);
  const mint = Keypair.generate().publicKey.toBase58();
  const { client, calls } = stubWeavr('build_withdraw', [legacy(wallet.publicKey, new PublicKey(FACTORY))], { book: { mint, price: '1000000' } });
  const connection = {
    getParsedTokenAccountsByOwner: async () => ({
      value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: '4990000' } } } } } }],
    }),
  };
  const partial = await makeWithdraw(client, 'BTCMAXI', null, signer, allowed, { amountUsd: '4', connection });
  assert.equal(partial.ok, true, JSON.stringify(partial));
  assert.equal(calls.find((c) => c.name === 'build_withdraw').args.shares, '4000000');
  assert.equal(partial.output.fullExit, false);
  assert.equal(partial.output.amountUsd, 4);

  const exit = await makeWithdraw(client, 'BTCMAXI', null, signer, allowed, { amountUsd: '5', connection });
  assert.equal(exit.ok, true, JSON.stringify(exit));
  assert.equal(calls.filter((c) => c.name === 'build_withdraw').at(-1).args.shares, '4990000');
  assert.equal(exit.output.fullExit, true);

  const tiny = await makeWithdraw(client, 'BTCMAXI', null, signer, allowed, { amountUsd: '0.0001', connection });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.output.error, 'BELOW_MINIMUM');
  assert.match(tiny.output.detail, /\$0\.001/);
  rmSync(dir, { recursive: true, force: true });
});

test('sign-local.mjs --withdraw and --refresh-nav check their arguments before any network call (exit 1 USAGE)', () => {
  const { dir } = localSignerFor(wallet);
  const env = { ...process.env, SIGN_LOCAL_KEYPAIR_FILE: join(dir, 'kp.json'), WEAVR_MANIFEST: MANIFEST, WEAVR_MCP_URL: 'http://127.0.0.1:9/mcp', WEAVR_API_URL: 'http://127.0.0.1:9' };
  const run = (args) => { const r = spawnSync(process.execPath, [LOCAL_TOOL, ...args], { env, encoding: 'utf8' }); return { code: r.status, json: JSON.parse(r.stdout) }; };
  for (const args of [['--withdraw', 'MAJB'], ['--withdraw', 'MAJB', '--amount', '0'], ['--withdraw', 'MAJB', '--amount', 'abc'], ['--withdraw', 'MAJB', '--shares', '2', '--amount', '4'], ['--withdraw', 'MAJB', '--shares', '0'], ['--withdraw', 'MAJB', '--shares', '1.5000001'], ['--withdraw', 'MAJB', '--shares', '2', '--min-out', 'abc'], ['--refresh-nav']]) {
    const r = run(args);
    assert.equal(r.code, EXIT.USAGE, args.join(' '));
    assert.equal(r.json.error, 'USAGE');
  }
  rmSync(dir, { recursive: true, force: true });
});

// The money gate is a Hermes plugin (Python). Its planted cases run here too,
// through the system python, so `npm test` covers them; skipped without python3.
test('the money-gate plugin escalates signing runs and ignores everything else', (t) => {
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (py.status !== 0) return t.skip('python3 is not available');
  const r = spawnSync('python3', [join(OPS_ROOT, 'plugins/weavr-wallet-gate/test_gate.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wallet gate: ok/);
});
