/**
 * Transaction verification (plan §4.3): the signer signs nothing it has not
 * decoded. The api is trusted to build well, not trusted absolutely — a
 * compromised api, a stale pin or a bug in a builder must not be able to
 * turn the curator key into a signature over something else.
 *
 * Pure: takes the built payload, the intent and the allowlists; returns a
 * verdict. The tests build fixtures with the api's real builders over a fake
 * connection and plant each violation (foreign program, wrong payer,
 * tampered targets, extra instruction, unknown lookup table, …) to prove
 * the refusal exists.
 *
 * What "every instruction" means here: the fee payer of every transaction,
 * the program of every instruction, the decoded name and accounts of every
 * program instruction, and the arguments the intent fixed (targets, amounts,
 * the new curator, the delay, the uri). Core programs are not a free pass
 * either: only the handful of core instructions the api's builders emit
 * (compute budget, a durable-nonce advance, an idempotent ATA create, a
 * memo) are accepted — a System `transfer` or a Token `transfer` inside a
 * "propose" is exactly the kind of instruction a bare program allowlist
 * would wave through, and it is refused as UNEXPECTED_INSTRUCTIONS.
 *
 * A proposal of more than PAGE_LEGS (8) legs is a case of its own: the api
 * builds it as `propose_targets_page` pages, which this verifier does not
 * decode (policy caps a proposal at 8 legs, so it is unreachable today), and
 * it is refused by name — PAGED_PROPOSE_UNSUPPORTED — rather than as a
 * generic mismatch, so the journal says why and nobody "fixes" the mismatch.
 */
import { createHash } from 'node:crypto';
import anchor from '@coral-xyz/anchor';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { PAGE_LEGS, programId as pinnedProgramId } from '@composable-portfolios/chain';
import { Refusal } from './errors.js';

/** Core Solana programs a curator transaction may touch (same ids as api sendSigned.js). */
export const CORE_PROGRAMS = Object.freeze({
  system: '11111111111111111111111111111111',
  compute_budget: 'ComputeBudget111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associated_token: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
});
const CORE_BY_ID = new Map(Object.entries(CORE_PROGRAMS).map(([name, id]) => [id, name]));

/** Programs the manifest may pin and this module can name. Others in the allowlist are refused as undecodable. */
export const KNOWN_PROGRAMS = Object.freeze([
  'portfolio_factory', 'stoken', 'portfolio_nav', 'portfolio_allocator', 'accountant', 'asset_manager_escrow',
]);

/**
 * Core instructions accepted in any transaction of any verb: what
 * `serialiseTx`/`flows.js serialise()` prepend (compute budget, a durable
 * nonce advance) and a memo. Everything else on a core program is refused.
 */
export const ALWAYS_ALLOWED = Object.freeze(new Set([
  'compute_budget:set_compute_unit_limit',
  'compute_budget:set_compute_unit_price',
  'compute_budget:request_heap_frame',
  'compute_budget:set_loaded_accounts_data_size_limit',
  'system:advance_nonce_account',
  'memo:memo',
]));

const ATA_CREATE = 'associated_token:create_idempotent';
const NAV_CRANKS = Object.freeze(['portfolio_nav:crank_pool', 'portfolio_nav:crank_nav_page']);
/** The keeper reimbursement the api puts inside `create_portfolio` (or in its own `fund_operator` step when the packet is full). */
const SYSTEM_TRANSFER = 'system:transfer';
/** The runtime's compute-unit cap per transaction: assumed for the create's priority-fee bound when a step sets a price without a limit. */
const CU_LIMIT_MAX = 1_400_000;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/**
 * The api's create manifest (`build.js manifest()`, operator setup) and who
 * signs each step. The treasury signs its own steps only; the keeper's are
 * "not mine": they must be where the manifest puts them, signed and paid by
 * someone who is not the treasury, and touch no program outside the
 * allowlist — nothing in them is decoded or vouched for.
 */
export const CREATE_STEPS = Object.freeze({
  create_portfolio: 'creator',
  create_portfolio_page: 'creator',
  fund_operator: 'creator',
  init_portfolio_shares: 'keeper_processor',
  init_custody: 'keeper_processor',
  init_vault_atas: 'keeper_processor',
  whitelist_custodian: 'keeper_processor',
  activate_portfolio: 'keeper_processor',
});

/**
 * The most legs a proposal may carry and still be one `propose_targets`
 * instruction (the api's `PAGE_LEGS`). Above it the api emits
 * `propose_targets_page` pages, which are refused as PAGED_PROPOSE_UNSUPPORTED.
 */
export const PROPOSE_MAX_LEGS = PAGE_LEGS;
const PROPOSE_PAGE = 'portfolio_factory:propose_targets_page';

/**
 * What each api `step` may carry. `required` must appear exactly once in
 * the step's transaction; `optional` may appear any number of times;
 * anything else is UNEXPECTED_INSTRUCTIONS. `paged` steps carry `pageIndex`
 * and their decoded page index must match and run 0..n-1 across the payload.
 */
export const STEP_RULES = Object.freeze({
  propose_targets: { required: ['portfolio_factory:propose_targets'], optional: [] },
  create_custody: { required: [], optional: [ATA_CREATE], atLeastOne: ATA_CREATE },
  apply_targets: { required: ['portfolio_factory:apply_targets'], optional: [], paged: true },
  cancel_targets: { required: ['portfolio_factory:cancel_targets'], optional: [] },
  deposit: { required: ['stoken:deposit'], optional: [ATA_CREATE, ...NAV_CRANKS] },
  withdraw_request: { required: ['stoken:withdraw_request'], optional: [ATA_CREATE, ...NAV_CRANKS] },
  crank_nav: { required: ['portfolio_nav:crank_nav_page'], optional: ['portfolio_nav:crank_pool'], paged: true },
  propose_curator: { required: ['portfolio_factory:propose_curator'], optional: [] },
  update_portfolio_rebalance_delay: { required: ['portfolio_factory:update_portfolio_rebalance_delay'], optional: [] },
  set_portfolio_metadata: { required: ['portfolio_factory:set_portfolio_metadata'], optional: [] },
  // The create (treasury-signed, `create` verb only): the one place a System
  // transfer is admitted — the keeper reimbursement, whose accounts and amount
  // are checked (`checkCreateInstruction`), at most once across the payload.
  create_portfolio: { required: ['portfolio_factory:create_portfolio'], optional: [SYSTEM_TRANSFER] },
  create_portfolio_page: { required: ['portfolio_factory:create_portfolio_page'], optional: [], paged: true },
  fund_operator: { required: [SYSTEM_TRANSFER], optional: [] },
});

const VERB_ALIASES = Object.freeze({
  refreshnav: 'refresh-nav',
  refresh_nav: 'refresh-nav',
  rotatecurator: 'rotate-curator',
  rotate_curator: 'rotate-curator',
  setdelay: 'set-delay',
  set_delay: 'set-delay',
  setmetadata: 'set-metadata',
  set_metadata: 'set-metadata',
});

const verbSpec = (primary, { pre = [], paged = false } = {}) => Object.freeze({
  steps: Object.freeze(new Set([...pre, primary])),
  instructions: Object.freeze(new Set([
    ...STEP_RULES[primary].required,
    ...STEP_RULES[primary].optional,
    ...pre.flatMap((step) => [...STEP_RULES[step].required, ...STEP_RULES[step].optional]),
  ])),
  primary,
  pre: Object.freeze(pre),
  paged,
});

/** Expected api steps and program instructions per verb (README §6). Keyed by route name. */
export const EXPECTED_STEPS = Object.freeze({
  propose: verbSpec('propose_targets'),
  apply: verbSpec('apply_targets', { pre: ['create_custody'], paged: true }),
  cancel: verbSpec('cancel_targets'),
  deposit: verbSpec('deposit'),
  withdraw: verbSpec('withdraw_request'),
  'refresh-nav': verbSpec('crank_nav', { paged: true }),
  'rotate-curator': verbSpec('propose_curator'),
  'set-delay': verbSpec('update_portfolio_rebalance_delay'),
  'set-metadata': verbSpec('set_portfolio_metadata'),
  // The WEAVR create, run once from the laptop by `scripts/create_portfolio.mjs`
  // (policy `verbs.denied` keeps `create` out of the signer process). `mine`
  // are the treasury-signed steps; the rest are the keeper's. Walked by
  // `verifyCreate`, not the single-primary walk above.
  create: Object.freeze({
    steps: Object.freeze(new Set(Object.keys(CREATE_STEPS))),
    instructions: Object.freeze(new Set(['create_portfolio', 'create_portfolio_page', 'fund_operator']
      .flatMap((step) => [...STEP_RULES[step].required, ...STEP_RULES[step].optional]))),
    primary: 'create_portfolio',
    pre: Object.freeze([]),
    paged: true,
    signers: CREATE_STEPS,
    mine: Object.freeze(new Set(Object.entries(CREATE_STEPS).filter(([, signer]) => signer === 'creator').map(([step]) => step))),
  }),
});

// ------------------------------------------------------------- helpers

const refuse = (code, message, detail) => new Refusal(code, message, detail);

const asBase58 = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toBase58 === 'function') return value.toBase58();
  return String(value);
};

const ixDisc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const NAV_DISCS = Object.freeze([
  { name: 'crank_pool', disc: ixDisc('crank_pool'), length: 8 },
  { name: 'crank_nav_page', disc: ixDisc('crank_nav_page'), length: 10 },
]);

const SYSTEM_IX = ['create_account', 'assign', 'transfer', 'create_account_with_seed', 'advance_nonce_account',
  'withdraw_nonce_account', 'initialize_nonce_account', 'authorize_nonce_account', 'allocate', 'allocate_with_seed',
  'assign_with_seed', 'transfer_with_seed', 'upgrade_nonce_account'];
const COMPUTE_BUDGET_IX = ['request_units', 'request_heap_frame', 'set_compute_unit_limit', 'set_compute_unit_price',
  'set_loaded_accounts_data_size_limit'];
const ATA_IX = ['create', 'create_idempotent', 'recover_nested'];
const TOKEN_IX = { 0: 'initialize_mint', 1: 'initialize_account', 3: 'transfer', 4: 'approve', 5: 'revoke',
  6: 'set_authority', 7: 'mint_to', 8: 'burn', 9: 'close_account', 12: 'transfer_checked', 17: 'sync_native',
  18: 'initialize_account3', 22: 'initialize_immutable_owner' };

/** The instruction name of a core-program instruction, from its data prefix. */
function coreInstructionName(program, data) {
  switch (program) {
    case 'compute_budget':
      return COMPUTE_BUDGET_IX[data[0]] ?? `compute_budget#${data[0] ?? 'empty'}`;
    case 'system': {
      if (data.length < 4) return 'system#malformed';
      const index = data.readUInt32LE(0);
      return SYSTEM_IX[index] ?? `system#${index}`;
    }
    case 'associated_token':
      return data.length === 0 ? 'create' : (ATA_IX[data[0]] ?? `associated_token#${data[0]}`);
    case 'token':
    case 'token_2022':
      return TOKEN_IX[data[0]] ?? `${program}#${data[0] ?? 'empty'}`;
    case 'memo':
      return 'memo';
    default:
      return 'unknown';
  }
}

/** Decoded Anchor data as plain JSON: PublicKey → base58, BN → decimal string. */
export function plain(value) {
  if (value == null) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value.toBase58 === 'function') return value.toBase58();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (anchor.BN.isBN?.(value) || (typeof value.toString === 'function' && value.constructor?.name === 'BN')) {
    return value.toString(10);
  }
  if (Array.isArray(value)) return value.map(plain);
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
}

const coders = new WeakMap();
function coderFor(idl) {
  if (!coders.has(idl)) coders.set(idl, new anchor.BorshInstructionCoder(idl));
  return coders.get(idl);
}

const ASSOCIATED_TOKEN_PROGRAM = new PublicKey(CORE_PROGRAMS.associated_token);
function associatedTokenAddress(mint, owner, tokenProgram) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0].toBase58();
}

/**
 * `expect.programIds` as a base58 → name map. Accepts `{ name: id }`,
 * `Map(id → name)` or nothing (the manifest's pins for KNOWN_PROGRAMS).
 */
function programNames(programIds) {
  const names = new Map();
  if (programIds instanceof Map) {
    for (const [key, value] of programIds) {
      // Either orientation: a base58 key is 32–44 chars and never a known name.
      if (KNOWN_PROGRAMS.includes(key)) names.set(asBase58(value), key);
      else names.set(key, value);
    }
    return names;
  }
  if (programIds && typeof programIds === 'object') {
    for (const [name, id] of Object.entries(programIds)) names.set(asBase58(id), name);
    return names;
  }
  for (const name of KNOWN_PROGRAMS) {
    try {
      names.set(pinnedProgramId(name).toBase58(), name);
    } catch {
      // not pinned on this deployment
    }
  }
  return names;
}

/**
 * `expect.lookupTables` as `{ allowed: Set<base58>, addresses: Map<base58, (base58|null)[]> }`.
 * A Set names the tables a v0 message may load from without telling us
 * their contents; a Map / object / array of `AddressLookupTableAccount`
 * also lets loaded addresses be resolved. Unresolved addresses are `null`
 * and refuse any check that needs them.
 */
function lookupTableSpec(value) {
  const allowed = new Set();
  const addresses = new Map();
  const put = (key, list) => {
    const id = asBase58(key);
    allowed.add(id);
    const entries = Array.isArray(list) ? list : (list?.state?.addresses ?? null);
    if (entries) addresses.set(id, entries.map(asBase58));
  };
  if (value == null) return { allowed, addresses };
  if (value instanceof Set) {
    for (const key of value) allowed.add(asBase58(key));
  } else if (value instanceof Map) {
    for (const [key, list] of value) put(key, list);
  } else if (Array.isArray(value)) {
    for (const table of value) {
      if (table?.key) put(table.key, table);
      else allowed.add(asBase58(table));
    }
  } else if (typeof value === 'object') {
    for (const [key, list] of Object.entries(value)) put(key, list);
  } else {
    allowed.add(asBase58(value));
  }
  return { allowed, addresses };
}

// ------------------------------------------------------------- parsing

/**
 * One encoded transaction as `{ version, payer, bytes, instructions:[{ programId, accounts:(base58|null)[], data:Buffer }] }`.
 * v0 messages may load addresses only from allowed tables; an address whose
 * table contents were not provided stays `null`.
 * @throws {Refusal} NOT_A_TRANSACTION, FOREIGN_LOOKUP_TABLE
 */
export function parseTransaction(base64, lookupTables) {
  const tables = lookupTableSpec(lookupTables);
  let raw;
  try {
    raw = Buffer.from(String(base64 ?? ''), 'base64');
  } catch {
    throw refuse('NOT_A_TRANSACTION', 'not a transaction: undecodable base64');
  }
  if (raw.length === 0) throw refuse('NOT_A_TRANSACTION', 'not a transaction: empty payload');
  let versioned;
  try {
    versioned = VersionedTransaction.deserialize(raw);
  } catch (error) {
    throw refuse('NOT_A_TRANSACTION', `not a transaction: ${String(error?.message ?? error).slice(0, 120)}`);
  }
  const { message } = versioned;

  if (message.version === 'legacy') {
    let tx;
    try {
      tx = Transaction.from(raw);
    } catch (error) {
      throw refuse('NOT_A_TRANSACTION', `not a legacy transaction: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    return {
      version: 'legacy',
      payer: tx.feePayer ? tx.feePayer.toBase58() : null,
      bytes: raw.length,
      tables: [],
      instructions: tx.instructions.map((ix) => ({
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((meta) => meta.pubkey.toBase58()),
        data: Buffer.from(ix.data),
      })),
    };
  }
  if (message.version !== 0) {
    throw refuse('NOT_A_TRANSACTION', `unsupported message version ${String(message.version)}`);
  }

  const statics = message.staticAccountKeys.map((key) => key.toBase58());
  const lookups = message.addressTableLookups ?? [];
  const writable = [];
  const readonly = [];
  for (const lookup of lookups) {
    const table = lookup.accountKey.toBase58();
    if (!tables.allowed.has(table)) {
      throw refuse('FOREIGN_LOOKUP_TABLE', `loads addresses from lookup table ${table}, which is not the NAV table`);
    }
    const contents = tables.addresses.get(table) ?? null;
    for (const index of lookup.writableIndexes) writable.push(contents ? (contents[index] ?? null) : null);
    for (const index of lookup.readonlyIndexes) readonly.push(contents ? (contents[index] ?? null) : null);
  }
  const keys = [...statics, ...writable, ...readonly];
  const instructions = message.compiledInstructions.map((ix) => {
    const program = keys[ix.programIdIndex];
    if (program == null) {
      throw refuse('FOREIGN_LOOKUP_TABLE', 'a program id is loaded from a lookup table this process cannot resolve');
    }
    return {
      programId: program,
      accounts: ix.accountKeyIndexes.map((index) => keys[index] ?? null),
      data: Buffer.from(ix.data),
    };
  });
  return {
    version: 0,
    payer: statics[0] ?? null,
    bytes: raw.length,
    tables: lookups.map((lookup) => lookup.accountKey.toBase58()),
    instructions,
  };
}

/**
 * Classify one parsed instruction: refuse a foreign program, name a core
 * instruction, decode a program instruction through its IDL (or, for
 * portfolio_nav which ships no IDL, by discriminator).
 * @throws {Refusal} FOREIGN_PROGRAM, UNKNOWN_INSTRUCTION
 */
function classify(ix, deps) {
  const { programId, accounts, data } = ix;
  if (!deps.allowedPrograms.has(programId)) {
    throw refuse('FOREIGN_PROGRAM', `instruction targets ${programId}, which is not a weavr or core program`);
  }
  const core = CORE_BY_ID.get(programId);
  if (core) {
    // `raw` keeps the bytes so a core instruction with arguments the intent
    // fixes (the create's reimbursement transfer) can be checked.
    return { program: core, programId, name: coreInstructionName(core, data), accounts, accountsByName: {}, data: {}, raw: data, core: true };
  }
  const program = deps.programNames.get(programId);
  if (!program) {
    throw refuse('UNKNOWN_INSTRUCTION', `program ${programId} is allowed but this process cannot decode it`);
  }
  if (program === 'portfolio_nav') {
    const match = NAV_DISCS.find((entry) => data.length === entry.length && data.subarray(0, 8).equals(entry.disc));
    if (!match) throw refuse('UNKNOWN_INSTRUCTION', 'portfolio_nav instruction is not crank_pool or crank_nav_page');
    const decoded = match.name === 'crank_nav_page' ? { page_index: data.readUInt16LE(8) } : {};
    const accountsByName = match.name === 'crank_nav_page'
      ? { payer: accounts[0] ?? null, vault: accounts[5] ?? null }
      : { pool: accounts[2] ?? null, vault: accounts[4] ?? null };
    return { program, programId, name: match.name, accounts, accountsByName, data: decoded, core: false };
  }
  const idl = deps.idls?.[program];
  if (!idl) throw refuse('UNKNOWN_INSTRUCTION', `no IDL for ${program}; cannot decode its instruction`);
  let decoded = null;
  try {
    decoded = coderFor(idl).decode(data);
  } catch {
    decoded = null;
  }
  if (!decoded) throw refuse('UNKNOWN_INSTRUCTION', `${program} instruction does not decode against the IDL`);
  const spec = idl.instructions.find((entry) => entry.name === decoded.name);
  const accountsByName = {};
  (spec?.accounts ?? []).forEach((account, index) => {
    accountsByName[account.name] = accounts[index] ?? null;
  });
  if ((spec?.accounts?.length ?? 0) > accounts.length) {
    throw refuse('UNKNOWN_INSTRUCTION', `${program}.${decoded.name} carries fewer accounts than the IDL declares`);
  }
  return { program, programId, name: decoded.name, accounts, accountsByName, data: plain(decoded.data), core: false };
}

/**
 * Decode every instruction of one encoded transaction (legacy or v0).
 * v0 messages may load addresses only from `lookupTables`; an address the
 * process cannot resolve is `null` in `accounts`, never a pass.
 * @param {string} base64
 * @param {{ idls: object, allowedPrograms: Set<string>, lookupTables?: Set<string> | Map<string, string[]>, programIds?: object }} deps
 * @returns {Array<{ program: string, programId: string, name: string, accounts: (string|null)[], accountsByName: object, data: object, core: boolean }>}
 * @throws {import('./errors.js').Refusal}
 */
export function decodeInstructions(base64, deps) {
  return decodeTransaction(base64, deps).instructions;
}

function decodeTransaction(base64, deps) {
  if (!(deps?.allowedPrograms instanceof Set)) throw new Error('decode: allowedPrograms must be a Set of base58 program ids');
  const parsed = parseTransaction(base64, deps.lookupTables);
  const classified = {
    allowedPrograms: deps.allowedPrograms,
    idls: deps.idls ?? {},
    programNames: deps.programNames ?? programNames(deps.programIds),
  };
  return { ...parsed, instructions: parsed.instructions.map((ix) => classify(ix, classified)) };
}

// ------------------------------------------------------------- semantics

const key = (ix) => `${ix.program}:${ix.name}`;

function normaliseVerb(verb) {
  const text = String(verb ?? '').trim();
  const lower = text.toLowerCase();
  if (EXPECTED_STEPS[lower]) return lower;
  return VERB_ALIASES[lower] ?? VERB_ALIASES[text.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()] ?? lower;
}

/** Approved targets as `[{ pool: base58, weight_bps }]`, resolving poolId through `expect.poolKeys`. */
function expectedTargets(expect) {
  const keys = expect.poolKeys instanceof Map ? expect.poolKeys : new Map(Object.entries(expect.poolKeys ?? {}));
  return expect.targets.map((target, index) => {
    const pool = target.pool ?? keys.get(target.poolId) ?? null;
    if (!pool) {
      throw refuse('TARGETS_MISMATCH', `target ${index} (${target.poolId ?? '?'}) has no Pool key to compare against`);
    }
    return { pool: asBase58(pool), weight_bps: Number(target.weightBps ?? target.weight_bps) };
  });
}

const sameValue = (actual, expected) => String(actual) === String(expected);

/** Refuse when an argument the intent fixed differs from what was built. */
function assertArg(ix, field, expected, label) {
  if (expected === undefined) return;
  const actual = ix.data?.[field];
  if (expected === null ? actual !== null : (actual == null || !sameValue(actual, expected))) {
    throw refuse('TARGETS_MISMATCH', `${ix.program}.${ix.name} ${label ?? field} is ${actual ?? 'absent'}, the approved intent says ${expected}`);
  }
}

function assertAccount(ix, name, expected, code = 'WRONG_ACCOUNT') {
  const actual = ix.accountsByName[name];
  if (actual == null) {
    throw refuse('UNKNOWN_INSTRUCTION', `${ix.program}.${ix.name} account ${name} is loaded from a lookup table this process cannot resolve`);
  }
  if (actual !== expected) {
    throw refuse(code, `${ix.program}.${ix.name} ${name} is ${actual}, expected ${expected}`);
  }
}

function assertSelfAta(ix, name, mintName, payer) {
  const mint = ix.accountsByName[mintName];
  const tokenProgram = ix.accountsByName.token_program;
  if (mint == null || tokenProgram == null) {
    throw refuse('UNKNOWN_INSTRUCTION', `${ix.program}.${ix.name} ${mintName}/token_program unresolved`);
  }
  assertAccount(ix, name, associatedTokenAddress(mint, payer, tokenProgram));
}

/** The checks a decoded program instruction must pass for this verb and intent. */
function checkProgramInstruction(ix, tx, ctx) {
  const { expect, payer } = ctx;
  switch (key(ix)) {
    case 'portfolio_factory:propose_targets': {
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'curator', payer);
      const wanted = JSON.stringify(ctx.targets);
      const got = JSON.stringify((ix.data.targets ?? []).map((t) => ({ pool: t.pool, weight_bps: Number(t.weight_bps) })));
      if (wanted !== got) throw refuse('TARGETS_MISMATCH', 'the built targets differ from the approved intent');
      return;
    }
    case 'portfolio_factory:apply_targets':
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'caller', payer);
      if (expect.vault !== undefined) assertAccount(ix, 'vault', expect.vault, 'WRONG_PORTFOLIO');
      return;
    case 'portfolio_factory:cancel_targets':
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'signer', payer);
      return;
    case 'portfolio_factory:propose_curator':
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'signer', payer);
      assertArg(ix, 'new_curator', expect.newCurator === undefined ? undefined : asBase58(expect.newCurator), 'new_curator');
      return;
    case 'portfolio_factory:update_portfolio_rebalance_delay':
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'curator', payer);
      assertArg(ix, 'new_secs', expect.rebalanceDelaySecs, 'new_secs');
      return;
    case 'portfolio_factory:set_portfolio_metadata':
      assertAccount(ix, 'portfolio', expect.portfolio, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'signer', payer);
      assertArg(ix, 'uri', expect.uri, 'uri');
      return;
    case 'stoken:deposit':
      assertAccount(ix, 'vault_config', expect.vault, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'user', payer);
      assertSelfAta(ix, 'user_underlying_account', 'underlying_mint', payer);
      assertSelfAta(ix, 'user_s_token_account', 'shares_mint', payer);
      // The depositor is the beneficiary; a beneficiary that is anyone else
      // is the curator's USDC minting shares to a stranger.
      assertSelfAta(ix, 'beneficiary_s_token_account', 'shares_mint', payer);
      assertArg(ix, 'amount', expect.amount);
      assertArg(ix, 'min_shares', expect.minShares, 'min_shares');
      return;
    case 'stoken:withdraw_request':
      assertAccount(ix, 'vault_config', expect.vault, 'WRONG_PORTFOLIO');
      assertAccount(ix, 'user', payer);
      assertSelfAta(ix, 'user_s_token_account', 'shares_mint', payer);
      assertArg(ix, 'shares', expect.shares);
      assertArg(ix, 'min_amount_out', expect.minAmountOut, 'min_amount_out');
      return;
    case 'portfolio_nav:crank_nav_page':
      assertAccount(ix, 'payer', payer);
      if (expect.vault !== undefined) assertAccount(ix, 'vault', expect.vault, 'WRONG_PORTFOLIO');
      return;
    case 'portfolio_nav:crank_pool':
      return;
    case ATA_CREATE: {
      // [payer, ata, owner, mint, system, token_program]: the curator pays
      // rent only for its own ATAs (deposit/withdraw) or the custodian's
      // (create_custody), and the address must be the derived one.
      const [ataPayer, ata, owner, mint, , tokenProgram] = ix.accounts;
      if ([ataPayer, ata, owner, mint, tokenProgram].some((value) => value == null)) {
        throw refuse('UNKNOWN_INSTRUCTION', 'associated_token.create_idempotent accounts unresolved');
      }
      if (ataPayer !== payer) throw refuse('WRONG_ACCOUNT', `associated_token.create_idempotent is paid by ${ataPayer}, not the signer`);
      if (ata !== associatedTokenAddress(mint, owner, tokenProgram)) {
        throw refuse('WRONG_ACCOUNT', 'associated_token.create_idempotent address is not the derived ATA');
      }
      const allowedOwner = tx.step === 'create_custody' ? ctx.custodian : payer;
      if (allowedOwner != null && owner !== allowedOwner) {
        throw refuse('WRONG_ACCOUNT', `associated_token.create_idempotent owner is ${owner}, expected ${allowedOwner}`);
      }
      return;
    }
    default:
      return;
  }
}

/** The allocator's `custodian` PDA for a vault, or null when the allocator is not pinned. */
function custodianFor(vault, programNamesMap) {
  if (vault == null) return null;
  const allocator = [...programNamesMap].find(([, name]) => name === 'portfolio_allocator')?.[0];
  if (!allocator) return null;
  return PublicKey.findProgramAddressSync(
    [Buffer.from('custodian'), new PublicKey(vault).toBuffer()],
    new PublicKey(allocator),
  )[0].toBase58();
}

// ------------------------------------------------------------- create

/** A snake_case argument of a decoded instruction that the intent fixed. */
function assertField(ix, values, field, expected, label = field) {
  if (expected === undefined) return;
  const actual = values?.[field];
  const want = typeof expected === 'boolean' ? String(expected) : String(asBase58(expected));
  if (actual == null || String(actual) !== want) {
    throw refuse('TARGETS_MISMATCH', `${ix.program}.${ix.name} ${label} is ${actual ?? 'absent'}, the approved intent says ${want}`);
  }
}

const targetList = (targets) => (targets ?? []).map((t) => ({ pool: asBase58(t.pool), weight_bps: Number(t.weight_bps) }));

/** A PDA of a pinned program, or null when the program is not pinned. */
function derivedKey(programNamesMap, program, seeds) {
  const id = [...programNamesMap].find(([, name]) => name === program)?.[0];
  if (!id) return null;
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(id))[0].toBase58();
}

/** A lamport amount out of a decoded argument (a BN as a decimal string) or a number; anything else is undecodable. */
function lamportsOf(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw refuse('UNKNOWN_INSTRUCTION', `${label} is not a lamport amount`);
}

/** A ceiling the caller fixes for the create: a non-negative integer of lamports (number, bigint or decimal string); anything else is a caller bug. */
function ceilingOf(value, name) {
  const ok = (typeof value === 'bigint' && value >= 0n)
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d+$/.test(value));
  if (!ok) throw new Error(`verifyBuilt: expect.${name} must be a non-negative integer of lamports for create`);
  return BigInt(value);
}

/**
 * The priority fee a transaction's compute-budget instructions commit, priced
 * the way the runtime prices it: `set_compute_unit_limit` (u32 units, capped
 * at 1.4M) × `set_compute_unit_price` (u64 micro-lamports per unit), rounded
 * up. Without a limit the runtime's cap is assumed; of duplicated
 * instructions the largest counts. Both are `ALWAYS_ALLOWED`, which is why
 * the create verb bounds them by value rather than by name.
 */
function priorityFeeOf(instructions) {
  let limit = null;
  let price = 0n;
  for (const ix of instructions) {
    const name = key(ix);
    if (name !== 'compute_budget:set_compute_unit_limit' && name !== 'compute_budget:set_compute_unit_price') continue;
    const raw = ix.raw ?? Buffer.alloc(0);
    if (name === 'compute_budget:set_compute_unit_limit') {
      if (raw.length < 5) throw refuse('UNKNOWN_INSTRUCTION', 'set_compute_unit_limit data is malformed');
      const units = raw.readUInt32LE(1);
      limit = limit == null ? units : Math.max(limit, units);
    } else {
      if (raw.length < 9) throw refuse('UNKNOWN_INSTRUCTION', 'set_compute_unit_price data is malformed');
      const micro = raw.readBigUInt64LE(1);
      if (micro > price) price = micro;
    }
  }
  const units = BigInt(Math.min(limit ?? CU_LIMIT_MAX, CU_LIMIT_MAX));
  const lamports = (units * price + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
  return { units, microLamports: price, lamports };
}

/**
 * The checks a decoded instruction of a treasury-signed create step must pass.
 * `state` accumulates what the summary reports and what the payload-wide
 * rules (targets across pages, one reimbursement, the outlay) need.
 */
function checkCreateInstruction(ix, tx, ctx, state) {
  const { expect, payer, keeper } = ctx;
  const addresses = expect.addresses ?? {};
  switch (key(ix)) {
    case 'portfolio_factory:create_portfolio': {
      assertAccount(ix, 'creator', payer);
      if (addresses.portfolio != null) assertAccount(ix, 'portfolio', asBase58(addresses.portfolio), 'WRONG_PORTFOLIO');
      if (addresses.vault != null) assertAccount(ix, 'vault', asBase58(addresses.vault), 'WRONG_PORTFOLIO');
      if (addresses.custodian != null) assertAccount(ix, 'custodian', asBase58(addresses.custodian));
      if (addresses.accountant != null) assertAccount(ix, 'accountant', asBase58(addresses.accountant));
      const args = ix.data?.args ?? {};
      assertField(ix, args, 'curator', expect.curator);
      assertField(ix, args, 'rebalance_delay_secs', expect.rebalanceDelaySecs);
      assertField(ix, args, 'name', expect.name);
      assertField(ix, args, 'symbol', expect.symbol);
      assertField(ix, args, 'metadata_uri', expect.metadataUri);
      assertField(ix, args, 'deposit_fee_bps', expect.depositFeeBps);
      assertField(ix, args, 'withdraw_fee_bps', expect.withdrawFeeBps);
      assertField(ix, args, 'management_fee_bps_per_year', expect.managementFeeBpsPerYear);
      assertField(ix, args, 'creator_fee_bps', expect.creatorFeeBps);
      assertField(ix, args, 'drift_band_bps', expect.driftBandBps);
      assertField(ix, args, 'idle_target_bps', expect.idleTargetBps);
      assertField(ix, args, 'composition_locked', expect.compositionLocked);
      assertField(ix, args, 'factory_rent_lamports', expect.factoryRentLamports);
      assertField(ix, args, 'custodian_reserve_lamports', expect.custodianReserveLamports);
      // The mint the CLI reports is derived from the vault the treasury signs
      // for, never copied from the api's echo; an echo that disagrees refuses.
      const vault = ix.accountsByName.vault;
      const sharesMint = vault ? derivedKey(ctx.programNamesMap, 'stoken', [Buffer.from('shares_mint'), new PublicKey(vault).toBuffer()]) : null;
      if (addresses.sharesMint != null && sharesMint != null && sharesMint !== asBase58(addresses.sharesMint)) {
        throw refuse('WRONG_ACCOUNT', `the shares mint derived from the signed vault is ${sharesMint}, the api says ${asBase58(addresses.sharesMint)}`);
      }
      state.headerTargets = targetList(args.targets);
      state.create = {
        name: args.name ?? null,
        symbol: args.symbol ?? null,
        metadataUri: args.metadata_uri ?? null,
        curator: args.curator ?? null,
        rebalanceDelaySecs: args.rebalance_delay_secs ?? null,
        depositFeeBps: args.deposit_fee_bps ?? null,
        withdrawFeeBps: args.withdraw_fee_bps ?? null,
        managementFeeBpsPerYear: args.management_fee_bps_per_year ?? null,
        creatorFeeBps: args.creator_fee_bps ?? null,
        driftBandBps: args.drift_band_bps ?? null,
        idleTargetBps: args.idle_target_bps ?? null,
        compositionLocked: args.composition_locked ?? null,
        factoryRentLamports: args.factory_rent_lamports ?? null,
        custodianReserveLamports: args.custodian_reserve_lamports ?? null,
        keeperLamports: null,
        portfolio: ix.accountsByName.portfolio ?? null,
        vault: vault ?? null,
        custodian: ix.accountsByName.custodian ?? null,
        accountant: ix.accountsByName.accountant ?? null,
        sharesMint,
        targets: [],
      };
      return;
    }
    case 'portfolio_factory:create_portfolio_page': {
      assertAccount(ix, 'creator', payer);
      if (addresses.portfolio != null) assertAccount(ix, 'portfolio', asBase58(addresses.portfolio), 'WRONG_PORTFOLIO');
      if (addresses.vault != null) assertAccount(ix, 'vault', asBase58(addresses.vault), 'WRONG_PORTFOLIO');
      const page = Number(ix.data?.page_index);
      if (tx.pageIndex != null && Number(tx.pageIndex) !== page) {
        throw refuse('UNEXPECTED_INSTRUCTIONS', `create_portfolio_page pageIndex ${tx.pageIndex} does not match the instruction's page ${page}`);
      }
      state.pages.push({ page, totalLegs: Number(ix.data?.total_legs), targets: targetList(ix.data?.targets) });
      return;
    }
    case SYSTEM_TRANSFER: {
      const [from, to] = ix.accounts;
      if (from == null || to == null) throw refuse('UNKNOWN_INSTRUCTION', 'system.transfer accounts are loaded from a lookup table this process cannot resolve');
      if (from !== payer) throw refuse('WRONG_ACCOUNT', `system.transfer moves lamports from ${from}, not the treasury`);
      if (keeper === undefined) throw refuse('WRONG_ACCOUNT', 'system.transfer destination cannot be checked: the intent names no keeperProcessor');
      if (to !== keeper) throw refuse('WRONG_ACCOUNT', `system.transfer pays ${to}, not the keeper processor ${keeper}`);
      const raw = ix.raw ?? Buffer.alloc(0);
      if (raw.length < 12) throw refuse('UNKNOWN_INSTRUCTION', 'system.transfer data is malformed');
      const lamports = raw.readBigUInt64LE(4).toString();
      if (expect.keeperLamports !== undefined && lamports !== String(expect.keeperLamports)) {
        throw refuse('TARGETS_MISMATCH', `system.transfer lamports is ${lamports}, the api quoted ${expect.keeperLamports} for the keeper reimbursement`);
      }
      state.transfers += 1;
      if (state.transfers > 1) throw refuse('UNEXPECTED_INSTRUCTIONS', 'the payload carries more than one keeper reimbursement transfer');
      state.keeperLamports = lamports;
      return;
    }
    default:
      return;
  }
}

/**
 * The `create` verb: the treasury signs `create_portfolio` (plus a
 * `create_portfolio_page` per eight legs beyond the first, and `fund_operator`
 * when the packet was full) and nothing else. Every creator step precedes the
 * first keeper step, `create_portfolio` comes first and exactly once, pages run
 * 0..n−1, and the targets — in the header or across the pages — equal the
 * intent byte for byte. Keeper steps are checked for placement, a signer and
 * fee payer that are not the treasury, and the program allowlist only.
 *
 * Every lamport the treasury commits is bounded by the intent, never by the
 * api's own numbers: the reimbursement transfer plus the `factory_rent_lamports`
 * and `custodian_reserve_lamports` the program moves out of `creator` must not
 * exceed `expect.maxLamports`, and each treasury transaction's priority fee
 * (compute-unit limit × price) must not exceed `expect.maxPriorityLamports`.
 * The build's `rentLamports` quote, when given, is a cross-check on top.
 */
function verifyCreate({ transactions, expect, payer, deps, programNamesMap }) {
  const curator = expect.curator == null ? null : asBase58(expect.curator);
  if (!curator) throw new Error('verifyBuilt: expect.curator is required for create');
  if (expect.rebalanceDelaySecs == null) throw new Error('verifyBuilt: expect.rebalanceDelaySecs is required for create');
  if (!Array.isArray(expect.targets)) throw new Error('verifyBuilt: expect.targets is required for create');
  const maxLamports = ceilingOf(expect.maxLamports, 'maxLamports');
  const maxPriorityLamports = ceilingOf(expect.maxPriorityLamports, 'maxPriorityLamports');
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw refuse('UNEXPECTED_INSTRUCTIONS', 'the payload carries no transactions');
  }
  const wanted = expectedTargets(expect);
  const keeper = expect.keeperProcessor === undefined ? undefined : asBase58(expect.keeperProcessor);
  const ctx = { expect: { ...expect, curator }, payer, keeper, programNamesMap };
  const state = { headerTargets: null, pages: [], transfers: 0, keeperLamports: null, priorityLamports: 0n, create: null };
  const summary = { txCount: 0, transactions: 0, steps: [], instructions: [], bytes: 0, pages: [], mine: [], theirs: [], create: null };
  let creates = 0;
  let sawKeeper = false;
  let fundSeen = false;

  transactions.forEach((tx, position) => {
    if (!tx || typeof tx !== 'object' || typeof tx.tx !== 'string') {
      throw refuse('NOT_A_TRANSACTION', `transactions[${position}] carries no encoded transaction`);
    }
    const step = String(tx.step ?? '');
    const role = CREATE_STEPS[step];
    if (!role) throw refuse('UNEXPECTED_STEP', `step ${step || '(none)'} is not part of create`);
    const claimed = tx.signer == null ? role : String(tx.signer);
    if (claimed !== role) throw refuse('UNEXPECTED_STEP', `${step} is signed by ${role}; the payload marks it ${claimed}`);

    if (role === 'creator') {
      if (sawKeeper) throw refuse('UNEXPECTED_STEP', `${step} comes after a keeper step; every creator step precedes the keeper's`);
      if (step === 'create_portfolio') {
        creates += 1;
        if (position !== 0) throw refuse('UNEXPECTED_STEP', 'create_portfolio must be the first transaction');
        if (creates > 1) throw refuse('UNEXPECTED_STEP', 'create builds one create_portfolio transaction, the payload has more');
      } else if (creates === 0) {
        throw refuse('UNEXPECTED_STEP', `${step} before create_portfolio`);
      }
      if (step === 'fund_operator') {
        if (fundSeen) throw refuse('UNEXPECTED_STEP', 'fund_operator appears more than once');
        fundSeen = true;
      }
      if (step === 'create_portfolio_page' && fundSeen) throw refuse('UNEXPECTED_STEP', 'create_portfolio_page after fund_operator');
      if (tx.signerKey != null && asBase58(tx.signerKey) !== payer) {
        throw refuse('WRONG_PAYER', `transactions[${position}] names ${asBase58(tx.signerKey)} as signer, not the treasury`);
      }
      const decoded = decodeTransaction(tx.tx, deps);
      if (decoded.payer !== payer) {
        throw refuse('WRONG_PAYER', `transactions[${position}] fee payer ${decoded.payer ?? 'unset'} is not the treasury`);
      }
      const rule = STEP_RULES[step];
      const counts = new Map();
      for (const ix of decoded.instructions) {
        const name = key(ix);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (!(ALWAYS_ALLOWED.has(name) || rule.required.includes(name) || rule.optional.includes(name))) {
          throw refuse('UNEXPECTED_INSTRUCTIONS', `${name} is not part of a ${step} transaction`);
        }
        summary.instructions.push({ step, program: ix.program, name: ix.name });
      }
      for (const name of rule.required) {
        const n = counts.get(name) ?? 0;
        if (n !== 1) throw refuse('UNEXPECTED_INSTRUCTIONS', `${step} must carry exactly one ${name}, it carries ${n}`);
      }
      for (const ix of decoded.instructions) checkCreateInstruction(ix, tx, ctx, state);
      const fee = priorityFeeOf(decoded.instructions);
      if (fee.lamports > maxPriorityLamports) {
        throw refuse('TARGETS_MISMATCH', `transactions[${position}] (${step}) carries a priority fee of ${fee.lamports} lamports (${fee.units} CU × ${fee.microLamports} µlamports), above the approved ceiling of ${maxPriorityLamports}`);
      }
      state.priorityLamports += fee.lamports;
      summary.mine.push(position);
      summary.bytes += decoded.bytes;
    } else {
      sawKeeper = true;
      if (tx.signerKey != null && asBase58(tx.signerKey) === payer) {
        throw refuse('WRONG_PAYER', `transactions[${position}] (${step}) is the keeper's step but names the treasury as its signer`);
      }
      const parsed = parseTransaction(tx.tx, deps.lookupTables);
      if (parsed.payer === payer) {
        throw refuse('WRONG_PAYER', `transactions[${position}] (${step}) is the keeper's step but the treasury is its fee payer`);
      }
      const programs = [];
      for (const ix of parsed.instructions) {
        if (!deps.allowedPrograms.has(ix.programId)) {
          throw refuse('FOREIGN_PROGRAM', `transactions[${position}] (${step}) targets ${ix.programId}, which is not a weavr or core program`);
        }
        programs.push(CORE_BY_ID.get(ix.programId) ?? programNamesMap.get(ix.programId) ?? ix.programId);
      }
      summary.theirs.push({ position, step, signer: role, programs });
      summary.bytes += parsed.bytes;
    }
    summary.txCount += 1;
    summary.transactions += 1;
    summary.steps.push(step);
  });

  if (creates === 0) throw refuse('UNEXPECTED_STEP', 'the payload has no create_portfolio transaction');

  // Targets: in the header (≤ 8 legs) or across the pages (a paged create), never both.
  let built;
  if (state.headerTargets.length > 0) {
    if (state.pages.length) throw refuse('UNEXPECTED_STEP', 'create_portfolio carries its targets and the payload also carries create_portfolio_page');
    built = state.headerTargets;
  } else {
    if (!state.pages.length) throw refuse('TARGETS_MISMATCH', 'create_portfolio carries no targets and the payload has no create_portfolio_page');
    const pages = state.pages.map((entry) => entry.page);
    const expectedPages = pages.map((_, index) => index);
    if (JSON.stringify(pages) !== JSON.stringify(expectedPages)) {
      throw refuse('UNEXPECTED_INSTRUCTIONS', `create_portfolio_page pages run ${pages.join(',')}, expected ${expectedPages.join(',')}`);
    }
    for (const entry of state.pages) {
      if (entry.totalLegs !== wanted.length) {
        throw refuse('TARGETS_MISMATCH', `create_portfolio_page ${entry.page} says ${entry.totalLegs} legs, the approved intent has ${wanted.length}`);
      }
    }
    built = state.pages.flatMap((entry) => entry.targets);
    summary.pages = pages;
  }
  if (JSON.stringify(built) !== JSON.stringify(wanted)) {
    throw refuse('TARGETS_MISMATCH', 'the built targets differ from the approved intent');
  }

  // The outlay: what leaves the treasury when the create lands — the keeper
  // reimbursement (a transfer this walk already tied to `keeperProcessor`),
  // plus the factory rent and the custodian reserve the program itself moves
  // out of `creator` for the amounts the instruction carries.
  const keeperLamports = state.keeperLamports == null ? 0n : BigInt(state.keeperLamports);
  const factoryRent = lamportsOf(state.create.factoryRentLamports, 'create_portfolio factory_rent_lamports');
  const custodianReserve = lamportsOf(state.create.custodianReserveLamports, 'create_portfolio custodian_reserve_lamports');
  const outlay = keeperLamports + factoryRent + custodianReserve;
  if (outlay > maxLamports) {
    throw refuse('TARGETS_MISMATCH', `the create commits ${outlay} lamports of the treasury's (keeper reimbursement ${keeperLamports} + factory rent ${factoryRent} + custodian reserve ${custodianReserve}), above the approved ceiling of ${maxLamports}`);
  }
  summary.create = {
    ...state.create,
    keeperLamports: state.keeperLamports,
    outlayLamports: outlay.toString(),
    priorityLamports: state.priorityLamports.toString(),
    targets: built.map((t) => ({ pool: t.pool, weightBps: t.weight_bps })),
  };
  return summary;
}

/**
 * Verify a built payload against the approved intent. Walks every
 * instruction of every transaction: fee payer == `expect.payer`, every
 * program in `expect.allowedPrograms`, factory/stoken instructions decoded
 * through the IDL, the instruction-name set equal to the verb's expected
 * set, the portfolio account == `expect.portfolio`, decoded targets equal to
 * `expect.targets` byte for byte, steps within the verb's allowed steps.
 * Checking only instruction 0 is wrong: instruction 0 is setComputeUnitLimit.
 *
 * `expect`:
 * - `payer` (base58) — the curator; `portfolio` (base58 Portfolio PDA);
 *   `vault` (base58 VaultConfig — required for deposit/withdraw, checked
 *   on apply and crank pages when given);
 * - `allowedPrograms` (Set<base58>), `lookupTables` (Set, or Map/object
 *   `{ table: addresses[] }` / `AddressLookupTableAccount[]` so v0 loads can be
 *   resolved), `idls` (`{ portfolio_factory, stoken, … }`), `programIds`
 *   (`{ name: base58 }`, default: the manifest's pins);
 * - the intent: `targets` (+ `poolKeys` `{ poolId: base58 }` when targets
 *   carry `poolId` instead of `pool`) for propose; `amount`/`minShares` for
 *   deposit; `shares`/`minAmountOut` for withdraw; `newCurator`,
 *   `rebalanceDelaySecs`, `uri` for the ops verbs; `curator`,
 *   `rebalanceDelaySecs`, `targets`, `maxLamports` (the treasury's outlay:
 *   reimbursement + factory rent + custodian reserve) and `maxPriorityLamports`
 *   (per treasury transaction) for create, all required. An intent field that
 *   is `undefined` is not checked; one that is given must match exactly.
 *
 * Refusal codes: NOT_A_TRANSACTION, FOREIGN_LOOKUP_TABLE, FOREIGN_PROGRAM,
 * UNKNOWN_INSTRUCTION, WRONG_PAYER, UNEXPECTED_STEP, UNEXPECTED_INSTRUCTIONS,
 * PAGED_PROPOSE_UNSUPPORTED (a propose of more than PROPOSE_MAX_LEGS legs, or
 * a built `propose_targets_page`), WRONG_PORTFOLIO, WRONG_ACCOUNT,
 * TARGETS_MISMATCH. A caller-side contract error (no payer, no allowlist, no
 * targets for propose) throws a plain Error instead of refusing.
 * @param {{ transactions: Array<{ step: string, signer?: string, signerKey?: string, tx: string, pageIndex?: number }>, verb: string, expect: object }} input
 * @returns {{ ok: true, summary: { txCount: number, transactions: number, steps: string[], instructions: Array<{ step: string, program: string, name: string }>, bytes: number, pages: number[] } } | { ok: false, code: string, message: string }}
 */
export function verifyBuilt(input) {
  try {
    return { ok: true, summary: verifyOrThrow(input ?? {}) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}

function verifyOrThrow({ transactions, verb, expect }) {
  if (!expect || typeof expect !== 'object') throw new Error('verifyBuilt: expect is required');
  const route = normaliseVerb(verb);
  const spec = EXPECTED_STEPS[route];
  if (!spec) throw refuse('UNEXPECTED_STEP', `no expected instruction set for verb ${String(verb)}`);
  const payer = asBase58(expect.payer);
  if (!payer) throw new Error('verifyBuilt: expect.payer is required');
  if (!(expect.allowedPrograms instanceof Set)) throw new Error('verifyBuilt: expect.allowedPrograms must be a Set');
  if (spec.mine) {
    const programNamesMap = expect.programNames ?? programNames(expect.programIds);
    return verifyCreate({
      transactions,
      expect,
      payer,
      programNamesMap,
      deps: {
        allowedPrograms: expect.allowedPrograms,
        idls: expect.idls ?? {},
        lookupTables: expect.lookupTables ?? new Set(),
        programNames: programNamesMap,
      },
    });
  }
  const needsPortfolio = ['propose', 'apply', 'cancel', 'rotate-curator', 'set-delay', 'set-metadata'].includes(route);
  const portfolio = asBase58(expect.portfolio);
  if (needsPortfolio && !portfolio) throw new Error('verifyBuilt: expect.portfolio is required');
  const vault = expect.vault === undefined ? undefined : asBase58(expect.vault);
  if (['deposit', 'withdraw'].includes(route) && !vault) throw new Error(`verifyBuilt: expect.vault is required for ${route}`);
  if (route === 'propose' && !Array.isArray(expect.targets)) throw new Error('verifyBuilt: expect.targets is required for propose');
  if (route === 'propose' && expect.targets.length > PROPOSE_MAX_LEGS) {
    throw refuse('PAGED_PROPOSE_UNSUPPORTED', `a proposal of ${expect.targets.length} legs is more than ${PROPOSE_MAX_LEGS}: the api builds it as propose_targets_page pages, which this signer does not verify`);
  }
  if (!Array.isArray(transactions) || transactions.length === 0) {
    throw refuse('UNEXPECTED_INSTRUCTIONS', 'the payload carries no transactions');
  }

  const programNamesMap = expect.programNames ?? programNames(expect.programIds);
  const deps = {
    allowedPrograms: expect.allowedPrograms,
    idls: expect.idls ?? {},
    lookupTables: expect.lookupTables ?? new Set(),
    programNames: programNamesMap,
  };
  const ctx = {
    expect: { ...expect, portfolio, vault },
    payer,
    targets: route === 'propose' ? expectedTargets(expect) : null,
    custodian: custodianFor(vault, programNamesMap),
  };

  const summary = { txCount: 0, transactions: 0, steps: [], instructions: [], bytes: 0, pages: [] };
  const primaryPages = [];
  let sawPrimary = 0;
  const preSeen = new Map();

  transactions.forEach((tx, position) => {
    if (!tx || typeof tx !== 'object' || typeof tx.tx !== 'string') {
      throw refuse('NOT_A_TRANSACTION', `transactions[${position}] carries no encoded transaction`);
    }
    const step = String(tx.step ?? '');
    if (!spec.steps.has(step)) throw refuse('UNEXPECTED_STEP', `step ${step || '(none)'} is not part of ${route}`);
    if (spec.pre.includes(step)) {
      if (sawPrimary > 0) throw refuse('UNEXPECTED_STEP', `${step} must come before ${spec.primary}`);
      if (preSeen.has(step)) throw refuse('UNEXPECTED_STEP', `${step} appears more than once`);
      preSeen.set(step, position);
    } else {
      sawPrimary += 1;
      if (!spec.paged && sawPrimary > 1) throw refuse('UNEXPECTED_STEP', `${route} builds one ${spec.primary} transaction, the payload has more`);
    }
    if (tx.signerKey != null && asBase58(tx.signerKey) !== payer) {
      throw refuse('WRONG_PAYER', `transactions[${position}] names ${asBase58(tx.signerKey)} as signer, not the curator`);
    }

    const decoded = decodeTransaction(tx.tx, deps);
    if (decoded.payer !== payer) {
      throw refuse('WRONG_PAYER', `transactions[${position}] fee payer ${decoded.payer ?? 'unset'} is not the curator`);
    }

    // Named before the generic allowlist walk: a page is a paged proposal, not
    // "an instruction that is not part of propose_targets".
    if (route === 'propose' && decoded.instructions.some((ix) => key(ix) === PROPOSE_PAGE)) {
      throw refuse('PAGED_PROPOSE_UNSUPPORTED', `transactions[${position}] carries propose_targets_page: the api paged this proposal (more than ${PROPOSE_MAX_LEGS} legs), which this signer does not verify`);
    }

    const rule = STEP_RULES[step];
    const counts = new Map();
    for (const ix of decoded.instructions) {
      const name = key(ix);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const allowed = ALWAYS_ALLOWED.has(name) || rule.required.includes(name) || rule.optional.includes(name);
      if (!allowed) {
        throw refuse('UNEXPECTED_INSTRUCTIONS', `${name} is not part of a ${step} transaction`);
      }
      summary.instructions.push({ step, program: ix.program, name: ix.name });
    }
    for (const name of rule.required) {
      const n = counts.get(name) ?? 0;
      if (n !== 1) throw refuse('UNEXPECTED_INSTRUCTIONS', `${step} must carry exactly one ${name}, it carries ${n}`);
    }
    if (rule.atLeastOne && !(counts.get(rule.atLeastOne) > 0)) {
      throw refuse('UNEXPECTED_INSTRUCTIONS', `${step} carries no ${rule.atLeastOne}`);
    }

    for (const ix of decoded.instructions) checkProgramInstruction(ix, tx, ctx);

    if (rule.paged) {
      const page = decoded.instructions.find((ix) => key(ix) === rule.required[0]);
      const onChain = Number(page.data.page_index);
      if (tx.pageIndex != null && Number(tx.pageIndex) !== onChain) {
        throw refuse('UNEXPECTED_INSTRUCTIONS', `${step} pageIndex ${tx.pageIndex} does not match the instruction's page ${onChain}`);
      }
      primaryPages.push(onChain);
    }

    summary.txCount += 1;
    summary.transactions += 1;
    summary.steps.push(step);
    summary.bytes += decoded.bytes;
  });

  if (sawPrimary === 0) throw refuse('UNEXPECTED_STEP', `the payload has no ${spec.primary} transaction`);
  if (spec.paged) {
    const expectedPages = primaryPages.map((_, index) => index);
    if (JSON.stringify(primaryPages) !== JSON.stringify(expectedPages)) {
      throw refuse('UNEXPECTED_INSTRUCTIONS', `${spec.primary} pages run ${primaryPages.join(',')}, expected ${expectedPages.join(',')}`);
    }
    summary.pages = primaryPages;
  }
  return summary;
}
