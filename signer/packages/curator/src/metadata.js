/**
 * The portfolio's metadata document: the JSON its shares mint's on-chain URI
 * resolves to, kept by weavr's metadata service (`/v1/metadata`, backend
 * `packages/metadata`). Wallets, explorers and weavr's site read its
 * `description` and `tags`; the site badges a book tagged `agent-managed` and
 * shows its description as the agent's strategy. The service lets only the
 * key the `Portfolio` account names as curator change it, and that key lives
 * here, so this process is the one writer an agent-run book has.
 *
 * Two writes, one path (`writeDocument`): the loop stamps the configured tags
 * (`CURATOR_METADATA_TAGS`) and links (`CURATOR_METADATA_LINKS`, e.g. the
 * portfolio's policy) once, and the `strategy` verb replaces the
 * description. Both read the stored document first and send it back whole
 * with their change merged in, because the service replaces the editable
 * block on every write: a write that sent only its own field would erase the
 * others. The tags and links are the deployment's, never the model's: every
 * write carries them, so a description the agent publishes can never drop
 * the badge or the policy link, and the agent has no argument that could add
 * or remove one.
 *
 * Why the message is checked line by line before it is signed: the service
 * builds the text and this process signs whatever it is handed, so the text
 * is the one thing a compromised or confused service could use to make the
 * curator key sign something else. `checkMessage` accepts exactly the
 * service's own format (`metadata/src/message.js buildMessage`) naming this
 * wallet, this portfolio, `set-metadata` and the sha256 of the body this
 * process is about to send, issued within the service's five-minute window.
 * `keys.js signText` then refuses anything that is not printable ASCII, so
 * no text it signs can be a transaction message either.
 *
 * Why the canonical JSON is the service's and not `journal.js canonical`:
 * the content hash must land on the service's bytes exactly, and the two
 * differ on `undefined` members (dropped there, `null` here). The function
 * below is `metadata/src/encoding.js canonicalJson`, verbatim in behaviour.
 */
import { createHash } from 'node:crypto';
import { Refusal } from './errors.js';
import { weavrClient } from './weavr.js';

/** The service's `METADATA_SIGN_DOMAIN` default: the first word of the signed text. */
export const DEFAULT_SIGN_DOMAIN = 'weavr.sh';
export const ACTION = 'set-metadata';
/** The service's own limits (`metadata/src/schema.js LIMITS`). */
export const DESCRIPTION_MAX_CHARS = 2000;
export const MAX_TAGS = 10;
export const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_LINKS = 8;
export const LINK_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
export const LINK_URL_MAX_CHARS = 512;
/** The service refuses a message older than this (`METADATA_SIGN_MAX_AGE_SECS`); one further from this clock is not signed. */
export const MESSAGE_MAX_SKEW_SECS = 300;
/** Retry ceiling for a tag stamp that keeps failing. */
export const STAMP_RETRY_MAX_SECS = 3600;
/** A stamp that has failed this many times in a row raises an alert. */
export const STAMP_ALERT_AFTER = 3;

const EDITABLE_KEYS = Object.freeze(['description', 'external_url', 'links', 'tags']);
const NONCE_RE = /^[0-9a-f]{16}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Sorted keys, no whitespace, `undefined` members dropped: the service's canonical form. */
export function canonicalJson(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item) ?? 'null').join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value)
      .sort()
      .map((key) => {
        const inner = canonicalJson(value[key]);
        return inner === undefined ? null : `${JSON.stringify(key)}:${inner}`;
      })
      .filter((member) => member !== null);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** `sha256:<hex>` over the canonical JSON of a metadata body: the `Content-Hash` line the service puts in the message. */
export function contentHashOf(metadata) {
  return `sha256:${createHash('sha256').update(canonicalJson(metadata), 'utf8').digest('hex')}`;
}

/**
 * `CURATOR_METADATA_TAGS` as a list: comma- or space-separated, lowercased,
 * de-duplicated, every tag in the service's form. Empty or unset is `[]`
 * (no stamp). Throws `Error` naming the variable.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseTagList(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return [];
  const tags = [];
  for (const part of text.split(/[\s,]+/)) {
    const tag = part.trim().toLowerCase();
    if (tag === '') continue;
    if (!TAG_RE.test(tag)) {
      throw new Error(`CURATOR_METADATA_TAGS: ${JSON.stringify(part.slice(0, 40))} is not a tag (1–32 lowercase letters, digits or hyphens, starting with a letter or digit; a colon is not allowed)`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) throw new Error(`CURATOR_METADATA_TAGS: at most ${MAX_TAGS} tags`);
  return tags;
}

/**
 * `CURATOR_METADATA_LINKS` as an object: `name=https-url` entries, comma- or
 * space-separated, each held to the service's own link rule (`metadata/src/
 * schema.js`): a name of 1–24 lowercase letters, digits or underscores
 * starting with a letter, an `https://` URL that parses, at most 512
 * characters, no credentials. At most 8, no name twice. Empty or unset is
 * `{}` (no links). Throws `Error` naming the variable and the link's name,
 * never its URL.
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
export function parseLinkList(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return {};
  const links = {};
  for (const part of text.split(/[\s,]+/)) {
    if (part === '') continue;
    const at = part.indexOf('=');
    if (at <= 0) throw new Error('CURATOR_METADATA_LINKS: each link is name=https-url');
    const name = part.slice(0, at);
    const url = part.slice(at + 1);
    if (!LINK_KEY_RE.test(name)) throw new Error(`CURATOR_METADATA_LINKS: ${JSON.stringify(name.slice(0, 40))} is not a link name (1–24 lowercase letters, digits or underscores, starting with a letter)`);
    if (Object.hasOwn(links, name)) throw new Error(`CURATOR_METADATA_LINKS: ${name} is named twice`);
    if (url.length > LINK_URL_MAX_CHARS) throw new Error(`CURATOR_METADATA_LINKS: ${name} is longer than ${LINK_URL_MAX_CHARS} characters`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`CURATOR_METADATA_LINKS: ${name} is not a URL`);
    }
    if (parsed.protocol !== 'https:') throw new Error(`CURATOR_METADATA_LINKS: ${name} must use https`);
    if (parsed.username || parsed.password) throw new Error(`CURATOR_METADATA_LINKS: ${name} must not carry credentials`);
    links[name] = url;
  }
  if (Object.keys(links).length > MAX_LINKS) throw new Error(`CURATOR_METADATA_LINKS: at most ${MAX_LINKS} links`);
  return links;
}

/** The tags a stored document carries (top level, else the editable block). */
export function tagsOf(document) {
  const tags = Array.isArray(document?.tags) ? document.tags : document?.editable?.tags;
  return Array.isArray(tags) ? tags.map(String) : [];
}

/** The links a stored document carries (top level, else the editable block), empty entries dropped. */
export function linksOf(document) {
  const links = isLinkObject(document?.links) ? document.links : document?.editable?.links;
  if (!isLinkObject(links)) return {};
  return Object.fromEntries(Object.entries(links).filter(([, url]) => url != null && url !== '').map(([name, url]) => [name, String(url)]));
}

const isLinkObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The editable block the service last stored, as the four keys it accepts and nothing else. */
export function editableOf(document) {
  const editable = document?.editable && typeof document.editable === 'object' && !Array.isArray(document.editable) ? document.editable : {};
  const out = {};
  for (const key of EDITABLE_KEYS) {
    if (editable[key] !== undefined && editable[key] !== null) out[key] = editable[key];
  }
  return out;
}

/**
 * The body to write: the stored block, the configured tags appended where
 * missing (stored order kept), each configured link set to its configured
 * URL (a stored link of the same name is overwritten; every other stored
 * link is kept), the description replaced when one is given. `changed` is
 * false when the write would store what is already there; `linked` names
 * the links this write sets or changes.
 * @param {object} editable from `editableOf`
 * @param {{ tags?: string[], links?: Record<string, string>, description?: string }} change
 * @returns {{ metadata: object, changed: boolean, added: string[], linked: string[] }}
 * @throws {Refusal} METADATA_TAGS_FULL / METADATA_LINKS_FULL when the configured tags or links do not fit beside the stored ones
 */
export function mergeEditable(editable, { tags = [], links = {}, description } = {}) {
  const stored = Array.isArray(editable?.tags) ? editable.tags.map(String) : [];
  const added = tags.filter((tag) => !stored.includes(tag));
  if (stored.length + added.length > MAX_TAGS) {
    throw new Refusal('METADATA_TAGS_FULL', `the document already carries ${stored.length} tags; ${added.join(', ')} would exceed the service's ${MAX_TAGS}`, { stored, missing: added });
  }
  const storedLinks = linksOf({ editable });
  const linked = Object.keys(links).filter((name) => storedLinks[name] !== links[name]);
  const mergedLinks = { ...storedLinks, ...links };
  if (linked.length && Object.keys(mergedLinks).length > MAX_LINKS) {
    throw new Refusal('METADATA_LINKS_FULL', `the document already carries ${Object.keys(storedLinks).length} links; ${linked.join(', ')} would exceed the service's ${MAX_LINKS}`, { stored: Object.keys(storedLinks), missing: linked });
  }
  const metadata = { ...editable };
  if (added.length) metadata.tags = [...stored, ...added];
  if (linked.length) metadata.links = mergedLinks;
  const describe = description !== undefined && description !== editable?.description;
  if (describe) metadata.description = description;
  return { metadata, changed: added.length > 0 || linked.length > 0 || describe, added, linked };
}

/** True when a stored document carries every configured tag and every configured link at its configured URL. */
export function carriesConfigured(document, { tags = [], links = {} } = {}) {
  const stored = tagsOf(document);
  const storedLinks = linksOf(document);
  return tags.every((tag) => stored.includes(tag)) && Object.entries(links).every(([name, url]) => storedLinks[name] === url);
}

/**
 * The text the service asked this process to sign, held to the service's
 * exact format and to what this process is about to send. Throws
 * Refusal('METADATA_MESSAGE_MISMATCH') naming the first line that differs.
 * @param {unknown} text
 * @param {{ domain: string, address: string, portfolio: string, contentHash: string, nowSecs: number }} expected
 * @returns {{ issuedAt: string, nonce: string }}
 */
export function checkMessage(text, expected) {
  const fail = (what) => {
    throw new Refusal('METADATA_MESSAGE_MISMATCH', `the metadata service asked for a signature over a message whose ${what}; nothing was signed`);
  };
  if (typeof text !== 'string') fail('body is not text');
  const lines = text.split('\n');
  if (lines.length !== 8) fail(`shape is not the service's eight lines`);
  if (lines[0] !== `${expected.domain} wants you to update portfolio metadata with your Solana account:`) fail(`first line does not name ${expected.domain}`);
  if (lines[1] !== expected.address) fail('account is not this signer');
  if (lines[2] !== '') fail('second block is not separated by a blank line');
  const field = (index, name) => {
    const prefix = `${name}: `;
    if (!lines[index].startsWith(prefix)) fail(`line ${index + 1} is not ${name}`);
    return lines[index].slice(prefix.length);
  };
  if (field(3, 'Portfolio') !== expected.portfolio) fail('portfolio is not this signer\'s');
  if (field(4, 'Action') !== ACTION) fail(`action is not ${ACTION}`);
  const hash = field(5, 'Content-Hash');
  if (!HASH_RE.test(hash) || hash !== expected.contentHash) fail('content hash is not the hash of the body being sent');
  const issuedAt = field(6, 'Issued-At');
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs) || Math.abs(issuedMs / 1000 - expected.nowSecs) > MESSAGE_MAX_SKEW_SECS) fail(`issue time is more than ${MESSAGE_MAX_SKEW_SECS} s from this clock`);
  const nonce = field(7, 'Nonce');
  if (!NONCE_RE.test(nonce)) fail('nonce is not 16 hex digits');
  return { issuedAt, nonce };
}

/**
 * The service's routes this process uses. Reads and refusals follow
 * `weavr.js`: a 4xx is `METADATA_REFUSED` with the service's `{ code,
 * message }` in `detail`, a 5xx, a timeout or an unreachable host
 * `UPSTREAM`, and no message carries the URL.
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {{ document: (portfolio: string) => Promise<object>, message: (portfolio: string, body: object) => Promise<object>, put: (portfolio: string, body: object) => Promise<object> }}
 */
export function metadataClient(opts = {}) {
  const { baseUrl, fetchImpl, timeoutMs } = opts;
  const http = weavrClient({ apiUrl: baseUrl, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
  const path = (portfolio, suffix = '') => {
    if (typeof portfolio !== 'string' || portfolio.trim() === '') throw new Refusal('BAD_REQUEST', 'portfolio is required');
    return `/v1/metadata/${encodeURIComponent(portfolio)}${suffix}`;
  };
  async function put(portfolio, body) {
    const route = path(portfolio);
    const { status, json } = await http.request('PUT', route, body);
    if (status >= 200 && status < 300 && json && typeof json === 'object') return json;
    const error = json?.error && typeof json.error === 'object' ? json.error : {};
    const detail = { path: route, status, code: typeof error.code === 'string' ? error.code : `HTTP_${status}`, message: typeof error.message === 'string' ? error.message : `answered ${status}` };
    if (status >= 400 && status < 500) throw new Refusal('METADATA_REFUSED', `metadata PUT ${route} refused: ${detail.message}`, detail);
    throw new Refusal('UPSTREAM', `metadata PUT ${route} answered ${status}`, detail);
  }
  return Object.freeze({
    document: async (portfolio) => http.get(path(portfolio)),
    message: async (portfolio, body) => http.post(path(portfolio, '/message'), body, { refusalCode: 'METADATA_REFUSED' }),
    put,
  });
}

/**
 * One write, end to end: read the stored document, merge, ask the service
 * for the text, check it, sign it, put the body. A merge that changes
 * nothing writes nothing (`changed: false`, the stored document returned).
 * @param {object} ctx `ctx.metadata` (the client), `ctx.signer` (`wallet`, `signText`), `ctx.config.metadata` (`tags`, `links`, `domain`)
 * @param {{ portfolio: string, description?: string, withLinks?: boolean }} input `portfolio` is the Portfolio PDA, never the mint;
 *   `withLinks: false` leaves the configured links out of the merge (stored links are kept as they are)
 * @returns {Promise<{ document: object, metadata: object, changed: boolean, added: string[], linked: string[], contentHash: string | null }>}
 * @throws {Refusal} METADATA_TAGS_FULL, METADATA_LINKS_FULL, METADATA_MESSAGE_MISMATCH, NOT_CURATOR, METADATA_REFUSED, UPSTREAM
 */
export async function writeDocument(ctx, input) {
  // One write at a time per signer: the loop's stamp and a `strategy` call
  // would otherwise read the same stored block and race to the service,
  // which answers the slower one 409 STALE_REQUEST.
  const previous = WRITES.get(ctx) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => mine);
  WRITES.set(ctx, queued);
  await previous;
  try {
    return await writeOnce(ctx, input);
  } finally {
    release();
    if (WRITES.get(ctx) === queued) WRITES.delete(ctx);
  }
}

/** The tail of each signer's write queue (`writeDocument`). */
const WRITES = new WeakMap();

async function writeOnce(ctx, { portfolio, description, withLinks = true }) {
  const { tags = [], links: configured = {}, domain = DEFAULT_SIGN_DOMAIN } = ctx.config.metadata ?? {};
  const links = withLinks ? configured : {};
  const address = ctx.signer.wallet;
  const stored = await ctx.metadata.document(portfolio);
  const { metadata, changed, added, linked } = mergeEditable(editableOf(stored), { tags, links, description });
  if (!changed) return { document: stored, metadata, changed: false, added, linked, contentHash: null };

  const contentHash = contentHashOf(metadata);
  const ask = await ctx.metadata.message(portfolio, { address, action: ACTION, metadata });
  if (ask?.isCurator === false) {
    throw new Refusal('NOT_CURATOR', `the chain names ${String(ask.curator ?? 'another key')} as this portfolio's curator, not this signer`, { curator: ask.curator ?? null });
  }
  checkMessage(ask?.message, { domain, address, portfolio, contentHash, nowSecs: Math.floor(ctx.now() / 1000) });
  const signature = await ctx.signer.signText(ask.message);
  const document = await ctx.metadata.put(portfolio, { address, message: ask.message, signature, metadata });
  return { document, metadata, changed: true, added, linked, contentHash };
}

/** `ctx.state.metadata`, created on first use. */
export function stampStateOf(ctx) {
  if (!ctx.state.metadata) ctx.state.metadata = { state: 'pending', at: null, attempts: 0, nextAt: null, error: null, updatedAt: null };
  return ctx.state.metadata;
}

/**
 * The loop's step: make sure the document carries the configured tags and
 * links. Runs until one read shows all of them (each link at its configured
 * URL) or one write sets them, then never again in this process; a restart
 * checks once more, so a link whose URL changed in the environment is
 * rewritten on the next boot. A failure retries on a doubling interval
 * capped at an hour and raises `metadata` after STAMP_ALERT_AFTER failures
 * in a row; a document with no room for the tags or links
 * (METADATA_TAGS_FULL, METADATA_LINKS_FULL) stops retrying and stays
 * alerted.
 *
 * Why a pause does not hold it: the tags and links are the deployment's
 * statement of what runs the book and under which policy, not an agent
 * action, and a paused book is still run by this signer. A self-lock does
 * hold it: the chain no longer matches what this process believes, and the
 * curator may already be someone else. So does a tick whose invariants
 * could not be read (`ctx.state.invariantsUnverified`): a policy link says
 * the book's fee recipient, curator and notice are the ones the policy
 * names, and an unread accountant is not proof of that.
 * @param {object} ctx
 * @param {object} snapshot this tick's
 * @param {{ raiseAlert: Function, clearAlert: Function, journal: Function }} hooks
 * @returns {Promise<{ state: string, attempts: number, error: object | null, alert: object | null } | null>} the outcome when an attempt ran
 *   (`alert` set when this attempt raised one the next GET /alerts delivers), null when none was due
 */
export async function stampMetadata(ctx, snapshot, hooks) {
  const tags = ctx.config.metadata?.tags ?? [];
  const links = ctx.config.metadata?.links ?? {};
  if ((!tags.length && !Object.keys(links).length) || !ctx.metadata) return null;
  const st = stampStateOf(ctx);
  const nowSecs = Math.floor(ctx.now() / 1000);
  if (st.state === 'ok' || st.state === 'full') return null;
  if (ctx.state.selfLocked) return null;
  if (Array.isArray(ctx.state.invariantsUnverified) && ctx.state.invariantsUnverified.length > 0) return null;
  if (st.nextAt != null && nowSecs < st.nextAt) return null;

  const portfolio = String(snapshot?.portfolioRow?.portfolio ?? ctx.state.snapshotKeys?.portfolio ?? '');
  let alert = null;
  try {
    if (!portfolio) throw new Refusal('UPSTREAM', 'the portfolio row carries no Portfolio key yet');
    const out = await writeDocument(ctx, { portfolio });
    Object.assign(st, { state: 'ok', at: nowSecs, attempts: 0, nextAt: null, error: null, updatedAt: out.document?.updatedAt ?? null });
    hooks.clearAlert(ctx, 'metadata');
    if (out.changed) {
      hooks.journal({ kind: 'metadata', action: 'stamp', ok: true, portfolio, added: out.added, linked: out.linked, tags: tagsOf(out.document), links: linksOf(out.document), contentHash: out.contentHash, updatedAt: out.document?.updatedAt ?? null });
      ctx.log?.('info', 'metadata-stamped', { added: out.added, linked: out.linked });
    }
  } catch (error) {
    const code = error instanceof Refusal ? error.code : 'ERROR';
    const message = String(error?.message ?? error).slice(0, 300);
    st.attempts += 1;
    st.error = { code, message };
    st.at = nowSecs;
    if (code === 'METADATA_TAGS_FULL' || code === 'METADATA_LINKS_FULL') {
      st.state = 'full';
      st.nextAt = null;
    } else {
      st.state = 'failed';
      const tickSecs = Math.max(1, Math.floor(Number(ctx.config.tickMs ?? 30000) / 1000));
      st.nextAt = nowSecs + Math.min(STAMP_RETRY_MAX_SECS, tickSecs * 2 ** Math.min(st.attempts, 16));
    }
    if (st.attempts === 1 || st.state === 'full') {
      hooks.journal({ kind: 'metadata', action: 'stamp', ok: false, portfolio: portfolio || null, code, message });
    }
    if (st.state === 'full' || st.attempts >= STAMP_ALERT_AFTER) {
      const text = `the metadata document's tags and links could not be written (${code}): ${message}`;
      if (hooks.raiseAlert(ctx, 'metadata', code, text)) alert = { key: 'metadata', code, message: text };
    }
    ctx.log?.('warn', 'metadata-stamp-failed', { code, error: message, attempts: st.attempts });
  }
  return { state: st.state, attempts: st.attempts, error: st.error, alert };
}
