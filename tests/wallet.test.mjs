// The wallet's lifecycle and what it holds, for a user who chooses a wallet
// in chat: status before any key exists, create once and never overwrite,
// import a Solana CLI keypair, and balances with the minimums the skill
// relays. No network: the RPC is a stub. No real key: throwaway keypairs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { localWalletOps, loadKeypair } from '../tools/lib/local-wallet.mjs';
import { MIN_SOL, USDC_MINT, readBalances } from '../tools/lib/balance.mjs';
import { EXIT } from '../tools/lib/tx-checks.mjs';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_TOOL = join(ROOT, 'tools/sign-local.mjs');
const PAYBOX_TOOL = join(ROOT, 'tools/sign-solana.mjs');

const tmp = () => mkdtempSync(join(tmpdir(), 'weavr-wallet-'));
const mode = (f) => statSync(f).mode & 0o777;

test('status says there is no wallet, create makes one (0600), status then names it, a second create is refused', () => {
  const dir = tmp();
  const file = join(dir, 'keys', 'agent.json');
  const ops = localWalletOps({ env: { SIGN_LOCAL_KEYPAIR_FILE: file } });
  const before = ops.status();
  assert.equal(before.configured, false);
  assert.match(before.detail, /--wallet create/);
  const created = ops.create();
  assert.equal(created.created, true);
  assert.equal(mode(file), 0o600);
  assert.equal(mode(join(dir, 'keys')), 0o700);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 64);
  const after = ops.status();
  assert.equal(after.configured, true);
  assert.equal(after.address, created.address);
  assert.equal(loadKeypair(file).publicKey.toBase58(), created.address);
  assert.throws(() => ops.create(), (e) => e.code === 'CONFIG' && /refusing to overwrite/.test(e.message));
  rmSync(dir, { recursive: true, force: true });
});

test('import copies a 64-byte keypair file into place and refuses anything else', () => {
  const dir = tmp();
  const target = join(dir, 'agent.json');
  const source = join(dir, 'phantom-export.json');
  const kp = Keypair.generate();
  writeFileSync(source, JSON.stringify(Array.from(kp.secretKey)));
  const ops = localWalletOps({ env: { SIGN_LOCAL_KEYPAIR_FILE: target } });
  assert.throws(() => ops.importFrom(undefined), /needs the path/);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify([1, 2, 3]));
  // the fixed sentence names the source path, never what the parser saw in it
  assert.throws(() => ops.importFrom(bad), (e) => e.code === 'CONFIG' && e.message === `${bad} is not a 64-byte JSON array`);
  const r = ops.importFrom(source);
  assert.equal(r.imported, true);
  assert.equal(r.address, kp.publicKey.toBase58());
  assert.equal(mode(target), 0o600);
  assert.throws(() => ops.importFrom(source), /refusing to overwrite/);
  rmSync(dir, { recursive: true, force: true });
});

test('readBalances sums USDC accounts, reports SOL, and flags the minimums the skill relays', async () => {
  const address = Keypair.generate().publicKey.toBase58();
  const seen = [];
  const conn = {
    getBalance: async (owner) => { seen.push(['balance', owner.toBase58()]); return 0.05 * 1e9; },
    getParsedTokenAccountsByOwner: async (owner, filter) => {
      seen.push(['tokens', owner.toBase58(), filter.mint.toBase58()]);
      return { value: [
        { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 1.5 } } } } } },
        { account: { data: { parsed: { info: { tokenAmount: { uiAmount: 2.25 } } } } } },
      ] };
    },
  };
  const b = await readBalances(address, conn);
  assert.equal(b.address, address);
  assert.equal(b.sol, 0.05);
  assert.equal(b.usdc, 3.75);
  assert.deepEqual(b.minSol, MIN_SOL);
  assert.deepEqual(b.ok, { create: false, action: true });
  assert.match(b.note, /USDC/);
  assert.deepEqual(seen[1], ['tokens', address, USDC_MINT]);
  const empty = await readBalances(address, { getBalance: async () => 0, getParsedTokenAccountsByOwner: async () => ({ value: [] }) });
  assert.deepEqual([empty.sol, empty.usdc, empty.ok], [0, 0, { create: false, action: false }]);
});

test('MIN_SOL covers a create (~0.08 SOL of rent and fees) with margin, and is small for other actions', () => {
  assert.ok(MIN_SOL.create >= 0.1 && MIN_SOL.create <= 0.3, String(MIN_SOL.create));
  assert.ok(MIN_SOL.action >= 0.005 && MIN_SOL.action < MIN_SOL.create, String(MIN_SOL.action));
});

function run(tool, args, env) {
  const r = spawnSync(process.execPath, [tool, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* raw */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('sign-local.mjs: --wallet status/create through the CLI, one JSON line each; signing commands name the missing wallet as CONFIG', () => {
  const dir = tmp();
  const env = { SIGN_LOCAL_KEYPAIR_FILE: join(dir, 'agent.json'), WEAVR_MANIFEST: join(ROOT, 'manifest.json') };
  const s0 = run(LOCAL_TOOL, ['--wallet', 'status'], env);
  assert.equal(s0.code, 0, s0.stderr);
  assert.equal(s0.json.configured, false);
  const a0 = run(LOCAL_TOOL, ['--address'], env);
  assert.equal(a0.code, EXIT.CONFIG);
  assert.match(a0.json.detail, /--wallet create/);
  const c = run(LOCAL_TOOL, ['--wallet', 'create'], env);
  assert.equal(c.code, 0, c.stderr);
  assert.equal(c.json.created, true);
  const s1 = run(LOCAL_TOOL, ['--wallet', 'status'], env);
  assert.equal(s1.json.configured, true);
  assert.equal(s1.json.address, c.json.address);
  const a1 = run(LOCAL_TOOL, ['--address'], env);
  assert.deepEqual(a1.json, { address: c.json.address, wallet: 'local' });
  // neither a mode nor a verb: the same CONFIG refusal as an unknown WEAVR_WALLET, naming both lists
  const bogus = run(LOCAL_TOOL, ['--wallet', 'bogus'], env);
  assert.equal(bogus.code, EXIT.CONFIG);
  assert.match(bogus.json.detail, /paybox, local, link.*status, create, import/);
  const again = run(LOCAL_TOOL, ['--wallet', 'create'], env);
  assert.equal(again.code, EXIT.CONFIG);
  assert.match(again.json.detail, /refusing to overwrite/);
  const bal = run(LOCAL_TOOL, ['--balance'], { ...env, SOLANA_RPC_URL: 'http://127.0.0.1:9/' });
  assert.equal(bal.code, EXIT.FAILED);
  assert.equal(bal.json.error, 'RPC_UNAVAILABLE');
  rmSync(dir, { recursive: true, force: true });
});

test('sign-solana.mjs: --wallet create is UNSUPPORTED (PayBox wallets live in the app); status without config says so', () => {
  const env = { PAYBOX_CONFIG_DIR: '', PAYBOX_CREDENTIAL_ID: '', PAYBOX_CLI: '' };
  const c = run(PAYBOX_TOOL, ['--wallet', 'create'], env);
  assert.equal(c.code, EXIT.USAGE);
  assert.equal(c.json.error, 'UNSUPPORTED');
  const s = run(PAYBOX_TOOL, ['--wallet', 'status'], env);
  assert.equal(s.code, 0);
  assert.equal(s.json.configured, false);
  assert.match(s.json.detail, /PAYBOX_CONFIG_DIR/);
});
