// The weavr-curator plugin's planted cases live in Python (no Hermes import,
// a fake urlopen, no network). This wrapper runs them under `npm test` and
// `npm run curator-test`, and skips cleanly where python3 is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST = join(ROOT, 'plugins/weavr-curator/test_plugin.py');
const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
const havePython = python.status === 0;

test('plugins/weavr-curator/test_plugin.py passes', { skip: !havePython && 'python3 not on PATH' }, () => {
  const r = spawnSync('python3', [TEST], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120_000 });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const m = r.stdout.match(/weavr-curator plugin: ok \((\d+) tests\)/);
  assert.ok(m, `no pass line in:\n${r.stdout}`);
  assert.ok(Number(m[1]) >= 21, `expected at least 21 planted cases, saw ${m[1]}`);
});

test('a failing planted case is reported as a non-zero exit', { skip: !havePython && 'python3 not on PATH' }, () => {
  // Run the same file with one test replaced by a failure: the wrapper must not
  // report a pass just because the runner printed something.
  const script = [
    'import importlib.util, pathlib, sys',
    `spec = importlib.util.spec_from_file_location("t", ${JSON.stringify(TEST)})`,
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'def broken():\n    assert mod.gate(tool_name="weavr_curator", args={"verb": "withdraw"}) is None, "planted"',
    'mod.TESTS.append(broken)',
    'for t in mod.TESTS:\n    t()',
    'print("weavr-curator plugin: ok (%d tests)" % len(mod.TESTS))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, HERMES_CRON_SESSION: '1', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 120_000 });
  assert.notEqual(r.status, 0, 'a planted failure must fail the run');
  assert.match(r.stderr, /AssertionError: planted/);
  assert.doesNotMatch(r.stdout, /plugin: ok/);
});
