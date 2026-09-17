// weavr-curator init, end to end against fakes: a local server standing in
// for the weavr api and the signer, a JSON-RPC table for the chain, temp
// homes and Keypair.generate() keys. The happy path proves the home tree and
// its modes, the derived chain facts, the rewritten preset notice, the
// rendered profile and plugin, both env files and every compose variable;
// then each planted failure proves the cross it must produce, and a re-run
// proves nothing the owner typed is lost. No network, no real key, no money.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { init, EXIT_INIT, rememberedUrls } from '../lib/curator/init.mjs';
import { homePaths, parseEnv } from '../lib/curator/home.mjs';
import { factoryConfigAddress, decodeFactoryConfig, lamportsToSol } from '../lib/curator/chain.mjs';
import { composeVariables, mergeJobs, readConfigModel } from '../lib/curator/render.mjs';
import { legsOf } from '../lib/curator/weavr-api.mjs';
import { canonicalSha256, policyDigest, stripComments, validatePolicyAgainstBook } from '../lib/curator/policy-check.mjs';
import { parseArgs } from '../lib/curator/args.mjs';
import { catalogue, portfolioRow } from './fixtures/curator/book.mjs';
import { fakeRpc, factoryConfigBytes } from './fixtures/curator/fake-rpc.mjs';
import { startFakeServer } from './fixtures/curator/fake-server.mjs';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/weavr-curator.mjs');
const STANDARD = JSON.parse(readFileSync(join(ROOT, 'curator/policy/standard.json'), 'utf8'));
const REHEARSAL = JSON.parse(readFileSync(join(ROOT, 'curator/policy/rehearsal.json'), 'utf8'));
const FLOOR = Number(STANDARD.rate.minSignerLamports);
const MINT = Keypair.generate().publicKey.toBase58();
const CONFIG_PDA = factoryConfigAddress();

const owner = Keypair.generate();
const guardian = Keypair.generate().publicKey.toBase58();
const treasury = Keypair.generate().publicKey.toBase58();
const mode = (p) => statSync(p).mode & 0o777;
const tmpHome = () => join(mkdtempSync(join(tmpdir(), 'weavr-curator-')), 'CLAWA1');
const writeKey = (file, keypair) => { mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify([...keypair.secretKey]), { mode: 0o600 }); };

/** A world: server, rpc, row. `curatorKey` decides who curates today. */
async function world({ curator = owner.publicKey.toBase58(), pendingCurator = null, legs, rebalanceDelaySecs = 60, balances = {}, accounts, feeRecipient = treasury } = {}) {
  const row = portfolioRow({ mint: MINT, creator: owner.publicKey.toBase58(), curator, pendingCurator, feeRecipient, rebalanceDelaySecs, legs });
  const rpc = fakeRpc({ balances, accounts: accounts ?? { [CONFIG_PDA]: factoryConfigBytes({ guardian, treasury }) } });
  const server = await startFakeServer({ portfolios: [row], pools: catalogue(), rpc, signer: null });
  return { row, rpc, server };
}

function runInit(w, home, extra = {}, deps = {}) {
  const lines = [];
  const sleeps = [];
  const opts = { portfolio: 'CLAWA1', home, api: w.server.url, mcp: `${w.server.url}/mcp`, yes: true, ...extra };
  const result = init(opts, {
    env: {},
    rpc: w.rpc,
    log: (l) => lines.push(l),
    sleep: async (ms) => { sleeps.push(ms); if (deps.onSleep) await deps.onSleep(lines); },
    now: deps.now,
    prompt: deps.prompt,
    interactive: deps.interactive,
    keygen: deps.keygen,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.makeSigner ? { makeSigner: deps.makeSigner } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.root ? { root: deps.root } : {}),
  });
  return result.then((r) => ({ ...r, lines, sleeps, text: lines.join('\n') }));
}

const step = (r, name) => r.steps.find((s) => s.name === name);
const crossStep = (r, name) => r.steps.find((s) => s.name === name && s.kind === 'cross');

/** The bin, asynchronously: spawnSync would block the loop the fake server answers on. */
const runBin = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});

// ---------------------------------------------------------------- happy path

test('init: a funded key that already curates renders the whole home with the right modes', async (t) => {
  const key = Keypair.generate();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: key.publicKey.toBase58(), balances: { [key.publicKey.toBase58()]: FLOOR * 5 } });
  t.after(() => w.server.close());

  const r = await runInit(w, home, { rpc: 'http://127.0.0.1:1/private-rpc-never-printed' });
  assert.equal(r.exit, 0, r.text);
  assert.equal(r.ok, true);

  // The tree and its modes.
  assert.equal(mode(home), 0o700);
  assert.equal(mode(paths.solanaDir), 0o700);
  assert.equal(mode(paths.curatorDir), 0o700);
  for (const f of [paths.keyFile, paths.signerToken, paths.opsToken, paths.signerEnv, paths.agentEnv]) assert.equal(mode(f), 0o600, f);
  assert.ok(existsSync(paths.policyFile));
  assert.ok(existsSync(paths.composeEnv));
  assert.ok(existsSync(join(paths.hermesHome, 'config.yaml')));
  assert.ok(existsSync(join(paths.hermesHome, 'cron/jobs.json')));
  assert.ok(existsSync(join(paths.hermesHome, 'SOUL.md')));
  assert.ok(existsSync(join(paths.hermesHome, 'scripts/curator-health.sh')));
  assert.ok(existsSync(join(paths.hermesHome, 'skills/weavr-curator/references/MANDATE.md')));
  assert.ok(existsSync(join(paths.pluginDir, '__init__.py')));
  assert.ok(existsSync(join(paths.pluginDir, 'plugin.yaml')));
  assert.ok(!existsSync(join(paths.pluginDir, '__pycache__')), 'python caches are not part of the plugin');

  // The derived facts.
  assert.equal(r.guardian, guardian);
  assert.equal(r.treasury, treasury);
  assert.equal(r.notice, 60);
  assert.equal(r.key, key.publicKey.toBase58());
  assert.match(r.text, new RegExp(`chain facts: guardian ${guardian}  treasury ${treasury}  notice 60s`));
  assert.match(r.text, /portfolio: CLAWA1 read from chain/);
  assert.match(r.text, /legs pSOL 40 \/ pCBBTC 40 \/ pUSDS 20/);
  assert.match(r.text, /curation: .* already curates CLAWA1/);

  // The preset notice was rewritten and said so on its own line.
  const policy = JSON.parse(readFileSync(paths.policyFile, 'utf8'));
  assert.equal(policy.invariants.rebalanceDelaySecs, 60);
  assert.equal(STANDARD.invariants.rebalanceDelaySecs, 86400, 'the standard preset ships a day-long notice; this test rewrites it');
  const notice = step(r, 'policy notice');
  assert.ok(notice, 'the rewrite is reported as its own step');
  assert.match(notice.text, /expects a 86400s notice; CLAWA1 announces 60s/);
  assert.ok(r.lines.some((l) => /^  · policy notice: /.test(l)), 'on its own line');
  assert.ok(policy._comment, 'the preset comments are kept for the owner');
  assert.equal(policy.universe._comment, STANDARD.universe._comment);

  // Both env files.
  const signerEnv = parseEnv(readFileSync(paths.signerEnv, 'utf8')).values;
  const signerToken = readFileSync(paths.signerToken, 'utf8');
  const opsToken = readFileSync(paths.opsToken, 'utf8');
  assert.match(signerToken, /^[0-9a-f]{64}$/);
  assert.match(opsToken, /^[0-9a-f]{64}$/);
  assert.notEqual(signerToken, opsToken);
  assert.equal(signerEnv.CURATOR_SIGNER_TOKEN, signerToken);
  assert.equal(signerEnv.CURATOR_OPS_TOKEN, opsToken);
  assert.equal(signerEnv.SOLANA_RPC_URL, 'http://127.0.0.1:1/private-rpc-never-printed');
  const agentEnv = parseEnv(readFileSync(paths.agentEnv, 'utf8'));
  assert.equal(agentEnv.values.CURATOR_SIGNER_URL, 'http://signer:8091');
  assert.equal(agentEnv.values.CURATOR_SIGNER_TOKEN, signerToken);
  assert.equal(agentEnv.values.WEAVR_MCP_URL, `${w.server.url}/mcp`);
  assert.equal(agentEnv.values.CURATOR_PORTFOLIO_SYMBOL, 'CLAWA1');
  assert.equal(agentEnv.values.CURATOR_REBALANCE_DELAY_SECS, '60');
  const providerVar = readConfigModel(readFileSync(paths.configYaml, 'utf8')).provider === 'openai-api' ? 'OPENAI_API_KEY' : null;
  assert.ok(providerVar, 'the shipped profile runs on openai-api');
  for (const k of [providerVar, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL']) {
    assert.ok(agentEnv.order.includes(k), `${k} line present`);
    assert.equal(agentEnv.values[k], '', `${k} left empty for the owner`);
  }
  assert.deepEqual(r.toFill, [providerVar, 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL']);
  assert.match(r.text, /fill OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, TELEGRAM_HOME_CHANNEL/);
  assert.match(r.text, /docker compose --env-file .*compose\.env -f .*curator\/compose\/curator\.yml up -d/);
  assert.match(r.text, /weavr-curator doctor --home/);

  // Every ${VAR} the compose file references is written.
  const yml = readFileSync(join(ROOT, 'curator/compose/curator.yml'), 'utf8');
  const referenced = [...yml.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 10, 'the compose file references its variables');
  const composeEnv = parseEnv(readFileSync(paths.composeEnv, 'utf8'));
  for (const name of new Set(referenced)) assert.ok(composeEnv.order.includes(name), `${name} written to compose.env`);
  assert.deepEqual(composeVariables(yml).map((v) => v.name).sort(), [...new Set(referenced)].sort());
  assert.equal(composeEnv.values.CURATOR_PORTFOLIO_MINT, MINT);
  assert.equal(composeEnv.values.CURATOR_TREASURY, treasury);
  assert.equal(composeEnv.values.CURATOR_EXPECTED_GUARDIAN, guardian);
  assert.equal(composeEnv.values.CURATOR_API_URL, w.server.url);
  assert.equal(composeEnv.values.CURATOR_KEY_FILE, paths.keyFile);
  assert.equal(composeEnv.values.CURATOR_POLICY_FILE, paths.policyFile);
  assert.equal(composeEnv.values.CURATOR_SIGNER_ENV, paths.signerEnv);
  assert.equal(composeEnv.values.HERMES_HOME, paths.hermesHome);
  assert.equal(composeEnv.values.CURATOR_SIGNER_IMAGE, 'weavr-backend:curator-local');
  assert.equal(composeEnv.values.HERMES_IMAGE, 'hermes-agent');
  assert.equal(composeEnv.values.CURATOR_START_PAUSED, '1');
  assert.doesNotMatch(readFileSync(paths.composeEnv, 'utf8'), /[0-9a-f]{64}/, 'compose.env carries no token');

  // Nothing secret reached stdout.
  const secretJson = JSON.stringify([...key.secretKey]);
  const printed = r.text + JSON.stringify(r);
  assert.ok(!printed.includes(secretJson));
  assert.doesNotMatch(printed, /\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]/, 'no 64-byte array anywhere in the output');
  assert.ok(!printed.includes(signerToken), 'the agent token is never printed');
  assert.ok(!printed.includes(opsToken), 'the ops token is never printed');
  assert.ok(!printed.includes('private-rpc-never-printed'), 'the RPC URL is never printed');
  assert.ok(!printed.includes(Buffer.from(key.secretKey).toString('base64')));
});

// ---------------------------------------------------------------- planted failures

test('init: an unfunded key is exit 3 with the fund line', async (t) => {
  const key = Keypair.generate();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: key.publicKey.toBase58(), balances: {} });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.UNFUNDED);
  assert.match(r.text, new RegExp(`✗ signer SOL: .*\\n\\s+fix: fund ${key.publicKey.toBase58()} with at least ${lamportsToSol(FLOOR)} SOL`));
  assert.ok(!existsSync(homePaths(home).policyFile), 'stopped before the policy');
});

test('init: --wait polls the balance every 15 s until the key is funded', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: 0 } });
  t.after(() => w.server.close());
  let polls = 0;
  const r = await runInit(w, home, { wait: true, waitSecs: 600 }, { onSleep: async () => { polls += 1; if (polls === 2) w.rpc.table.balances[pk] = FLOOR; } });
  assert.equal(r.exit, 0, r.text);
  assert.deepEqual(r.sleeps, [15000, 15000]);
  assert.match(r.text, new RegExp(`→ signer SOL: fund ${pk} with at least`));
  assert.match(r.text, /✓ signer SOL: 0\.02 SOL/);
});

test('init: --wait gives up at --wait-secs', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: {} });
  t.after(() => w.server.close());
  let clock = 1_000_000;
  const r = await runInit(w, home, { wait: true, waitSecs: 30 }, { now: () => clock, onSleep: async () => { clock += 15_000; } });
  assert.equal(r.exit, EXIT_INIT.UNFUNDED);
  assert.match(r.text, /✗ signer SOL: still 0 SOL after 30 s/);
});

test('init: a two-leg book is MIN_LEGS under standard, naming rehearsal, and clean under rehearsal', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR }, legs: [['pSOL', 6000], ['pCBBTC', 4000]] });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const policy = step(r, 'policy');
  assert.equal(policy.ok, false);
  const codes = policy.items.map((i) => i.code);
  assert.ok(codes.includes('MIN_LEGS'), codes.join(','));
  const minLegs = policy.items.find((i) => i.code === 'MIN_LEGS');
  assert.match(minLegs.message, /the standard preset needs at least 3 legs; the book holds 2 \(the rehearsal preset admits a 2-leg book\)/);
  assert.match(minLegs.fix, /--policy rehearsal/);
  assert.match(r.text, /✗ policy: the standard preset refuses CLAWA1/);
  assert.match(r.text, /MIN_LEGS: /);
  assert.ok(!existsSync(homePaths(home).policyFile), 'a refused preset is not written');

  const r2 = await runInit(w, home, { policy: 'rehearsal' });
  assert.equal(r2.exit, 0, r2.text);
  assert.equal(JSON.parse(readFileSync(homePaths(home).policyFile, 'utf8')).shape.minLegs, REHEARSAL.shape.minLegs);
  assert.equal(step(r2, 'policy notice'), undefined, 'the rehearsal notice already matches a 60 s book');
});

test('init: a held leg off the allowlist is POOL_DENIED naming the symbol', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR }, legs: [['pSOL', 4000], ['pXAUT', 4000], ['pUSDS', 2000]] });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const denied = step(r, 'policy').items.filter((i) => i.code === 'POOL_DENIED');
  assert.ok(denied.some((i) => /pXAUT is not on universe\.allowlist/.test(i.message)), JSON.stringify(denied));
  assert.ok(denied.some((i) => /add pXAUT to universe\.allowlist and to a category/.test(i.fix)));
  assert.ok(step(r, 'policy').items.some((i) => i.code === 'CHAIN_DENIED' && /pXAUT is on ethereum/.test(i.message)));
  assert.match(r.text, /POOL_DENIED: held leg pXAUT/);
});

test('init: handover (b) signs and sends exactly one accept and prints the signature', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, 0, r.text);
  const sends = w.server.hits.filter((h) => h.path === '/v1/transactions/send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.signed.length, 1);
  assert.deepEqual(w.server.state.sends.map((s) => [s.step, s.payer]), [['accept_curator', pk]]);
  const accepts = w.server.hits.filter((h) => h.path === `/v1/portfolios/${MINT}/curator/accept`);
  assert.equal(accepts.length, 1);
  assert.deepEqual(accepts[0].body, { signer: pk });
  assert.equal(w.row.curator, pk);
  assert.equal(w.row.pendingCurator, null);
  assert.deepEqual(r.signatures, [`sig1${pk.slice(0, 6)}`]);
  assert.match(r.text, new RegExp(`✓ curation: accepted by ${pk}: sig1`));
  assert.ok(!r.text.includes(sends[0].body.signed[0]), 'the transaction is never printed');
});

test('init: handover (c) with a local wallet that is not the curator is WRONG_PAYER and sends nothing', async (t) => {
  const stranger = Keypair.generate();
  const strangerFile = join(mkdtempSync(join(tmpdir(), 'weavr-owner-')), 'owner.json');
  writeFileSync(strangerFile, JSON.stringify([...stranger.secretKey]), { mode: 0o600 });
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  const r = await runInit(w, home, { transferWallet: 'local' }, {
    env: { SIGN_LOCAL_KEYPAIR_FILE: strangerFile },
    keygen: () => { const k = Keypair.generate(); w.rpc.table.balances[k.publicKey.toBase58()] = FLOOR; return k; },
  });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const curation = step(r, 'curation');
  assert.equal(curation.code, 'WRONG_PAYER');
  assert.match(r.text, new RegExp(`✗ curation: WRONG_PAYER: the local wallet ${stranger.publicKey.toBase58()} is not the current curator ${owner.publicKey.toBase58()}`));
  assert.equal(w.server.hits.filter((h) => h.path === '/v1/transactions/send').length, 0);
  assert.equal(w.server.hits.filter((h) => h.method === 'POST').length, 0, 'nothing was even built');
});

test('init: handover (c) with the curating local wallet signs the transfer, then accepts with the new key', async (t) => {
  const ownerFile = join(mkdtempSync(join(tmpdir(), 'weavr-owner-')), 'owner.json');
  writeFileSync(ownerFile, JSON.stringify([...owner.secretKey]), { mode: 0o600 });
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  let generated;
  const r = await runInit(w, home, { transferWallet: 'local' }, {
    env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile },
    keygen: () => { generated = Keypair.generate(); w.rpc.table.balances[generated.publicKey.toBase58()] = FLOOR; return generated; },
  });
  assert.equal(r.exit, 0, r.text);
  const pk = generated.publicKey.toBase58();
  assert.deepEqual(w.server.state.sends.map((s) => [s.step, s.payer, s.arg]), [['propose_curator', owner.publicKey.toBase58(), pk], ['accept_curator', pk, undefined]]);
  assert.equal(w.row.curator, pk);
  assert.equal(r.signatures.length, 2);
  assert.match(r.text, /✓ curation: transfer to .* signed by .*: sig1/);
  assert.match(r.text, /✓ curation: accepted by .*: sig2/);
  assert.equal(mode(homePaths(home).keyFile), 0o600);
});

test('init: handover (c) --transfer-wallet none prints the MCP instruction and, with --wait, polls until the row shows the key pending, then accepts', async (t) => {
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  const r0 = await runInit(w, home, {}, { keygen: () => { const k = Keypair.generate(); w.rpc.table.balances[k.publicKey.toBase58()] = FLOOR; return k; } });
  assert.equal(r0.exit, EXIT_INIT.CROSS, 'without --wait the instruction is printed and init stops');
  const key = r0.key;
  assert.match(r0.text, new RegExp(`→ curation: the current curator ${owner.publicKey.toBase58()} must hand CLAWA1 to ${key}`));
  assert.match(r0.text, new RegExp(`build_transfer_curator \\{ portfolio: "${MINT}", signer: "${owner.publicKey.toBase58()}", newCurator: "${key}" \\}, then send_signed`));
  assert.equal(w.server.hits.filter((h) => h.method === 'POST').length, 0);

  // The owner acts after the second poll: the fake row flips to pending.
  let polls = 0;
  const r = await runInit(w, home, { wait: true, waitSecs: 300 }, { onSleep: async () => { polls += 1; if (polls === 2) w.row.pendingCurator = key; } });
  assert.equal(r.exit, 0, r.text);
  assert.equal(r.key, key, 'the same key was reused');
  assert.deepEqual(r.sleeps, [15000, 15000]);
  assert.deepEqual(w.server.state.sends.map((s) => [s.step, s.payer]), [['accept_curator', key]]);
  assert.equal(w.row.curator, key);
  assert.match(r.text, /polling the portfolio every 15 s/);
  assert.match(r.text, /✓ curation: accepted by/);
});

test('init: a FactoryConfig discriminator mismatch is a cross, never a guess', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const wrong = factoryConfigBytes({ guardian, treasury, discriminator: [1, 2, 3, 4, 5, 6, 7, 8] });
  const w = await world({ curator: pk, balances: { [pk]: FLOOR }, accounts: { [CONFIG_PDA]: wrong } });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ chain facts: FactoryConfig .*discriminator \[1,2,3,4,5,6,7,8\] is not FactoryConfig's/);
  assert.equal(r.guardian, null);
  assert.ok(!existsSync(homePaths(home).composeEnv));
  assert.equal(decodeFactoryConfig(wrong).ok, false);
  assert.equal(decodeFactoryConfig(factoryConfigBytes({ guardian, treasury })).guardian, guardian);
});

test('init: a missing FactoryConfig account is a cross too', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR }, accounts: {} });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ chain facts: FactoryConfig .*no account at the FactoryConfig address/);
});

test('init: without --yes a non-interactive stdin is a cross telling the owner to pass --yes; an interactive n stops too', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runInit(w, home, { yes: false }, { interactive: false });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ confirm: stdin is not interactive.*\n\s+fix: pass --yes/);
  const asked = [];
  const r2 = await runInit(w, home, { yes: false }, { interactive: true, prompt: async (q) => { asked.push(q); return 'n'; } });
  assert.equal(r2.exit, EXIT_INIT.CROSS);
  assert.equal(asked.length, 1);
  assert.match(r2.text, /✗ confirm: not confirmed/);
  const r3 = await runInit(w, home, { yes: false }, { interactive: true, prompt: async () => 'y' });
  assert.equal(r3.exit, 0, r3.text);
  assert.match(r3.text, /✓ confirm: chain facts confirmed/);
});

test('init: an unknown portfolio, preset or wallet is a cross before anything is written', async (t) => {
  const home = tmpHome();
  const w = await world({});
  t.after(() => w.server.close());
  const r = await runInit(w, home, { portfolio: 'NOPE' });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ portfolio: no portfolio NOPE/);
  assert.ok(!existsSync(home));
  const r2 = await runInit(w, home, { policy: 'loose' });
  assert.equal(r2.exit, EXIT_INIT.USAGE);
  assert.match(r2.text, /unknown preset "loose"/);
  const r3 = await runInit(w, home, { transferWallet: 'ledger' });
  assert.equal(r3.exit, EXIT_INIT.USAGE);
  assert.match(r3.text, /unknown --transfer-wallet "ledger"/);
});

test('init: a mint resolves like a ticker does', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runInit(w, home, { portfolio: MINT });
  assert.equal(r.exit, 0, r.text);
  assert.equal(r.portfolio.symbol, 'CLAWA1');
  const r2 = await runInit(w, home, { portfolio: 'clawa1' });
  assert.equal(r2.exit, 0, r2.text);
  assert.ok(w.server.hits.some((h) => h.path === '/v1/portfolios'), 'the lowercase ticker fell back to the list');
});

// ---------------------------------------------------------------- re-run

test('init: a re-run keeps the key, both tokens and the OPENAI_API_KEY the owner typed', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const first = await runInit(w, home, { rpc: 'http://127.0.0.1:1/rpc-one' });
  assert.equal(first.exit, 0, first.text);
  const keyBefore = readFileSync(paths.keyFile, 'utf8');
  const signerBefore = readFileSync(paths.signerToken, 'utf8');
  const opsBefore = readFileSync(paths.opsToken, 'utf8');

  // The owner fills the agent env and pins an image override.
  const env = readFileSync(paths.agentEnv, 'utf8')
    .replace(/^OPENAI_API_KEY=$/m, 'OPENAI_API_KEY=sk-typed-by-the-owner')
    .replace(/^TELEGRAM_ALLOWED_USERS=$/m, 'TELEGRAM_ALLOWED_USERS=12345');
  writeFileSync(paths.agentEnv, `${env}EXTRA_OWNER_VAR=kept\n`);
  writeFileSync(paths.composeEnv, readFileSync(paths.composeEnv, 'utf8').replace(/^HERMES_IMAGE=.*$/m, 'HERMES_IMAGE=my/hermes:pinned'));

  const second = await runInit(w, home);
  assert.equal(second.exit, 0, second.text);
  assert.equal(readFileSync(paths.keyFile, 'utf8'), keyBefore);
  assert.equal(readFileSync(paths.signerToken, 'utf8'), signerBefore);
  assert.equal(readFileSync(paths.opsToken, 'utf8'), opsBefore);
  assert.match(second.text, /curator key: .*\(reused/);
  assert.match(second.text, /agent token reused, ops token reused/);
  const after = parseEnv(readFileSync(paths.agentEnv, 'utf8')).values;
  assert.equal(after.OPENAI_API_KEY, 'sk-typed-by-the-owner');
  assert.equal(after.TELEGRAM_ALLOWED_USERS, '12345');
  assert.equal(after.EXTRA_OWNER_VAR, 'kept');
  assert.equal(after.CURATOR_SIGNER_TOKEN, signerBefore);
  assert.deepEqual(second.toFill, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_HOME_CHANNEL']);
  assert.equal(parseEnv(readFileSync(paths.signerEnv, 'utf8')).values.SOLANA_RPC_URL, 'http://127.0.0.1:1/rpc-one', 'the RPC URL typed earlier survives a re-run without --rpc');
  assert.equal(parseEnv(readFileSync(paths.composeEnv, 'utf8')).values.HERMES_IMAGE, 'my/hermes:pinned');
  assert.equal(mode(paths.agentEnv), 0o600);
  assert.ok(!(second.text + JSON.stringify(second)).includes('sk-typed-by-the-owner'), 'a typed provider key is never printed');
});

test('init: an existing key file that is too open or not a keypair is a cross, not overwritten', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  chmodSync(paths.keyFile, 0o644);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ curator key: .*readable by group or others: chmod 600 it/);
  chmodSync(paths.keyFile, 0o600);
  writeFileSync(paths.keyFile, '"not a key"');
  const r2 = await runInit(w, home);
  assert.equal(r2.exit, EXIT_INIT.CROSS);
  assert.match(r2.text, /✗ curator key: .*not a 64-byte JSON array/);
  assert.equal(readFileSync(paths.keyFile, 'utf8'), '"not a key"', 'never overwritten');
});


// ---------------------------------------------------------------- the guards before a signature

test('init: an accept the api built against a foreign program is refused before signing, and nothing is sent', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  w.server.state.build = { programId: Keypair.generate().publicKey.toBase58() };
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const curation = crossStep(r, 'curation');
  assert.ok(curation, r.text);
  assert.equal(curation.code, 'FOREIGN_PROGRAM');
  assert.match(r.text, /✗ curation: accept refused before signing: FOREIGN_PROGRAM, instruction targets .* which is not a weavr or core program/);
  assert.equal(w.server.hits.filter((h) => h.path === '/v1/transactions/send').length, 0, 'never sent');
  assert.equal(w.row.pendingCurator, pk, 'the row did not move');
  assert.deepEqual(r.signatures, []);
});

test('init: an accept the api built for another fee payer is WRONG_PAYER before signing, and nothing is sent', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  w.server.state.build = { feePayer: Keypair.generate().publicKey.toBase58() };
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.equal(crossStep(r, 'curation').code, 'WRONG_PAYER');
  assert.match(r.text, new RegExp(`✗ curation: accept refused before signing: WRONG_PAYER, fee payer .* is not the wallet ${pk}`));
  assert.equal(w.server.hits.filter((h) => h.path === '/v1/transactions/send').length, 0, 'never sent');
});

test('init: a transfer the api built against a foreign program is refused before the owner wallet signs', async (t) => {
  const ownerFile = join(mkdtempSync(join(tmpdir(), 'weavr-owner-')), 'owner.json');
  writeFileSync(ownerFile, JSON.stringify([...owner.secretKey]), { mode: 0o600 });
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  w.server.state.build = { programId: Keypair.generate().publicKey.toBase58() };
  const r = await runInit(w, home, { transferWallet: 'local' }, {
    env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile },
    keygen: () => { const k = Keypair.generate(); w.rpc.table.balances[k.publicKey.toBase58()] = FLOOR; return k; },
  });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.equal(crossStep(r, 'curation').code, 'FOREIGN_PROGRAM');
  assert.match(r.text, /✗ curation: transfer refused before signing: FOREIGN_PROGRAM/);
  assert.equal(w.server.hits.filter((h) => h.path === '/v1/transactions/send').length, 0, 'never sent');
  assert.equal(w.row.curator, owner.publicKey.toBase58(), 'curation did not move');
});

test('init: an accept the api reports as expired is a cross with no signature recorded', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  w.server.state.sendStatus = 'expired';
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ curation: accept sent but expired\n\s+fix: run init again; the accept is rebuilt and re-sent/);
  assert.deepEqual(r.signatures, []);
  assert.ok(crossStep(r, 'curation'), r.text);
  assert.equal(w.server.hits.filter((h) => h.path === '/v1/transactions/send').length, 1);
  assert.equal(w.row.pendingCurator, pk, 'the row did not move');
  assert.ok(!existsSync(homePaths(home).policyFile), 'stopped before the policy');
});

test('init: a transfer the api reports as failed is a cross, and the accept is never attempted', async (t) => {
  const ownerFile = join(mkdtempSync(join(tmpdir(), 'weavr-owner-')), 'owner.json');
  writeFileSync(ownerFile, JSON.stringify([...owner.secretKey]), { mode: 0o600 });
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  w.server.state.sendStatus = 'failed';
  const r = await runInit(w, home, { transferWallet: 'local' }, {
    env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile },
    keygen: () => { const k = Keypair.generate(); w.rpc.table.balances[k.publicKey.toBase58()] = FLOOR; return k; },
  });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, /✗ curation: transfer sent but failed/);
  assert.deepEqual(r.signatures, []);
  assert.deepEqual(w.server.state.sends.map((s) => s.step), ['propose_curator']);
  assert.equal(w.server.hits.filter((h) => h.path === `/v1/portfolios/${MINT}/curator/accept`).length, 0, 'no accept was built');
});

test('init: nothing is signed without --yes: a non-interactive run stops with nothing built, n at the prompt stops, y signs', async (t) => {
  const ownerFile = join(mkdtempSync(join(tmpdir(), 'weavr-owner-')), 'owner.json');
  writeFileSync(ownerFile, JSON.stringify([...owner.secretKey]), { mode: 0o600 });
  const home = tmpHome();
  const w = await world({ curator: owner.publicKey.toBase58() });
  t.after(() => w.server.close());
  const keygen = () => { const k = Keypair.generate(); w.rpc.table.balances[k.publicKey.toBase58()] = FLOOR; return k; };

  const r = await runInit(w, home, { transferWallet: 'local', yes: false }, { env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile }, keygen, interactive: false });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, new RegExp(`→ curation: ${owner.publicKey.toBase58()} is about to sign the transfer of curation to ${r.key} for CLAWA1; it lands onchain`));
  assert.match(r.text, /✗ curation: stdin is not interactive, so the signing above cannot be confirmed here; nothing built, nothing signed\n\s+fix: pass --yes to sign and send/);
  assert.equal(w.server.hits.filter((h) => h.method === 'POST').length, 0, 'nothing built, nothing sent');
  assert.equal(w.row.curator, owner.publicKey.toBase58());

  const r2 = await runInit(w, home, { transferWallet: 'local', yes: false }, { env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile }, interactive: true, prompt: async () => 'n' });
  assert.equal(r2.exit, EXIT_INIT.CROSS);
  assert.match(r2.text, /✗ curation: not confirmed; nothing built, nothing signed/);
  assert.equal(w.server.hits.filter((h) => h.method === 'POST').length, 0);

  const asked = [];
  const r3 = await runInit(w, home, { transferWallet: 'local', yes: false }, { env: { SIGN_LOCAL_KEYPAIR_FILE: ownerFile }, interactive: true, prompt: async (q) => { asked.push(q); return 'y'; } });
  assert.equal(r3.exit, 0, r3.text);
  assert.deepEqual(asked, ['sign and send? [y/N] ', 'sign and send? [y/N] ', 'write these into the signer config? [y/N] '], 'the transfer, the accept and the chain facts each asked');
  assert.deepEqual(w.server.state.sends.map((s) => s.step), ['propose_curator', 'accept_curator']);
  assert.equal(w.row.curator, r.key);

  // Handover (b) is gated the same way.
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home2 = tmpHome();
  writeKey(homePaths(home2).keyFile, key);
  const w2 = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w2.server.close());
  const r4 = await runInit(w2, home2, { yes: false }, { interactive: false });
  assert.equal(r4.exit, EXIT_INIT.CROSS);
  assert.match(r4.text, new RegExp(`→ curation: ${pk} is about to sign the accept of curation for CLAWA1`));
  assert.equal(w2.server.hits.filter((h) => h.method === 'POST').length, 0, 'the accept was not even built');
  assert.equal(w2.row.pendingCurator, pk);
});

// ---------------------------------------------------------------- tokens and env

test('init: equal agent and ops tokens are a cross naming the ops token file', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const first = await runInit(w, home);
  assert.equal(first.exit, 0, first.text);
  const same = randomBytes(32).toString('hex');
  writeFileSync(paths.signerToken, same, { mode: 0o600 });
  writeFileSync(paths.opsToken, same, { mode: 0o600 });
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.match(r.text, new RegExp(`✗ tokens: the agent token and the ops token are equal; the signer refuses to boot on that\\n\\s+fix: move ${paths.opsToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} away and run init again`));
  assert.ok(!r.text.includes(same), 'the token is never printed');
});

test('init: an env file carrying a token that differs from a reused token file is a cross naming both files, and the env files are left alone', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const first = await runInit(w, home);
  assert.equal(first.exit, 0, first.text);
  const before = readFileSync(paths.signerToken, 'utf8');

  // The README's rotation: a new value in both env files, the token file untouched.
  const rotated = randomBytes(32).toString('hex');
  const setToken = (file, name) => writeFileSync(file, readFileSync(file, 'utf8').replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${rotated}`), { mode: 0o600 });
  setToken(paths.signerEnv, 'CURATOR_SIGNER_TOKEN');
  setToken(paths.agentEnv, 'CURATOR_SIGNER_TOKEN');
  const r = await runInit(w, home);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const tokens = step(r, 'tokens');
  assert.equal(tokens.kind, 'cross');
  assert.ok(tokens.text.includes(`CURATOR_SIGNER_TOKEN in ${paths.signerEnv} is not the value in ${paths.signerToken}`), tokens.text);
  assert.ok(tokens.text.includes(`CURATOR_SIGNER_TOKEN in ${paths.agentEnv} is not the value in ${paths.signerToken}`), tokens.text);
  assert.match(tokens.fix, /write that value into the token file/);
  assert.equal(parseEnv(readFileSync(paths.signerEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, rotated, 'signer.env not reverted');
  assert.equal(parseEnv(readFileSync(paths.agentEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, rotated, 'hermes-home/.env not reverted');
  assert.equal(readFileSync(paths.signerToken, 'utf8'), before, 'the token file is not silently adopted either');
  const printed = r.text + JSON.stringify(r);
  assert.ok(!printed.includes(rotated) && !printed.includes(before), 'no token value printed');

  // The owner writes the rotated value into the token file: the re-run agrees and rewrites nothing the owner did not mean.
  writeFileSync(paths.signerToken, rotated, { mode: 0o600 });
  const r2 = await runInit(w, home);
  assert.equal(r2.exit, 0, r2.text);
  assert.match(r2.text, /agent token reused/);
  assert.equal(parseEnv(readFileSync(paths.signerEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, rotated);
  assert.equal(parseEnv(readFileSync(paths.agentEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, rotated);

  // The ops copy is compared the same way.
  setToken(paths.signerEnv, 'CURATOR_OPS_TOKEN');
  const r3 = await runInit(w, home);
  assert.equal(r3.exit, EXIT_INIT.CROSS);
  assert.ok(step(r3, 'tokens').text.includes(`CURATOR_OPS_TOKEN in ${paths.signerEnv} is not the value in ${paths.opsToken}`), step(r3, 'tokens').text);
});

test('init: a token file generated on this run replaces the stale copies in the env files and says so', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const first = await runInit(w, home);
  assert.equal(first.exit, 0, first.text);
  const old = readFileSync(paths.signerToken, 'utf8');
  rmSync(paths.signerToken);
  const r = await runInit(w, home);
  assert.equal(r.exit, 0, r.text);
  const fresh = readFileSync(paths.signerToken, 'utf8');
  assert.notEqual(fresh, old);
  assert.match(r.text, /agent token generated, ops token reused/);
  const info = step(r, 'tokens');
  assert.equal(info.kind, 'info');
  assert.ok(info.text.includes(`CURATOR_SIGNER_TOKEN in ${paths.signerEnv} and CURATOR_SIGNER_TOKEN in ${paths.agentEnv} held a value from before the token file was generated; replaced`), info.text);
  assert.equal(parseEnv(readFileSync(paths.signerEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, fresh);
  assert.equal(parseEnv(readFileSync(paths.agentEnv, 'utf8')).values.CURATOR_SIGNER_TOKEN, fresh);
  assert.ok(!(r.text + JSON.stringify(r)).includes(fresh) && !r.text.includes(old));
});

test('init: without --rpc the signer env carries a commented SOLANA_RPC_URL line and the next steps say to set it', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runInit(w, home);
  assert.equal(r.exit, 0, r.text);
  const text = readFileSync(paths.signerEnv, 'utf8');
  assert.match(text, /^# SOLANA_RPC_URL=$/m, 'a commented, empty line');
  assert.ok(!('SOLANA_RPC_URL' in parseEnv(text).values), 'no value the signer would read');
  assert.match(text, /the public endpoint rate-limits/);
  const env = step(r, 'tokens and env');
  assert.equal(env.rpcUrlSet, false);
  assert.match(env.text, /SOLANA_RPC_URL left for you to set/);
  assert.match(r.text, /✓ tokens and env: .*SOLANA_RPC_URL left for you to set/);
  assert.match(r.text, new RegExp(`\\d\\. set SOLANA_RPC_URL in ${paths.signerEnv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to a private endpoint`));
  // With --rpc the line is a value and the next step is gone.
  const r2 = await runInit(w, home, { rpc: 'http://127.0.0.1:1/rpc-two' });
  assert.equal(step(r2, 'tokens and env').rpcUrlSet, true);
  assert.doesNotMatch(r2.text, /SOLANA_RPC_URL left for you to set|set SOLANA_RPC_URL in/);
  assert.doesNotMatch(readFileSync(paths.signerEnv, 'utf8'), /^# SOLANA_RPC_URL=$/m);
});

test('init: a re-run keeps the agent\'s memories and its cron job state, takes the job definitions from the profile, and says what it replaced', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const first = await runInit(w, home);
  assert.equal(first.exit, 0, first.text);
  assert.equal(step(first, 'agent home').kind, 'ok');
  assert.equal(first.steps.filter((s) => s.name === 'agent home' && s.kind === 'info').length, 0, 'a first render replaced nothing');
  assert.equal(mode(join(paths.hermesHome, 'scripts/curator-health.sh')), statSync(join(ROOT, 'curator/profile/scripts/curator-health.sh')).mode & 0o777, 'file modes follow the profile');

  // The gateway runs: the agent writes a memory, the owner disables a job, the scheduler records a run.
  const memory = join(paths.hermesHome, 'memories/MEMORY.md');
  const user = join(paths.hermesHome, 'memories/USER.md');
  writeFileSync(memory, 'agent learned something\n');
  const userBefore = readFileSync(user, 'utf8');
  const jobs = JSON.parse(readFileSync(paths.jobsJson, 'utf8'));
  const review = jobs.jobs.find((j) => j.id === 'curator-review');
  review.enabled = false;
  review.last_run_at = '2026-09-17T09:00:00+00:00';
  review.last_status = 'ok';
  review.failure_streak = 2;
  review.repeat.completed = 7;
  review.prompt = 'an edit that must not survive: definitions come from the profile';
  jobs.jobs.push({ id: 'owner-extra', name: 'owner-extra', enabled: true, schedule: { kind: 'cron', expr: '0 0 * * *' } });
  writeFileSync(paths.jobsJson, JSON.stringify(jobs, null, 2));
  writeFileSync(join(paths.hermesHome, 'SOUL.md'), 'edited');

  const second = await runInit(w, home);
  assert.equal(second.exit, 0, second.text);
  assert.equal(readFileSync(memory, 'utf8'), 'agent learned something\n', 'MEMORY.md kept');
  assert.equal(readFileSync(user, 'utf8'), userBefore, 'USER.md kept');
  const after = JSON.parse(readFileSync(paths.jobsJson, 'utf8'));
  const reviewAfter = after.jobs.find((j) => j.id === 'curator-review');
  const profileReview = JSON.parse(readFileSync(join(ROOT, 'curator/profile/cron/jobs.json'), 'utf8')).jobs.find((j) => j.id === 'curator-review');
  assert.equal(reviewAfter.enabled, false, 'the owner\'s disable survives');
  assert.equal(reviewAfter.last_run_at, '2026-09-17T09:00:00+00:00');
  assert.equal(reviewAfter.last_status, 'ok');
  assert.equal(reviewAfter.failure_streak, 2);
  assert.equal(reviewAfter.repeat.completed, 7);
  assert.equal(reviewAfter.prompt, profileReview.prompt, 'the definition is the profile\'s again');
  assert.equal(reviewAfter.provider, profileReview.provider);
  assert.deepEqual(after.jobs.map((j) => j.id), ['curator-health', 'curator-review', 'curator-universe', 'curator-weekly', 'owner-extra'], 'the owner\'s own job is kept after the profile\'s');
  assert.equal(readFileSync(join(paths.hermesHome, 'SOUL.md'), 'utf8'), readFileSync(join(ROOT, 'curator/profile/SOUL.md'), 'utf8'), 'templates are replaced');
  const info = second.steps.find((s) => s.name === 'agent home' && s.kind === 'info');
  assert.ok(info, 'the re-render is reported');
  assert.deepEqual(info.kept, ['memories/MEMORY.md', 'memories/USER.md']);
  assert.deepEqual(info.merged, ['cron/jobs.json']);
  assert.ok(info.replaced.includes('config.yaml') && info.replaced.includes('SOUL.md') && info.replaced.some((f) => f.startsWith('scripts/')) && info.replaced.some((f) => f.startsWith('skills/')), info.replaced.join(','));
  assert.ok(!info.replaced.some((f) => f.startsWith('memories/') || f === 'cron/jobs.json'));
  assert.match(second.text, /· agent home: re-rendered: kept memories\/MEMORY\.md, memories\/USER\.md \(the agent's own notes\); merged cron\/jobs\.json \(job state kept, definitions from the profile\); replaced .*config\.yaml.* from the profile/);
});

test('mergeJobs: state fields from the home, everything else from the profile, unknown jobs kept', () => {
  const profile = { jobs: [{ id: 'a', prompt: 'new', enabled: true, last_run_at: null, repeat: { times: null, completed: 0 } }, { id: 'b', prompt: 'b', enabled: true }], updated_at: 'p' };
  const home = { jobs: [{ id: 'a', prompt: 'old', enabled: false, last_run_at: 't', failure_streak: 3, repeat: { times: null, completed: 4 } }, { id: 'z', prompt: 'mine' }], updated_at: 'h' };
  const merged = mergeJobs(profile, home);
  assert.deepEqual(merged.jobs.map((j) => j.id), ['a', 'b', 'z']);
  assert.deepEqual(merged.jobs[0], { id: 'a', prompt: 'new', enabled: false, last_run_at: 't', failure_streak: 3, repeat: { times: null, completed: 4 } });
  assert.deepEqual(merged.jobs[1], { id: 'b', prompt: 'b', enabled: true });
  assert.deepEqual(mergeJobs(profile, null).jobs, profile.jobs);
});

// ---------------------------------------------------------------- --json never prompts

test('init: --json never prompts; a confirmation it would have asked for is a cross saying to pass --yes, and the bin prints exactly one JSON object', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const trap = async () => { throw new Error('the prompt seam was called under --json'); };

  // The chain-facts confirmation.
  const r = await runInit(w, home, { yes: false, json: true }, { interactive: true, prompt: trap });
  assert.equal(r.exit, EXIT_INIT.CROSS);
  assert.equal(r.lines.length, 0, 'json mode prints nothing before the object');
  const confirm = crossStep(r, 'confirm');
  assert.ok(confirm, JSON.stringify(r.steps));
  assert.equal(confirm.text, '--json never prompts, so the chain facts above cannot be confirmed here');
  assert.match(confirm.fix, /pass --yes/);
  assert.ok(!existsSync(homePaths(home).policyFile), 'stopped before the policy');

  // The signing confirmation is gated the same way, and nothing is built.
  const key2 = Keypair.generate();
  const pk2 = key2.publicKey.toBase58();
  const home2 = tmpHome();
  writeKey(homePaths(home2).keyFile, key2);
  const w2 = await world({ curator: owner.publicKey.toBase58(), pendingCurator: pk2, balances: { [pk2]: FLOOR } });
  t.after(() => w2.server.close());
  const r2 = await runInit(w2, home2, { yes: false, json: true }, { interactive: true, prompt: trap });
  assert.equal(r2.exit, EXIT_INIT.CROSS);
  assert.equal(r2.lines.length, 0);
  assert.equal(crossStep(r2, 'curation').text, '--json never prompts, so the signing above cannot be confirmed here; nothing built, nothing signed');
  assert.equal(w2.server.hits.filter((h) => h.method === 'POST').length, 0, 'nothing built, nothing sent');
  assert.equal(w2.row.pendingCurator, pk2, 'the row did not move');

  // Without --json the same run asks, so the gate is --json itself, not a side effect of the seam.
  const asked = [];
  const r3 = await runInit(w, home, { yes: false }, { interactive: true, prompt: async (q) => { asked.push(q); return 'y'; } });
  assert.equal(r3.exit, 0, r3.text);
  assert.equal(asked.length, 1);

  // The executable: stdout is one JSON object and nothing else, exit 2.
  const bin = await runBin(['init', '--portfolio', 'CLAWA1', '--home', home, '--api', w.server.url, '--mcp', `${w.server.url}/mcp`, '--rpc', `${w.server.url}/rpc`, '--json'], { SOLANA_RPC_URL: '' });
  assert.equal(bin.status, EXIT_INIT.CROSS, bin.stderr + bin.stdout);
  assert.ok(bin.stdout.startsWith('{'), `stdout starts with the object: ${bin.stdout.slice(0, 80)}`);
  const body = JSON.parse(bin.stdout);
  assert.equal(body.exit, EXIT_INIT.CROSS);
  assert.equal(body.ok, false);
  assert.equal(body.steps.find((s) => s.name === 'confirm').kind, 'cross');
  assert.match(body.steps.find((s) => s.name === 'confirm').text, /--json never prompts/);
});

// ---------------------------------------------------------------- remembered URLs and the RPC endpoint

test('init: a re-run without --api/--mcp keeps the URLs the previous run wrote, a flag wins, and the line says what was kept', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  // Any request that leaves the fake server is a test failure, never a network call.
  const asked = [];
  const fenced = (url, options) => {
    asked.push(String(url));
    if (!String(url).startsWith(w.server.url)) throw Object.assign(new Error(`left the fake server for ${url}`), { code: 'ECONNREFUSED' });
    return fetch(url, options);
  };

  const first = await runInit(w, home, {}, { fetchImpl: fenced });
  assert.equal(first.exit, 0, first.text);
  assert.equal(step(first, 'tokens and env').apiUrlFrom, 'flag');
  assert.equal(step(first, 'tokens and env').mcpUrlFrom, 'flag');
  assert.doesNotMatch(first.text, /kept the api URL|kept the MCP URL/);

  const second = await runInit(w, home, { api: undefined, mcp: undefined }, { fetchImpl: fenced });
  assert.equal(second.exit, 0, second.text);
  assert.equal(parseEnv(readFileSync(paths.composeEnv, 'utf8')).values.CURATOR_API_URL, w.server.url, 'compose.env keeps the api URL');
  const agentEnv = parseEnv(readFileSync(paths.agentEnv, 'utf8')).values;
  assert.equal(agentEnv.WEAVR_API_URL, w.server.url);
  assert.equal(agentEnv.WEAVR_MCP_URL, `${w.server.url}/mcp`);
  const env = step(second, 'tokens and env');
  assert.equal(env.apiUrlFrom, 'home');
  assert.equal(env.mcpUrlFrom, 'home');
  assert.match(env.text, /; kept the api URL from compose\.env and the MCP URL from hermes-home\/\.env$/);
  assert.ok(asked.every((u) => u.startsWith(w.server.url)), `every request went to the remembered api: ${asked.join(', ')}`);

  // A flag wins over the remembered value; the other URL is still kept.
  const third = await runInit(w, home, { api: undefined, mcp: `${w.server.url}/other-mcp` }, { fetchImpl: fenced });
  assert.equal(third.exit, 0, third.text);
  assert.equal(parseEnv(readFileSync(paths.agentEnv, 'utf8')).values.WEAVR_MCP_URL, `${w.server.url}/other-mcp`);
  assert.equal(step(third, 'tokens and env').mcpUrlFrom, 'flag');
  assert.equal(step(third, 'tokens and env').apiUrlFrom, 'home');
  assert.match(step(third, 'tokens and env').text, /; kept the api URL from compose\.env$/);

  // With nothing remembered the public api is the default: the fence refuses it and init stops, no network touched.
  asked.length = 0;
  const fresh = await runInit(w, tmpHome(), { api: undefined, mcp: undefined }, { fetchImpl: fenced });
  assert.equal(fresh.exit, EXIT_INIT.CROSS);
  assert.deepEqual(asked, ['https://api.weavr.sh/v1/portfolios/CLAWA1'], 'the default api was asked once and refused by the fence');
});

test('init: without --home a re-run finds the previous home under the root by ticker in any case or by mint, and keeps its URLs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'weavr-curator-root-'));
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const fenced = (url, options) => {
    if (!String(url).startsWith(w.server.url)) throw Object.assign(new Error(`left the fake server for ${url}`), { code: 'ECONNREFUSED' });
    return fetch(url, options);
  };
  const first = await runInit(w, undefined, {}, { root, keygen: () => key, fetchImpl: fenced });
  assert.equal(first.exit, 0, first.text);
  assert.equal(first.home, join(root, 'CLAWA1'));
  assert.deepEqual(rememberedUrls({ portfolio: 'clawa1' }, { root }), { home: join(root, 'CLAWA1'), api: w.server.url, mcp: `${w.server.url}/mcp` });
  assert.deepEqual(rememberedUrls({ portfolio: MINT }, { root }), { home: join(root, 'CLAWA1'), api: w.server.url, mcp: `${w.server.url}/mcp` });
  assert.deepEqual(rememberedUrls({ portfolio: 'NOPE' }, { root }), { home: null, api: '', mcp: '' });
  assert.deepEqual(rememberedUrls({ portfolio: 'CLAWA1' }, { root: join(root, 'missing') }), { home: null, api: '', mcp: '' });

  const byTicker = await runInit(w, undefined, { portfolio: 'clawa1', api: undefined, mcp: undefined }, { root, fetchImpl: fenced });
  assert.equal(byTicker.exit, 0, byTicker.text);
  assert.equal(byTicker.home, join(root, 'CLAWA1'));
  assert.equal(step(byTicker, 'tokens and env').apiUrlFrom, 'home');
  const byMint = await runInit(w, undefined, { portfolio: MINT, api: undefined, mcp: undefined }, { root, fetchImpl: fenced });
  assert.equal(byMint.exit, 0, byMint.text);
  assert.equal(step(byMint, 'tokens and env').mcpUrlFrom, 'home');
  assert.equal(parseEnv(readFileSync(homePaths(join(root, 'CLAWA1')).agentEnv, 'utf8')).values.WEAVR_MCP_URL, `${w.server.url}/mcp`);
  rmSync(root, { recursive: true, force: true });
});

test('init: SOLANA_RPC_URL from the shell is written into signer.env when --rpc is absent; --rpc wins; the shell wins over the previous run; never printed', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const rpcOf = () => parseEnv(readFileSync(paths.signerEnv, 'utf8')).values.SOLANA_RPC_URL;
  const never = (r, ...urls) => { const printed = r.text + JSON.stringify(r); for (const u of urls) assert.ok(!printed.includes(u), `${u} never printed`); };

  const shell = await runInit(w, home, {}, { env: { SOLANA_RPC_URL: 'http://127.0.0.1:1/from-the-shell' } });
  assert.equal(shell.exit, 0, shell.text);
  assert.equal(rpcOf(), 'http://127.0.0.1:1/from-the-shell');
  assert.equal(step(shell, 'tokens and env').rpcUrlFrom, 'shell');
  assert.equal(step(shell, 'tokens and env').rpcUrlSet, true);
  assert.match(shell.text, /✓ tokens and env: .*SOLANA_RPC_URL from your shell environment/);
  assert.doesNotMatch(shell.text, /left for you to set|set SOLANA_RPC_URL in/);
  never(shell, 'from-the-shell');

  const flag = await runInit(w, home, { rpc: 'http://127.0.0.1:1/from-the-flag' }, { env: { SOLANA_RPC_URL: 'http://127.0.0.1:1/from-the-shell' } });
  assert.equal(rpcOf(), 'http://127.0.0.1:1/from-the-flag', '--rpc wins over the shell');
  assert.equal(step(flag, 'tokens and env').rpcUrlFrom, 'flag');
  assert.match(flag.text, /SOLANA_RPC_URL from --rpc/);
  never(flag, 'from-the-flag', 'from-the-shell');

  const kept = await runInit(w, home, {}, { env: {} });
  assert.equal(rpcOf(), 'http://127.0.0.1:1/from-the-flag', 'the previous value survives a run with neither');
  assert.equal(step(kept, 'tokens and env').rpcUrlFrom, 'home');
  assert.match(kept.text, /SOLANA_RPC_URL kept from the previous run/);
  never(kept, 'from-the-flag');

  const again = await runInit(w, home, {}, { env: { SOLANA_RPC_URL: 'http://127.0.0.1:1/shell-again' } });
  assert.equal(rpcOf(), 'http://127.0.0.1:1/shell-again', 'the shell wins over the previous run');
  assert.equal(step(again, 'tokens and env').rpcUrlFrom, 'shell');
  never(again, 'shell-again', 'from-the-flag');

  const blank = await runInit(w, home, {}, { env: { SOLANA_RPC_URL: '   ' } });
  assert.equal(rpcOf(), 'http://127.0.0.1:1/shell-again', 'a blank shell value is unset');
  assert.equal(step(blank, 'tokens and env').rpcUrlFrom, 'home');
});

// ---------------------------------------------------------------- an existing --home

test('init: --home on an existing, non-empty directory no init made is a cross before anything is written; --yes writes into it; a placed key or a previous init is not a stranger', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const interactive = { interactive: true, prompt: async () => 'y', keygen: () => key };

  const dir = mkdtempSync(join(tmpdir(), 'weavr-someone-elses-'));
  writeFileSync(join(dir, 'notes.txt'), 'mine\n');
  chmodSync(dir, 0o755);
  const r = await runInit(w, dir, { yes: false }, interactive);
  assert.equal(r.exit, EXIT_INIT.CROSS);
  const cross = crossStep(r, 'home');
  assert.ok(cross, r.text);
  assert.equal(cross.text, `${dir} exists and was not made by weavr-curator init; pass an empty or new directory`);
  assert.match(cross.fix, /--yes/);
  assert.match(r.text, /✗ home: .*exists and was not made by weavr-curator init; pass an empty or new directory\n\s+fix: /);
  assert.equal(mode(dir), 0o755, 'the directory mode is untouched');
  assert.deepEqual(readdirSync(dir), ['notes.txt'], 'nothing written beside what it held');
  assert.equal(w.server.hits.filter((h) => h.method === 'POST').length, 0);

  // --yes writes into it, says so, and the stray file survives.
  const r2 = await runInit(w, dir, {}, { keygen: () => key });
  assert.equal(r2.exit, 0, r2.text);
  const info = r2.steps.find((s) => s.name === 'home');
  assert.equal(info.kind, 'info');
  assert.match(info.text, /exists and was not made by weavr-curator init; writing into it \(--yes\)/);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine\n');
  assert.equal(mode(dir), 0o700);

  // A home a previous init made is fine without --yes: curator/ is the marker.
  const r3 = await runInit(w, dir, { yes: false }, interactive);
  assert.equal(r3.exit, 0, r3.text);
  assert.equal(r3.steps.find((s) => s.name === 'home'), undefined, 'no home step on a made home');

  // An empty directory is fine without --yes, and so is a new one.
  const empty = mkdtempSync(join(tmpdir(), 'weavr-empty-'));
  const r4 = await runInit(w, empty, { yes: false }, interactive);
  assert.equal(r4.exit, 0, r4.text);
  assert.equal(r4.steps.find((s) => s.name === 'home'), undefined);
  const r5 = await runInit(w, tmpHome(), { yes: false }, interactive);
  assert.equal(r5.exit, 0, r5.text);

  // A directory holding only the key file placed there for init to reuse is meant for init.
  const placed = tmpHome();
  writeKey(homePaths(placed).keyFile, key);
  const r6 = await runInit(w, placed, { yes: false }, interactive);
  assert.equal(r6.exit, 0, r6.text);
  assert.equal(r6.steps.find((s) => s.name === 'home'), undefined);
  assert.match(r6.text, /curator key: .*\(reused/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the preset on a re-run

test('init: a re-run without --policy keeps the preset the home was written from, --policy switches it and says so, and a policy.json edited by hand is not written over without a y or --yes', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  const paths = homePaths(home);
  writeKey(paths.keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const policyOf = () => JSON.parse(readFileSync(paths.policyFile, 'utf8'));
  const isRehearsal = (p) => p.verbs.denied.includes('deposit') && p.universe.requirePythFeedId === false && p.shape.minLegs === REHEARSAL.shape.minLegs;
  const isStandard = (p) => !p.verbs.denied.includes('deposit') && p.universe.requirePythFeedId === true && p.shape.minLegs === STANDARD.shape.minLegs;
  const fileStep = (r) => r.steps.find((s) => s.name === 'policy file');
  // Both presets admit this book, so a swap between them changes what the agent may do without any refusal to show for it.
  assert.deepEqual(validatePolicyAgainstBook(STANDARD, w.row, catalogue()), []);
  assert.deepEqual(validatePolicyAgainstBook(REHEARSAL, w.row, catalogue()), []);

  const first = await runInit(w, home, { policy: 'rehearsal' });
  assert.equal(first.exit, 0, first.text);
  assert.ok(isRehearsal(policyOf()));
  assert.equal(step(first, 'policy').preset, 'rehearsal');
  assert.equal(step(first, 'policy').presetFrom, 'flag');
  assert.equal(fileStep(first), undefined, 'a first run has no file to speak of');

  // No --policy: the file says which preset the home runs, and the line says it was remembered.
  const second = await runInit(w, home, {});
  assert.equal(second.exit, 0, second.text);
  assert.ok(isRehearsal(policyOf()), 'the re-run kept the rehearsal preset');
  assert.equal(step(second, 'policy').preset, 'rehearsal');
  assert.equal(step(second, 'policy').presetFrom, 'home');
  assert.match(second.text, /✓ policy: the rehearsal preset \(remembered from .*policy\.json; pass --policy to change it\) admits pSOL 40 \/ pCBBTC 40 \/ pUSDS 20; written to/);
  assert.equal(fileStep(second), undefined, 'the same preset goes back: nothing to report about the file');

  // --policy standard switches, and the switch is its own line.
  const third = await runInit(w, home, { policy: 'standard' });
  assert.equal(third.exit, 0, third.text);
  assert.ok(isStandard(policyOf()));
  assert.equal(step(third, 'policy').presetFrom, 'flag');
  assert.equal(fileStep(third).kind, 'info');
  assert.ok(fileStep(third).text.startsWith(`${paths.policyFile} held the rehearsal preset; the standard preset is written over it (--policy standard)`), fileStep(third).text);
  assert.ok(third.lines.some((l) => /^  · policy file: .*held the rehearsal preset; the standard preset is written over it/.test(l)), 'on its own line');
  // And back without the flag: the file now says standard.
  const fourth = await runInit(w, home, {});
  assert.equal(step(fourth, 'policy').preset, 'standard');
  assert.equal(step(fourth, 'policy').presetFrom, 'home');

  // A file that matches no shipped preset holds the owner's edits. The chain
  // facts prompt comes first (answered y); the policy prompt is the one that
  // names the file. n leaves the file as it is and stops; y replaces it and says so.
  const edit = () => { const p = policyOf(); p.turnover.maxTurnoverBps = 1234; writeFileSync(paths.policyFile, `${JSON.stringify(p, null, 2)}\n`); };
  edit();
  const asked = [];
  const answering = (reply) => ({ interactive: true, prompt: async (q) => { asked.push(q); return /edited by hand|not valid JSON/.test(q) ? reply : 'y'; } });
  const envWrittenAt = statSync(paths.composeEnv).mtimeMs;
  const declined = await runInit(w, home, { yes: false }, answering('n'));
  assert.equal(declined.exit, EXIT_INIT.CROSS);
  assert.ok(asked.some((q) => q === `write the standard preset over ${paths.policyFile}, which was edited by hand? [y/N] `), asked.join(' | '));
  const cross = crossStep(declined, 'policy file');
  assert.ok(cross, declined.text);
  assert.ok(cross.text.startsWith(`${paths.policyFile} matches no shipped preset (edited by hand); not confirmed, so it is left as it is`), cross.text);
  assert.match(cross.fix, /answer y, or pass --yes/);
  assert.equal(policyOf().turnover.maxTurnoverBps, 1234, 'the edited file is untouched');
  assert.equal(statSync(paths.composeEnv).mtimeMs, envWrittenAt, 'init stopped before the env files: compose.env was not rewritten');

  const accepted = await runInit(w, home, { yes: false }, answering('y'));
  assert.equal(accepted.exit, 0, accepted.text);
  assert.ok(isStandard(policyOf()));
  assert.equal(policyOf().turnover.maxTurnoverBps, STANDARD.turnover.maxTurnoverBps);
  assert.equal(fileStep(accepted).kind, 'info');
  assert.ok(fileStep(accepted).text.startsWith(`${paths.policyFile} matched no shipped preset (edited by hand); the standard preset is written over it (confirmed); put your edits back and restart the signer`), fileStep(accepted).text);

  // --yes replaces it too, and the line says --yes did.
  edit();
  const withYes = await runInit(w, home, {});
  assert.equal(withYes.exit, 0, withYes.text);
  assert.ok(isStandard(policyOf()));
  assert.equal(policyOf().turnover.maxTurnoverBps, STANDARD.turnover.maxTurnoverBps);
  assert.ok(fileStep(withYes).text.startsWith(`${paths.policyFile} matched no shipped preset (edited by hand); the standard preset is written over it (--yes); put your edits back and restart the signer`), fileStep(withYes).text);

  // A file whose only difference from its preset is the notice (a set-delay, or the doctor's by-hand fix) is that preset: remembered, no line about the file.
  const notice = policyOf(); notice.invariants.rebalanceDelaySecs = 120; writeFileSync(paths.policyFile, `${JSON.stringify(notice, null, 2)}\n`);
  const afterDelay = await runInit(w, home, {});
  assert.equal(afterDelay.exit, 0, afterDelay.text);
  assert.equal(step(afterDelay, 'policy').presetFrom, 'home');
  assert.equal(fileStep(afterDelay), undefined);
  assert.equal(policyOf().invariants.rebalanceDelaySecs, 60, 'the notice is rewritten from chain');

  // A file that is not JSON is not a preset either: replaced only with --yes or a y.
  writeFileSync(paths.policyFile, '{ not json\n');
  const broken = await runInit(w, home, { yes: false }, answering('n'));
  assert.equal(broken.exit, EXIT_INIT.CROSS);
  assert.match(crossStep(broken, 'policy file').text, /is not valid JSON; not confirmed, so it is left as it is/);
  assert.equal(readFileSync(paths.policyFile, 'utf8'), '{ not json\n');
  const repaired = await runInit(w, home, {});
  assert.equal(repaired.exit, 0, repaired.text);
  assert.match(fileStep(repaired).text, /was not valid JSON; the standard preset is written over it \(--yes\)/);
  assert.ok(isStandard(policyOf()));
});

// ---------------------------------------------------------------- pure pieces

test('validatePolicyAgainstBook: each rule reports on a planted violation and is silent on a clean book', () => {
  const pools = catalogue();
  const row = (legs) => portfolioRow({ mint: MINT, creator: 'x', curator: 'x', feeRecipient: 'x', legs });
  assert.deepEqual(validatePolicyAgainstBook(STANDARD, row([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]]), pools), []);
  const codes = (legs, policy = STANDARD, extraPools = []) => validatePolicyAgainstBook(policy, row(legs), [...pools, ...extraPools]).map((i) => i.code);
  assert.ok(codes([['pSOL', 6000], ['pCBBTC', 4000]]).includes('MIN_LEGS'));
  assert.ok(codes([['pSOL', 6000], ['pCBBTC', 4000]]).includes('LEG_WEIGHT_CAP'), 'pSOL 60 is over the standard per-leg cap');
  assert.ok(codes([['pSOL', 6000], ['pCBBTC', 4000]]).includes('STABLE_BAND'), 'no stable sleeve under standard');
  assert.ok(codes([['pSOL', 3000], ['pJITOSOL', 3000], ['pCBBTC', 2000], ['pUSDS', 2000]]).length === 0);
  assert.ok(codes([['pSOL', 3500], ['pJITOSOL', 3500], ['pCBBTC', 1000], ['pUSDS', 2000]], { ...STANDARD, shape: { ...STANDARD.shape, categoryMaxBps: 3000 } }).includes('CATEGORY_CAP'));
  assert.ok(codes([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]], { ...STANDARD, shape: { ...STANDARD.shape, maxLegs: 2 } }).includes('MAX_LEGS'));
  assert.ok(codes([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]], { ...STANDARD, universe: { ...STANDARD.universe, chains: ['ethereum'] } }).includes('CHAIN_DENIED'));
  assert.ok(codes([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]], { ...STANDARD, universe: { ...STANDARD.universe, maxRiskTier: 1 } }).includes('POOL_DENIED'));
  assert.ok(codes([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]], { ...STANDARD, universe: { ...STANDARD.universe, maxExecutionLossBps: 10 } }).includes('POOL_COST_TOO_HIGH'));
  const paused = pools.map((p) => (p.symbol === 'pSOL' ? { ...p, status: 'paused' } : p));
  assert.ok(validatePolicyAgainstBook(STANDARD, row([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]]), paused).map((i) => i.code).includes('POOL_NOT_ACTIVE'));
  const noFeed = pools.map((p) => (p.symbol === 'pSOL' ? { ...p, pythFeedId: null } : p));
  assert.ok(validatePolicyAgainstBook(STANDARD, row([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]]), noFeed).some((i) => i.code === 'POOL_DENIED' && /no Pyth feed/.test(i.message)));
  assert.deepEqual(validatePolicyAgainstBook(REHEARSAL, row([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]]), noFeed), [], 'rehearsal does not require a feed');
  const capped = pools.map((p) => (p.symbol === 'pCBBTC' ? { ...p, maxWeightBps: 3000 } : p));
  assert.ok(validatePolicyAgainstBook(STANDARD, row([['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]]), capped).some((i) => i.code === 'LEG_WEIGHT_CAP' && /pCBBTC targets 4000 bps; .* allows 500\.\.3000 bps/.test(i.message)), 'the pool cap binds below the shape cap');
  const items = validatePolicyAgainstBook(STANDARD, row([['pSOL', 6000], ['pCBBTC', 4000]]), pools, { presetName: 'standard', alternatives: { rehearsal: REHEARSAL } });
  assert.match(items.find((i) => i.code === 'MIN_LEGS').fix, /--policy rehearsal/);
});


test('validatePolicyAgainstBook: a number a rule needs and cannot find is INPUTS_INCOMPLETE, never a pass', () => {
  const pools = catalogue();
  const row = (legs) => portfolioRow({ mint: MINT, creator: 'x', curator: 'x', feeRecipient: 'x', legs });
  const legs = [['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]];
  const strict = { ...STANDARD, universe: { ...STANDARD.universe, maxRiskTier: 0, maxExecutionLossBps: 0 } };
  assert.ok(validatePolicyAgainstBook(strict, row(legs), pools).length >= 6, 'with the numbers present every leg is over both caps');

  // Catalogue rows without riskTier / maxExecutionLossBps clear nothing.
  const blind = pools.map(({ riskTier, maxExecutionLossBps, ...rest }) => rest);
  const items = validatePolicyAgainstBook(strict, row(legs), blind);
  assert.ok(items.length > 0, 'not a pass');
  const incomplete = items.filter((i) => i.code === 'INPUTS_INCOMPLETE');
  assert.equal(incomplete.length, 3, 'one item per held leg');
  for (const symbol of ['pSOL', 'pCBBTC', 'pUSDS']) assert.ok(incomplete.some((i) => i.message.includes(`the catalogue row for ${symbol} has no number for riskTier, maxExecutionLossBps`)), JSON.stringify(incomplete));
  assert.ok(!items.some((i) => i.code === 'POOL_DENIED' || i.code === 'POOL_COST_TOO_HIGH'), 'no comparison ran on a missing number');

  // A missing pool cap.
  const uncapped = pools.map(({ maxWeightBps, ...rest }) => (rest.symbol === 'pCBBTC' ? rest : { maxWeightBps, ...rest }));
  const capItems = validatePolicyAgainstBook(STANDARD, row(legs), uncapped);
  assert.ok(capItems.some((i) => i.code === 'INPUTS_INCOMPLETE' && /the catalogue row for pCBBTC has no number for maxWeightBps/.test(i.message)), JSON.stringify(capItems));
  assert.equal(capItems.length, 1);

  // Targets without weights.
  const noWeights = row(legs);
  noWeights.targets = noWeights.targets.map(({ poolId }) => ({ poolId }));
  const weightItems = validatePolicyAgainstBook(STANDARD, noWeights, pools);
  assert.ok(weightItems.length > 0, 'not a pass');
  assert.equal(weightItems.filter((i) => i.code === 'INPUTS_INCOMPLETE').length, 3);
  assert.ok(weightItems.some((i) => /pSOL has no target weightBps in the portfolio row/.test(i.message)));
  assert.ok(!weightItems.some((i) => ['LEG_WEIGHT_CAP', 'STABLE_BAND', 'CATEGORY_CAP'].includes(i.code)), 'no weight rule ran on a missing weight, and no partial sum was judged');
  const nullWeight = row(legs);
  nullWeight.targets[0].weightBps = null;
  assert.ok(Number.isNaN(legsOf(nullWeight, pools)[0].weightBps), 'a null weight is not 0');
  assert.ok(validatePolicyAgainstBook(STANDARD, nullWeight, pools).some((i) => i.code === 'INPUTS_INCOMPLETE'));

  // A preset without a cap.
  const { maxLegWeightBps, ...shapeWithoutCap } = STANDARD.shape;
  const presetItems = validatePolicyAgainstBook({ ...STANDARD, shape: shapeWithoutCap }, row(legs), pools, { presetName: 'the standard preset' });
  assert.ok(presetItems.some((i) => i.code === 'INPUTS_INCOMPLETE' && i.message === 'the standard preset has no number for shape.maxLegWeightBps, so those rules cannot run' && /shipped preset/.test(i.fix)), JSON.stringify(presetItems));
  const { maxRiskTier, ...universeWithoutTier } = STANDARD.universe;
  assert.ok(validatePolicyAgainstBook({ ...STANDARD, universe: universeWithoutTier }, row(legs), pools).some((i) => i.code === 'INPUTS_INCOMPLETE' && /universe\.maxRiskTier/.test(i.message)));

  // The shipped presets carry every number, so a clean book is still clean.
  assert.deepEqual(validatePolicyAgainstBook(STANDARD, row(legs), pools), []);
  assert.deepEqual(validatePolicyAgainstBook(REHEARSAL, row(legs), pools), []);
});

test('validatePolicyAgainstBook: each missing input is its own INPUTS_INCOMPLETE item, absent, null or empty: weightBps, riskTier, maxExecutionLossBps, maxWeightBps', () => {
  const pools = catalogue();
  const row = (legs) => portfolioRow({ mint: MINT, creator: 'x', curator: 'x', feeRecipient: 'x', legs });
  const legs = [['pSOL', 4000], ['pCBBTC', 4000], ['pUSDS', 2000]];
  const without = (pool, field, value) => {
    if (value === undefined) { const { [field]: dropped, ...rest } = pool; return rest; }
    return { ...pool, [field]: value };
  };

  // One catalogue field at a time, on one leg: one item, naming that field, and no comparison run on it.
  for (const field of ['riskTier', 'maxExecutionLossBps', 'maxWeightBps']) {
    for (const value of [undefined, null, '']) {
      const planted = pools.map((p) => (p.symbol === 'pCBBTC' ? without(p, field, value) : p));
      const items = validatePolicyAgainstBook(STANDARD, row(legs), planted);
      assert.deepEqual(items.map((i) => i.code), ['INPUTS_INCOMPLETE'], `${field}=${String(value)}: ${JSON.stringify(items)}`);
      assert.equal(items[0].message, `the catalogue row for pCBBTC has no number for ${field}, so those rules cannot run on it`);
      assert.match(items[0].fix, /read the catalogue again/);
    }
  }

  // One target without a weight: one item naming the leg, and no weight rule or sleeve sum judged.
  for (const value of [undefined, null, '']) {
    const r = row(legs);
    r.targets = r.targets.map((t) => (t.poolId === 'pCBBTC@solana' ? without(t, 'weightBps', value) : t));
    const items = validatePolicyAgainstBook(STANDARD, r, pools);
    assert.deepEqual(items.map((i) => i.code), ['INPUTS_INCOMPLETE'], `weightBps=${String(value)}: ${JSON.stringify(items)}`);
    assert.equal(items[0].message, 'pCBBTC has no target weightBps in the portfolio row, so the weight rules cannot run on it');
    assert.match(items[0].fix, /read the portfolio again/);
  }

  // A zero is a number, not a missing input: the rule runs and judges it.
  const zeroWeight = row(legs);
  zeroWeight.targets[1].weightBps = 0;
  const zeroItems = validatePolicyAgainstBook(STANDARD, zeroWeight, pools);
  assert.ok(zeroItems.some((i) => i.code === 'LEG_WEIGHT_CAP' && /pCBBTC targets 0 bps/.test(i.message)), JSON.stringify(zeroItems));
  assert.ok(!zeroItems.some((i) => i.code === 'INPUTS_INCOMPLETE'));
  const zeroTier = pools.map((p) => (p.symbol === 'pCBBTC' ? { ...p, riskTier: 0, maxExecutionLossBps: 0 } : p));
  assert.deepEqual(validatePolicyAgainstBook(STANDARD, row(legs), zeroTier), []);
});

test('policyDigest strips _comment keys at every level and sorts keys, like the signer', () => {
  const a = { version: 1, _comment: 'x', universe: { _comment: 'y', b: 2, a: 1, categories: { _comment: 'z', sol: ['pSOL'] } } };
  const b = { universe: { categories: { sol: ['pSOL'] }, a: 1, b: 2 }, version: 1 };
  assert.equal(policyDigest(a), policyDigest(b));
  assert.equal(policyDigest(a), canonicalSha256(stripComments(a)));
  assert.notEqual(policyDigest(a), policyDigest({ ...b, version: 2 }));
  assert.deepEqual(stripComments(a), b);
});

test('parseArgs: booleans never eat the next switch', () => {
  const { opts } = parseArgs(['--wait', '--wait-secs', '60', '--yes', '--portfolio', 'CLAWA1', '--policy=rehearsal'], { booleans: ['wait', 'yes'] });
  assert.deepEqual(opts, { wait: true, 'wait-secs': '60', yes: true, portfolio: 'CLAWA1', policy: 'rehearsal' });
});

// ---------------------------------------------------------------- the executable

test('bin: --help prints the three commands with their flags and exits 0', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const s of ['weavr-curator init --portfolio <ticker|mint>', '--transfer-wallet paybox|local|none', '--wait-secs N', 'weavr-curator doctor [--home <dir>] [--signer-url <url>] [--json]', 'weavr-curator ops <status|resume|unlock|request-review|rotate-curator|set-delay>', '--rebalance-delay-secs N', '--new-curator <pubkey>']) {
    assert.ok(r.stdout.includes(s), `help names ${s}`);
  }
  const bare = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(bare.status, 0);
  const unknown = spawnSync(process.execPath, [BIN, 'frobnicate'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
});

test('bin: init --json against the fake server and its /rpc route', async (t) => {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const home = tmpHome();
  writeKey(homePaths(home).keyFile, key);
  const w = await world({ curator: pk, balances: { [pk]: FLOOR } });
  t.after(() => w.server.close());
  const r = await runBin(['init', '--portfolio', 'CLAWA1', '--home', home, '--api', w.server.url, '--mcp', `${w.server.url}/mcp`, '--rpc', `${w.server.url}/rpc`, '--yes', '--json'], { SOLANA_RPC_URL: '' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.exit, 0);
  assert.equal(body.home, home);
  assert.equal(body.key, pk);
  assert.equal(body.guardian, guardian);
  assert.ok(Array.isArray(body.steps) && body.steps.every((s) => typeof s.name === 'string' && ['ok', 'cross', 'wait', 'info', 'skip'].includes(s.kind)));
  assert.deepEqual(body.steps.filter((s) => s.kind === 'ok').map((s) => s.name), ['portfolio', 'curator key', 'signer SOL', 'curation', 'chain facts', 'confirm', 'policy', 'tokens and env', 'agent home']);
  assert.ok(w.rpc.calls.some((c) => c.method === 'getBalance'), 'the bin wired its rpc to --rpc');
  assert.ok(!r.stdout.includes(readFileSync(homePaths(home).signerToken, 'utf8')));
  const unfunded = await runBin(['init', '--portfolio', 'CLAWA1', '--home', tmpHome(), '--api', w.server.url, '--rpc', `${w.server.url}/rpc`, '--yes']);
  assert.equal(unfunded.status, 3);
  assert.match(unfunded.stdout, /fix: fund .* with at least/);
  rmSync(join(home, '..'), { recursive: true, force: true });
});
