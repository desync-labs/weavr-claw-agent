/**
 * The gauge producer and the Prometheus renderer are two modules with one
 * contract, and the server test satisfies it with a fake renderer that
 * echoes whatever keys it is given. That is how a rename on either side
 * rendered every production gauge as 0 while every suite stayed green. This
 * test runs the real loop, the real gaugesOf and the real renderPrometheus
 * end to end and asserts the VALUES, not the names.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx, fakeSnapshot, NEW_TARGETS, T0 } from './fakes.js';
import { createLoop, gaugesOf } from '../src/loop.js';
import { normaliseGauges, renderPrometheus } from '../src/metrics.js';

const ctxs = [];
after(() => ctxs.forEach((ctx) => ctx.cleanup()));

const EFF = T0 + 86400;
const ROW_PENDING = { targets: NEW_TARGETS, proposedAt: T0, effectiveAt: EFF };

test('the real gauges render with their values through the real renderer (no fake in between)', async () => {
  const ctx = fakeCtx({ snapshot: fakeSnapshot({ pending: ROW_PENDING, priceState: 'fresh' }) });
  ctxs.push(ctx);
  ctx.state.hermesHeartbeatAt = T0 - 5;
  await createLoop({ ctx }).tick();
  const text = renderPrometheus(gaugesOf(ctx));
  assert.match(text, new RegExp(`^curator_last_tick_ts ${T0}$`, 'm'));
  assert.match(text, new RegExp(`^curator_hermes_heartbeat_ts ${T0 - 5}$`, 'm'));
  assert.match(text, new RegExp(`^curator_pending_effective_at ${EFF}$`, 'm'));
  assert.match(text, /^curator_apply_state\{state="ARMED"\} 1$/m);
  assert.match(text, /^curator_book_price_fresh 1$/m);
  assert.match(text, /^curator_signer_lamports 100000000$/m);
  assert.match(text, /^curator_self_locked 0$/m);
  assert.match(text, /^curator_paused 0$/m);
});

test('planted: a producer that emits only the metric-name spelling still renders values, and unknown keys render nothing', () => {
  const text = renderPrometheus({ curator_signer_lamports: 42, curator_paused: 1, curator_apply_state: 'ARMED', unrelated: 7 });
  assert.match(text, /^curator_signer_lamports 42$/m);
  assert.match(text, /^curator_paused 1$/m);
  assert.match(text, /^curator_apply_state\{state="ARMED"\} 1$/m);
  assert.doesNotMatch(text, /unrelated/);
  assert.equal(normaliseGauges({ curator_paused: 1 }).paused, 1);
  assert.equal(normaliseGauges({ paused: 0, curator_paused: 1 }).paused, 0, 'the camelCase spelling wins when both are present');
});
