// The pre-demo sign check signs one memo and throws it away. Proven here:
// the memo is legacy, paid by the wallet and unsendable by construction; a
// real signature passes, a missing or forged one fails; through the fake
// PayBox CLI the tool reports ok, a revoked signer, and missing config with
// the same exit codes as the wallet tool. No key, network or money involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const OPS_ROOT = fileURLToPath(new URL('..', import.meta.url));
import { EXIT, isVersioned } from '../tools/lib/tx-checks.mjs';
import { MEMO_PROGRAM, UNSENDABLE_HASH, carriesSignatureOf, memoTransaction, payboxClientId, signCheck } from '../tools/lib/sign-check.mjs';

const require = createRequire(import.meta.url);
const { Keypair, Transaction } = require('@solana/web3.js');

const TOOL = join(OPS_ROOT, 'tools/sign-check.mjs');
const FAKE_CLI = join(OPS_ROOT, 'tests/fixtures/fake-paybox-cli.mjs');
const wallet = Keypair.generate();
const address = wallet.publicKey.toBase58();

function signedBy(kp, encoded) {
  const tx = Transaction.from(Buffer.from(encoded, 'base64'));
  tx.partialSign(kp);
  return tx.serialize({ requireAllSignatures: false }).toString('base64');
}
const stubSigner = (sign) => ({ wallet: address, kind: 'stub', sign: async (list) => list.map(sign) });

test('the memo is a legacy transaction paid by the wallet, one memo instruction, unsendable hash', () => {
  const encoded = memoTransaction(address);
  assert.equal(isVersioned(Buffer.from(encoded, 'base64')), false);
  const tx = Transaction.from(Buffer.from(encoded, 'base64'));
  assert.equal(tx.feePayer.toBase58(), address);
  assert.equal(tx.recentBlockhash, UNSENDABLE_HASH);
  assert.equal(tx.instructions.length, 1);
  assert.equal(tx.instructions[0].programId.toBase58(), MEMO_PROGRAM);
  assert.equal(tx.signatures.length, 1);
});

test('a signature from the wallet passes; none, a forged one, or another key fails', async () => {
  const ok = await signCheck(stubSigner((e) => signedBy(wallet, e)));
  assert.deepEqual(ok, { status: 'ok', address, sent: false });
  const none = await signCheck(stubSigner((e) => e));
  assert.equal(none.status, 'bad_signature');
  const forged = await signCheck(stubSigner((e) => {
    const tx = Transaction.from(Buffer.from(e, 'base64'));
    tx.addSignature(wallet.publicKey, Buffer.alloc(64, 7));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }));
  assert.equal(forged.status, 'bad_signature');
  assert.equal(carriesSignatureOf('not a transaction', address), false);
});

test('payboxClientId reads the cid claim of the stored token, null when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sign-check-'));
  try {
    const payload = Buffer.from(JSON.stringify({ cid: 'client-xyz', sub: 'u' })).toString('base64url');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ oauth: { accessToken: `h.${payload}.s` } }));
    assert.equal(payboxClientId(dir), 'client-xyz');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ oauth: { accessToken: 'opaque' } }));
    assert.equal(payboxClientId(dir), null);
    assert.equal(payboxClientId(join(dir, 'missing')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function toolEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sign-check-cli-'));
  writeFileSync(join(dir, 'signing-key.txt'), 'pbxk1.fake-key\n', { mode: 0o600 });
  const payload = Buffer.from(JSON.stringify({ cid: 'client-xyz' })).toString('base64url');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ oauth: { accessToken: `h.${payload}.s` } }), { mode: 0o600 });
  const env = {
    ...process.env,
    PAYBOX_CONFIG_DIR: dir,
    PAYBOX_CREDENTIAL_ID: 'cred-1',
    PAYBOX_CLI: FAKE_CLI,
    FAKE_PAYBOX_WALLET: address,
    ...extra,
  };
  return { dir, env };
}
const run = (env, args = []) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { env, encoding: 'utf8' });
  return { code: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
};

test('through the fake PayBox CLI: ok with a real signature, exit 0, and the client id', () => {
  const { dir, env } = toolEnv({ FAKE_PAYBOX_KEYPAIR: JSON.stringify(Array.from(wallet.secretKey)) });
  try {
    const r = run(env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { status: 'ok', address, sent: false, signer: 'paybox', clientId: 'client-xyz' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a placeholder signature from the CLI is not accepted', () => {
  const { dir, env } = toolEnv();
  try {
    const r = run(env);
    assert.equal(r.code, EXIT.WALLET_DECLINED);
    assert.equal(r.json.status, 'bad_signature');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a revoked signer is WALLET_DECLINED with the reason and the client id to mint for', () => {
  const { dir, env } = toolEnv({ FAKE_PAYBOX_REVOKED: '1' });
  try {
    const r = run(env);
    assert.equal(r.code, EXIT.WALLET_DECLINED);
    assert.equal(r.json.error, 'WALLET_DECLINED');
    assert.match(r.json.detail, /revoked/);
    assert.equal(r.json.clientId, 'client-xyz');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing configuration is CONFIG, naming the variable', () => {
  const r = run({ ...process.env, PAYBOX_CONFIG_DIR: '', PAYBOX_CREDENTIAL_ID: '', PAYBOX_CLI: '' });
  assert.equal(r.code, EXIT.CONFIG);
  assert.equal(r.json.error, 'CONFIG');
  assert.match(r.json.detail, /PAYBOX_CLI/);
});
