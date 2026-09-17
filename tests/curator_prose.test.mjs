// The no-thresholds-in-prose gate. A live run once held against a clean
// `simulate` because a page the model reads asserted a cadence and a window
// the deployed policy did not have. The durable fix: no file the model reads
// may state a policy threshold. The numbers come from `weavr_curator policy`
// (live, from the signer) and from `simulate`'s refusals; the prose says which
// section governs what and which code refuses. This test is the rule as code,
// proven on planted violations before it is trusted on the real files.
//
// The rule: a number next to a policy unit is a finding. The number may be
// glued, spaced, hyphenated or en-dashed to its unit ("24 h", "24-hour",
// "7–day"), may carry a minus (a drawdown floor of -35%), and a comparison
// may be a symbol (<, >, <=, >=, ≤, ≥) or a word (at most, under, over ...).
// The allowances are exactly the documented list below; nothing else passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = join(ROOT, 'curator/profile');
const SKILL = join(PROFILE, 'skills/weavr-curator');
const PLUGIN = join(ROOT, 'plugins/weavr-curator/__init__.py');

// A number, not glued to a word (so DRAWDOWN_30D, 6004, v0.2.0, Token-2022
// and 2026-09-13 do not count), with an optional leading minus so a floor
// written as -35% counts.
const NUM = String.raw`(?<![\w.\-−])[-−]?\d[\d,.]*`;
// What may sit between a number and its unit: nothing, a space, a hyphen or an
// en dash. "24 h", "24h", "24-hour" and "24–hour" are the same threshold.
const SEP = String.raw`[\s\-–]?`;
const WINDOW_TIME = String.raw`\d{1,2}:\d{2}`;
export const RULES = [
  ['bps', new RegExp(`${NUM}${SEP}(?:bps|basis[\\s-]?points?)\\b`, 'i')],
  ['percent', new RegExp(`${NUM}${SEP}(?:%|(?:percent|per\\s?cent|pct)\\b)`, 'i')],
  ['hours', new RegExp(`${NUM}${SEP}(?:h|hrs?|hours?|hourly)\\b`)],
  ['minutes', new RegExp(`${NUM}${SEP}(?:min|mins|minutes?)\\b`)],
  ['seconds', new RegExp(`${NUM}${SEP}(?:s|secs?|seconds?)\\b`)],
  ['days', new RegExp(`${NUM}${SEP}(?:d|days?)\\b`)],
  ['weeks', new RegExp(`${NUM}${SEP}(?:w|wks?|weeks?|months?)\\b`)],
  ['dollars', /(?:\$|\bUSDC?)\s?[-−]?\d/],
  ['usd', new RegExp(`${NUM}${SEP}USDC?\\b`)],
  ['sol', new RegExp(`${NUM}${SEP}(?:SOL|lamports?)\\b`)],
  // reason.maxChars and review.briefMaxChars are policy values too
  ['chars', new RegExp(`${NUM}${SEP}(?:chars?|characters|bytes|[kK][bB])\\b`)],
  ['count', new RegExp(`${NUM}${SEP}(?:proposals?|legs?|pools?|assets?|positions?|slots?|pages?|attempts?|retries)\\b`)],
  ['per-window', new RegExp(`${NUM}\\s(?:\\S+\\s){0,3}per\\s+(?:rolling\\s+|UTC\\s+)?(?:hour|day|week|month|window|\\d+\\s?d)\\b`, 'i')],
  ['window', new RegExp(`\\b${WINDOW_TIME}(?:\\s?[–—-]\\s?|\\s(?:to|and|until)\\s)${WINDOW_TIME}\\b`)],
  ['window-edge', new RegExp(`\\b(?:from|after|before|until|till|between|opens at|closes at)\\s${WINDOW_TIME}\\b`, 'i')],
  ['comparison', /(?:<=|>=|[<>≤≥])\s?[-−]?\d/],
  ['bound', /\b(?:at most|at least|up to|no more than|more than|fewer than|less than|under|over|above|below|exceeds?|capped at|cap of|max(?:imum)? of|min(?:imum)? of)\s[-−]?\d/i],
];

// The allowances, each small and named. Anything not listed here is a finding.
const EXAMPLE_MARK = '<!-- example -->';                               // BRIEF.md's sample brief line
const ERROR_CODE_CELL = /^\|\s*60\d\d\s*\|/;                           // only the code cell of a factory error row (6000..6064); the rest of the row is scanned
const VERSION_LINE = /^(?:version|\s*version):\s*[\d.]+\s*$/;          // frontmatter version
const PHONE_LIMITS = /(?:<=|[<≤]|at most)?\s?(?:1,200 chars|2 KB)\b/g;  // the two phone-format limits, by exact string: the brief's length and a note's size
const HISTORY_WINDOW = /\b(?:24h|7d|30d)\b/g;                         // get_*_history windows and the brief template
const SECTION_SIGN = /§/g;                                             // the memory delimiter

export function checkProse(text, { file = '' } = {}) {
  const findings = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.includes(EXAMPLE_MARK) || VERSION_LINE.test(raw)) return;
    let line = raw.replace(ERROR_CODE_CELL, '| |').replace(PHONE_LIMITS, ' ').replace(SECTION_SIGN, '');
    if (file.endsWith('BRIEF.md') || /_history\b/.test(line)) line = line.replace(HISTORY_WINDOW, ' ');
    for (const [rule, re] of RULES) {
      const m = re.exec(line);
      if (m) findings.push({ file, line: index + 1, rule, match: m[0], text: raw.trim() });
    }
  });
  return findings;
}

// The string literals of one region of a Python file (SCHEMA / USAGE / describe).
function pythonRegion(source, startRe, endRe) {
  const start = source.search(startRe);
  assert.ok(start >= 0, `region ${startRe} not found in __init__.py`);
  const rest = source.slice(start);
  const end = rest.slice(1).search(endRe);
  return end >= 0 ? rest.slice(0, end + 1) : rest;
}
function stringLiterals(region) {
  return [...region.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)].map((m) => m[0].slice(1, -1)).join('\n');
}

const read = (p) => readFileSync(p, 'utf8');
const SCANNED = [
  join(PROFILE, 'SOUL.md'),
  ...readdirSync(join(PROFILE, 'memories')).filter((f) => f.endsWith('.md')).map((f) => join(PROFILE, 'memories', f)),
  join(SKILL, 'SKILL.md'),
  ...readdirSync(join(SKILL, 'references')).filter((f) => f.endsWith('.md')).map((f) => join(SKILL, 'references', f)),
  join(ROOT, 'curator/README.md'),
  join(ROOT, 'curator/policy/README.md'),
];

// ---------------------------------------------------------------- the checker fails on planted thresholds

// Every spelling of a threshold the gate must catch, each with the rule that
// owns it. The factory-error rows are the pre-rewrite ops text of ERRORS.md
// rows 6029, 6035 and 6036, which the port reworded by hand: the gate has to
// catch their return, so a code row is scanned past its code cell.
const PLANTED = [
  ['≥ 7 d since the last rebalance', 'days'],
  ['the 7-day cadence and the 30-day quota of two proposals', 'days'],
  ['08:00–12:00 UTC', 'window'],
  ['propose only between 08:00 and 12:00 UTC', 'window'],
  ['the window opens after 08:00 UTC', 'window-edge'],
  ['cost ≤ 25 bps', 'bps'],
  ['100 basis points of NAV', 'bps'],
  ['a 30-day return under −35 %', 'percent'],
  ['a drawdown floor of -35%', 'percent'],
  ['turnover under 30 percent', 'percent'],
  ['lands 24 h later', 'hours'],
  ['a 24-hour notice before every apply', 'hours'],
  ['a 2-week cadence', 'weeks'],
  ['at most 2 proposals per 30 d', 'per-window'],
  ['no more than 2 per window', 'per-window'],
  ['> $1,000 today', 'dollars'],
  ['cap USD 500', 'dollars'],
  ['500 USD a day', 'usd'],
  ['no signing under 0.02 SOL', 'sol'],
  ['refresh_nav if stale > 15 min', 'minutes'],
  ['3–8 legs', 'count'],
  ['a 2-leg minimum, 8-leg maximum', 'count'],
  ['why ≤ 500 chars', 'chars'],
  ['the why must be at most 500 chars', 'chars'],
  ['the quota is at most 2', 'bound'],
  ['| 6020 | RebalanceTooSoon | delay not elapsed | HOLD until 7 d |', 'days'],
  ['| 6029 | ApplyInFlight | a paged apply is mid-way | the loop waits 320 slots and restarts |', 'count'],
  ['| 6035 | PoolPriceStale | a required pool price is stale | wait (keeper cranks ≤ 600 s) |', 'seconds'],
  ['| 6036 | PoolPricePending | a required pool mark is pending | Pyth: wait ≤ 10 min; publisher: do not wait, report |', 'minutes'],
  ['| 6036 | PoolPricePending | a required pool mark is pending | Pyth: wait ≤ 10 min; publisher: do not wait, report |', 'comparison'],
];

test('the checker reports planted thresholds in an otherwise clean page', () => {
  const clean = read(join(SKILL, 'SKILL.md'));
  assert.deepEqual(checkProse(clean, { file: 'SKILL.md' }), [], 'SKILL.md must be clean for the plant to mean anything');
  const findings = checkProse(clean + '\n' + PLANTED.map(([line]) => line).join('\n'), { file: 'SKILL.md' });
  for (const [line, rule] of PLANTED) {
    assert.ok(findings.some((f) => f.text === line), `planted ${JSON.stringify(line)} was not reported`);
    assert.ok(findings.some((f) => f.text === line && f.rule === rule), `planted ${JSON.stringify(line)} was not reported by rule ${rule}`);
  }
  const fired = new Set(findings.map((f) => f.rule));
  for (const [rule] of RULES) assert.ok(fired.has(rule), `rule ${rule} never fired on the plant`);
  assert.ok(findings.every((f) => f.line > clean.split('\n').length), 'every finding is on a planted line');
});

test('the factory error rows of the real ERRORS.md are scanned past their code cell', () => {
  const errors = read(join(SKILL, 'references/ERRORS.md'));
  assert.deepEqual(checkProse(errors, { file: 'ERRORS.md' }), []);
  const lines = errors.split('\n');
  const row = lines.findIndex((l) => /^\| 6035 \|/.test(l));
  assert.ok(row >= 0, 'ERRORS.md has the 6035 row');
  const cells = lines[row].split('|');
  cells[cells.length - 2] += ' (keeper cranks ≤ 600 s)';      // the pre-rewrite ops action cell
  lines[row] = cells.join('|');
  const findings = checkProse(lines.join('\n'), { file: 'ERRORS.md' });
  assert.deepEqual(findings.map((f) => [f.line, f.rule]).sort(), [[row + 1, 'comparison'], [row + 1, 'seconds']]);
});

test('the allowances are exactly the documented ones', () => {
  const ok = [
    ['≤ 1,200 chars, numbers first', 'BRIEF.md'],                          // the brief's phone length, by exact string
    ['at most 1,200 chars, numbers first', 'USER.md'],                     // the same literal on any page
    ['`note {text}` (≤ 2 KB) records', 'SKILL.md'],                        // a note's size, by exact string
    ['Legs: pSOL 30 % · pUSDS 15 %   <!-- example -->', 'BRIEF.md'],       // the marked sample line
    ['NAV/share <x.xxxx> (<7d %>, <30d %>)', 'BRIEF.md'],                  // history windows in the brief template
    ['get_asset_history over 30d and 7d', 'SKILL.md'],                     // history windows on a get_*_history line
    ['| 6020 | RebalanceTooSoon | delay since the last apply not elapsed | HOLD until `nextProposeAt` |', 'ERRORS.md'], // the code cell
    ['| 6012 | CreatorFeeOutOfRange | creator fee not in (0, 10000) | create-time only |', 'ERRORS.md'],             // a program bound, no unit
    ['| 6042 | MaxPriceAgeOutOfRange | pool max price age outside 1..86400 | governance only |', 'ERRORS.md'],
    ['version: 0.2.0', 'SKILL.md'],                                        // frontmatter version
    ['# Mandate v1 (11 Sep 2026)', 'MANDATE.md'],                          // a date in a header
    ['review daily 09:00 UTC; weekly Mon 10:00 UTC', 'MEMORY.md'],         // two schedules are not a window
    ['apply lands 2026-09-13 09:12 UTC', 'BRIEF.md'],                      // a timestamp
    ['a trigger named DRAWDOWN_30D', 'SKILL.md'],                          // a glued identifier
    ['FactoryError, code 6000 + index', 'ERRORS.md'],                      // a code, no unit
    ['Token-2022 snapshot wrong', 'ERRORS.md'],                            // a name
    ['both mode 0600', 'README.md'],                                       // a file mode
    ['Σ|Δw_i| × maxExecutionLossBps_i / 10000, in bps', 'POLICY.md'],      // a formula's divisor, not a number of bps
  ];
  for (const [line, file] of ok) assert.deepEqual(checkProse(line, { file }), [], `allowed line was reported: ${line}`);
  const notOk = [
    ['7 d cadence in the brief', 'BRIEF.md'],                                 // a spaced number is not a history window
    ['get_asset_history says ≥ 7 d', 'SKILL.md'],                             // the history allowance covers the token, not the sentence
    ['| CODE | a row that is not a code row | 7 d |', 'ERRORS.md'],
    ['| 6020 | RebalanceTooSoon | delay not elapsed | HOLD until 7 d |', 'ERRORS.md'],          // the code cell is allowed, the row is not
    ['| 6035 | PoolPriceStale | stale | wait (keeper cranks ≤ 600 s) |', 'ERRORS.md'],
    ['| 6029 | ApplyInFlight | mid-way | the loop waits 320 slots |', 'ERRORS.md'],
    ['at most 500 chars, and 24 h notice', 'SKILL.md'],                       // the format allowance does not launder a neighbour
    ['at most 1,200 chars and a 24 h notice', 'BRIEF.md'],
    ['why ≤ 500 chars', 'SKILL.md'],                                          // reason.maxChars is a policy value
    ['the why must be at most 500 chars', 'SKILL.md'],
    ['the brief is capped at 4096 chars', 'POLICY.md'],                       // review.briefMaxChars is a policy value
    ['the `why` is at most 500 chars', 'BRIEF.md'],                           // in BRIEF.md too: the allowance is two literals, not any count
    ['≤ 1,500 chars, numbers first', 'BRIEF.md'],                             // a different literal is a change to this list
    ['a 24-hour notice', 'SKILL.md'],
    ['the 7-day cadence', 'MEMORY.md'],
    ['a 30-day quota', 'SKILL.md'],
    ['drawdown floor -35%', 'SKILL.md'],
    ['propose only between 08:00 and 12:00 UTC', 'SKILL.md'],
    ['from 08:00 to 12:00', 'SKILL.md'],
    ['turnover under 30 percent', 'SKILL.md'],
    ['cap USD 500', 'SKILL.md'],
    ['a 2-leg minimum, 8-leg maximum', 'SKILL.md'],
    ['≤ -35 %', 'SKILL.md'],
  ];
  for (const [line, file] of notOk) assert.ok(checkProse(line, { file }).length > 0, `must be reported: ${line}`);
});

// ---------------------------------------------------------------- the real files are clean

for (const file of SCANNED) {
  test(`${relative(ROOT, file)} states no policy threshold`, () => {
    const findings = checkProse(read(file), { file });
    assert.deepEqual(findings, [], findings.map((f) => `${f.rule} at line ${f.line}: ${f.text}`).join('\n'));
  });
}

test('every cron job prompt states no policy threshold', () => {
  const doc = JSON.parse(read(join(PROFILE, 'cron/jobs.json')));
  for (const job of doc.jobs) {
    const findings = checkProse(job.prompt, { file: `cron/jobs.json#${job.id}` });
    assert.deepEqual(findings, [], `${job.id}: ${findings.map((f) => `${f.rule}: ${f.match}`).join(', ')}`);
    assert.doesNotMatch(job.prompt, /\bWEAVR\b/, `${job.id} names the house book`);
  }
});

test('the plugin SCHEMA, USAGE and describe string literals state no threshold', () => {
  const source = read(PLUGIN);
  const regions = {
    SCHEMA: pythonRegion(source, /^SCHEMA = \{/m, /^\}/m),
    USAGE: pythonRegion(source, /^USAGE = \(/m, /^\)/m),
    describe: pythonRegion(source, /^def describe\(/m, /^(?:def |# -{10,})/m),
  };
  for (const [name, region] of Object.entries(regions)) {
    const literals = stringLiterals(region);
    assert.ok(literals.length > 20, `${name} has string literals`);
    const findings = checkProse(literals, { file: `__init__.py#${name}` });
    assert.deepEqual(findings, [], `${name}: ${findings.map((f) => `${f.rule}: ${f.match}`).join(', ')}`);
    assert.doesNotMatch(literals, /24 h/, `${name} hard-codes the house notice`);
    assert.doesNotMatch(literals, /\bWEAVR\b/, `${name} names the house book`);
  }
  // the notice in describe() is derived from the environment, never a literal
  assert.match(regions.describe, /_notice\(\)/, 'describe derives the notice from CURATOR_REBALANCE_DELAY_SECS');
});

// ---------------------------------------------------------------- the positive side: where the numbers do come from

test('SKILL.md sends the model to the live policy and forbids remembered numbers', () => {
  const skill = read(join(SKILL, 'SKILL.md'));
  assert.match(skill, /weavr_curator \{verb: "policy"\}/, 'SKILL.md names the policy verb');
  assert.match(skill, /Never decide from remembered policy numbers/);
  assert.match(skill, /once per run/i, 'the policy is fetched once per run, before deciding');
  assert.match(skill, /nextProposeAt/, 'the field that answers "when may I propose"');
});

test('POLICY.md warns that the deployed document is the only truth, and MEMORY.md points at the verb', () => {
  assert.match(read(join(SKILL, 'references/POLICY.md')), /deployed document is the only truth/);
  assert.match(read(join(SKILL, 'references/POLICY.md')), /weavr_curator \{verb: "policy"\}/);
  assert.match(read(join(PROFILE, 'memories/MEMORY.md')), /weavr_curator policy/);
  assert.match(read(join(SKILL, 'references/MANDATE.md')), /every SIZE and LIMIT lives in the signer's policy document/i);
});
