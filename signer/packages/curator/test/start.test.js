/**
 * bin/start.mjs: the key handed over as CURATOR_KEYPAIR_JSON lands at
 * $KEY_DIR/solana/curator.json at 0600, CURATOR_KEYPAIR points at it unless
 * the deployment set it, the variable is gone afterwards, and a mounted key
 * (no variable) leaves everything alone. The value is never a real key.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_JSON_ENV, keyDir, materialiseKey } from '../bin/start.mjs';

const FAKE = JSON.stringify(Array.from({ length: 64 }, (_, i) => i));
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'curator-start-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

describe('materialiseKey', () => {
  it('writes the key at 0600 under KEY_DIR, points CURATOR_KEYPAIR at it and drops the variable', () => {
    const env = { COMPOSABLE_PORTFOLIOS_KEY_DIR: join(dir, 'a'), [KEY_JSON_ENV]: FAKE };
    const path = materialiseKey(env);
    assert.equal(path, join(dir, 'a', 'solana', 'curator.json'));
    assert.equal(readFileSync(path, 'utf8'), FAKE);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'a', 'solana')).mode & 0o777, 0o700);
    assert.equal(env.CURATOR_KEYPAIR, path);
    assert.equal(KEY_JSON_ENV in env, false, 'the JSON variable is removed from the environment object children inherit');
  });

  it('keeps an explicit CURATOR_KEYPAIR', () => {
    const env = { COMPOSABLE_PORTFOLIOS_KEY_DIR: join(dir, 'b'), [KEY_JSON_ENV]: FAKE, CURATOR_KEYPAIR: '/custom/path/curator.json' };
    materialiseKey(env);
    assert.equal(env.CURATOR_KEYPAIR, '/custom/path/curator.json');
    assert.equal(readFileSync(join(dir, 'b', 'solana', 'curator.json'), 'utf8'), FAKE);
  });

  it('tightens a looser existing file instead of keeping its bits', () => {
    const env = { COMPOSABLE_PORTFOLIOS_KEY_DIR: join(dir, 'c'), [KEY_JSON_ENV]: FAKE };
    const path = join(dir, 'c', 'solana', 'curator.json');
    materialiseKey({ ...env });
    chmodSync(path, 0o644);
    writeFileSync(path, 'stale');
    materialiseKey(env);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, 'utf8'), FAKE);
  });

  it('does nothing without the variable: a mounted key is the compose stack\'s case', () => {
    const env = { COMPOSABLE_PORTFOLIOS_KEY_DIR: join(dir, 'd'), CURATOR_KEYPAIR: '/keys/curator.json' };
    assert.equal(materialiseKey(env), null);
    assert.equal(env.CURATOR_KEYPAIR, '/keys/curator.json');
    assert.throws(() => statSync(join(dir, 'd')), /ENOENT/);
  });

  it('defaults KEY_DIR to the image path', () => {
    assert.equal(keyDir({}), '/app/.keydir');
    assert.equal(keyDir({ COMPOSABLE_PORTFOLIOS_KEY_DIR: '/x' }), '/x');
  });
});
