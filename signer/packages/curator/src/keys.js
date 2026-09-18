/**
 * The curator key: one 64-byte JSON array file, written by
 * `deploy/hydrate.mjs` at 0600 from CURATOR_KEYPAIR_JSON, read once at boot.
 * It never leaves this module as bytes — the signer object exposes the
 * public key and a `sign` function, nothing else, so no other module can
 * log it by accident. Same contract as the ops local signer
 * (`integrations/claw-agent/tools/lib/local-signer.mjs`): legacy via
 * partialSign, v0 via sign([keypair]).
 *
 * Why the refusal names the env var and never the path's contents: a boot
 * failure is printed to stderr and ends up in Loki. "CURATOR_KEYPAIR: keypair
 * file must be a 64-byte JSON array" tells the operator which variable to
 * fix; echoing what was in the file would put a half-pasted secret in the
 * logs, which is exactly the class of leak this process exists to prevent.
 */
import { readFileSync } from 'node:fs';
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Refusal } from './errors.js';

/** The env var the keypair path comes from; the refusal names it, not the path. */
export const KEYPAIR_ENV = 'CURATOR_KEYPAIR';

/**
 * A serialised transaction is v0 when the first byte after the signature
 * block has its high bit set (the version prefix); a legacy message starts
 * with a header byte whose value is a small signer count. Same test as
 * `tx-checks.mjs` in the ops wallet tool.
 * @param {Uint8Array} raw
 * @returns {boolean}
 */
export function isVersioned(raw) {
  if (!raw.length) return false;
  const count = raw[0];
  const first = raw[1 + 64 * count];
  return first !== undefined && (first & 0x80) !== 0;
}

/**
 * @param {{ file?: string, text?: string, env?: string, kind?: string }} opts the keypair as a path to its file (`file`) or as the JSON
 *   text itself (`text`: what an env var such as TREASURY_KEYPAIR_JSON carries — never argv); `env` is the variable name quoted in
 *   refusals (default CURATOR_KEYPAIR); `kind` labels the signer (default `curator`)
 * @returns {{ wallet: string, kind: string, sign: (encodedList: string[]) => Promise<string[]> }}
 * @throws {Refusal} code CONFIG when neither source is set, both are set (the key is given once), the file is unreadable, the source is not JSON, not a 64-byte array or not a valid ed25519 secret; the message never includes the source's contents
 */
export function loadSigner(opts = {}) {
  const { file, env = KEYPAIR_ENV, kind = 'curator' } = opts;
  const inline = typeof opts.text === 'string' && opts.text.trim() !== '';
  const hasFile = typeof file === 'string' && file.trim() !== '';
  if (inline && hasFile) {
    throw new Refusal('CONFIG', `${env}: the key is given once — the JSON text or a file path, not both`);
  }
  if (!inline && !hasFile) {
    throw new Refusal('CONFIG', `${env} is not set (path to the 64-byte JSON keypair file)`);
  }
  const source = inline ? 'keypair text' : 'keypair file';

  let text;
  if (inline) {
    text = opts.text;
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      // error.message would carry the path; error.code (ENOENT, EACCES) is enough.
      throw new Refusal('CONFIG', `${env}: keypair file is unreadable (${error?.code ?? 'error'})`);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal('CONFIG', `${env}: ${source} is not JSON`);
  } finally {
    text = null;
  }

  const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every(isByte)) {
    throw new Refusal('CONFIG', `${env}: ${source} must be a 64-byte JSON array`);
  }

  let keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    throw new Refusal('CONFIG', `${env}: keypair bytes are not a valid ed25519 secret key`);
  } finally {
    // The array came from JSON.parse; zero it so a heap dump has one copy fewer.
    if (Array.isArray(parsed)) parsed.fill(0);
    parsed = null;
  }

  const wallet = keypair.publicKey.toBase58();

  /**
   * Sign every transaction in the list and return them re-serialised, in
   * order. Legacy: `partialSign` so a second signer (the api's nonce
   * authority, a co-signer) can still be added; v0: `sign([keypair])`.
   * Anything that is not a transaction refuses with NOT_A_TRANSACTION —
   * the decoder runs before the signer, so reaching this is a bug upstream,
   * and a bug should not be signed.
   * @param {string[]} encodedList base64
   * @returns {Promise<string[]>} base64
   */
  async function sign(encodedList) {
    if (!Array.isArray(encodedList)) throw new Refusal('NOT_A_TRANSACTION', 'sign expects a list of base64 transactions');
    return encodedList.map((encoded, index) => {
      if (typeof encoded !== 'string' || encoded.trim() === '') {
        throw new Refusal('NOT_A_TRANSACTION', `transaction[${index}] is not a base64 string`);
      }
      const raw = Buffer.from(encoded, 'base64');
      try {
        if (isVersioned(raw)) {
          const tx = VersionedTransaction.deserialize(raw);
          tx.sign([keypair]);
          return Buffer.from(tx.serialize()).toString('base64');
        }
        const tx = Transaction.from(raw);
        tx.partialSign(keypair);
        return tx.serialize({ requireAllSignatures: false }).toString('base64');
      } catch (error) {
        if (error instanceof Refusal) throw error;
        throw new Refusal('NOT_A_TRANSACTION', `transaction[${index}] could not be decoded or signed`);
      }
    });
  }

  // Frozen and closed over: no property ever holds the secret, so
  // JSON.stringify(signer) or util.inspect(signer) show wallet and kind only.
  return Object.freeze({ wallet, kind, sign });
}
