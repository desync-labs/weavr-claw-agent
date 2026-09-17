/**
 * The policy preset against the book, before anything runs. Pure: a policy
 * document, a portfolio row and the catalogue in, a list of
 * `{ code, message, fix }` out, empty when the preset admits the book as it
 * stands. The codes are the signer's own refusal codes, so what init reports
 * here is what the first proposal would have come back with days later.
 *
 * Also the policy digest: sha256 of the canonical JSON (keys sorted at every
 * level) of the document with every `_comment` key stripped, which is what
 * the signer computes for the document it loaded (GET /policy, status.policy.sha256).
 */
import * as nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { legsOf } from './weavr-api.mjs';

export const PRESETS = Object.freeze(['standard', 'rehearsal']);

/** Drop `_comment` keys at every level; arrays and scalars pass through. */
export function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== '_comment').map(([k, v]) => [k, stripComments(v)]));
  }
  return value;
}

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const canonicalSha256 = (value) => createHash('sha256').update(canonicalJson(value ?? null), 'utf8').digest('hex');

/** The digest the running signer reports for this document. */
export const policyDigest = (doc) => canonicalSha256(stripComments(doc));

/** The shipped preset, comments and all, from curator/policy/<name>.json. */
export function loadPreset(name, { repoRoot, fs = nodeFs } = {}) {
  if (!PRESETS.includes(name)) throw new Error(`unknown policy preset ${JSON.stringify(name)}; shipped presets are ${PRESETS.join(', ')}`);
  return JSON.parse(fs.readFileSync(join(repoRoot, 'curator', 'policy', `${name}.json`), 'utf8'));
}

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Validate `policy` against the book `row` holds. `pools` is the catalogue.
 * `presetName` names the document in messages; `alternatives` is
 * `{ name: policy }` for the other shipped presets, so a fix can say which
 * preset would admit the book instead of guessing.
 *
 * A number a rule needs and cannot find (a catalogue row without a riskTier,
 * a target without a weight, a preset without a cap) is its own item,
 * INPUTS_INCOMPLETE, never a pass: a comparison against a missing value is
 * false both ways, and a check that is silent on missing input is
 * indistinguishable from one that cannot fail.
 */
const POLICY_NUMBERS = Object.freeze({
  shape: ['minLegs', 'maxLegs', 'minLegWeightBps', 'maxLegWeightBps', 'stableMinBps', 'stableMaxBps', 'categoryMaxBps'],
  universe: ['maxRiskTier', 'maxExecutionLossBps'],
});
const POOL_NUMBERS = Object.freeze(['riskTier', 'maxExecutionLossBps', 'maxWeightBps']);
const lacks = (obj, fields) => fields.filter((f) => !Number.isFinite(num(obj?.[f])));

export function validatePolicyAgainstBook(policy, row, pools = [], { presetName = 'this preset', alternatives = {} } = {}) {
  const items = [];
  const push = (code, message, fix) => items.push({ code, message, fix });
  const universe = stripComments(policy.universe ?? {});
  const shape = stripComments(policy.shape ?? {});
  const categories = universe.categories ?? {};
  const categoryOf = new Map();
  for (const [name, symbols] of Object.entries(categories)) for (const s of symbols ?? []) categoryOf.set(s, name);
  const allowlist = new Set(universe.allowlist ?? []);
  const legs = legsOf(row, pools);
  const n = legs.length;
  const alts = Object.entries(alternatives).map(([name, doc]) => [name, stripComments(doc)]);

  const policyMissing = [
    ...lacks(shape, POLICY_NUMBERS.shape).map((f) => `shape.${f}`),
    ...lacks(universe, POLICY_NUMBERS.universe).map((f) => `universe.${f}`),
  ];
  if (policyMissing.length) {
    push('INPUTS_INCOMPLETE', `${presetName} has no number for ${policyMissing.join(', ')}, so those rules cannot run`,
      'start from a shipped preset (curator/policy/standard.json or rehearsal.json); the signer refuses to boot on a document with a missing key');
  }

  if (n < num(shape.minLegs) || n > num(shape.maxLegs)) {
    const admits = alts.filter(([, p]) => n >= num(p.shape?.minLegs) && n <= num(p.shape?.maxLegs)).map(([name]) => name);
    const which = admits.length
      ? `the ${admits.join(' or ')} preset admits a ${n}-leg book`
      : `no shipped preset admits a ${n}-leg book`;
    if (n < num(shape.minLegs)) {
      push('MIN_LEGS', `${presetName} needs at least ${shape.minLegs} legs; the book holds ${n} (${which})`,
        admits.length ? `pass --policy ${admits[0]}, or add legs until the book holds at least ${shape.minLegs}` : `add legs until the book holds at least ${shape.minLegs}, or lower shape.minLegs in curator/policy.json`);
    } else {
      push('MAX_LEGS', `${presetName} allows at most ${shape.maxLegs} legs; the book holds ${n} (${which})`,
        admits.length ? `pass --policy ${admits[0]}, or remove legs until the book holds at most ${shape.maxLegs}` : `remove legs until the book holds at most ${shape.maxLegs}, or raise shape.maxLegs in curator/policy.json`);
    }
  }

  let weightsKnown = true;
  for (const leg of legs) {
    const { symbol, pool, weightBps, poolId } = leg;
    if (!Number.isFinite(weightBps)) {
      weightsKnown = false;
      push('INPUTS_INCOMPLETE', `${symbol} has no target weightBps in the portfolio row, so the weight rules cannot run on it`,
        'the api answered a row without a weight; read the portfolio again, and report it if it persists');
    }
    if (!allowlist.has(symbol) || !categoryOf.has(symbol)) {
      const admits = alts.filter(([, p]) => (p.universe?.allowlist ?? []).includes(symbol)).map(([name]) => name);
      const where = !allowlist.has(symbol) ? 'universe.allowlist' : 'a category';
      push('POOL_DENIED', `held leg ${symbol} is not on ${where} of ${presetName}`,
        `add ${symbol} to universe.allowlist and to a category in curator/policy.json${admits.length ? `, or pass --policy ${admits[0]} (it allowlists ${symbol})` : ''}`);
    }
    if (!pool) {
      push('POOL_DENIED', `held leg ${poolId} is not in the catalogue`, 'the keeper will unwind a delisted leg; wait for the catalogue, or choose a book whose legs are listed');
    } else {
      const poolMissing = lacks(pool, POOL_NUMBERS);
      if (poolMissing.length) {
        push('INPUTS_INCOMPLETE', `the catalogue row for ${symbol} has no number for ${poolMissing.join(', ')}, so those rules cannot run on it`,
          'the api answered a catalogue row without it; read the catalogue again, and report it if it persists');
      }
      if (!(universe.chains ?? []).includes(pool.chain)) {
        push('CHAIN_DENIED', `${symbol} is on ${pool.chain}; universe.chains allows ${(universe.chains ?? []).join(', ')}`, `add ${pool.chain} to universe.chains in curator/policy.json, or drop the leg`);
      }
      if (universe.requireStatus && pool.status !== universe.requireStatus) {
        push('POOL_NOT_ACTIVE', `${symbol} is ${pool.status ?? 'unknown'}; universe.requireStatus is ${universe.requireStatus}`, 'wait for the pool to come back, or drop the leg');
      }
      if (num(pool.riskTier) > num(universe.maxRiskTier)) {
        push('POOL_DENIED', `${symbol} is risk tier ${pool.riskTier}; universe.maxRiskTier is ${universe.maxRiskTier}`, 'raise universe.maxRiskTier in curator/policy.json, or drop the leg');
      }
      if (universe.requirePythFeedId && !pool.pythFeedId) {
        push('POOL_DENIED', `${symbol} has no Pyth feed; universe.requirePythFeedId is on`, 'set universe.requirePythFeedId to false in curator/policy.json (the rehearsal preset does), or drop the leg');
      }
      if (num(pool.maxExecutionLossBps) > num(universe.maxExecutionLossBps)) {
        push('POOL_COST_TOO_HIGH', `${symbol} allows ${pool.maxExecutionLossBps} bps execution loss; universe.maxExecutionLossBps is ${universe.maxExecutionLossBps}`, 'raise universe.maxExecutionLossBps in curator/policy.json, or drop the leg');
      }
    }
    const poolCap = pool && Number.isFinite(num(pool.maxWeightBps)) ? num(pool.maxWeightBps) : Infinity;
    const cap = Math.min(num(shape.maxLegWeightBps), poolCap);
    if (Number.isFinite(weightBps) && (weightBps < num(shape.minLegWeightBps) || weightBps > cap)) {
      push('LEG_WEIGHT_CAP', `${symbol} targets ${weightBps} bps; ${presetName} allows ${shape.minLegWeightBps}..${cap} bps (shape.minLegWeightBps..min(shape.maxLegWeightBps, the pool's maxWeightBps))`,
        'widen shape.minLegWeightBps / shape.maxLegWeightBps in curator/policy.json, or rebalance the book inside the band first');
    }
  }

  // The sleeve rules need every weight; with one missing the item above stands and a partial sum proves nothing.
  if (!weightsKnown) return items;
  const sums = new Map();
  for (const leg of legs) {
    const cat = categoryOf.get(leg.symbol);
    if (!cat) continue;
    sums.set(cat, (sums.get(cat) ?? 0) + leg.weightBps);
  }
  const stable = sums.get(shape.stableCategory) ?? 0;
  if (stable < num(shape.stableMinBps) || stable > num(shape.stableMaxBps)) {
    push('STABLE_BAND', `the ${shape.stableCategory} sleeve is ${stable} bps; ${presetName} wants ${shape.stableMinBps}..${shape.stableMaxBps} bps`,
      'change shape.stableMinBps / shape.stableMaxBps in curator/policy.json, or rebalance the sleeve inside the band first');
  }
  for (const [cat, total] of sums) {
    if (total > num(shape.categoryMaxBps)) {
      push('CATEGORY_CAP', `category ${cat} holds ${total} bps; ${presetName} caps a category at ${shape.categoryMaxBps} bps`,
        'raise shape.categoryMaxBps in curator/policy.json, or spread the book across categories first');
    }
  }
  return items;
}
