#!/usr/bin/env node
/**
 * The image entrypoint: `node packages/curator/bin/start.mjs`.
 *
 * One thing happens before `boot()`. A deployment that hands the key over
 * as `CURATOR_KEYPAIR_JSON` (a Kubernetes secret in the environment, never
 * a file mount) gets it written to `$COMPOSABLE_PORTFOLIOS_KEY_DIR/solana/curator.json`
 * at 0600, `CURATOR_KEYPAIR` set to that path when nothing set it, and the
 * variable removed from Node's environment so that no child process
 * inherits it. (The kernel's record of the environment this process was
 * started with, /proc/<pid>/environ, keeps it, as it did in the backend
 * image: a secret delivered through the environment is visible to whoever
 * can read that file, which is root in the container.) A deployment that
 * mounts the file (the compose stack: `CURATOR_KEYPAIR=/keys/curator.json`)
 * sets nothing here and nothing here runs. The value is written verbatim
 * and never parsed or printed; `keys.js` is what judges it, once, at boot.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boot } from '../src/index.js';
import { scrubText } from '../src/verbs.js';

export const KEY_JSON_ENV = 'CURATOR_KEYPAIR_JSON';

/** The directory the key is written under; the backend's default, kept. */
export function keyDir(env = process.env) {
  return env.COMPOSABLE_PORTFOLIOS_KEY_DIR || '/app/.keydir';
}

/**
 * Write `CURATOR_KEYPAIR_JSON` to a 0600 file and point `CURATOR_KEYPAIR` at
 * it; a no-op without the variable. Returns the path written, or null.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fs?: { mkdirSync: Function, writeFileSync: Function, chmodSync: Function } }} [deps]
 */
export function materialiseKey(env = process.env, { fs = { mkdirSync, writeFileSync, chmodSync } } = {}) {
  const json = env[KEY_JSON_ENV];
  if (!json) return null;
  const path = join(keyDir(env), 'solana', 'curator.json');
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, json, { mode: 0o600 });
  // `mode` applies only when the file is created; an existing file keeps its
  // bits, so a rewrite over a looser file must tighten it explicitly.
  fs.chmodSync(path, 0o600);
  if (!env.CURATOR_KEYPAIR) env.CURATOR_KEYPAIR = path;
  // Node's copy only: children spawned from here no longer inherit it.
  delete env[KEY_JSON_ENV];
  return path;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  materialiseKey();
  boot().catch((error) => {
    console.error(`curator: ${scrubText(error?.message ?? String(error))}`);
    process.exit(1);
  });
}
