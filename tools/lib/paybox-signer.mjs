/**
 * The PayBox signer: signs through the PayBox CLI (@paybox-sh/sdk) with a
 * signing key read from a file. Intents are written as 0600 files under
 * $PAYBOX_CONFIG_DIR/work and a lock serialises runs (the SDK's token refresh
 * is not safe to run concurrently). The key is never in argv or in the chat.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function payboxSigner({ env = process.env, configDir, credentialId, keyFile, cli, nodeBin = process.execPath } = {}) {
  const CONFIG_DIR = configDir ?? env.PAYBOX_CONFIG_DIR;
  const CRED = credentialId ?? env.PAYBOX_CREDENTIAL_ID;
  const KEY_FILE = keyFile ?? env.PAYBOX_SIGNING_KEY_FILE ?? (CONFIG_DIR ? join(CONFIG_DIR, 'signing-key.txt') : undefined);
  const CLI = cli ?? env.PAYBOX_CLI;
  const missing = [['PAYBOX_CONFIG_DIR', CONFIG_DIR], ['PAYBOX_CREDENTIAL_ID', CRED], ['PAYBOX_CLI', CLI]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const err = new Error(`missing ${missing.join(', ')}`);
    err.code = 'CONFIG';
    throw err;
  }

  function run(cliArgs, { withKey = false } = {}) {
    const childEnv = { ...env, PAYBOX_CONFIG_DIR: CONFIG_DIR };
    if (withKey) childEnv.PAYBOX_SIGNING_KEY = readFileSync(KEY_FILE, 'utf8').trim();
    const r = spawnSync(nodeBin, [CLI, '--json', ...cliArgs], { env: childEnv, encoding: 'utf8', timeout: 120_000 });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  }

  function address() {
    const r = run(['credentials']);
    const entry = (r.json?.credentials ?? []).find((c) => c.credential?.id === CRED);
    if (!entry) {
      const err = new Error(`credential ${CRED} is not granted to this client`);
      err.code = 'CONFIG';
      throw err;
    }
    return entry.credential.metadata?.address;
  }

  function withLock(fn) {
    const work = join(CONFIG_DIR, 'work');
    const lock = join(work, '.lock');
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { mkdirSync(lock); break; } catch {
        if (Date.now() > deadline) { const err = new Error('another signing run is in progress'); err.code = 'BUSY'; throw err; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    const release = () => rmSync(lock, { recursive: true, force: true });
    process.on('exit', release);
    try { return fn(work); } finally { release(); }
  }

  const wallet = address();
  return {
    wallet,
    kind: 'paybox',
    async sign(encodedList) {
      return withLock((work) => encodedList.map((encoded, i) => {
        const intentPath = join(work, `intent-${process.pid}-${i}.json`);
        writeFileSync(intentPath, JSON.stringify({ op: 'solanaTransaction', address: wallet, transactionBase64: encoded }), { mode: 0o600 });
        try {
          const r = run(['sign', '--credential', CRED, '--intent', `@${intentPath}`], { withKey: true });
          const signed = r.json?.output?.value?.signedTransactionBase64;
          if (!signed) {
            const err = new Error(`PayBox status ${r.json?.status ?? 'unknown'}${r.json?.error ? ': ' + String(r.json.error).slice(0, 200) : ''}`);
            err.code = 'WALLET_DECLINED';
            throw err;
          }
          return signed;
        } finally { rmSync(intentPath, { force: true }); }
      }));
    },
  };
}
