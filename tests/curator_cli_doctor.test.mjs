// weavr-curator doctor against fakes: one clean run, then a planted failing
// case for every check, each asserting that the cross line names the check
// and the exit is 1. The home comes from a real in-process init against the
// fake api, so what the doctor reads is what init writes. No network, no real
// key, no docker: the exec seam says docker is absent unless a test fakes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { init } from '../lib/curator/init.mjs';
import { COMPOSE_HOME_PATHS, COMPOSE_HOME_PATH_OF, PROFILE_JOB_IDS, doctor, parseMetrics } from '../lib/curator/doctor.mjs';
import { homePaths } from '../lib/curator/home.mjs';
import { factoryConfigAddress } from '../lib/curator/chain.mjs';
import { policyDigest } from '../lib/curator/policy-check.mjs';
import { readConfigModel, readPluginsEnabled } from '../lib/curator/render.mjs';
import { catalogue, portfolioRow } from './fixtures/curator/book.mjs';
import { fakeRpc, factoryConfigBytes } from './fixtures/curator/fake-rpc.mjs';
import { startFakeServer } from './fixtures/curator/fake-server.mjs';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'bin/weavr-curator.mjs');
const STANDARD = JSON.parse(readFileSync(join(ROOT, 'curator/policy/standard.json'), 'utf8'));
const FLOOR = Number(STANDARD.rate.minSignerLamports);
const CONFIG_PDA = factoryConfigAddress();
const PROVIDER_KEY = 'sk-provider-key-for-tests-never-printed';
const BOT_TOKEN = '123456:bot-token-for-tests-never-printed';
const NOW_SECS = 1_800_000_000;

const other = () => Keypair.generate().publicKey.toBase58();
const dockerAbsent = () => ({ status: null, stdout: '', stderr: '' });

/** A rendered home plus a healthy fake signer pinned to it. */
async function setup({ legs, preset } = {}) {
  const key = Keypair.generate();
  const pk = key.publicKey.toBase58();
  const guardian = other();
  const treasury = other();
  const mint = other();
  const home = join(mkdtempSync(join(tmpdir(), 'weavr-doctor-')), 'CLAWA1');
  const paths = homePaths(home);
  mkdirSync(paths.solanaDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.keyFile, JSON.stringify([...key.secretKey]), { mode: 0o600 });
  const row = portfolioRow({ mint, creator: other(), curator: pk, feeRecipient: treasury, rebalanceDelaySecs: 60, legs });
  const rpc = fakeRpc({ balances: { [pk]: FLOOR * 3 }, accounts: { [CONFIG_PDA]: factoryConfigBytes({ guardian, treasury }) } });
  const state = { portfolios: [row], pools: catalogue(), rpc, signer: null };
  const server = await startFakeServer(state);
  const r = await init({ portfolio: 'CLAWA1', home, api: server.url, mcp: `${server.url}/mcp`, yes: true, ...(preset ? { policy: preset } : {}) }, { env: {}, rpc, log: () => {} });
  assert.equal(r.exit, 0, r.steps.map((s) => `${s.name}: ${s.text}`).join('\n'));
  const env = readFileSync(paths.agentEnv, 'utf8')
    .replace(/^OPENAI_API_KEY=$/m, `OPENAI_API_KEY=${PROVIDER_KEY}`)
    .replace(/^TELEGRAM_BOT_TOKEN=$/m, `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`)
    .replace(/^TELEGRAM_ALLOWED_USERS=$/m, 'TELEGRAM_ALLOWED_USERS=12345,67890')
    .replace(/^TELEGRAM_HOME_CHANNEL=$/m, 'TELEGRAM_HOME_CHANNEL=-1001234');
  writeFileSync(paths.agentEnv, env, { mode: 0o600 });
  const agentToken = readFileSync(paths.signerToken, 'utf8');
  const opsToken = readFileSync(paths.opsToken, 'utf8');
  const policy = JSON.parse(readFileSync(paths.policyFile, 'utf8'));
  state.signer = {
    agentToken,
    opsToken,
    healthz: { ok: true, at: NOW_SECS, lastTickAgeSecs: 5, running: true },
    status: {
      ok: true,
      at: NOW_SECS,
      paused: false,
      selfLocked: null,
      operatorRequest: null,
      invariants: { ok: true, drift: [] },
      apply: { state: 'IDLE' },
      portfolio: { mint, symbol: 'CLAWA1', curator: pk, pendingCurator: null, rebalanceDelaySecs: 60 },
      signer: { wallet: pk, lamports: FLOOR * 3 },
      ledger: {},
      policy: { version: 1, sha256: policyDigest(policy), review: policy.review },
      lastTick: { at: NOW_SECS, ok: true, error: null },
    },
    metrics: { curator_last_tick_ts: NOW_SECS, curator_hermes_heartbeat_ts: NOW_SECS - 600, curator_paused: 0, curator_self_locked: 0, curator_signer_lamports: FLOOR * 3 },
    telegram: { ok: true, username: 'weavr_curator_bot' },
  };
  state.telegram = { ok: true, username: 'weavr_curator_bot' };
  state.provider = { status: 200 };
  return { key, pk, guardian, treasury, mint, home, paths, row, rpc, state, server, agentToken, opsToken, policy };
}

async function runDoctor(ctx, { json = false, exec = dockerAbsent, now = () => NOW_SECS * 1000 } = {}) {
  const lines = [];
  const r = await doctor({ home: ctx.home, signerUrl: ctx.server.url, json }, {
    rpc: ctx.rpc,
    log: (l) => lines.push(l),
    exec,
    now,
    telegramApi: ctx.server.url,
    providerBases: { 'openai-api': `${ctx.server.url}/provider` },
  });
  return { ...r, lines, text: lines.join('\n') };
}

const check = (r, name) => r.steps.find((s) => s.name === name);
const crossLine = (r, name) => r.lines.find((l) => l.startsWith(`  ✗ ${name}:`));

test('doctor: a clean home against a healthy fake signer is green, docker checks skipped when docker is absent', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  const r = await runDoctor(ctx);
  assert.equal(r.exit, 0, r.text);
  assert.equal(r.ok, true);
  const okNames = r.steps.filter((s) => s.kind === 'ok').map((s) => s.name);
  for (const name of ['home', 'key file', 'tokens', 'policy file', 'compose env', 'signer SOL', 'mint', 'curator', 'notice', 'policy vs book', 'treasury', 'guardian', 'signer health', 'signer status', 'signer paused', 'signer lock', 'signer invariants', 'signer policy', 'signer wallet', 'agent provider', 'agent env', 'agent jobs', 'agent plugin', 'telegram env', 'telegram bot', 'provider key', 'agent heartbeat']) {
    assert.ok(okNames.includes(name), `${name} is green: ${r.text}`);
  }
  assert.deepEqual(r.steps.filter((s) => s.kind === 'skip').map((s) => s.name), ['docker', 'signer image', 'agent image', 'containers']);
  assert.equal(r.steps.filter((s) => s.kind === 'cross').length, 0);
  assert.match(r.text, /✓ telegram bot: @weavr_curator_bot/);
  assert.match(r.text, /✓ curator: .* curates CLAWA1, no handover pending/);
  assert.match(r.text, /✓ tokens: .*the copies in curator\/signer\.env and hermes-home\/\.env match them/);
  assert.match(r.text, /✓ agent env: CLAWA1 and its 60s notice in hermes-home\/\.env, as onchain/);
  assert.match(r.text, /✓ provider key: openai-api answers HTTP 200/);
  assert.match(r.text, /✓ signer policy: sha256 [0-9a-f]{12} matches/);
  assert.match(r.text, /· docker: skipped, docker is not on PATH here/);
  // Nothing secret reached the output.
  const printed = r.text + JSON.stringify(r);
  for (const secret of [PROVIDER_KEY, BOT_TOKEN, ctx.agentToken, ctx.opsToken]) assert.ok(!printed.includes(secret), 'no secret in the doctor output');
  assert.ok(!printed.includes('/getMe'), 'the Telegram URL is never printed');
  // The requests carried the right things and nothing more.
  const status = ctx.server.hits.find((h) => h.path === '/status');
  assert.equal(status.headers.authorization, `Bearer ${ctx.agentToken}`);
  assert.equal(status.headers['x-curator-session'], 'chat');
  const me = ctx.server.hits.find((h) => /getMe$/.test(h.path));
  assert.equal(me.path, `/bot${BOT_TOKEN}/getMe`);
  const models = ctx.server.hits.find((h) => h.path === '/provider/models');
  assert.equal(models.headers.authorization, `Bearer ${PROVIDER_KEY}`);
});

test('doctor: with docker present it inspects both images and reads compose ps', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '--version') return { status: 0, stdout: 'Docker version 27.0.0\n', stderr: '' };
    if (args[0] === 'image') return { status: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'compose') return { status: 0, stdout: '{"Service":"signer","State":"running"}\n{"Service":"agent","State":"running"}\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const r = await runDoctor(ctx, { exec });
  assert.equal(r.exit, 0, r.text);
  assert.match(r.text, /✓ signer image: weavr-backend:curator-local/);
  assert.match(r.text, /✓ agent image: hermes-agent/);
  assert.match(r.text, /✓ containers: signer and agent running/);
  assert.ok(calls.some((c) => c[1] === 'image' && c[2] === 'inspect' && c[3] === 'weavr-backend:curator-local'));
  assert.ok(calls.some((c) => c[1] === 'compose' && c.includes('--env-file') && c.includes(ctx.paths.composeEnv) && c.includes('ps')));

  const stopped = (cmd, args) => (args[0] === 'compose' ? { status: 0, stdout: '{"Service":"signer","State":"running"}\n{"Service":"agent","State":"exited"}\n', stderr: '' } : exec(cmd, args));
  const r2 = await runDoctor(ctx, { exec: stopped });
  assert.equal(r2.exit, 1);
  assert.match(crossLine(r2, 'containers'), /agent not running/);
  const noImage = (cmd, args) => (args[0] === 'image' ? { status: 1, stdout: '', stderr: 'No such image' } : exec(cmd, args));
  const r3 = await runDoctor(ctx, { exec: noImage });
  assert.equal(r3.exit, 1);
  assert.match(crossLine(r3, 'signer image'), /weavr-backend:curator-local is not a local image/);
  assert.match(r3.text, /fix: build it from a checkout of the weavr backend/);
});

// ---------------------------------------------------------------- planted failures

const CASES = [
  {
    name: 'wrong mode on the key',
    check: 'key file',
    plant: (ctx) => chmodSync(ctx.paths.keyFile, 0o644),
    line: /is mode 644, readable by group or others/,
    fix: /chmod 600/,
  },
  {
    name: 'low SOL',
    check: 'signer SOL',
    plant: (ctx) => { ctx.rpc.table.balances[ctx.pk] = 1000; },
    line: /under the policy floor of 0\.02 SOL/,
    fix: /fund .* with at least/,
  },
  {
    name: 'curator not the key',
    check: 'curator',
    plant: (ctx) => { ctx.row.curator = other(); },
    line: /curates CLAWA1, not/,
    fix: /weavr-curator init --portfolio .* --wait/,
  },
  {
    name: 'handover pending',
    check: 'curator',
    plant: (ctx) => { ctx.row.pendingCurator = ctx.pk; ctx.row.curator = other(); },
    line: /handover pending/,
    fix: /weavr-curator init --portfolio/,
  },
  {
    // The signer self-locks on exactly this drift and refuses every write
    // while locked, set-delay included, so the fix cannot start with set-delay.
    name: 'notice mismatch',
    check: 'notice',
    plant: (ctx) => { ctx.row.rebalanceDelaySecs = 120; },
    line: /CLAWA1 announces 120s; policy\.invariants\.rebalanceDelaySecs is 60; the signer self-locks on this and, while locked, refuses every write, set-delay included$/,
    // The printed init carries the preset: init does not know which preset a
    // home runs unless told, and a bare re-run of a rehearsal home would
    // write standard over it while the book admits both.
    fix: /^\s+fix: weavr-curator init --portfolio \S+ --home \S+ --policy standard again \(it rewrites invariants\.rebalanceDelaySecs to the chain's 120s and keeps the standard preset\), restart the signer, then weavr-curator ops unlock --why "<reason>" --home \S+\. /,
    extra: (r, ctx) => {
      const { fix } = check(r, 'notice');
      assert.ok(fix.includes(`--portfolio ${ctx.mint} --home ${ctx.home} --policy standard again`), fix);
      assert.match(check(r, 'policy file').text, /\(version 1, the standard preset\)$/);
      assert.ok(fix.indexOf('ops unlock') < fix.indexOf('ops set-delay'), 'set-delay is never the first thing to run on a locked signer');
      assert.match(fix, /ops set-delay --rebalance-delay-secs 60 --why "<reason>" --home \S+ from an unlocked signer whose policy file already carries 60s \(it locks on its next tick\), then restart it and unlock$/);
      assert.doesNotMatch(fix, /once the signer curates/);
    },
  },
  {
    name: 'notice mismatch on a rehearsal home',
    check: 'notice',
    setup: { preset: 'rehearsal' },
    plant: (ctx) => { ctx.row.rebalanceDelaySecs = 120; },
    line: /CLAWA1 announces 120s; policy\.invariants\.rebalanceDelaySecs is 60; the signer self-locks/,
    fix: /^\s+fix: weavr-curator init --portfolio \S+ --home \S+ --policy rehearsal again \(it rewrites invariants\.rebalanceDelaySecs to the chain's 120s and keeps the rehearsal preset\), restart the signer, then weavr-curator ops unlock/,
    extra: (r, ctx) => {
      const { fix } = check(r, 'notice');
      assert.ok(fix.includes(`--portfolio ${ctx.mint} --home ${ctx.home} --policy rehearsal again`), fix);
      assert.doesNotMatch(fix, /--policy standard/);
      assert.match(check(r, 'policy file').text, /\(version 1, the rehearsal preset\)$/);
    },
  },
  {
    // A file that matches no shipped preset holds the owner's edits; init
    // writes a preset over it, so the remedy is the one number, by hand.
    name: 'notice mismatch on a policy.json edited by hand',
    check: 'notice',
    plant: (ctx) => {
      ctx.row.rebalanceDelaySecs = 120;
      const p = JSON.parse(readFileSync(ctx.paths.policyFile, 'utf8'));
      p.turnover.maxTurnoverBps = 1234;
      writeFileSync(ctx.paths.policyFile, `${JSON.stringify(p, null, 2)}\n`);
    },
    line: /CLAWA1 announces 120s; policy\.invariants\.rebalanceDelaySecs is 60; the signer self-locks/,
    fix: /^\s+fix: set invariants\.rebalanceDelaySecs to 120 in \S+policy\.json by hand \(the file matches no shipped preset, so init would write a preset over your edits\), restart the signer, then weavr-curator ops unlock --why "<reason>" --home \S+\. To move the notice onchain to 60s instead/,
    extra: (r, ctx) => {
      const { fix } = check(r, 'notice');
      assert.ok(fix.includes(`in ${ctx.paths.policyFile} by hand`), fix);
      assert.doesNotMatch(fix, /init --portfolio/);
      assert.ok(fix.indexOf('ops unlock') < fix.indexOf('ops set-delay'));
      assert.match(check(r, 'policy file').text, /\(version 1, matches no shipped preset: edited by hand\)$/);
    },
  },
  {
    name: 'policy refuses the book',
    check: 'policy vs book',
    plant: (ctx) => { ctx.row.targets = [{ poolId: 'pSOL@solana', weightBps: 6000 }, { poolId: 'pCBBTC@solana', weightBps: 4000 }]; ctx.row.holdings.legs = ctx.row.holdings.legs.slice(0, 2); },
    line: /the policy refuses CLAWA1 as it stands/,
    fix: /add legs until the book holds at least 3/,
    extra: (r) => {
      assert.ok(r.lines.includes('      MIN_LEGS: the policy needs at least 3 legs; the book holds 2 (no shipped preset admits a 2-leg book)'), r.text);
      assert.ok(check(r, 'policy vs book').items.some((i) => i.code === 'LEG_WEIGHT_CAP'));
    },
  },
  {
    name: 'guardian mismatch',
    check: 'guardian',
    plant: (ctx) => { ctx.rpc.table.accounts[CONFIG_PDA] = factoryConfigBytes({ guardian: other(), treasury: ctx.treasury }); },
    line: /compose\.env CURATOR_EXPECTED_GUARDIAN is .*; the factory says/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'FactoryConfig discriminator mismatch',
    check: 'guardian',
    plant: (ctx) => { ctx.rpc.table.accounts[CONFIG_PDA] = factoryConfigBytes({ guardian: ctx.guardian, treasury: ctx.treasury, discriminator: [9, 9, 9, 9, 9, 9, 9, 9] }); },
    line: /discriminator \[9,9,9,9,9,9,9,9\] is not FactoryConfig's/,
    fix: /not guessing/,
  },
  {
    name: 'treasury mismatch',
    check: 'treasury',
    plant: (ctx) => { ctx.row.feeRecipient = other(); },
    line: /the fee recipient onchain is/,
    fix: /run weavr-curator init again/,
  },
  {
    name: '/status 401',
    check: 'signer status',
    plant: (ctx) => { ctx.state.signer.agentToken = 'f'.repeat(64); },
    line: /token mismatch/,
    fix: /restart the signer with/,
  },
  {
    name: '/status 404',
    check: 'signer status',
    plant: (ctx) => { ctx.state.signer.noStatus = true; },
    line: /no signer at http:\/\/127\.0\.0\.1:\d+ \(404 on \/status\)/,
    fix: /--signer-url/,
  },
  {
    name: 'no signer at all',
    check: 'signer health',
    plant: (ctx) => { ctx.state.signer.absent = true; },
    line: /no signer at .* \(404 on \/healthz\)/,
    fix: /--signer-url/,
  },
  {
    name: 'signer loop stalled',
    check: 'signer health',
    plant: (ctx) => { ctx.state.signer.healthz.lastTickAgeSecs = 500; },
    line: /last tick 500s ago, over three ticks \(90s\)/,
    fix: /docker compose logs signer/,
  },
  {
    name: 'paused',
    check: 'signer paused',
    plant: (ctx) => { ctx.state.signer.status.paused = true; },
    line: /the signer is paused/,
    fix: /weavr-curator ops resume --home/,
  },
  {
    name: 'selfLocked with the drift printed',
    check: 'signer lock',
    plant: (ctx) => {
      ctx.state.signer.status.selfLocked = { at: NOW_SECS - 100, reason: 'INVARIANT_DRIFT' };
      ctx.state.signer.status.invariants = { ok: false, drift: [{ invariant: 'curator', expected: ctx.pk, actual: 'SomeoneE1se' }, { invariant: 'rebalanceDelaySecs', expected: 60, actual: 120 }] };
    },
    line: /self-locked: INVARIANT_DRIFT/,
    fix: /weavr-curator ops unlock --why/,
    extra: (r, ctx) => {
      assert.ok(r.lines.includes(`      curator: expected ${ctx.pk}, actual SomeoneE1se`), r.text);
      assert.ok(r.lines.includes('      rebalanceDelaySecs: expected 60, actual 120'));
      assert.equal(check(r, 'signer invariants').ok, false);
    },
  },
  {
    name: 'policy sha256 mismatch',
    check: 'signer policy',
    plant: (ctx) => { ctx.state.signer.status.policy.sha256 = 'deadbeef'.repeat(8); },
    line: /the running signer loaded another document \(sha256 deadbeefdead, local [0-9a-f]{12}\)/,
    fix: /restart signer/,
  },
  {
    name: 'wallet mismatch',
    check: 'signer wallet',
    plant: (ctx) => { ctx.state.signer.status.signer.wallet = other(); },
    line: /the signer holds .*, not/,
    fix: /CURATOR_KEY_FILE/,
  },
  {
    name: 'provider variable empty',
    check: 'agent provider',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^OPENAI_API_KEY=.*$/m, 'OPENAI_API_KEY=')),
    line: /model\.provider "openai-api" reads OPENAI_API_KEY, which is empty/,
    fix: /set OPENAI_API_KEY in/,
    extra: (r) => assert.equal(check(r, 'provider key').kind, 'skip'),
  },
  {
    name: 'jobs.json provider differs from config.yaml',
    check: 'agent jobs',
    plant: (ctx) => {
      const doc = JSON.parse(readFileSync(ctx.paths.jobsJson, 'utf8'));
      doc.jobs.find((j) => j.id === 'curator-review').provider = 'anthropic';
      writeFileSync(ctx.paths.jobsJson, JSON.stringify(doc, null, 2));
    },
    line: /curator-review pins anthropic \/ gpt-5\.4; config\.yaml runs openai-api \/ gpt-5\.4/,
    fix: /set provider and model on those jobs/,
  },
  {
    name: 'jobs.json with an empty jobs list',
    check: 'agent jobs',
    plant: (ctx) => writeFileSync(ctx.paths.jobsJson, '{"jobs":[],"updated_at":"x"}\n'),
    line: /jobs\.json lacks curator-review, curator-universe, curator-weekly, curator-health \(the profile ships curator-review, curator-universe, curator-weekly, curator-health; a job that is not there never runs/,
    fix: /run weavr-curator init again; it merges the profile's jobs into the file/,
  },
  {
    name: 'jobs.json as a plain empty array',
    check: 'agent jobs',
    plant: (ctx) => writeFileSync(ctx.paths.jobsJson, '[]\n'),
    line: /lacks curator-review, curator-universe, curator-weekly, curator-health/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'jobs.json as a plain array holding only the agent jobs',
    check: 'agent jobs',
    plant: (ctx) => writeFileSync(ctx.paths.jobsJson, JSON.stringify(JSON.parse(readFileSync(ctx.paths.jobsJson, 'utf8')).jobs.filter((j) => j.id !== 'curator-health'))),
    line: /lacks curator-health \(/,
    fix: /run weavr-curator init again/,
    extra: (r) => assert.ok(!crossLine(r, 'agent jobs').includes('lacks curator-review'), 'only the missing id is named'),
  },
  {
    name: 'jobs.json without the review job',
    check: 'agent jobs',
    plant: (ctx) => {
      const doc = JSON.parse(readFileSync(ctx.paths.jobsJson, 'utf8'));
      doc.jobs = doc.jobs.filter((j) => j.id !== 'curator-review');
      writeFileSync(ctx.paths.jobsJson, JSON.stringify(doc, null, 2));
    },
    line: /lacks curator-review \(/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'jobs.json holds an object without a jobs array',
    check: 'agent jobs',
    plant: (ctx) => writeFileSync(ctx.paths.jobsJson, '{"updated_at":"x"}\n'),
    line: /holds no jobs array/,
    fix: /run weavr-curator init again/,
  },
  {
    name: '/metrics without curator gauges',
    check: 'agent heartbeat',
    plant: (ctx) => { ctx.state.signer.metrics = '# HELP process_cpu_seconds_total Total user and system CPU time.\n# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total 1.5\n'; },
    line: /\/metrics answered but carries no curator gauges: not this signer, or an older image$/,
    fix: /pass --signer-url for the curator signer, or rebuild the signer image/,
  },
  {
    name: '/metrics with curator gauges but no last tick',
    check: 'agent heartbeat',
    plant: (ctx) => { ctx.state.signer.metrics = { curator_paused: 0, curator_self_locked: 0 }; },
    line: /\/metrics answered but carries no curator_last_tick_ts gauge \(2 other curator gauges\): an older signer image/,
    fix: /rebuild the signer image/,
  },
  {
    name: 'compose.env lacks HERMES_UID',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_UID=.*$/m, '')),
    line: /compose\.env lacks HERMES_UID$/,
    fix: /run weavr-curator init again with --home .*; it re-derives the chain facts and writes every variable curator\.yml references/,
  },
  {
    name: 'compose.env with an empty CURATOR_SIGNER_IMAGE and CURATOR_TICK_MS',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_SIGNER_IMAGE=.*$/m, 'CURATOR_SIGNER_IMAGE=').replace(/^CURATOR_TICK_MS=.*$/m, 'CURATOR_TICK_MS=  ')),
    line: /compose\.env lacks CURATOR_SIGNER_IMAGE, CURATOR_TICK_MS$/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'compose.env CURATOR_KEY_FILE outside the home',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_KEY_FILE=.*$/m, 'CURATOR_KEY_FILE=/somewhere/else/curator.json')),
    line: /compose\.env CURATOR_KEY_FILE is \/somewhere\/else\/curator\.json, outside \S+: the container would mount a different directory than the one the doctor inspected$/,
    fix: /run weavr-curator init again with --home/,
    extra: (r) => assert.equal(check(r, 'key file').kind, 'ok', 'the key the doctor inspected is still the one under the home'),
  },
  {
    name: 'compose.env CURATOR_POLICY_FILE and CURATOR_SIGNER_ENV outside the home',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_POLICY_FILE=.*$/m, 'CURATOR_POLICY_FILE=/etc/weavr/policy.json').replace(/^CURATOR_SIGNER_ENV=.*$/m, 'CURATOR_SIGNER_ENV=/etc/weavr/signer.env')),
    line: /CURATOR_POLICY_FILE is \/etc\/weavr\/policy\.json, outside .*; CURATOR_SIGNER_ENV is \/etc\/weavr\/signer\.env, outside/,
    fix: /run weavr-curator init again with --home/,
  },
  {
    name: 'compose.env HERMES_HOME as a relative path',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, 'HERMES_HOME=hermes-home')),
    line: /HERMES_HOME is hermes-home, not an absolute path under \S+: the container would mount a different directory/,
    fix: /run weavr-curator init again with --home/,
  },
  {
    name: 'compose.env HERMES_HOME as a sibling whose name starts with the home',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.home}-other/hermes-home`)),
    line: /HERMES_HOME is \S+-other\/hermes-home, outside/,
    fix: /run weavr-curator init again with --home/,
  },
  {
    name: 'compose.env HERMES_HOME escaping the home through a parent segment',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.home}/../elsewhere`)),
    line: /HERMES_HOME is \S+\/\.\.\/elsewhere, outside/,
    fix: /run weavr-curator init again with --home/,
  },
  {
    // Under the home is not enough: the container would mount the key, both
    // tokens and signer.env into the agent at /opt/data, and every agent
    // check above read <home>/hermes-home.
    name: 'compose.env HERMES_HOME as the home itself',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.home}`)),
    line: /HERMES_HOME is \S+, not \S+\/hermes-home: the container would mount a different directory than the one the doctor inspected$/,
    fix: /run weavr-curator init again with --home/,
    extra: (r, ctx) => assert.ok(check(r, 'compose env').text.includes(`HERMES_HOME is ${ctx.home}, not ${ctx.paths.hermesHome}:`), check(r, 'compose env').text),
  },
  {
    name: 'compose.env HERMES_HOME as the home itself with a trailing slash',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.home}/`)),
    line: /HERMES_HOME is \S+\/, not \S+\/hermes-home: the container would mount a different directory/,
    fix: /run weavr-curator init again with --home/,
  },
  {
    name: 'compose.env HERMES_HOME as another directory under the home',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.home}/hermes-home-old`)),
    line: /HERMES_HOME is \S+\/hermes-home-old, not \S+\/hermes-home: the container would mount a different directory/,
    fix: /run weavr-curator init again with --home/,
    extra: (r) => assert.equal(check(r, 'agent jobs').kind, 'ok', 'the agent checks read the rendered home, not the one the container would mount'),
  },
  {
    name: 'compose.env CURATOR_KEY_FILE as another file under the home',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_KEY_FILE=.*$/m, `CURATOR_KEY_FILE=${ctx.paths.opsToken}`)),
    line: /CURATOR_KEY_FILE is \S+\/curator\/ops-token, not \S+\/solana\/curator\.json: the container would mount a different directory than the one the doctor inspected$/,
    fix: /run weavr-curator init again with --home/,
    extra: (r) => assert.equal(check(r, 'key file').kind, 'ok', 'the key file check read the file under solana/, not the one the container would mount'),
  },
  {
    name: 'compose.env CURATOR_POLICY_FILE and CURATOR_SIGNER_ENV as siblings under the home that do not exist',
    check: 'compose env',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_POLICY_FILE=.*$/m, `CURATOR_POLICY_FILE=${ctx.home}/curator/policy-old.json`).replace(/^CURATOR_SIGNER_ENV=.*$/m, `CURATOR_SIGNER_ENV=${ctx.home}/curator/signer.env.bak`)),
    line: /CURATOR_POLICY_FILE is \S+\/curator\/policy-old\.json, not \S+\/curator\/policy\.json: [^;]*; CURATOR_SIGNER_ENV is \S+\/curator\/signer\.env\.bak, not \S+\/curator\/signer\.env: the container would mount a different directory/,
    fix: /run weavr-curator init again with --home/,
    extra: (r) => { assert.equal(check(r, 'policy file').kind, 'ok'); assert.equal(check(r, 'signer policy').kind, 'ok', 'the running signer matches the file the doctor read, which is not the file the container would mount'); },
  },
  {
    name: 'plugin missing',
    check: 'agent plugin',
    plant: (ctx) => rmSync(ctx.paths.pluginDir, { recursive: true, force: true }),
    line: /plugins\/weavr-curator is missing/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'plugin not enabled',
    check: 'agent plugin',
    plant: (ctx) => writeFileSync(ctx.paths.configYaml, readFileSync(ctx.paths.configYaml, 'utf8').replace(/enabled: \[weavr-curator\]/, 'enabled: []')),
    line: /plugins\.enabled does not list weavr-curator/,
    fix: /add weavr-curator to plugins\.enabled/,
  },
  {
    name: 'empty allow-list',
    check: 'telegram env',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=')),
    line: /TELEGRAM_ALLOWED_USERS is empty \(an empty allow-list is fail-open\)/,
    fix: /set them in/,
  },
  {
    name: 'allow-list not numeric',
    check: 'telegram env',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^TELEGRAM_ALLOWED_USERS=.*$/m, 'TELEGRAM_ALLOWED_USERS=@alice')),
    line: /not a comma-separated list of numeric ids/,
    fix: /set them in/,
  },
  {
    name: 'getMe not ok',
    check: 'telegram bot',
    plant: (ctx) => { ctx.state.telegram = { ok: false }; },
    line: /getMe answered 401: Unauthorized/,
    fix: /TELEGRAM_BOT_TOKEN .* against BotFather/,
  },
  {
    name: 'provider key 401',
    check: 'provider key',
    plant: (ctx) => { ctx.state.provider = { status: 401 }; },
    line: /openai-api answers HTTP 401/,
    fix: /check OPENAI_API_KEY in/,
  },
  {
    name: 'stale heartbeat',
    check: 'agent heartbeat',
    plant: (ctx) => { ctx.state.signer.metrics.curator_hermes_heartbeat_ts = NOW_SECS - 2 * 3600; },
    line: /curator-health has not ticked: the gateway is not running the cron \(last heartbeat 120 min before/,
    fix: /docker compose logs agent/,
  },
  {
    name: 'no heartbeat ever',
    check: 'agent heartbeat',
    plant: (ctx) => { ctx.state.signer.metrics.curator_hermes_heartbeat_ts = 0; },
    line: /curator-health has not ticked: the gateway is not running the cron \(no heartbeat yet/,
    fix: /docker compose logs agent/,
  },
  {
    name: 'token file too open',
    check: 'tokens',
    plant: (ctx) => chmodSync(ctx.paths.signerToken, 0o644),
    line: /signer-token must be mode 0600 \(is 644\)/,
    fix: /chmod 600/,
    extra: (r) => assert.equal(check(r, 'signer status').kind, 'skip', 'the doctor never sends a token it refused to read'),
  },
  {
    name: 'a handover away from the signer key is pending',
    check: 'curator',
    plant: (ctx) => { ctx.row.pendingCurator = other(); },
    line: /a handover away from .* is pending: .* is the pending curator of CLAWA1/,
    fix: /cancel it with the key, POST \/v1\/portfolios\/.*\/curator\/cancel \{ signer: ".*" \}.*then rotate the key/,
    extra: (r, ctx) => {
      const line = crossLine(r, 'curator');
      assert.ok(line.includes(ctx.row.pendingCurator), 'names who is pending');
      assert.ok(line.includes(ctx.pk), 'names the key');
    },
  },
  {
    name: '/healthz not ok (503)',
    check: 'signer health',
    plant: (ctx) => { ctx.state.signer.healthz = { ok: false, at: NOW_SECS, lastTickAgeSecs: null, running: true }; },
    line: /\/healthz 503: not ok/,
    fix: /docker compose logs signer; a boot refusal names its reason on one line/,
    extra: (r) => assert.equal(check(r, 'signer status').kind, 'skip', 'nothing else is asked of a signer that is not up'),
  },
  {
    name: '/status ok:false with the error set',
    check: 'signer status',
    plant: (ctx) => { ctx.state.signer.status.ok = false; ctx.state.signer.status.error = 'snapshot read failed: api timeout'; },
    line: /the signer answers ok:false: snapshot read failed: api timeout \(its snapshot read failed; the fields below are its last good snapshot\)/,
    fix: /docker compose logs signer; the tick names what it could not read/,
  },
  {
    name: 'equal tokens',
    check: 'tokens',
    plant: (ctx) => { const same = randomBytes(32).toString('hex'); writeFileSync(ctx.paths.signerToken, same, { mode: 0o600 }); writeFileSync(ctx.paths.opsToken, same, { mode: 0o600 }); },
    line: /the agent token and the ops token are equal; the signer refuses to boot/,
    fix: /move .*ops-token away and run init again/,
  },
  {
    name: 'hermes-home/.env carries another agent token',
    check: 'tokens',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^CURATOR_SIGNER_TOKEN=.*$/m, `CURATOR_SIGNER_TOKEN=${randomBytes(32).toString('hex')}`)),
    line: /^  ✗ tokens: CURATOR_SIGNER_TOKEN in .*hermes-home\/\.env is not the value in .*curator\/signer-token$/,
    fix: /the token file is what init writes both env files from/,
    extra: (r, ctx) => {
      assert.ok(!crossLine(r, 'tokens').includes('signer.env'), 'the copy that agrees is not named');
      assert.equal(check(r, 'signer status').kind, 'ok', 'the token file itself still opens the signer');
      assert.ok(!r.text.includes(ctx.agentToken));
    },
  },
  {
    name: 'curator/signer.env carries another ops token',
    check: 'tokens',
    plant: (ctx) => writeFileSync(ctx.paths.signerEnv, readFileSync(ctx.paths.signerEnv, 'utf8').replace(/^CURATOR_OPS_TOKEN=.*$/m, `CURATOR_OPS_TOKEN=${randomBytes(32).toString('hex')}`), { mode: 0o600 }),
    line: /^  ✗ tokens: CURATOR_OPS_TOKEN in .*curator\/signer\.env is not the value in .*curator\/ops-token$/,
    fix: /the token file is what init writes both env files from/,
  },
  {
    name: 'curator/signer.env lost its agent token line',
    check: 'tokens',
    plant: (ctx) => writeFileSync(ctx.paths.signerEnv, readFileSync(ctx.paths.signerEnv, 'utf8').replace(/^CURATOR_SIGNER_TOKEN=.*$/m, ''), { mode: 0o600 }),
    line: /CURATOR_SIGNER_TOKEN is empty in .*curator\/signer\.env/,
    fix: /the token file is what init writes both env files from/,
  },
  {
    name: 'hermes-home/.env notice stale after a set-delay',
    check: 'agent env',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^CURATOR_REBALANCE_DELAY_SECS=.*$/m, 'CURATOR_REBALANCE_DELAY_SECS=86400')),
    line: /CURATOR_REBALANCE_DELAY_SECS is 86400; CLAWA1 announces 60s \(the approval text the agent shows reads these\)/,
    fix: /run weavr-curator init again; it rewrites them from chain/,
    extra: (r) => assert.equal(check(r, 'notice').kind, 'ok', 'the policy notice is a separate check and still holds'),
  },
  {
    name: 'hermes-home/.env symbol is another portfolio',
    check: 'agent env',
    plant: (ctx) => writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^CURATOR_PORTFOLIO_SYMBOL=.*$/m, 'CURATOR_PORTFOLIO_SYMBOL=OTHER')),
    line: /CURATOR_PORTFOLIO_SYMBOL is OTHER; the row says CLAWA1/,
    fix: /run weavr-curator init again/,
  },
  {
    name: 'mint drift between compose.env and the api',
    check: 'mint',
    plant: (ctx) => writeFileSync(ctx.paths.composeEnv, readFileSync(ctx.paths.composeEnv, 'utf8').replace(/^CURATOR_PORTFOLIO_MINT=.*$/m, 'CURATOR_PORTFOLIO_MINT=CLAWA1')),
    line: /compose\.env names CLAWA1 but the api answered/,
    fix: /run weavr-curator init again/,
  },
];

for (const c of CASES) {
  test(`doctor: ${c.name} is a cross on "${c.check}" and exit 1`, async (t) => {
    const ctx = await setup(c.setup ?? {});
    t.after(() => ctx.server.close());
    await c.plant(ctx);
    const r = await runDoctor(ctx);
    assert.equal(r.exit, 1, r.text);
    assert.equal(r.ok, false);
    const step = check(r, c.check);
    assert.ok(step, `${c.check} reported: ${r.text}`);
    assert.equal(step.kind, 'cross', `${c.check} is a cross: ${r.text}`);
    const line = crossLine(r, c.check);
    assert.ok(line, `a cross line names ${c.check}: ${r.text}`);
    assert.match(line, c.line);
    const idx = r.lines.indexOf(line);
    const fix = r.lines.slice(idx + 1, idx + 12).find((l) => /^\s+fix: /.test(l));
    assert.ok(fix, `${c.check} carries a fix: ${r.text}`);
    assert.match(fix, c.fix);
    if (c.extra) c.extra(r, ctx);
    const printed = r.text + JSON.stringify(r);
    for (const secret of [PROVIDER_KEY, BOT_TOKEN, ctx.agentToken, ctx.opsToken]) assert.ok(!printed.includes(secret));
  });
}


test('doctor: after the README rotation (new token in both env files, signer restarted, token file untouched) the tokens cross names both copies and the 401 fix names all three', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  const rotated = randomBytes(32).toString('hex');
  const setToken = (file) => writeFileSync(file, readFileSync(file, 'utf8').replace(/^CURATOR_SIGNER_TOKEN=.*$/m, `CURATOR_SIGNER_TOKEN=${rotated}`), { mode: 0o600 });
  setToken(ctx.paths.signerEnv);
  setToken(ctx.paths.agentEnv);
  ctx.state.signer.agentToken = rotated;
  const r = await runDoctor(ctx);
  assert.equal(r.exit, 1, r.text);
  const tokens = crossLine(r, 'tokens');
  assert.ok(tokens.includes(`CURATOR_SIGNER_TOKEN in ${ctx.paths.signerEnv} is not the value in ${ctx.paths.signerToken}`), tokens);
  assert.ok(tokens.includes(`CURATOR_SIGNER_TOKEN in ${ctx.paths.agentEnv} is not the value in ${ctx.paths.signerToken}`), tokens);
  const status = check(r, 'signer status');
  assert.equal(status.kind, 'cross');
  assert.match(status.text, /token mismatch/);
  assert.ok(status.fix.includes(ctx.paths.signerToken) && status.fix.includes(ctx.paths.signerEnv) && status.fix.includes(ctx.paths.agentEnv), status.fix);
  assert.match(status.fix, /must be one value/);
  const printed = r.text + JSON.stringify(r);
  assert.ok(!printed.includes(rotated) && !printed.includes(ctx.agentToken), 'no token value printed');
});

test('doctor: the job ids it requires are the ones the profile ships, the path variables are the four the compose file mounts, and a last tick of 0 is a skip, not a cross', async (t) => {
  const shipped = JSON.parse(readFileSync(join(ROOT, 'curator/profile/cron/jobs.json'), 'utf8')).jobs.map((j) => j.id);
  assert.deepEqual([...PROFILE_JOB_IDS].sort(), [...shipped].sort());
  assert.deepEqual([...COMPOSE_HOME_PATHS], ['CURATOR_KEY_FILE', 'CURATOR_POLICY_FILE', 'CURATOR_SIGNER_ENV', 'HERMES_HOME']);
  // Each path variable is compared with the file or directory the doctor's own checks read, never just with the home.
  assert.deepEqual(COMPOSE_HOME_PATH_OF, { CURATOR_KEY_FILE: 'keyFile', CURATOR_POLICY_FILE: 'policyFile', CURATOR_SIGNER_ENV: 'signerEnv', HERMES_HOME: 'hermesHome' });
  const yml = readFileSync(join(ROOT, 'curator/compose/curator.yml'), 'utf8');
  for (const name of COMPOSE_HOME_PATHS) assert.ok(yml.includes(`\${${name}`), `${name} is a compose variable`);

  const ctx = await setup();
  t.after(() => ctx.server.close());
  const clean = await runDoctor(ctx);
  assert.equal(clean.exit, 0, clean.text);
  assert.match(clean.text, /✓ agent jobs: curator-review, curator-universe, curator-weekly, curator-health present; 3 agent jobs pin openai-api \/ gpt-5\.4 like config\.yaml/);
  assert.match(clean.text, /✓ compose env: .*compose\.env: mint \S+, every variable curator\.yml references set, the path variables the files and the agent home the doctor inspected/);
  assert.match(clean.text, /✓ policy file: \S+policy\.json \(version 1, the standard preset\)/);
  assert.equal(check(clean, 'policy file').preset, 'standard');
  for (const [name, expected] of Object.entries(COMPOSE_HOME_PATH_OF)) assert.equal(readFileSync(ctx.paths.composeEnv, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))[1], ctx.paths[expected], `init writes ${name} as the path the doctor inspects`);

  // Another spelling of the same path is the same mount: a trailing slash, a `..` that comes back.
  const composeText = readFileSync(ctx.paths.composeEnv, 'utf8');
  writeFileSync(ctx.paths.composeEnv, composeText.replace(/^HERMES_HOME=.*$/m, `HERMES_HOME=${ctx.paths.hermesHome}/`).replace(/^CURATOR_KEY_FILE=.*$/m, `CURATOR_KEY_FILE=${ctx.home}/solana/../solana/curator.json`));
  const spelled = await runDoctor(ctx);
  assert.equal(check(spelled, 'compose env').kind, 'ok', spelled.text);
  writeFileSync(ctx.paths.composeEnv, composeText);

  // The gauge is there and reads 0: a signer that has not ticked, which is a skip, unlike a body with no gauge.
  ctx.state.signer.healthz.lastTickAgeSecs = null;
  ctx.state.signer.metrics = { curator_last_tick_ts: 0, curator_hermes_heartbeat_ts: 0, curator_paused: 0 };
  const r = await runDoctor(ctx);
  assert.equal(check(r, 'agent heartbeat').kind, 'skip', r.text);
  assert.match(r.text, /· agent heartbeat: skipped, the signer has not ticked yet/);
  assert.equal(check(r, 'signer health').kind, 'ok');
});

test('doctor: a missing home is one cross and nothing else runs', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  const r = await doctor({ home: join(ctx.home, 'nope'), signerUrl: ctx.server.url }, { rpc: ctx.rpc, log: () => {}, exec: dockerAbsent });
  assert.equal(r.exit, 1);
  assert.deepEqual(r.steps.map((s) => [s.kind, s.name]), [['cross', 'home']]);
});

test('doctor: --json is one object with ok, exit, home and the steps, and prints nothing else', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  ctx.state.signer.status.paused = true;
  const r = await runDoctor(ctx, { json: true });
  assert.equal(r.lines.length, 0, 'json mode prints through the caller, not the log');
  const { lines, text, ...body } = r;
  assert.deepEqual(Object.keys(body), ['exit', 'ok', 'home', 'steps']);
  assert.equal(body.exit, 1);
  assert.equal(body.ok, false);
  assert.equal(body.home, ctx.home);
  for (const s of body.steps) {
    assert.ok(['ok', 'cross', 'skip', 'info'].includes(s.kind), s.kind);
    assert.equal(typeof s.name, 'string');
    assert.equal(typeof s.text, 'string');
    assert.ok('ok' in s);
  }
  const paused = body.steps.find((s) => s.name === 'signer paused');
  assert.equal(paused.kind, 'cross');
  assert.match(paused.fix, /weavr-curator ops resume/);
  assert.ok(!JSON.stringify(body).includes(ctx.agentToken));
});

test('doctor: the config.yaml readers see what the profile ships', () => {
  const yaml = readFileSync(join(ROOT, 'curator/profile/config.yaml'), 'utf8');
  assert.deepEqual(readConfigModel(yaml), { provider: 'openai-api', model: 'gpt-5.4' });
  assert.deepEqual(readPluginsEnabled(yaml), ['weavr-curator']);
  assert.deepEqual(readConfigModel('model:\n  default: "x"  # c\n  provider: anthropic # c\nagent:\n  provider: nope\n'), { provider: 'anthropic', model: 'x' });
  assert.deepEqual(readPluginsEnabled('plugins:\n  enabled:\n    - a\n    - "b"\nx: 1\n'), ['a', 'b']);
  assert.deepEqual(parseMetrics('# HELP a\ncurator_last_tick_ts 12\ncurator_apply_state{state="IDLE"} 1\ncurator_hermes_heartbeat_ts 0\n'), { curator_last_tick_ts: 12, curator_apply_state: 1, curator_hermes_heartbeat_ts: 0 });
});

test('bin: doctor --json on an unfilled home exits 1 without touching the network', async (t) => {
  const ctx = await setup();
  t.after(() => ctx.server.close());
  // Blank the owner's lines again: the bot and provider checks then skip, so nothing leaves the host.
  writeFileSync(ctx.paths.agentEnv, readFileSync(ctx.paths.agentEnv, 'utf8').replace(/^OPENAI_API_KEY=.*$/m, 'OPENAI_API_KEY=').replace(/^TELEGRAM_BOT_TOKEN=.*$/m, 'TELEGRAM_BOT_TOKEN='));
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, 'doctor', '--home', ctx.home, '--signer-url', ctx.server.url, '--rpc', `${ctx.server.url}/rpc`, '--json'], { env: { ...process.env, PATH: '/nonexistent' } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(r.status, 1, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.exit, 1);
  assert.equal(body.steps.find((s) => s.name === 'agent provider').kind, 'cross');
  assert.equal(body.steps.find((s) => s.name === 'telegram bot').kind, 'skip');
  assert.equal(body.steps.find((s) => s.name === 'provider key').kind, 'skip');
  assert.equal(body.steps.find((s) => s.name === 'docker').kind, 'skip');
  assert.equal(body.steps.find((s) => s.name === 'signer wallet').kind, 'ok', 'the bin wired the signer url and the rpc');
});
