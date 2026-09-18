/**
 * Reading the chain, and decoding it from the generated IDLs.
 *
 * The keeper's entire job is derived from on-chain state — the tick keeps no
 * memory between runs by design (spec §8.1), because a keeper that trusts its
 * own cache is a keeper that acts on a world that has moved. Everything here is
 * therefore a read, and every read goes through the IDL rather than a
 * hand-written layout, so the account definitions keep one home.
 *
 * Two factory accounts (`FactoryConfig`, `Portfolio`) are append-only on
 * chain: a NOW-era body is shorter than today's IDL and still valid. The
 * program pads the missing tail with zeros (`pad.rs`). The JS coder does
 * not, so a 406-byte live FactoryConfig throws `offset 456` and the
 * curator holds every write. `decode` applies the same pad.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { withRpcRetry } from './confirm.js';
import { observeRpc } from './metrics.js';
import { configuredMaxRps, rateLimitedFetch, rateLimiter } from './rateLimit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UMBRELLA =
  process.env.COMPOSABLE_PORTFOLIOS_UMBRELLA ?? join(HERE, '..', '..', '..', '..');
const DEPLOY = join(HERE, '..', '..', '..', 'deploy');

const IDL_PATHS = {
  portfolio_factory: 'composable-portfolios-programs/target/idl/portfolio_factory.json',
  portfolio_allocator: 'composable-portfolios-programs/target/idl/portfolio_allocator.json',
  stoken: 'splyce-composable-core/target/idl/stoken.json',
  accountant: 'splyce-composable-core/target/idl/accountant.json',
  asset_manager_escrow: 'splyce-composable-core/target/idl/asset_manager_escrow.json',
};

function resolveTree() {
  if (existsSync(join(DEPLOY, 'manifest.json'))) {
    return {
      manifest: JSON.parse(readFileSync(join(DEPLOY, 'manifest.json'), 'utf8')),
      idlPath: (program) => join(DEPLOY, 'idls', `${program}.json`),
    };
  }
  if (existsSync(join(UMBRELLA, 'manifest.json'))) {
    return {
      manifest: JSON.parse(readFileSync(join(UMBRELLA, 'manifest.json'), 'utf8')),
      idlPath: (program) => join(UMBRELLA, IDL_PATHS[program]),
    };
  }
  throw new Error('no manifest.json (vendored deploy/ or umbrella)');
}

const { manifest, idlPath } = resolveTree();
const idls = new Map();
const coders = new Map();

/**
 * Anchor 0.30 sometimes emits `#[event]` structs into `types` without the
 * top-level `events` discriminator table. BorshEventCoder needs that table —
 * without it the indexer silently drops every factory event (including
 * `TargetsProposed`, which broke demo history).
 */
const FACTORY_EVENT_NAMES = Object.freeze([
  'PoolRegistered', 'PortfolioCreated', 'PortfolioSharesReady', 'PortfolioActivated',
  'PoolStatusChanged', 'PoolReserveRatioUpdated', 'PoolAssetMintUpdated', 'FactoryInitialized', 'PolicyUpdated',
  'RentMarginsUpdated', 'ServiceRoleReplaced', 'DefaultOracleUpdated',
  'CreationPauseToggled', 'KeeperRiskPauseToggled',
  'CuratorProposed', 'CuratorAccepted', 'CuratorCancelled',
  'PortfolioMetadataUpdated', 'TargetsProposed', 'TargetsApplied', 'TargetsCancelled',
  'PositionRetired', 'CoreAdminProposed', 'PoolVaultCreated',
  'PoolEscrowPauseToggled', 'PoolEscrowTokenAccountInitialized',
  'PoolCctpDestinationAdded', 'FeeRecipientProposed', 'FeeRecipientAccepted',
]);

function synthesiseEvents(idl) {
  if (Array.isArray(idl.events) && idl.events.length > 0) return idl;
  const typeNames = new Set((idl.types ?? []).map((entry) => entry.name));
  const names = FACTORY_EVENT_NAMES.filter((name) => typeNames.has(name));
  if (names.length === 0) return idl;
  return {
    ...idl,
    events: names.map((name) => ({
      name,
      discriminator: [...createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)],
    })),
  };
}

export function idlFor(program) {
  if (!idls.has(program)) {
    if (!IDL_PATHS[program]) throw new Error(`no IDL registered for ${program}`);
    const raw = JSON.parse(readFileSync(idlPath(program), 'utf8'));
    idls.set(program, program === 'portfolio_factory' ? synthesiseEvents(raw) : raw);
  }
  return idls.get(program);
}

function coderFor(program) {
  if (!coders.has(program)) {
    coders.set(program, new anchor.BorshAccountsCoder(idlFor(program)));
  }
  return coders.get(program);
}

/**
 * Program IDs come from `manifest.json`, which is where identity is decided.
 * `ci/check_program_id_pins` already proves it agrees with `declare_id!`, the
 * keypair and the compiled object, so reading it here means the keeper and that
 * check cannot disagree about what it is talking to.
 */
export function programId(program) {
  for (const entry of Object.values(manifest.repos)) {
    const pinned = entry.deployed_programs?.[program];
    if (pinned) return new PublicKey(pinned);
  }
  throw new Error(`manifest.json pins no program ID for ${program}`);
}

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

export function programDataKey(program) {
  const pk = program instanceof PublicKey ? program : new PublicKey(program);
  return PublicKey.findProgramAddressSync(
    [pk.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

/** Escrow `token_custody` PDA. `execute_kamino_*` writes shares here, not the ATA. */
export function tokenCustody(assetManager, mint) {
  const am = assetManager instanceof PublicKey ? assetManager : new PublicKey(assetManager);
  const m = mint instanceof PublicKey ? mint : new PublicKey(mint);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('token_custody'), am.toBuffer(), m.toBuffer()],
    programId('asset_manager_escrow'),
  )[0];
}

/**
 * Anchor spells account names PascalCase in the IDL but camelCase in the
 * TypeScript client, and which one a given version emits has moved before.
 * Resolving against the IDL's own list means a toolchain bump cannot silently
 * turn every read into "account not found".
 */
function accountName(program, account) {
  const names = idlFor(program).accounts.map((a) => a.name);
  const match = names.find((name) => name.toLowerCase() === account.toLowerCase());
  if (!match) throw new Error(`${program} IDL has no account named ${account}`);
  return match;
}

/**
 * `keeper_risk_paused` becomes `keeperRiskPaused`, and the enum variant `Live`
 * becomes `live`. Rust struct fields are always snake_case, so lowercasing the
 * first character is a no-op for them and only affects variant names.
 */
const camel = (key) =>
  key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toLowerCase());

/** The variant name of a decoded Anchor enum, e.g. `live` or `halted`. */
export const variantOf = (value) => Object.keys(value ?? {})[0];

/**
 * Anchor's Borsh coder hands back the Rust field names verbatim, so a decoded
 * account arrives as `keeper_risk_paused` rather than `keeperRiskPaused`.
 *
 * Normalising once here rather than at every call site is deliberate: the ops
 * scripts learned this the hard way, where a single `assetManager` that should
 * have been `asset_manager` read as `undefined` and a role check quietly
 * compared nothing to nothing. One conversion, in one place, means no service
 * can make that mistake and none of them care what the coder decides to emit.
 *
 * Only plain objects and arrays are walked. `PublicKey` and `BN` are class
 * instances whose internals must survive untouched.
 */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [camel(key), normalise(inner)]),
  );
}

const APPEND_ONLY_ACCOUNTS = new Set(['FactoryConfig', 'Portfolio']);
const APPEND_ONLY_PAD_BYTES = 8 + 1024;

export function decode(program, account, data) {
  const name = accountName(program, account);
  const body = Buffer.from(data);
  try {
    return normalise(coderFor(program).decode(name, body));
  } catch (error) {
    if (
      !APPEND_ONLY_ACCOUNTS.has(name) ||
      !/Reached the end of buffer when accessing index|offset .+ out of range/.test(String(error))
    ) {
      throw error;
    }
    const padded = Buffer.alloc(Math.max(body.length, APPEND_ONLY_PAD_BYTES));
    body.copy(padded);
    return normalise(coderFor(program).decode(name, padded));
  }
}

const instructionCoders = new Map();

/**
 * Encodes instruction data, resolving the name against the IDL for the same
 * reason `accountName` does: Anchor spells instructions `create_portfolio` in
 * the IDL and `createPortfolio` in the generated client, and picking the wrong
 * one fails with "Unknown method" at the worst possible moment — after the
 * caller has already been told their intent is valid.
 */
export function encodeInstruction(program, instruction, args) {
  if (!instructionCoders.has(program)) {
    instructionCoders.set(program, new anchor.BorshInstructionCoder(idlFor(program)));
  }

  const names = idlFor(program).instructions.map((entry) => entry.name);
  const flatten = (value) => value.replace(/_/g, '').toLowerCase();
  const match = names.find((name) => flatten(name) === flatten(instruction));
  if (!match) throw new Error(`${program} IDL has no instruction named ${instruction}`);

  return instructionCoders.get(program).encode(match, denormalise(args));
}

/**
 * `depositFeeBps` becomes `deposit_fee_bps`, but `Underlying` is left alone.
 *
 * The first character disambiguates the two kinds of key perfectly: Rust struct
 * fields are always snake_case, so ours are camelCase and start lowercase,
 * while enum variants are always PascalCase and start uppercase. Converting a
 * variant would turn `Underlying` into `_underlying` and `VaultCreated` into
 * `vault_created`, neither of which any IDL has heard of.
 */
const snake = (key) =>
  /^[A-Z]/.test(key) ? key : key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Account metas for an instruction, in IDL order with IDL flags.
 *
 * Hand-writing the list means hand-writing the order and the `writable` and
 * `signer` flags, and getting any of the three wrong fails on chain with
 * `ConstraintMut` or a seeds mismatch — after a transaction has been built,
 * signed and sent. The IDL already states all of it, so the caller supplies
 * only the addresses, by name.
 *
 * A name the IDL does not know, or one it knows and the caller omitted, throws
 * here rather than producing a transaction that is wrong in a way only a
 * validator will tell you about.
 */
export function accountMetas(program, instruction, addresses, { remaining = [] } = {}) {
  const names = idlFor(program).instructions.map((entry) => entry.name);
  const flatten = (value) => value.replace(/_/g, '').toLowerCase();
  const match = names.find((name) => flatten(name) === flatten(instruction));
  if (!match) throw new Error(`${program} IDL has no instruction named ${instruction}`);

  const spec = idlFor(program).instructions.find((entry) => entry.name === match);
  const supplied = new Map(Object.entries(addresses).map(([key, value]) => [flatten(key), value]));

  const metas = spec.accounts.map((account) => {
    const pubkey = supplied.get(flatten(account.name)) ?? account.address;
    if (!pubkey) {
      throw new Error(`${program}.${match} needs an address for ${account.name}`);
    }
    supplied.delete(flatten(account.name));
    return {
      pubkey: typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey,
      isWritable: Boolean(account.writable),
      isSigner: Boolean(account.signer),
    };
  });

  if (supplied.size > 0) {
    throw new Error(
      `${program}.${match} was given accounts it does not take: ${[...supplied.keys()].join(', ')}`,
    );
  }

  return [...metas, ...remaining];
}

/**
 * The inverse of `normalise`, for arguments on their way out.
 *
 * Argument field names are snake_case in the IDL just as account fields are,
 * and getting one wrong does not produce a helpful error — Borsh reports
 * "indeterminate span" or "unable to infer src variant" from somewhere deep in
 * the layout, long after the mistake. Converting here keeps every call site
 * idiomatic and keeps this failure impossible.
 */
function denormalise(value) {
  if (Array.isArray(value)) return value.map(denormalise);
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [snake(key), denormalise(inner)]),
  );
}

/** The 8-byte discriminator as base58, for a `memcmp` filter. */
export function discriminator(program, account) {
  const name = accountName(program, account);
  const entry = idlFor(program).accounts.find((a) => a.name === name);
  const bytes = entry.discriminator
    ? Buffer.from(entry.discriminator)
    : createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
  return anchor.utils.bytes.bs58.encode(bytes);
}

export const pda = (seeds, program) =>
  PublicKey.findProgramAddressSync(seeds, programId(program))[0];

export const factoryConfigKey = () => pda([Buffer.from('factory_config')], 'portfolio_factory');
export const factoryAuthorityKey = () =>
  pda([Buffer.from('factory_authority')], 'portfolio_factory');
/** Core `Config` singletons: `create_portfolio` bumps both counters through CPI. */
export const stokenConfigKey = () => pda([Buffer.from('config')], 'stoken');
export const accountantConfigKey = () => pda([Buffer.from('config')], 'accountant');
export const custodianKey = (vault) =>
  pda([Buffer.from('custodian'), vault.toBuffer()], 'portfolio_allocator');
export const allocatorPortfolioKey = (portfolio) =>
  pda([Buffer.from('allocator_portfolio'), portfolio.toBuffer()], 'portfolio_allocator');
export const sharesMintKey = (vault) =>
  pda([Buffer.from('shares_mint'), vault.toBuffer()], 'stoken');
export const depositWhitelistKey = (vault, user) =>
  pda([Buffer.from('user_deposit_whitelist'), vault.toBuffer(), user.toBuffer()], 'stoken');

const WRAPPED_RPC = [
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getProgramAccounts',
  'getLatestBlockhash',
  'getTokenAccountBalance',
  'sendRawTransaction',
  'getSignatureStatuses',
];

/**
 * A connection that retries the calls the services lean on and paces every
 * HTTP request to `RPC_MAX_RPS` (or `maxRps`; 0 lifts the limit). The pacing
 * sits under `fetch` so it covers methods the retry list does not name, such
 * as the indexer's history scan.
 */
export function connect(rpcUrl, { maxRps = configuredMaxRps() } = {}) {
  const limit = rateLimiter(maxRps);
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    ...(maxRps > 0 ? { fetch: rateLimitedFetch(limit) } : {}),
  });
  for (const name of WRAPPED_RPC) {
    const original = connection[name].bind(connection);
    connection[name] = (...args) => observeRpc(name, () => withRpcRetry(() => original(...args)));
  }
  return connection;
}

/** Every account of one type owned by a program, already decoded. */
export async function programAccounts(connection, program, account) {
  const raw = await connection.getProgramAccounts(programId(program), {
    filters: [{ memcmp: { offset: 0, bytes: discriminator(program, account) } }],
  });
  return raw.map(({ pubkey, account: info }) => ({
    pubkey,
    data: decode(program, account, info.data),
  }));
}

export async function fetchDecoded(connection, program, account, pubkey) {
  const info = await connection.getAccountInfo(new PublicKey(pubkey));
  if (!info) return null;
  return decode(program, account, info.data);
}

const GET_MULTIPLE_LIMIT = 100;

/** Raw account infos for many keys — chunked getMultipleAccountsInfo, order kept. */
export async function accountInfoMany(connection, pubkeys) {
  const keys = [...pubkeys].map((key) => (key == null ? null : new PublicKey(key)));
  const infos = new Array(keys.length).fill(null);
  const indexed = keys
    .map((key, index) => ({ key, index }))
    .filter((row) => row.key);
  for (let offset = 0; offset < indexed.length; offset += GET_MULTIPLE_LIMIT) {
    const chunk = indexed.slice(offset, offset + GET_MULTIPLE_LIMIT);
    const answers = await connection.getMultipleAccountsInfo(chunk.map((row) => row.key));
    chunk.forEach((row, i) => {
      infos[row.index] = answers[i] ?? null;
    });
  }
  return infos;
}

/** Decode many accounts of one type in as few RPC calls as the provider allows. */
export async function fetchDecodedMany(connection, program, account, pubkeys) {
  const infos = await accountInfoMany(connection, pubkeys);
  return infos.map((info) => (info ? decode(program, account, info.data) : null));
}

const splAmount = (info) =>
  !info || info.data.length < 72 ? 0n : info.data.readBigUInt64LE(64);

/** An SPL token account balance, or zero if the account does not exist. */
export async function tokenBalance(connection, pubkey) {
  return splAmount(await connection.getAccountInfo(new PublicKey(pubkey)));
}

/** Many SPL balances in one round trip; missing accounts read as zero. */
export async function tokenBalanceMany(connection, pubkeys) {
  return (await accountInfoMany(connection, pubkeys)).map(splAmount);
}
