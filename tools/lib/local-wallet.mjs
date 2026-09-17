/**
 * The local wallet's lifecycle for a text-only agent: does a keypair exist,
 * make a new one, or bring one in from a Solana CLI keypair file. The key is
 * a 64-byte JSON array at SIGN_LOCAL_KEYPAIR_FILE (0600, directory 0700); the
 * path is the only thing in the environment, and nothing here ever prints
 * the key. An existing wallet is never overwritten.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');

function configError(message) {
  const err = new Error(message);
  err.code = 'CONFIG';
  return err;
}

/** Load a 64-byte JSON keypair file; a CONFIG error names anything else. */
export function loadKeypair(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw configError(`${file}: cannot read a keypair there (${String(e.message).slice(0, 80)})`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || raw.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw configError(`${file}: not a 64-byte JSON keypair`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function localWalletOps({ env = process.env } = {}) {
  const file = env.SIGN_LOCAL_KEYPAIR_FILE;
  const need = () => {
    if (!file) throw configError('missing SIGN_LOCAL_KEYPAIR_FILE');
    return file;
  };
  const refuseOverwrite = (f) => {
    if (existsSync(f)) throw configError(`a wallet already exists at ${f}; refusing to overwrite it`);
  };
  const place = (f) => {
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  };

  return {
    kind: 'local',
    /** Is there a wallet, and which address. Informational, never throws on a missing file. */
    status() {
      if (!file) return { configured: false, signer: 'local', detail: 'SIGN_LOCAL_KEYPAIR_FILE is not set' };
      if (!existsSync(file)) {
        return { configured: false, signer: 'local', keyFile: file, detail: 'no wallet yet: --wallet create makes a new one, --wallet import <keypair.json> brings an existing one' };
      }
      return { configured: true, signer: 'local', address: loadKeypair(file).publicKey.toBase58(), keyFile: file };
    },
    /** Generate a new keypair at the configured path. */
    create() {
      const f = need();
      refuseOverwrite(f);
      place(f);
      const kp = Keypair.generate();
      writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      chmodSync(f, 0o600);
      return { created: true, signer: 'local', address: kp.publicKey.toBase58(), keyFile: f };
    },
    /** Copy an existing Solana CLI keypair file into place. */
    importFrom(source) {
      const f = need();
      if (!source) throw configError('--wallet import needs the path of a 64-byte JSON keypair file');
      refuseOverwrite(f);
      const kp = loadKeypair(source);
      place(f);
      copyFileSync(source, f);
      chmodSync(f, 0o600);
      return { imported: true, signer: 'local', address: kp.publicKey.toBase58(), keyFile: f };
    },
  };
}
