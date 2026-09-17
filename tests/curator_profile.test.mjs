// The curator profile (curator/profile) is owner-owned text the agent cannot
// edit, so its shape is what keeps the curator inside its box: no terminal,
// only the read MCP tools, cron denied, the four seeded jobs, and cron scripts
// that relay the signer's wake gate without ever putting the bearer token in
// argv. Each assertion here fails on a planted deviation; the scripts run
// against a fake signer on 127.0.0.1: no network, no key, no Hermes import.
// Ported from the ops repo's tests/unit/integrations/curator_profile.test.mjs
// with the WEAVR-specific pins replaced by the generalised text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(ROOT, 'curator/profile');
const SCRIPTS = join(PROFILE, 'scripts');
const SKILL = join(PROFILE, 'skills/weavr-curator');
const read = (rel) => readFileSync(join(PROFILE, rel), 'utf8');
const TOKEN = 'curator-agent-token-for-tests-0123456789abcdef';
const READ_TOOLS = [
  'list_assets', 'get_asset', 'get_asset_history', 'suggest_mix', 'simulate_portfolio', 'simulate_rebalance',
  'list_portfolios', 'get_portfolio', 'get_portfolio_history', 'list_withdrawals', 'get_withdrawal',
];
const WRITE_TOOLS = ['create_portfolio', 'await_portfolio', 'send_signed', 'build_propose_targets', 'build_deposit', 'build_withdraw', 'portfolio_status'];
const JOB_IDS = ['curator-health', 'curator-review', 'curator-universe', 'curator-weekly'];

const have = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
const toolsPresent = have('sh') && have('curl') && have('python3');

// ---------------------------------------------------------------- config.yaml

test('config.yaml parses and pins the hardening keys the fork actually reads', () => {
  const cfg = yamlLoad(read('config.yaml'));
  assert.equal(cfg.model.default, 'gpt-5.4');
  assert.equal(cfg.model.provider, 'openai-api');
  assert.deepEqual([...cfg.agent.disabled_toolsets].sort(), ['browser', 'code_execution', 'cronjob', 'terminal']);
  // The allowlist the gateway actually reads is platform_toolsets.<platform>
  // (tools_config._get_platform_tools); agent.enabled_toolsets is never read
  // from this file. Without these two lists the platform default hands the
  // model eighteen toolsets, file and web among them. 'weavr-curator' is the
  // plugin's own toolset key: drop it and the model loses weavr_curator.
  for (const platform of ['telegram', 'cli']) {
    assert.deepEqual([...cfg.platform_toolsets[platform]].sort(), ['clarify', 'skills', 'weavr-curator'],
      `platform_toolsets.${platform} is the whole tool surface the curator agent gets`);
  }
  assert.equal(cfg.tools.tool_search.enabled, 'off');
  assert.equal(cfg.approvals.cron_mode, 'deny');
  assert.equal(cfg.cron.allow_agent_scheduling, false);
  assert.deepEqual(cfg.plugins.enabled, ['weavr-curator']);
  assert.equal(cfg.telegram.group_policy, 'disabled');
  assert.deepEqual(cfg.telegram.group_allow_from, []);
  assert.equal(cfg.telegram.dm_policy, 'allowlist');
  assert.equal(cfg.telegram.unauthorized_dm_behavior, 'ignore');
  assert.equal(cfg.telegram.allow_from, undefined, 'no allow_from: the loader never expands ${VAR}, the ids come from TELEGRAM_ALLOWED_USERS on the host');
});

test('the weavr MCP server exposes exactly the 11 read tools and no write tool', () => {
  const cfg = yamlLoad(read('config.yaml'));
  const weavr = cfg.mcp_servers.weavr;
  assert.equal(weavr.enabled, true);
  assert.equal(weavr.trust, 'full');
  assert.equal(weavr.url, '${WEAVR_MCP_URL}');
  assert.deepEqual([...weavr.tools.include].sort(), [...READ_TOOLS].sort());
  for (const tool of WRITE_TOOLS) assert.ok(!weavr.tools.include.includes(tool), `${tool} must not be registered`);
  assert.equal(weavr.tools.resources, false);
  assert.equal(weavr.tools.prompts, false);
  assert.equal(cfg.mcp_servers.clawpump.enabled, false);
});

test('config.yaml carries no secret-shaped value', () => {
  const text = read('config.yaml');
  assert.doesNotMatch(text, /Bearer\s+\S{20,}/);
  assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/);
  assert.doesNotMatch(text, /https?:\/\/[^\s"']*(rpc|helius|quicknode|alchemy)/i);
});

// ---------------------------------------------------------------- cron/jobs.json

test('cron/jobs.json seeds the four ids in the create_job record shape', () => {
  const doc = JSON.parse(read('cron/jobs.json'));
  assert.ok(Array.isArray(doc.jobs), 'the fork expects {"jobs": [...]}');
  assert.deepEqual(doc.jobs.map((j) => j.id), JOB_IDS);
  for (const job of doc.jobs) {
    for (const key of ['schedule', 'repeat', 'enabled', 'state', 'deliver', 'created_at', 'no_agent']) assert.ok(key in job, `${job.id} lacks ${key}`);
    assert.equal(job.schedule.kind, 'cron');
    assert.equal(job.schedule.expr, job.schedule_display);
    assert.equal(job.deliver, 'telegram');
    assert.equal(job.enabled, true);
    assert.equal(job.state, 'scheduled');
    assert.equal(job.workdir, null);
    // scripts resolve under $HERMES_HOME/scripts/, so the record names the file, not a path
    for (const field of ['script', 'monitor_script']) {
      if (job[field]) {
        assert.doesNotMatch(job[field], /\//, `${job.id}.${field} must be a bare file name`);
        assert.ok(existsSync(join(SCRIPTS, job[field])), `${job.id}.${field} ${job[field]} is missing from scripts/`);
      }
    }
  }
});

test('the jobs match the curator topology, and their prompts are portfolio-agnostic', () => {
  const cfg = yamlLoad(read('config.yaml'));
  const byId = Object.fromEntries(JSON.parse(read('cron/jobs.json')).jobs.map((j) => [j.id, j]));
  const health = byId['curator-health'];
  assert.equal(health.no_agent, true);
  assert.equal(health.script, 'curator-health.sh');
  assert.equal(health.schedule.expr, '*/15 * * * *');
  assert.equal(health.model, null, 'a no_agent job pins no model');

  for (const id of ['curator-review', 'curator-universe', 'curator-weekly']) {
    const job = byId[id];
    assert.equal(job.no_agent, false);
    assert.equal(job.model, cfg.model.default, `${id} pins the model config.yaml runs on`);
    assert.equal(job.provider, cfg.model.provider, `${id} pins the provider config.yaml runs on`);
    assert.equal(job.reasoning_effort, 'medium');
    assert.deepEqual(job.skills, ['weavr-curator']);
    assert.equal(job.skill, 'weavr-curator');
    assert.ok(job.enabled_toolsets.includes('weavr-curator') && job.enabled_toolsets.includes('mcp-weavr'), `${id} toolsets`);
    assert.ok(!job.enabled_toolsets.includes('terminal'), `${id} never gets a terminal`);
    assert.ok(job.prompt.length > 40, `${id} has a task prompt`);
    assert.doesNotMatch(job.prompt, /walletPayload/);
    assert.doesNotMatch(job.prompt, /\bWEAVR\b|CLAWA1/, `${id} names a specific book`);
    assert.match(job.prompt, /[Nn]ever print transaction bytes/);
  }
  assert.equal(byId['curator-review'].script, 'curator-review-gate.sh');
  assert.equal(byId['curator-review'].schedule.expr, '0 9 * * *');
  assert.match(byId['curator-review'].prompt, /weavr_curator policy/, 'the daily review reads the live policy');
  assert.match(byId['curator-review'].prompt, /lands after the book's own notice/, 'the notice is the book\'s, not a remembered length');
  assert.doesNotMatch(byId['curator-review'].prompt, /24 h/);
  assert.equal(byId['curator-universe'].monitor_script, 'curator-universe.sh');
  assert.equal(byId['curator-universe'].script, null, 'monitor jobs have no pre-run script');
  assert.equal(byId['curator-universe'].schedule.expr, '0 */6 * * *');
  assert.match(byId['curator-universe'].prompt, /weavr_curator policy/);
  assert.deepEqual(byId['curator-weekly'].context_from, ['curator-review']);
  assert.equal(byId['curator-weekly'].script, 'curator-weekly.sh');
  assert.equal(byId['curator-weekly'].schedule.expr, '0 10 * * 1');
  assert.match(byId['curator-weekly'].prompt, /[Nn]ever propose/);
});

// ---------------------------------------------------------------- scripts

test('every cron script is POSIX sh that parses, and never puts the token in argv', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.sh'));
  assert.deepEqual(files.sort(), ['curator-health.sh', 'curator-lib.sh', 'curator-review-gate.sh', 'curator-universe.sh', 'curator-weekly.sh']);
  for (const file of files) {
    const text = readFileSync(join(SCRIPTS, file), 'utf8');
    assert.match(text, /^#!\/bin\/sh\n/, `${file} shebang`);
    const parsed = spawnSync('sh', ['-n', join(SCRIPTS, file)], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
    // the planted anti-pattern: a header with the token expanded on the command line
    assert.doesNotMatch(text, /-H\s+["']?Authorization[^\n]*\$/, `${file} passes the bearer through argv`);
    // the value may be expanded only on a line piped straight into curl's stdin, or in the unset test
    for (const line of text.split('\n')) {
      if (!/\$\{?CURATOR_SIGNER_TOKEN/.test(line)) continue;
      assert.ok(/-z "\$\{CURATOR_SIGNER_TOKEN:-\}"/.test(line) || /\|\s*$/.test(line), `${file} expands the token outside curl's stdin: ${line.trim()}`);
    }
    if (file !== 'curator-lib.sh') assert.match(text, /X-Curator-Session: cron|curator-lib\.sh/, `${file} declares the cron session`);
  }
  assert.match(readFileSync(join(SCRIPTS, 'curator-lib.sh'), 'utf8'), /-K -/, 'the lib feeds curl its config on stdin');
});

// A fake signer: records every request, answers from a table keyed by method+path.
async function withSigner(routes, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const key = `${req.method} ${req.url}`;
      const route = routes[key] ?? routes[`${req.method} ${req.url.split('?')[0]}`];
      if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"NOT_FOUND"}}'); return; }
      const [status, payload] = typeof route === 'function' ? route(seen.at(-1)) : route;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(url, seen); } finally { server.close(); }
}

// The fake signer lives in this process, so the script must run asynchronously:
// spawnSync would block the event loop and the server could never answer.
function runScript(name, url, extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', CURATOR_SIGNER_URL: url, CURATOR_SIGNER_TOKEN: TOKEN, ...extraEnv };
  delete env.HERMES_HOME;
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [join(SCRIPTS, name)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const lastLine = (text) => text.split('\n').filter((l) => l.trim()).at(-1);

test('the scripts refuse to run without the signer env and never print the token', { skip: !toolsPresent && 'sh, curl or python3 missing' }, () => {
  for (const name of ['curator-health.sh', 'curator-review-gate.sh', 'curator-universe.sh', 'curator-weekly.sh']) {
    const r = spawnSync('sh', [join(SCRIPTS, name)], { encoding: 'utf8', env: { PATH: process.env.PATH, CURATOR_SIGNER_TOKEN: TOKEN } });
    assert.equal(r.status, 2, `${name} exit`);
    assert.match(r.stderr, /CURATOR_SIGNER_URL and CURATOR_SIGNER_TOKEN/);
    assert.ok(!r.stderr.includes(TOKEN) && !r.stdout.includes(TOKEN), `${name} leaked the token`);
  }
});

test('review-gate relays the brief and the signer\'s wakeAgent as the last line, with the cron headers', { skip: !toolsPresent && 'sh, curl or python3 missing' }, async () => {
  await withSigner({
    'GET /review': [200, { brief: 'brief line one\nline two', triggers: [{ code: 'MONTHLY_REVIEW', detail: 'first Monday' }], wakeAgent: true, holdReason: '' }],
  }, async (url, seen) => {
    const r = await runScript('curator-review-gate.sh', url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /brief line one\nline two/);
    assert.match(r.stdout, /Triggers: MONTHLY_REVIEW/);
    assert.deepEqual(JSON.parse(lastLine(r.stdout)), { wakeAgent: true });
    assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen[0].headers['x-curator-session'], 'cron');
    assert.equal(seen[0].headers['x-curator-caller'], 'curator-review-gate.sh');
  });
  // planted: a HOLD must not wake the model
  await withSigner({ 'GET /review': [200, { brief: 'HOLD', triggers: [], wakeAgent: false, holdReason: 'HOLD: cadence' }] }, async (url) => {
    const r = await runScript('curator-review-gate.sh', url);
    assert.deepEqual(JSON.parse(lastLine(r.stdout)), { wakeAgent: false });
  });
  // planted: a signer that refuses (401) or is down must not wake the model either
  await withSigner({ 'GET /review': [401, { error: { code: 'UNAUTHORIZED' } }] }, async (url) => {
    const r = await runScript('curator-review-gate.sh', url);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /HTTP 401/);
    assert.deepEqual(JSON.parse(lastLine(r.stdout)), { wakeAgent: false });
  });
  const down = await runScript('curator-review-gate.sh', 'http://127.0.0.1:9');
  assert.equal(down.status, 0);
  assert.deepEqual(JSON.parse(lastLine(down.stdout)), { wakeAgent: false });
});

test('health is silent on an empty alert list, prints planted anomalies, and always heartbeats', { skip: !toolsPresent && 'sh, curl or python3 missing' }, async () => {
  await withSigner({
    'GET /alerts': [200, { since: null, alerts: [] }],
    'POST /hermes-heartbeat': [200, { ok: true, at: 1 }],
  }, async (url, seen) => {
    const r = await runScript('curator-health.sh', url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'empty stdout = nothing delivered');
    const beat = seen.find((s) => s.method === 'POST');
    assert.equal(beat.url, '/hermes-heartbeat');
    assert.equal(beat.headers['x-curator-session'], 'cron');
  });
  await withSigner({
    'GET /alerts': [200, { since: 1, alerts: [{ key: 'sol', code: 'LOW_SOL', at: 1757500000, message: 'signer at 0.01 SOL' }] }],
    'POST /hermes-heartbeat': [200, { ok: true }],
  }, async (url) => {
    const r = await runScript('curator-health.sh', url);
    assert.match(r.stdout, /LOW_SOL 1757500000 signer at 0\.01 SOL/);
  });
  await withSigner({ 'GET /alerts': [401, { error: { code: 'UNAUTHORIZED' } }], 'POST /hermes-heartbeat': [401, {}] }, async (url) => {
    const r = await runScript('curator-health.sh', url);
    assert.match(r.stdout, /refused GET \/alerts \(HTTP 401\)/);
    assert.match(r.stdout, /heartbeat failed \(HTTP 401\)/);
  });
  const down = await runScript('curator-health.sh', 'http://127.0.0.1:9');
  assert.match(down.stdout, /signer unreachable/);
});

test('universe prints stable sorted rows, and nothing when no source answers', { skip: !toolsPresent && 'sh, curl or python3 missing' }, async () => {
  const pools = [
    { poolId: 'b', symbol: 'pSOL', status: 'active', riskTier: 2, maxWeightBps: 4000, chain: 'solana', tvlUsdc: 123.4 },
    { poolId: 'a', symbol: 'pCBBTC', status: 'active', riskTier: 3, maxWeightBps: 3000, chain: 'solana', tvlUsdc: 9 },
  ];
  await withSigner({ 'GET /review?mode=universe': [200, { pools }] }, async (url, seen) => {
    const r = await runScript('curator-universe.sh', url);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'pCBBTC,active,3,3000,solana\npSOL,active,2,4000,solana\n');
    assert.equal(seen[0].url, '/review?mode=universe');
  });
  // the signer answers the plain brief (mode not implemented): fall back to the catalogue when it is configured
  await withSigner({
    'GET /review': [200, { brief: 'x', triggers: [], wakeAgent: false, holdReason: 'HOLD' }],
    'GET /v1/pools': [200, pools.slice(0, 1)],
  }, async (url) => {
    const r = await runScript('curator-universe.sh', url, { WEAVR_API_URL: url });
    assert.equal(r.stdout, 'pSOL,active,2,4000,solana\n');
    assert.match(r.stderr, /no pools array/);
    const none = await runScript('curator-universe.sh', url);
    assert.equal(none.stdout, '', 'no source: a stable empty hash, no wake');
  });
});

test('weekly prints the brief and always ends with wakeAgent true, even when the signer says false', { skip: !toolsPresent && 'sh, curl or python3 missing' }, async () => {
  await withSigner({ 'GET /review?mode=weekly': [200, { brief: 'weekly text', triggers: [], wakeAgent: false, holdReason: 'HOLD' }] }, async (url) => {
    const r = await runScript('curator-weekly.sh', url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^weekly text\n/);
    assert.deepEqual(JSON.parse(lastLine(r.stdout)), { wakeAgent: true });
  });
  const down = await runScript('curator-weekly.sh', 'http://127.0.0.1:9');
  assert.deepEqual(JSON.parse(lastLine(down.stdout)), { wakeAgent: true });
});

// ---------------------------------------------------------------- skill, soul, memories

test('SKILL.md frontmatter follows the fork\'s skill standards and the body fits the prompt budget', () => {
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const [, front, body] = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const meta = yamlLoad(front);
  assert.equal(meta.name, 'weavr-curator');
  assert.ok(meta.description.length <= 60, `description is ${meta.description.length} chars`);
  assert.ok(meta.description.endsWith('.'), 'description ends with a period');
  assert.ok(meta.version);
  assert.deepEqual(meta.metadata.hermes.requires_toolsets, ['weavr-curator']);
  assert.ok(Buffer.byteLength(body, 'utf8') <= 8192, 'body ≤ 8 KB');
  for (const needle of ['[SILENT]', 'EXECUTION_COST', 'transaction bytes', 'references/BRIEF.md', 'references/ERRORS.md', 'HOLD', 'simulate_rebalance', 'weavr_curator {verb: "policy"}', 'weavr_curator {verb: "status"}']) {
    assert.ok(body.includes(needle), `SKILL.md mentions ${needle}`);
  }
  for (const ref of ['MANDATE.md', 'POLICY.md', 'ERRORS.md', 'BRIEF.md']) assert.ok(existsSync(join(SKILL, 'references', ref)), ref);
});

test('the skill never quotes a policy threshold, and names the signer as the authority', () => {
  // A live run held against a clean `simulate` because SKILL.md asserted a
  // cadence and a window the deployed policy did not have. The full rule is
  // tests/curator_prose.test.mjs; this keeps the original planted phrases.
  const skill = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const policy = readFileSync(join(SKILL, 'references/POLICY.md'), 'utf8');
  for (const quoted of ['08:00–12:00', '≥ 7 d', '2 per 30 d', 'turnover ≤ 30', 'cost ≤ 25 bps', '3–8 legs', '5–40 %', '24 h']) {
    assert.ok(!skill.includes(quoted), `SKILL.md quotes the policy threshold ${JSON.stringify(quoted)}; the numbers belong to the live policy and simulate, not to the prompt`);
    assert.ok(!policy.includes(quoted), `POLICY.md quotes the policy threshold ${JSON.stringify(quoted)}`);
  }
  assert.match(skill, /Never decide from remembered policy numbers/, 'SKILL.md says where the numbers come from');
  assert.match(skill, /nextProposeAt/, 'SKILL.md points at the field that answers "when may I propose"');
  assert.match(policy, /deployed document is the only truth/, 'POLICY.md warns that the deployed document can differ');
  assert.match(policy, /states \*\*no values on purpose\*\*/);
});

test('ERRORS.md names every refusal code of the signer and all 65 factory error codes', () => {
  const errors = readFileSync(join(SKILL, 'references/ERRORS.md'), 'utf8');
  const codes = `PORTFOLIO_NOT_ALLOWED CHAIN_DENIED POOL_DENIED POOL_NOT_ACTIVE POOL_COST_TOO_HIGH MIN_LEGS MAX_LEGS PAGE_LIMIT
    LEG_WEIGHT_CAP CATEGORY_CAP WEIGHTS_SUM TURNOVER_CAP COST_CAP PROPOSAL_TOO_SOON PROPOSAL_QUOTA TARGETS_PENDING
    INPUTS_INCOMPLETE OUTSIDE_WINDOW WHY_REQUIRED DEPOSIT_DAILY_CAP BOOK_NOT_FRESH CAP_HEADROOM WITHDRAW_CRON_BLOCKED
    WITHDRAW_DAILY_CAP VERB_DENIED OPS_ONLY RATE_LIMITED LOW_SOL SELF_LOCKED INVARIANT_DRIFT PAUSED INVARIANTS_UNVERIFIED
    PAGED_PROPOSE_UNSUPPORTED UPSTREAM BUILD_REFUSED SEND_FAILED`.split(/\s+/).filter(Boolean);
  for (const code of codes) assert.ok(errors.includes(code), `ERRORS.md lacks ${code}`);
  // No programs repo here to cross-check names against errors.rs; the table
  // must still carry every code 6000..6064 exactly once, in the row shape.
  const rows = [...errors.matchAll(/^\| (60\d\d) \| ([A-Z][A-Za-z0-9]+) \|/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.equal(rows.length, 65, 'one row per factory error');
  assert.deepEqual([...new Set(rows.map(([c]) => c))].sort((a, b) => a - b), Array.from({ length: 65 }, (_, i) => 6000 + i));
  assert.ok(rows.some(([c, n]) => c === 6020 && n === 'RebalanceTooSoon') && rows.some(([c, n]) => c === 6064 && n === 'Unauthorized'));
});

test('SOUL.md and the memories fit the Hermes memory tool limits and its § delimiter', () => {
  assert.ok(read('SOUL.md').length <= 800, 'SOUL.md ≈ 600 chars');
  const memory = read('memories/MEMORY.md');
  const user = read('memories/USER.md');
  assert.ok(memory.length <= 2200, `MEMORY.md is ${memory.length} chars`);
  assert.ok(user.length <= 1375, `USER.md is ${user.length} chars`);
  for (const [name, text] of [['MEMORY.md', memory], ['USER.md', user]]) {
    const entries = text.split('\n§\n');
    assert.ok(entries.length >= 3, `${name} has entries`);
    for (const e of entries) assert.ok(e.trim().length > 0 && !e.includes('§'), `${name} clean entries`);
    assert.doesNotMatch(text, /https?:\/\//, `${name} carries no URL`);
  }
  assert.match(memory, /EXECUTION_COST/);
  assert.match(memory, /\[SILENT\]/);
  assert.match(memory, /weavr_curator policy/, 'MEMORY.md points at the policy verb instead of carrying numbers');
  assert.match(memory, /weavr_curator status/, 'MEMORY.md takes the book\'s identity from status');
  assert.match(user, /ops token/);
  assert.doesNotMatch(user, /treasury wallet|guardian key/, 'USER.md drops the weavr-internal roles');
});

test('the profile names no specific book: the signer\'s status does', () => {
  const files = [
    'SOUL.md', 'memories/MEMORY.md', 'memories/USER.md', 'skills/weavr-curator/SKILL.md',
    ...readdirSync(join(SKILL, 'references')).map((f) => `skills/weavr-curator/references/${f}`),
    'config.yaml', ...readdirSync(SCRIPTS).map((f) => `scripts/${f}`),
  ];
  for (const rel of files) {
    const text = read(rel);
    assert.doesNotMatch(text, /\bWEAVR\b/, `${rel} names the house book`);
    assert.doesNotMatch(text, /CLAWA1|1Password|kubectl|ArgoCD/, `${rel} carries weavr-internal operations`);
  }
  assert.match(read('SOUL.md'), /one weavr portfolio/);
  assert.match(read('skills/weavr-curator/references/BRIEF.md'), /<TICKER>/);
  assert.match(read('skills/weavr-curator/references/MANDATE.md'), /template/i);
});

// ---------------------------------------------------------------- policy presets

test('the two policy presets parse, share a schema, and differ exactly where the rehearsal must', () => {
  const standard = JSON.parse(readFileSync(join(ROOT, 'curator/policy/standard.json'), 'utf8'));
  const rehearsal = JSON.parse(readFileSync(join(ROOT, 'curator/policy/rehearsal.json'), 'utf8'));
  const keys = (doc) => Object.keys(doc).filter((k) => !k.startsWith('_')).sort();
  assert.deepEqual(keys(standard), keys(rehearsal));
  for (const section of keys(standard)) {
    if (typeof standard[section] !== 'object' || standard[section] === null) continue;
    assert.deepEqual(keys(rehearsal[section]), keys(standard[section]), `section ${section} has the same keys in both presets`);
  }
  for (const [name, doc] of [['standard', standard], ['rehearsal', rehearsal]]) {
    const cats = Object.entries(doc.universe.categories).filter(([k]) => !k.startsWith('_'));
    for (const symbol of doc.universe.allowlist) {
      const owners = cats.filter(([, members]) => members.includes(symbol)).map(([k]) => k);
      assert.equal(owners.length, 1, `${name}: ${symbol} is in exactly one category (${owners})`);
    }
    assert.ok(cats.some(([k]) => k === doc.shape.stableCategory), `${name}: stableCategory names a category`);
    assert.equal(doc.shape.sumBps, 10000);
    assert.ok(doc.verbs.denied.includes('create') && doc.verbs.denied.includes('transfer-curator'), `${name}: owner-wallet actions never go through the signer`);
    assert.ok(doc.verbs.ops.includes('resume') && doc.verbs.ops.includes('unlock') && doc.verbs.ops.includes('rotate-curator'), `${name}: ops verbs`);
    assert.ok(!doc.verbs.agent.includes('resume'), `${name}: the agent can never resume itself`);
  }
  // the rehearsal: a two-leg book, no cadence gate, an all-day window, a minute of notice, no money verbs
  assert.equal(rehearsal.shape.minLegs, 2);
  assert.equal(rehearsal.cadence.minSecsSinceLastRebalance, 0);
  assert.deepEqual(rehearsal.cadence.proposeWindowUtc, { fromHour: 0, toHour: 24 });
  assert.equal(rehearsal.invariants.rebalanceDelaySecs, 60);
  for (const verb of ['deposit', 'withdraw']) {
    assert.ok(rehearsal.verbs.denied.includes(verb) && !rehearsal.verbs.agent.includes(verb), `rehearsal denies ${verb}`);
    assert.ok(standard.verbs.agent.includes(verb), `standard lets the agent ${verb}`);
  }
  assert.ok(standard.cadence.minSecsSinceLastRebalance > 0 && standard.shape.stableMinBps > 0);
  assert.ok(standard.invariants.rebalanceDelaySecs > rehearsal.invariants.rebalanceDelaySecs);
  assert.deepEqual(standard.verbs.cronDenied, ['withdraw']);
});

// ---------------------------------------------------------------- compose and env examples

const COMPOSE = join(ROOT, 'curator/compose/curator.yml');
const dockerOk = have('docker') && spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 30_000 }).status === 0;

test('the compose file publishes the signer on loopback only and takes every secret from an env file', () => {
  const text = readFileSync(COMPOSE, 'utf8');
  const doc = yamlLoad(text);
  assert.deepEqual(Object.keys(doc.services).sort(), ['agent', 'signer']);
  assert.deepEqual(doc.services.signer.ports, ['127.0.0.1:8091:8091']);
  assert.equal(doc.services.agent.ports, undefined, 'the agent publishes nothing');
  assert.equal(doc.services.agent.network_mode, undefined, 'the agent reaches the signer by service name on the compose network');
  assert.deepEqual(doc.services.agent.command, ['gateway', 'run']);
  const env = doc.services.signer.environment.join('\n');
  for (const secret of ['CURATOR_SIGNER_TOKEN', 'CURATOR_OPS_TOKEN', 'SOLANA_RPC_URL', 'CURATOR_RPC_URL', 'CURATOR_KEYPAIR_JSON']) {
    assert.ok(!env.includes(secret), `${secret} must come from the env file, never the compose environment`);
  }
  assert.match(env, /^SERVICE=curator$/m);
  assert.match(env, /^CURATOR_KEYPAIR=\/keys\/curator\.json$/m);
  assert.match(env, /^CURATOR_POLICY_FILE=\/policy\/policy\.json$/m);
  assert.match(env, /^CURATOR_START_PAUSED=\$\{CURATOR_START_PAUSED:-1\}$/m, 'the signer boots paused by default');
  assert.ok(doc.services.signer.volumes.some((v) => v.endsWith(':/keys/curator.json:ro')), 'the key is bind-mounted read-only');
  assert.ok(doc.services.signer.volumes.some((v) => v.endsWith(':/policy/policy.json:ro')), 'the policy is bind-mounted read-only');
  assert.match(text, /CURATOR_SIGNER_IMAGE:-weavr-backend:curator-local/);
  assert.match(text, /HERMES_IMAGE:-hermes-agent/);
  assert.match(text, /http:\/\/signer:8091/, 'the header tells the self-hoster what CURATOR_SIGNER_URL must be');
  assert.doesNotMatch(text, /\b[0-9a-f]{64}\b|Bearer\s+\S{20,}/);
});

test('the env examples list the secret names with no values', () => {
  const signer = readFileSync(join(ROOT, 'curator/compose/signer.env.example'), 'utf8');
  const agent = readFileSync(join(ROOT, 'curator/compose/agent.env.example'), 'utf8');
  const entries = (text) => Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); assert.ok(i > 0, `not NAME=…: ${l}`); return [l.slice(0, i), l.slice(i + 1)]; }));
  const s = entries(signer);
  assert.deepEqual(Object.keys(s).sort(), ['CURATOR_OPS_TOKEN', 'CURATOR_SIGNER_TOKEN', 'SOLANA_RPC_URL']);
  for (const [k, v] of Object.entries(s)) assert.equal(v, '', `${k} carries a value`);
  const a = entries(agent);
  for (const name of ['OPENAI_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL', 'CURATOR_SIGNER_URL', 'CURATOR_SIGNER_TOKEN', 'WEAVR_MCP_URL', 'CURATOR_PORTFOLIO_SYMBOL', 'CURATOR_REBALANCE_DELAY_SECS']) {
    assert.ok(name in a, `agent.env.example lacks ${name}`);
  }
  for (const [k, v] of Object.entries(a)) {
    if (/KEY|TOKEN|USERS|CHANNEL|SYMBOL|DELAY|RPC/.test(k)) assert.equal(v, '', `${k} carries a value`);
  }
  assert.equal(a.CURATOR_SIGNER_URL, 'http://signer:8091');
  assert.ok(!('CURATOR_OPS_TOKEN' in a), 'the agent never gets the ops token');
});

test('docker compose config accepts the file with placeholder values', { skip: !dockerOk && 'docker compose not available' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'curator-compose-'));
  try {
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'home', '.env'), '');
    writeFileSync(join(dir, 'signer.env'), '');
    writeFileSync(join(dir, 'key.json'), '');
    const env = {
      PATH: process.env.PATH, HOME: process.env.HOME,
      CURATOR_KEY_FILE: join(dir, 'key.json'),
      CURATOR_POLICY_FILE: join(ROOT, 'curator/policy/standard.json'),
      CURATOR_SIGNER_ENV: join(dir, 'signer.env'),
      CURATOR_PORTFOLIO_MINT: 'Mint1111111111111111111111111111111111111111',
      CURATOR_TREASURY: 'Treas111111111111111111111111111111111111111',
      CURATOR_EXPECTED_GUARDIAN: 'Guard111111111111111111111111111111111111111',
      HERMES_HOME: join(dir, 'home'),
    };
    const r = spawnSync('docker', ['compose', '-f', COMPOSE, 'config'], { encoding: 'utf8', env, timeout: 90_000 });
    assert.equal(r.status, 0, r.stderr);
    const rendered = yamlLoad(r.stdout);
    assert.equal(rendered.services.signer.image, 'weavr-backend:curator-local');
    assert.equal(rendered.services.agent.image, 'hermes-agent');
    assert.equal(rendered.services.signer.ports[0].host_ip, '127.0.0.1');
    assert.equal(rendered.services.signer.environment.CURATOR_START_PAUSED, '1');
    assert.ok(rendered.services.signer.volumes.find((v) => v.target === '/keys/curator.json').read_only);
    // planted: a missing required variable is refused with its message, not defaulted
    const missing = spawnSync('docker', ['compose', '-f', COMPOSE, 'config'], { encoding: 'utf8', env: { ...env, CURATOR_PORTFOLIO_MINT: '' }, timeout: 90_000 });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /CURATOR_PORTFOLIO_MINT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the self-hoster page

test('curator/README.md is the self-hoster page: short, in order, and without a policy number', () => {
  const text = readFileSync(join(ROOT, 'curator/README.md'), 'utf8');
  assert.ok(text.split('\n').length <= 260, 'under about 250 lines');
  const order = ['## What it is', '## The trust boundaries', '## What you need', '## Setup', '## Run it', '## The daily life', '## Operations', '## What stays private'];
  let last = -1;
  for (const heading of order) {
    const at = text.indexOf(heading);
    assert.ok(at > last, `${heading} present and in order`);
    last = at;
  }
  for (const needle of ['weavr-curator init --portfolio', 'weavr-curator doctor', 'docker compose -f curator/compose/curator.yml up -d', '/weavr-curator pause', 'weavr-curator ops resume', 'rotate-curator', 'cannot withdraw user funds', 'guardian cancel']) {
    assert.ok(text.includes(needle), `README mentions ${needle}`);
  }
  assert.doesNotMatch(text, /\bWEAVR\b|CLAWA1/);
});
