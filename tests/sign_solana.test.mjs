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
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { CORE_PROGRAMS, EXIT, LEGACY_ONLY_DETAIL, PROGRAM_FROM_LOOKUP_TABLE, allowedPrograms, checkAll, checkTransaction, isVersioned, programsFromManifest } from '../tools/lib/tx-checks.mjs';
import { localSigner } from '../tools/lib/local-signer.mjs';

const require = createRequire(import.meta.url);
const { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

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

// --- v0 for a signer that signs it (the local key) ------------------------

/** A v0 transaction paid by `payer` with one instruction for `programId`, no lookup table: the shape of a five-asset create. */
function v0For(payer, programId) {
  const ix = new TransactionInstruction({ programId, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/**
 * A v0 transaction whose instruction names its program through an address
 * lookup table. web3.js never compiles one (a program id is always static),
 * so the message is compiled with the system program as a plain account
 * loaded from a fabricated table, then the instruction is pointed at that
 * loaded index. The loaded key is an allowlisted program on purpose: the
 * refusal has to come from the index, not from the allowlist.
 */
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
  assert.equal(msg.staticAccountKeys.length, 2, 'payer and the factory are static');
  assert.equal(msg.addressTableLookups.length, 1, 'the system program rides in the table');
  const loadedIndex = msg.staticAccountKeys.length + msg.addressTableLookups[0].writableIndexes.length + msg.addressTableLookups[0].readonlyIndexes.length - 1;
  msg.compiledInstructions[0].programIdIndex = loadedIndex;
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/**
 * A v0 transaction that loads its accounts from an address lookup table with
 * the program static: the shape weavr builds for a create of five to eight
 * assets against its NAV lookup table. `loaded` throwaway account keys ride
 * in a fabricated table (the first `writable` of them writable) and the only
 * static keys are the payer and the program. The headline case for a local
 * key, planted as a pass: a check that refused every lookup would refuse it.
 */
function v0WithTable(payer, programId, { loaded = 8, writable = 5 } = {}) {
  const addresses = Array.from({ length: loaded }, () => Keypair.generate().publicKey);
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses },
  });
  const ix = new TransactionInstruction({
    programId,
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, ...addresses.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i < writable }))],
    data: Buffer.from([1]),
  });
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [ix] }).compileToV0Message([table]);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/** True when the first signature of the encoded v0 transaction is `pubkey`'s ed25519 signature over its message. */
function v0SignedBy(encoded, pubkey) {
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  const sig = Buffer.from(tx.signatures[0]);
  if (sig.every((b) => b === 0)) return false;
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkey.toBytes())]), format: 'der', type: 'spki' });
  return verifyEd25519(null, Buffer.from(tx.message.serialize()), spki, sig);
}

const v0opts = { ...opts, allowVersioned: true };

test('a weavr-shaped v0 transaction for this wallet passes when the signer signs v0, and the local key\'s signature over it verifies', async () => {
  const encoded = v0For(wallet.publicKey, new PublicKey(FACTORY));
  assert.equal(isVersioned(Buffer.from(encoded, 'base64')), true);
  const r = checkTransaction(encoded, v0opts);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.versioned, true);
  assert.deepEqual(r.programs, [FACTORY]);
  assert.equal(r.bytes, Buffer.from(encoded, 'base64').length);
  // and checkAll takes a mixed payload, legacy first
  const all = checkAll([legacy(wallet.publicKey, new PublicKey(FACTORY)), encoded], v0opts);
  assert.equal(all.ok, true);
  assert.equal(all.results[1].versioned, true);
  // the local key signs it: signatures[0] is filled and is a real ed25519 signature over the message
  const dir = mkdtempSync(join(tmpdir(), 'sign-local-v0-'));
  try {
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600 });
    const s = localSigner({ keypairFile: file });
    assert.equal(s.allowVersioned, true);
    const [signed] = await s.sign([encoded]);
    assert.equal(v0SignedBy(signed, wallet.publicKey), true, 'signed by the wallet');
    assert.equal(v0SignedBy(signed, other.publicKey), false, 'and by nobody else');
    assert.equal(v0SignedBy(encoded, wallet.publicKey), false, 'the unsigned input carries no signature');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a v0 that loads its accounts from a lookup table, the program static (a five-to-eight-asset create), passes when the signer signs v0, and the local key signs it with the lookup kept', async () => {
  const encoded = v0WithTable(wallet.publicKey, new PublicKey(FACTORY));
  assert.equal(isVersioned(Buffer.from(encoded, 'base64')), true);
  const input = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  assert.equal(input.message.addressTableLookups.length, 1, 'one table is consulted');
  assert.equal(input.message.staticAccountKeys.length, 2, 'the payer and the factory are the only static keys');
  assert.equal(input.message.addressTableLookups[0].writableIndexes.length, 5);
  assert.equal(input.message.addressTableLookups[0].readonlyIndexes.length, 3);
  assert.equal(input.message.compiledInstructions[0].accountKeyIndexes.length, 9, 'the payer and eight loaded accounts');
  assert.equal(input.message.compiledInstructions[0].programIdIndex < input.message.staticAccountKeys.length, true, 'the program is static');
  const r = checkTransaction(encoded, v0opts);
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.versioned, true);
  assert.deepEqual(r.programs, [FACTORY]);
  assert.equal(r.bytes, Buffer.from(encoded, 'base64').length);
  assert.equal(checkAll([encoded, legacy(wallet.publicKey, new PublicKey(FACTORY))], v0opts).ok, true);
  // the table loosens nothing: the same shape still fails on the payer and on the program
  assert.equal(checkTransaction(v0WithTable(other.publicKey, new PublicKey(FACTORY)), v0opts).error, 'WRONG_PAYER');
  assert.equal(checkTransaction(v0WithTable(wallet.publicKey, Keypair.generate().publicKey), v0opts).error, 'FOREIGN_PROGRAM');
  // and a legacy-only signer still gets LEGACY_ONLY for it
  assert.equal(checkTransaction(encoded, opts).error, 'LEGACY_ONLY');
  // the local key signs it: a real ed25519 signature over the message, the message untouched
  const dir = mkdtempSync(join(tmpdir(), 'sign-local-v0-table-'));
  try {
    const file = join(dir, 'agent.json');
    writeFileSync(file, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600 });
    const [signed] = await localSigner({ keypairFile: file }).sign([encoded]);
    assert.equal(v0SignedBy(signed, wallet.publicKey), true, 'signed by the wallet');
    assert.equal(v0SignedBy(signed, other.publicKey), false, 'and by nobody else');
    const out = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
    assert.equal(out.message.addressTableLookups.length, 1, 'the lookup rides through');
    assert.deepEqual(Buffer.from(out.message.serialize()), Buffer.from(input.message.serialize()), 'the message is byte-identical after signing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planted: a v0 for a foreign program is FOREIGN_PROGRAM (exit 4) even when v0 is allowed', () => {
  const foreign = Keypair.generate().publicKey;
  const r = checkTransaction(v0For(wallet.publicKey, foreign), v0opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FOREIGN_PROGRAM');
  assert.equal(r.exit, EXIT.REFUSED);
  assert.match(r.detail, new RegExp(foreign.toBase58()));
  // allowing v0 loosens nothing for legacy
  assert.equal(checkTransaction(legacy(wallet.publicKey, foreign), v0opts).error, 'FOREIGN_PROGRAM');
});

test('planted: a v0 paid by another key is WRONG_PAYER (exit 4)', () => {
  const r = checkTransaction(v0For(other.publicKey, new PublicKey(FACTORY)), v0opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'WRONG_PAYER');
  assert.equal(r.exit, EXIT.REFUSED);
  assert.match(r.detail, new RegExp(`${other.publicKey.toBase58()}.*${wallet.publicKey.toBase58()}`));
  assert.equal(checkTransaction(legacy(other.publicKey, new PublicKey(FACTORY)), v0opts).error, 'WRONG_PAYER');
});

test('planted: a v0 whose instruction loads its program from a lookup table is FOREIGN_PROGRAM naming the table, allowlisted key or not', () => {
  const encoded = v0ProgramFromTable(wallet.publicKey);
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, 'base64'));
  assert.equal(tx.message.compiledInstructions[0].programIdIndex >= tx.message.staticAccountKeys.length, true, 'the plant points past the static keys');
  const r = checkTransaction(encoded, v0opts);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FOREIGN_PROGRAM');
  assert.equal(r.exit, EXIT.REFUSED);
  assert.match(r.detail, /lookup table/);
  assert.equal(r.detail.startsWith(PROGRAM_FROM_LOOKUP_TABLE), true);
  assert.ok(allowed.has(SystemProgram.programId.toBase58()), 'the loaded key is allowlisted, so the refusal is the index');
  // and the same payload is LEGACY_ONLY for a legacy-only signer, as before
  assert.equal(checkTransaction(encoded, opts).error, 'LEGACY_ONLY');
});

test('planted: without allowVersioned a good v0 is still LEGACY_ONLY, and the detail names PayBox, the local key and the sign link', () => {
  const encoded = v0For(wallet.publicKey, new PublicKey(FACTORY));
  for (const o of [opts, { ...opts, allowVersioned: false }, { ...opts, allowVersioned: 'yes' }]) {
    const r = checkTransaction(encoded, o);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'LEGACY_ONLY');
    assert.equal(r.exit, EXIT.LEGACY_ONLY);
    assert.equal(r.detail, LEGACY_ONLY_DETAIL);
  }
  assert.match(LEGACY_ONLY_DETAIL, /the PayBox signer decodes legacy transactions only/);
  assert.match(LEGACY_ONLY_DETAIL, /a local key or the sign link signs any size/);
  assert.equal(checkAll([legacy(wallet.publicKey, new PublicKey(FACTORY)), encoded], opts).error, 'LEGACY_ONLY');
});

test('planted: a payload with the version bit set that is not a transaction is NOT_A_TRANSACTION when v0 is allowed, never a crash', () => {
  const truncated = Buffer.from([1, ...new Array(64).fill(0), 0x80, 0, 0, 0]).toString('base64');
  assert.equal(isVersioned(Buffer.from(truncated, 'base64')), true);
  const a = checkTransaction(truncated, v0opts);
  assert.equal(a.error, 'NOT_A_TRANSACTION');
  assert.equal(a.exit, EXIT.REFUSED);
  // a message version this tool does not know is not signed either
  const v1 = Buffer.from([1, ...new Array(64).fill(0), 0x81, 1, 0, 0, 1, ...new Array(32).fill(3), ...new Array(32).fill(4), 0, 0]).toString('base64');
  const b = checkTransaction(v1, v0opts);
  assert.equal(b.error, 'NOT_A_TRANSACTION');
  assert.equal(b.exit, EXIT.REFUSED);
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
  assert.deepEqual(r.json, { address: wallet.publicKey.toBase58(), wallet: 'paybox' });
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
    assert.deepEqual(JSON.parse(r.stdout), { address: wallet.publicKey.toBase58(), wallet: 'local' });
    rmSync(dir, { recursive: true, force: true });
  });
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
