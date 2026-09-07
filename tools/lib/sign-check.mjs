/**
 * A signing check that costs nothing: one memo transaction with the wallet as
 * fee payer, signed and thrown away. It proves the signer's key, grant and
 * client are all in order before a demo, so an expired login or a revoked
 * signer (both seen on 6 Sep 2026) surfaces here and not in the middle of a
 * create. Nothing is ever sent: the default hash is valid in shape only, so
 * the signed bytes cannot land even if they leaked.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from './tx-checks.mjs';

const require = createRequire(import.meta.url);
const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const MEMO_TEXT = 'weavr sign check, never sent';
/** Valid in shape only; a transaction carrying it can never be included. */
export const UNSENDABLE_HASH = '11111111111111111111111111111111';

/** One legacy memo transaction paid and signed by `wallet`, as the encoded string PayBox takes. */
export function memoTransaction(wallet, recentBlockhash = UNSENDABLE_HASH, text = MEMO_TEXT) {
  const payer = new PublicKey(wallet);
  const tx = new Transaction({ feePayer: payer, recentBlockhash });
  tx.add(new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM),
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    data: Buffer.from(text, 'utf8'),
  }));
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** True when `signed` decodes to a transaction that carries a valid signature from `wallet`. */
export function carriesSignatureOf(signed, wallet) {
  let tx;
  try { tx = Transaction.from(Buffer.from(signed, 'base64')); } catch { return false; }
  const mine = tx.signatures.find((s) => s.publicKey.toBase58() === wallet);
  if (!mine?.signature) return false;
  try { return tx.verifySignatures(true); } catch { return false; }
}

/** Sign one memo with `signer` and verify the signature; the result is discarded. */
export async function signCheck(signer, { recentBlockhash = UNSENDABLE_HASH } = {}) {
  const [signed] = await signer.sign([memoTransaction(signer.wallet, recentBlockhash)]);
  const ok = typeof signed === 'string' && carriesSignatureOf(signed, signer.wallet);
  return { status: ok ? 'ok' : 'bad_signature', address: signer.wallet, sent: false };
}

/**
 * The PayBox client the CLI's login token was issued to: the `cid` claim of
 * the stored access token, read without verification. An identifier, not a
 * secret; it is the id a signing key is minted for. Null when unknown.
 */
export function payboxClientId(configDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    const payload = String(cfg.oauth?.accessToken ?? '').split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).cid ?? null;
  } catch {
    return null;
  }
}

/** The command line: one JSON line, exit 0 only when the wallet signed and the signature verified. */
export async function runSignCheck(argv, makeSigner, env = process.env, { fetchRecentHash } = {}) {
  const out = (obj, code) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code); };
  const clientId = env.PAYBOX_CONFIG_DIR ? payboxClientId(env.PAYBOX_CONFIG_DIR) : null;
  try {
    const signer = makeSigner();
    let recentBlockhash = UNSENDABLE_HASH;
    if (argv.includes('--recent') && fetchRecentHash) recentBlockhash = await fetchRecentHash();
    const r = await signCheck(signer, { recentBlockhash });
    return out({ ...r, signer: signer.kind, clientId }, r.status === 'ok' ? 0 : EXIT.WALLET_DECLINED);
  } catch (e) {
    const known = e.code && EXIT[e.code] !== undefined;
    return out({ status: 'failed', error: known ? e.code : 'FAILED', detail: String(e.message).slice(0, 200), clientId }, known ? EXIT[e.code] : EXIT.FAILED);
  }
}
