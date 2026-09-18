/**
 * The mirrored subset in the public layout: every name the signer imports
 * resolves, the manifest and the five IDLs are read from `signer/deploy/`,
 * and the three hand-carried definitions give the values the backend's own
 * package gave when they were carried over (recorded 18 Sep 2026; the ops
 * gate re-checks them against the backend on every run).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import * as chain from '../src/index.js';

const PROGRAMS = ['portfolio_factory', 'portfolio_allocator', 'stoken', 'accountant', 'asset_manager_escrow'];
/** The names packages/curator imports: index.js, decode.js, errors.js and preflight.js. */
const SIGNER_NAMES = [
  'connect', 'idlFor', 'programId', 'fetchDecoded', 'factoryConfigKey', 'tokenBalanceMany',
  'associatedTokenAddress', 'PAGE_LEGS', 'applyScratchPda', 'readNavLookupTableAddress',
];
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const SCRATCH_OF_SYSTEM_PROGRAM = '89Mw9ebTAje1zbdxh3Reg8UR1kJmMJT6CRzxZj3vZGXZ';

describe('the chain subset', () => {
  it('exports every name the signer imports', () => {
    for (const name of SIGNER_NAMES) assert.ok(name in chain, `${name} is not exported`);
  });

  it('reads the manifest and the five IDLs from signer/deploy', () => {
    for (const program of PROGRAMS) {
      const idl = chain.idlFor(program);
      assert.ok(Array.isArray(idl.instructions) && idl.instructions.length > 0, `${program}: no instructions`);
      const id = chain.programId(program).toBase58();
      assert.match(id, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      if (idl.address) assert.equal(idl.address, id, `${program}: the IDL names a different program than the manifest`);
    }
    assert.throws(() => chain.idlFor('portfolio_nav'), /no IDL registered/);
    assert.throws(() => chain.programId('not_a_program'), /pins no program ID/);
  });

  it('synthesises the factory event table the IDL omits', () => {
    const { events } = chain.idlFor('portfolio_factory');
    assert.ok(events.some((event) => event.name === 'TargetsProposed'));
  });

  it('PAGE_LEGS and applyScratchPda give the backend\'s values', () => {
    assert.equal(chain.PAGE_LEGS, 8);
    assert.equal(chain.applyScratchPda(SYSTEM_PROGRAM).toBase58(), SCRATCH_OF_SYSTEM_PROGRAM);
    assert.equal(chain.applyScratchPda(new PublicKey(SYSTEM_PROGRAM)).toBase58(), SCRATCH_OF_SYSTEM_PROGRAM);
  });

  it('readNavLookupTableAddress: the variable first, then the cache file, else null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nav-lut-'));
    const saved = { table: process.env.NAV_LOOKUP_TABLE, cache: process.env.NAV_LOOKUP_TABLE_CACHE };
    try {
      delete process.env.NAV_LOOKUP_TABLE;
      process.env.NAV_LOOKUP_TABLE_CACHE = join(dir, 'missing.json');
      assert.equal(chain.navLookupTableCachePath(), join(dir, 'missing.json'));
      assert.equal(chain.readNavLookupTableAddress(), null);
      const cache = join(dir, 'cache.json');
      writeFileSync(cache, JSON.stringify({ address: 'GR1LTP93eQ11111111111111111111111111111111' }));
      process.env.NAV_LOOKUP_TABLE_CACHE = cache;
      assert.equal(chain.readNavLookupTableAddress(), 'GR1LTP93eQ11111111111111111111111111111111');
      writeFileSync(cache, '{not json');
      assert.equal(chain.readNavLookupTableAddress(), null, 'an unreadable cache is null, never a throw at boot');
      process.env.NAV_LOOKUP_TABLE = 'Tab1e11111111111111111111111111111111111111';
      assert.equal(chain.readNavLookupTableAddress(), 'Tab1e11111111111111111111111111111111111111');
    } finally {
      if (saved.table === undefined) delete process.env.NAV_LOOKUP_TABLE; else process.env.NAV_LOOKUP_TABLE = saved.table;
      if (saved.cache === undefined) delete process.env.NAV_LOOKUP_TABLE_CACHE; else process.env.NAV_LOOKUP_TABLE_CACHE = saved.cache;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('connect binds the endpoint without touching the network', () => {
    const connection = chain.connect('http://127.0.0.1:9');
    assert.equal(connection.rpcEndpoint, 'http://127.0.0.1:9');
  });
});
