/**
 * The local signer: a keypair file (a 64-byte JSON array under the key dir,
 * path from SIGN_LOCAL_KEYPAIR_FILE) signs legacy and v0 transactions. It is
 * the bisecting control for the PayBox signer — same checks, same flows, no
 * PayBox — and the dust-only fallback when PayBox is out of the picture.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isVersioned } from './tx-checks.mjs';

const require = createRequire(import.meta.url);
const { Keypair, Transaction, VersionedTransaction } = require('@solana/web3.js');

export function localSigner({ env = process.env, keypairFile } = {}) {
  const file = keypairFile ?? env.SIGN_LOCAL_KEYPAIR_FILE;
  if (!file) { const err = new Error('missing SIGN_LOCAL_KEYPAIR_FILE'); err.code = 'CONFIG'; throw err; }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
  return {
    wallet: keypair.publicKey.toBase58(),
    kind: 'local',
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
