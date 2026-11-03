// The fee terms the weavr skill gives the model. The books charge 25 bps each
// way, a rebalance fee and a royalty (weavr ADR-0347, ADR-0349); the skill
// once said 0.40% round trip and 60% to the creator, the demo terms, and the
// model repeated them to users. The sentence matches the weavr MCP
// instructions, which build it from the same policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(ROOT, 'skills/weavr/SKILL.md'), 'utf8');

test('the weavr skill states the fee terms the books charge', () => {
  assert.ok(
    skill.includes('Fees: 0.50% round trip (0.25% in, 0.25% out), no management fee, 0.25% of a rebalance sale capped at 0.50% of NAV per 30 days. Portfolio royalty starts at 25% of fees.'),
    'SKILL.md carries the fee sentence of the weavr MCP instructions',
  );
  for (const stale of ['0.40%', '0.20%', '60% of the fee stream']) {
    assert.equal(skill.includes(stale), false, `SKILL.md still says ${stale}`);
  }
});
