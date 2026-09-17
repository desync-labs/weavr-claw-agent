/**
 * The local signer: a dedicated keypair file that lives on this box (a 64-byte
 * JSON array, 0600, path from SIGN_LOCAL_KEYPAIR_FILE) signs legacy and v0
 * transactions. The supported path for a key that stays on the box: the
 * autonomous curator, or a small creator wallet. Same checks, same flows and
 * same output as the PayBox signer, no human in the loop.
 *
 * The file is read behind fixed sentences: a file that cannot be read, that
 * is readable by group or others, or that is not a 64-byte JSON array (a
 * base58 export, a truncated array) is a CONFIG refusal naming the variable
 * and never the parser's message, because that message quotes the file and
 * the tool's stdout is the agent transcript.
 */
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isVersioned } from './tx-checks.mjs';

const require = createRequire(import.meta.url);
const { Keypair, Transaction, VersionedTransaction } = require('@solana/web3.js');

export const KEYPAIR_UNREADABLE = 'SIGN_LOCAL_KEYPAIR_FILE cannot be read';
export const KEYPAIR_TOO_OPEN = 'SIGN_LOCAL_KEYPAIR_FILE is readable by group or others: chmod 600 it';
export const KEYPAIR_NOT_ARRAY = 'SIGN_LOCAL_KEYPAIR_FILE is not a 64-byte JSON array';

function config(message) {
  const err = new Error(message);
  err.code = 'CONFIG';
  return err;
}

/**
 * The keypair in `file`, or a CONFIG error whose message is one of the fixed
 * sentences above (the unreadable one carries the errno code, ENOENT or
 * EACCES, which names no content). Nothing read from the file, and nothing a
 * parser says about it, reaches the error.
 */
export function readKeypairFile(file) {
  let mode;
  let text;
  try {
    mode = statSync(file).mode;
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw config(e?.code ? `${KEYPAIR_UNREADABLE} (${e.code})` : KEYPAIR_UNREADABLE);
  }
  if ((mode & 0o077) !== 0) throw config(KEYPAIR_TOO_OPEN);
  let bytes;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw config(KEYPAIR_NOT_ARRAY);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw config(KEYPAIR_NOT_ARRAY);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    throw config(KEYPAIR_NOT_ARRAY);
  }
}

export function localSigner({ env = process.env, keypairFile } = {}) {
  const file = keypairFile ?? env.SIGN_LOCAL_KEYPAIR_FILE;
  if (!file) throw config('missing SIGN_LOCAL_KEYPAIR_FILE');
  const keypair = readKeypairFile(file);
  return {
    wallet: keypair.publicKey.toBase58(),
    kind: 'local',
    // the checks take v0 on this word (tx-checks.mjs); a create of five or
    // more assets is a v0 message against weavr's NAV lookup table
    allowVersioned: true,
    async sign(encodedList) {
      return encodedList.map((encoded) => {
        const raw = Buffer.from(encoded, 'base64');
        if (isVersioned(raw)) {
          const tx = VersionedTransaction.deserialize(raw);
          tx.sign([keypair]);
          return Buffer.from(tx.serialize()).toString('base64');
        }
        const tx = Transaction.from(raw);
        tx.partialSign(keypair);
        return tx.serialize({ requireAllSignatures: false }).toString('base64');
      });
    },
  };
}
