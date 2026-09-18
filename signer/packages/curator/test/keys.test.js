/**
 * The signer must sign both wire formats and must refuse every malformed
 * key file with a message that names the variable and never the file's
 * contents — a refusal that echoed the file would put the secret in Loki.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { loadSigner, isVersioned, KEYPAIR_ENV } from '../src/keys.js';
import { Refusal } from '../src/errors.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const BLOCKHASH = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const SECRET_MARKER = 'THIS-IS-NOT-A-KEY-BUT-MUST-NOT-LEAK';

const edVerifyRaw = (publicKey, message, signature) => edVerify(
  null,
  message,
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKey.toBytes()]), format: 'der', type: 'spki' }),
  signature,
);

let dir;
let keypair;
let file;
let signer;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'curator-keys-'));
  keypair = Keypair.generate();
  file = join(dir, 'curator.json');
  writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  signer = loadSigner({ file });
});

after(() => rmSync(dir, { recursive: true, force: true }));

const legacyTransfer = ({ payer = keypair.publicKey, from = keypair.publicKey } = {}) => {
  const tx = new Transaction({ recentBlockhash: BLOCKHASH, feePayer: payer });
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
};

const v0Transfer = () => {
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
};

describe('loadSigner', () => {
  it('exposes the public key, the kind and sign — nothing else, frozen', () => {
    assert.equal(signer.wallet, keypair.publicKey.toBase58());
    assert.equal(signer.kind, 'curator');
    assert.equal(typeof signer.sign, 'function');
    assert.deepEqual(Object.keys(signer).sort(), ['kind', 'sign', 'wallet']);
    assert.ok(Object.isFrozen(signer));
  });

  it('never leaks the secret through JSON, inspect or the file path', () => {
    const secretHex = Buffer.from(keypair.secretKey).toString('hex');
    const secretJson = JSON.stringify(Array.from(keypair.secretKey));
    for (const rendered of [JSON.stringify(signer), inspect(signer, { depth: 10 }), String(signer.sign)]) {
      assert.ok(!rendered.includes(secretHex));
      assert.ok(!rendered.includes(secretJson));
      assert.ok(!rendered.includes('secretKey'));
    }
  });

  it('signs a legacy transaction with partialSign', async () => {
    const [signed] = await signer.sign([legacyTransfer()]);
    const tx = Transaction.from(Buffer.from(signed, 'base64'));
    assert.ok(tx.verifySignatures());
    assert.ok(tx.signatures.some((entry) => entry.publicKey.equals(keypair.publicKey) && entry.signature));
  });

  it('partialSign leaves a co-signer slot empty rather than failing', async () => {
    const payer = Keypair.generate();
    const [signed] = await signer.sign([legacyTransfer({ payer: payer.publicKey })]);
    const tx = Transaction.from(Buffer.from(signed, 'base64'));
    const ours = tx.signatures.find((entry) => entry.publicKey.equals(keypair.publicKey));
    const theirs = tx.signatures.find((entry) => entry.publicKey.equals(payer.publicKey));
    assert.ok(ours?.signature, 'our slot is signed');
    assert.equal(theirs?.signature, null, 'the payer slot stays open for the co-signer');
  });

  it('signs a v0 transaction with a valid ed25519 signature over the message', async () => {
    const encoded = v0Transfer();
    assert.ok(isVersioned(Buffer.from(encoded, 'base64')));
    const [signed] = await signer.sign([encoded]);
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
    assert.equal(tx.signatures.length, 1);
    assert.ok(edVerifyRaw(keypair.publicKey, Buffer.from(tx.message.serialize()), Buffer.from(tx.signatures[0])));
  });

  it('signs a mixed list in order', async () => {
    const signed = await signer.sign([legacyTransfer(), v0Transfer(), legacyTransfer()]);
    assert.equal(signed.length, 3);
    assert.ok(!isVersioned(Buffer.from(signed[0], 'base64')));
    assert.ok(isVersioned(Buffer.from(signed[1], 'base64')));
    assert.ok(!isVersioned(Buffer.from(signed[2], 'base64')));
  });

  it('refuses to sign something that is not a transaction', async () => {
    await assert.rejects(signer.sign(['bm90IGEgdHJhbnNhY3Rpb24=']), (error) => error instanceof Refusal && error.code === 'NOT_A_TRANSACTION');
    await assert.rejects(signer.sign(['']), (error) => error.code === 'NOT_A_TRANSACTION');
    await assert.rejects(signer.sign('abc'), (error) => error.code === 'NOT_A_TRANSACTION');
  });
});

describe('loadSigner refusals (code CONFIG, env var named, contents never echoed)', () => {
  const expectConfig = (fn, { names = KEYPAIR_ENV, neverContains = [] } = {}) => {
    assert.throws(fn, (error) => {
      assert.ok(error instanceof Refusal, 'is a Refusal');
      assert.equal(error.code, 'CONFIG');
      assert.ok(error.message.includes(names), `message names ${names}: ${error.message}`);
      for (const banned of neverContains) assert.ok(!error.message.includes(banned), `message must not include ${banned}`);
      assert.equal(error.detail, undefined, 'no detail that could carry the file');
      return true;
    });
  };

  it('unset path', () => {
    expectConfig(() => loadSigner({}));
    expectConfig(() => loadSigner({ file: '' }));
  });

  it('missing file: names the variable, not the path', () => {
    const missing = join(dir, 'nope.json');
    expectConfig(() => loadSigner({ file: missing }), { neverContains: [missing, dir] });
  });

  it('custom env name is what the message quotes', () => {
    expectConfig(() => loadSigner({ file: join(dir, 'nope.json'), env: 'OTHER_KEYPAIR' }), { names: 'OTHER_KEYPAIR' });
  });

  it('not JSON: the file contents never appear in the message', () => {
    const bad = join(dir, 'garbage.json');
    writeFileSync(bad, `${SECRET_MARKER} {not json`);
    expectConfig(() => loadSigner({ file: bad }), { neverContains: [SECRET_MARKER, bad] });
  });

  it('wrong length: 63 and 65 bytes, and a JSON object, are refused', () => {
    const bytes = Array.from(keypair.secretKey);
    for (const [name, content] of [
      ['short.json', JSON.stringify(bytes.slice(0, 63))],
      ['long.json', JSON.stringify([...bytes, 1])],
      ['object.json', JSON.stringify({ secretKey: bytes })],
      ['string.json', JSON.stringify(SECRET_MARKER)],
      ['nonbyte.json', JSON.stringify(bytes.map((b, i) => (i === 3 ? 256 : b)))],
    ]) {
      const path = join(dir, name);
      writeFileSync(path, content);
      expectConfig(() => loadSigner({ file: path }), { neverContains: [SECRET_MARKER, content.slice(0, 40)] });
    }
  });

  it('64 bytes whose public half does not match the secret half', () => {
    const bytes = Array.from(keypair.secretKey);
    bytes[63] ^= 0xff; // corrupt the public key half
    const path = join(dir, 'mismatch.json');
    writeFileSync(path, JSON.stringify(bytes));
    expectConfig(() => loadSigner({ file: path }), { neverContains: [JSON.stringify(bytes).slice(0, 40)] });
  });
});

describe('loadSigner from text (what an env var such as TREASURY_KEYPAIR_JSON carries)', () => {
  const text = () => JSON.stringify(Array.from(keypair.secretKey));

  it('parses the JSON text, labels the kind, exposes nothing else, and signs', async () => {
    const fromText = loadSigner({ text: text(), env: 'TREASURY_KEYPAIR_JSON', kind: 'treasury' });
    assert.equal(fromText.wallet, keypair.publicKey.toBase58());
    assert.equal(fromText.kind, 'treasury');
    assert.deepEqual(Object.keys(fromText).sort(), ['kind', 'sign', 'wallet']);
    assert.ok(Object.isFrozen(fromText));
    assert.ok(!JSON.stringify(fromText).includes(text().slice(1, 20)));
    assert.ok(!inspect(fromText, { depth: 5, showHidden: true }).includes(text().slice(1, 20)));
    const [signed] = await fromText.sign([legacyTransfer()]);
    assert.ok(Transaction.from(Buffer.from(signed, 'base64')).verifySignatures());
    assert.equal(loadSigner({ text: text() }).kind, 'curator', 'kind defaults to curator');
  });

  it('whitespace-only text is no text: the file is read instead, and nothing at all is CONFIG', () => {
    assert.equal(loadSigner({ text: '   ', file }).wallet, keypair.publicKey.toBase58());
    assert.throws(() => loadSigner({ text: '' }), (error) => error instanceof Refusal && error.code === 'CONFIG' && error.message.includes(KEYPAIR_ENV));
  });

  it('text and a file together are refused CONFIG: the key is given once, and neither is echoed', () => {
    assert.throws(() => loadSigner({ text: text(), file, env: 'TREASURY_KEYPAIR_JSON' }), (error) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, 'CONFIG');
      assert.match(error.message, /TREASURY_KEYPAIR_JSON/);
      assert.match(error.message, /once/);
      assert.ok(!error.message.includes(file));
      assert.ok(!error.message.includes(text().slice(1, 20)));
      assert.equal(error.detail, undefined);
      return true;
    });
  });

  it('malformed text refuses CONFIG naming the env var and never echoing the text', () => {
    const bytes = Array.from(keypair.secretKey);
    for (const content of [
      `${SECRET_MARKER} {not json`,
      JSON.stringify(bytes.slice(0, 63)),
      JSON.stringify([...bytes, 1]),
      JSON.stringify({ secretKey: bytes }),
      JSON.stringify(SECRET_MARKER),
      JSON.stringify(bytes.map((b, i) => (i === 63 ? b ^ 0xff : b))),
    ]) {
      assert.throws(() => loadSigner({ text: content, env: 'TREASURY_KEYPAIR_JSON' }), (error) => {
        assert.ok(error instanceof Refusal, 'is a Refusal');
        assert.equal(error.code, 'CONFIG');
        assert.ok(error.message.includes('TREASURY_KEYPAIR_JSON'), error.message);
        assert.ok(!error.message.includes(SECRET_MARKER));
        assert.ok(!error.message.includes(content.slice(0, 40)));
        assert.equal(error.detail, undefined, 'no detail that could carry the text');
        return true;
      });
    }
  });
});
