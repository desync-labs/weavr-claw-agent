/**
 * The metadata document: the hash lands on the service's canonical bytes,
 * the message is held to the service's exact text before anything is
 * signed, a write sends the stored block back whole with the configured
 * tags merged in, and the loop's stamp runs until the tags are there, backs
 * off on failure and stops for good when they cannot fit. A real key signs
 * one end-to-end write so the signature is checked, not assumed. Fakes only.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { fakeCtx, fakeMetadata, KEYS, WALLET, T0, T0_MS } from './fakes.js';
import {
  canonicalJson, contentHashOf, parseTagList, mergeEditable, editableOf, tagsOf, checkMessage, metadataClient,
  writeDocument, stampTags, STAMP_RETRY_MAX_SECS, MESSAGE_MAX_SKEW_SECS,
} from '../src/metadata.js';
import { loadSigner } from '../src/keys.js';
import { raiseAlert, clearAlert } from '../src/verbs.js';
import { Refusal } from '../src/errors.js';

const PORTFOLIO = KEYS.portfolio.toBase58();
const ctxs = [];
const mk = (over = {}) => { const ctx = fakeCtx({ metadataTags: ['agent-managed', 'agent-thesis'], ...over }); ctxs.push(ctx); return ctx; };
after(() => ctxs.forEach((ctx) => ctx.cleanup()));

const isRefusal = (code) => (error) => error instanceof Refusal && error.code === code;
const hooksOf = (ctx) => ({ raiseAlert, clearAlert, journal: (record) => ctx.journal.append(record) });
const snapshotWith = (portfolio = PORTFOLIO) => ({ portfolioRow: { portfolio } });

const messageFor = ({ domain = 'weavr.sh', address = WALLET, portfolio = PORTFOLIO, action = 'set-metadata', contentHash, issuedAt = new Date(T0_MS).toISOString(), nonce = '0123456789abcdef' }) => [
  `${domain} wants you to update portfolio metadata with your Solana account:`, address, '',
  `Portfolio: ${portfolio}`, `Action: ${action}`, `Content-Hash: ${contentHash}`, `Issued-At: ${issuedAt}`, `Nonce: ${nonce}`,
].join('\n');

test('canonicalJson is the service\'s form: sorted keys at every level, no whitespace, undefined members dropped', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 'x'], c: null } }), '{"a":{"c":null,"d":[1,"x"]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: [undefined, 2] }), '{"b":[null,2]}');
  assert.equal(contentHashOf({ tags: ['agent-managed'], description: 'x' }), contentHashOf({ description: 'x', tags: ['agent-managed'] }));
  // Pinned bytes: the service's hashJson over the same body (backend packages/metadata/src/encoding.js).
  assert.equal(contentHashOf({ description: 'Hold SOL.', tags: ['agent-managed'] }), 'sha256:4fb7c7aeb6c1a6fc8e1dd1ede5e46d75e7e97995ec764356c1a06fbb64af2a9c');
});

test('parseTagList: comma or space separated, lowercased, de-duplicated; a colon, a bad tag or an eleventh refuses by name', () => {
  assert.deepEqual(parseTagList(undefined), []);
  assert.deepEqual(parseTagList('  '), []);
  assert.deepEqual(parseTagList('agent-managed, Agent-Thesis agent-managed'), ['agent-managed', 'agent-thesis']);
  for (const raw of ['agent:thesis', '-lead', 'x'.repeat(33), 'emoji✓']) {
    assert.throws(() => parseTagList(raw), /CURATOR_METADATA_TAGS/, raw);
  }
  assert.throws(() => parseTagList(Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')), /at most 10/);
});

test('mergeEditable keeps every stored field, appends only the missing tags and reports no change when there is none', () => {
  const stored = { description: 'Mine.', external_url: 'https://example.org', links: { twitter: 'https://x.com/a' }, tags: ['lst'] };
  const tagged = mergeEditable(stored, { tags: ['agent-managed'] });
  assert.deepEqual(tagged.metadata, { ...stored, tags: ['lst', 'agent-managed'] });
  assert.deepEqual(tagged.added, ['agent-managed']);
  assert.equal(tagged.changed, true);
  assert.equal(mergeEditable(tagged.metadata, { tags: ['agent-managed'] }).changed, false);
  const described = mergeEditable(tagged.metadata, { tags: ['agent-managed'], description: 'New.' });
  assert.deepEqual(described.metadata, { ...tagged.metadata, description: 'New.' });
  assert.equal(mergeEditable(described.metadata, { tags: ['agent-managed'], description: 'New.' }).changed, false);
  assert.throws(() => mergeEditable({ tags: Array.from({ length: 10 }, (_, i) => `t${i}`) }, { tags: ['agent-managed'] }), isRefusal('METADATA_TAGS_FULL'));
});

test('editableOf and tagsOf read only what the service stores', () => {
  assert.deepEqual(editableOf({ editable: { description: 'd', tags: ['a'], icon: 'x', name: 'n', links: null } }), { description: 'd', tags: ['a'] });
  assert.deepEqual(editableOf({ editable: [] }), {});
  assert.deepEqual(editableOf(null), {});
  assert.deepEqual(tagsOf({ tags: ['a'], editable: { tags: ['b'] } }), ['a']);
  assert.deepEqual(tagsOf({ editable: { tags: ['b'] } }), ['b']);
  assert.deepEqual(tagsOf({}), []);
});

test('checkMessage accepts the service\'s text and refuses a change to any line, with nothing else to go on', () => {
  const contentHash = contentHashOf({ tags: ['agent-managed'] });
  const expected = { domain: 'weavr.sh', address: WALLET, portfolio: PORTFOLIO, contentHash, nowSecs: T0 };
  assert.deepEqual(checkMessage(messageFor({ contentHash }), expected), { issuedAt: new Date(T0_MS).toISOString(), nonce: '0123456789abcdef' });
  const other = Keypair.generate().publicKey.toBase58();
  const bad = [
    null,
    messageFor({ contentHash }).replace('\n\n', '\n'),
    `${messageFor({ contentHash })}\nExtra: line`,
    messageFor({ contentHash, domain: 'evil.sh' }),
    messageFor({ contentHash, address: other }),
    messageFor({ contentHash, portfolio: other }),
    messageFor({ contentHash, action: 'set-icon' }),
    messageFor({ contentHash: contentHashOf({ tags: ['other'] }) }),
    messageFor({ contentHash: 'sha256:abc' }),
    messageFor({ contentHash, issuedAt: new Date(T0_MS + (MESSAGE_MAX_SKEW_SECS + 1) * 1000).toISOString() }),
    messageFor({ contentHash, issuedAt: new Date(T0_MS - (MESSAGE_MAX_SKEW_SECS + 1) * 1000).toISOString() }),
    messageFor({ contentHash, issuedAt: 'yesterday' }),
    messageFor({ contentHash, nonce: 'zz' }),
    messageFor({ contentHash }).replace('Action:', 'Action :'),
  ];
  for (const text of bad) assert.throws(() => checkMessage(text, expected), isRefusal('METADATA_MESSAGE_MISMATCH'), JSON.stringify(text)?.slice(0, 80));
});

test('metadataClient: GET, POST and PUT on /v1/metadata; a 4xx is METADATA_REFUSED with the service code, a 5xx UPSTREAM; no URL in any message', async () => {
  const seen = [];
  let answer = { status: 200, body: { ok: 1 } };
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  const client = metadataClient({ baseUrl: 'https://meta.test/', fetchImpl });
  await client.document(PORTFOLIO);
  await client.message(PORTFOLIO, { address: WALLET });
  await client.put(PORTFOLIO, { address: WALLET });
  assert.deepEqual(seen.map((r) => [r.method, r.url]), [
    ['GET', `https://meta.test/v1/metadata/${PORTFOLIO}`],
    ['POST', `https://meta.test/v1/metadata/${PORTFOLIO}/message`],
    ['PUT', `https://meta.test/v1/metadata/${PORTFOLIO}`],
  ]);
  answer = { status: 403, body: { error: { code: 'NOT_CURATOR', message: 'only the curator' } } };
  for (const call of [() => client.message(PORTFOLIO, {}), () => client.put(PORTFOLIO, {})]) {
    await assert.rejects(call(), (error) => isRefusal('METADATA_REFUSED')(error) && error.detail.code === 'NOT_CURATOR' && !error.message.includes('meta.test'));
  }
  answer = { status: 503, body: { error: { code: 'RPC_BUSY', message: 'busy' } } };
  await assert.rejects(client.put(PORTFOLIO, {}), (error) => isRefusal('UPSTREAM')(error) && !error.message.includes('meta.test'));
  await assert.rejects(client.document(PORTFOLIO), isRefusal('UPSTREAM'));
});

test('writeDocument: document → message → check → signText → put, the stored block sent back whole with the tags merged and the description set', async () => {
  const ctx = mk();
  ctx.metadata.doc.editable = { external_url: 'https://example.org', links: { twitter: 'https://x.com/a' }, tags: ['lst'] };
  const out = await writeDocument(ctx, { portfolio: PORTFOLIO, description: 'Hold SOL.' });
  assert.deepEqual(ctx.trace.filter((t) => t.startsWith('metadata.') || t === 'signText'), ['metadata.document', 'metadata.message', 'signText', 'metadata.put']);
  const put = ctx.metadata.calls.find((c) => c.name === 'put');
  assert.deepEqual(put.body.metadata, { external_url: 'https://example.org', links: { twitter: 'https://x.com/a' }, tags: ['lst', 'agent-managed', 'agent-thesis'], description: 'Hold SOL.' });
  assert.equal(put.body.address, WALLET);
  assert.equal(put.body.message, ctx.signer.texts[0]);
  assert.ok(put.body.message.includes(`Content-Hash: ${contentHashOf(put.body.metadata)}`));
  assert.equal(out.changed, true);
  assert.deepEqual(out.added, ['agent-managed', 'agent-thesis']);
  assert.equal(out.document.updatedBy, WALLET);
  assert.equal(ctx.signer.calls.length, 0, 'no transaction is signed');

  const again = await writeDocument(ctx, { portfolio: PORTFOLIO, description: 'Hold SOL.' });
  assert.equal(again.changed, false);
  assert.equal(ctx.metadata.calls.filter((c) => c.name === 'put').length, 1, 'the same document is not written twice');
  assert.equal(ctx.signer.texts.length, 1);
});

test('writeDocument signs nothing when the service names another curator or hands back a text that is not the one expected', async () => {
  const notCurator = mk();
  notCurator.metadata.curator = Keypair.generate().publicKey.toBase58();
  await assert.rejects(writeDocument(notCurator, { portfolio: PORTFOLIO }), isRefusal('NOT_CURATOR'));
  for (const tamper of [
    (m) => ({ ...m, portfolio: Keypair.generate().publicKey.toBase58() }),
    (m) => ({ ...m, contentHash: contentHashOf({ description: 'something else' }) }),
    (m) => ({ ...m, domain: 'attacker.example' }),
  ]) {
    const ctx = mk();
    ctx.metadata.build = (input) => messageFor(tamper({ ...input, address: input.address }));
    await assert.rejects(writeDocument(ctx, { portfolio: PORTFOLIO }), isRefusal('METADATA_MESSAGE_MISMATCH'));
    assert.equal(ctx.signer.texts.length, 0);
    assert.equal(ctx.metadata.calls.filter((c) => c.name === 'put').length, 0);
  }
});

test('a real curator key signs the service\'s message: the signature verifies against the wallet over the exact text', async () => {
  const keypair = Keypair.generate();
  const signer = loadSigner({ text: JSON.stringify(Array.from(keypair.secretKey)) });
  const ctx = mk({ signer });
  ctx.metadata.curator = signer.wallet;
  await writeDocument(ctx, { portfolio: PORTFOLIO, description: 'Hold SOL.' });
  const put = ctx.metadata.calls.find((c) => c.name === 'put');
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keypair.publicKey.toBytes()]), format: 'der', type: 'spki' });
  assert.ok(edVerify(null, Buffer.from(put.body.message, 'utf8'), publicKey, Buffer.from(put.body.signature, 'base64')));
  assert.ok(put.body.message.split('\n')[1] === signer.wallet);
});

test('stampTags: nothing configured is nothing done; otherwise one write adds the tags, one journal line says so, and the stamp never runs again', async () => {
  const off = mk({ metadataTags: [] });
  assert.equal(await stampTags(off, snapshotWith(), hooksOf(off)), null);
  assert.equal(off.metadata.calls.length, 0);

  const ctx = mk();
  const out = await stampTags(ctx, snapshotWith(), hooksOf(ctx));
  assert.equal(out.state, 'ok');
  assert.deepEqual(ctx.metadata.doc.tags, ['agent-managed', 'agent-thesis']);
  const lines = ctx.journal.records().filter((r) => r.kind === 'metadata');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].added, ['agent-managed', 'agent-thesis']);
  assert.equal(await stampTags(ctx, snapshotWith(), hooksOf(ctx)), null);
  assert.equal(ctx.metadata.calls.filter((c) => c.name === 'document').length, 1);

  const already = mk();
  already.metadata.doc.editable = { tags: ['agent-managed', 'agent-thesis'] };
  assert.equal((await stampTags(already, snapshotWith(), hooksOf(already))).state, 'ok');
  assert.equal(already.metadata.calls.filter((c) => c.name !== 'document').length, 0, 'a document that already carries them is only read');
  assert.equal(already.journal.records().filter((r) => r.kind === 'metadata').length, 0);
});

test('stampTags runs while paused, not while self-locked', async () => {
  const paused = mk({ paused: true });
  assert.equal((await stampTags(paused, snapshotWith(), hooksOf(paused))).state, 'ok');
  const locked = mk({ selfLocked: { at: T0, reason: 'INVARIANT_DRIFT', drift: [] } });
  assert.equal(await stampTags(locked, snapshotWith(), hooksOf(locked)), null);
  assert.equal(locked.metadata.calls.length, 0);
});

test('stampTags backs off on failure (doubling, capped at an hour), alerts on the third failure in a row and clears it on success', async () => {
  const ctx = mk();
  ctx.metadata.fail.document = new Refusal('UPSTREAM', 'metadata GET answered 503');
  const first = await stampTags(ctx, snapshotWith(), hooksOf(ctx));
  assert.equal(first.state, 'failed');
  assert.equal(ctx.state.metadata.nextAt, T0 + 60);
  assert.equal(await stampTags(ctx, snapshotWith(), hooksOf(ctx)), null, 'not due yet');
  ctx.clock.advance(60);
  assert.equal((await stampTags(ctx, snapshotWith(), hooksOf(ctx))).alert, null);
  ctx.clock.advance(120);
  const third = await stampTags(ctx, snapshotWith(), hooksOf(ctx));
  assert.equal(third.attempts, 3);
  assert.equal(third.alert?.code, 'UPSTREAM');
  assert.equal(ctx.journal.records().filter((r) => r.kind === 'metadata' && r.ok === false).length, 1, 'the first failure is journaled, not every retry');
  for (let i = 0; i < 12; i += 1) {
    ctx.clock.set((ctx.state.metadata.nextAt ?? T0) * 1000);
    await stampTags(ctx, snapshotWith(), hooksOf(ctx));
  }
  assert.ok(ctx.state.metadata.nextAt - Math.floor(ctx.clock.now() / 1000) <= STAMP_RETRY_MAX_SECS);
  delete ctx.metadata.fail.document;
  ctx.clock.set(ctx.state.metadata.nextAt * 1000);
  assert.equal((await stampTags(ctx, snapshotWith(), hooksOf(ctx))).state, 'ok');
  const alert = ctx.state.alerts.get('metadata');
  assert.ok(!alert || alert.resolvedAt != null, 'the alert clears (an undelivered one is dropped)');
});

test('stampTags stops for good, alerted, when the document has no room for the tags', async () => {
  const ctx = mk();
  ctx.metadata.doc.editable = { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) };
  const out = await stampTags(ctx, snapshotWith(), hooksOf(ctx));
  assert.equal(out.state, 'full');
  assert.equal(out.alert?.code, 'METADATA_TAGS_FULL');
  ctx.clock.advance(STAMP_RETRY_MAX_SECS * 2);
  assert.equal(await stampTags(ctx, snapshotWith(), hooksOf(ctx)), null);
  assert.equal(ctx.metadata.calls.filter((c) => c.name === 'put').length, 0);
});

test('stampTags without a Portfolio key yet fails and retries rather than naming the mint', async () => {
  const ctx = mk();
  const out = await stampTags(ctx, { portfolioRow: null }, hooksOf(ctx));
  assert.equal(out.state, 'failed');
  assert.equal(ctx.metadata.calls.length, 0);
  assert.equal(fakeMetadata().doc.portfolio, PORTFOLIO);
});

test('two writes on one signer run one after the other: the second reads what the first stored', async () => {
  const ctx = mk();
  const [tagsOnly, described] = await Promise.all([
    writeDocument(ctx, { portfolio: PORTFOLIO }),
    writeDocument(ctx, { portfolio: PORTFOLIO, description: 'Hold SOL.' }),
  ]);
  assert.equal(tagsOnly.changed, true);
  assert.equal(described.changed, true);
  assert.deepEqual(ctx.trace.filter((t) => t.startsWith('metadata.')), [
    'metadata.document', 'metadata.message', 'metadata.put',
    'metadata.document', 'metadata.message', 'metadata.put',
  ]);
  assert.deepEqual(ctx.metadata.calls.filter((c) => c.name === 'put')[1].body.metadata, { tags: ['agent-managed', 'agent-thesis'], description: 'Hold SOL.' });
  ctx.metadata.fail.document = new Refusal('UPSTREAM', 'down');
  await assert.rejects(writeDocument(ctx, { portfolio: PORTFOLIO }), isRefusal('UPSTREAM'));
  delete ctx.metadata.fail.document;
  assert.equal((await writeDocument(ctx, { portfolio: PORTFOLIO, description: 'Hold BTC.' })).changed, true, 'a failed write does not block the next');
});
