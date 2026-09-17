/**
 * The lines init and doctor print: one per step or check, a check mark, a
 * cross or an arrow, with a `fix:` line under a cross. In JSON mode nothing is
 * printed until the end; either way every line is also kept as a record so a
 * test can assert on it and `--json` can print it whole.
 */
export const MARK = Object.freeze({ ok: '✓', cross: '✗', wait: '→', note: '·' });

export function makeReport({ log = console.log, json = false } = {}) {
  const records = [];
  const lines = [];
  const emit = (line) => {
    lines.push(line);
    if (!json) log(line);
  };
  const record = (kind, name, text, extra = {}) => {
    const entry = { kind, name, text, ...extra };
    records.push(entry);
    return entry;
  };
  return {
    records,
    lines,
    /** A step that passed. `details` are indented lines under it. */
    ok(name, text, { details = [], ...extra } = {}) {
      emit(`  ${MARK.ok} ${name}: ${text}`);
      for (const d of details) emit(`      ${d}`);
      return record('ok', name, text, { ok: true, details, ...extra });
    },
    /** A step that failed; `fix` is the plain sentence the owner acts on. */
    cross(name, text, { fix, details = [], ...extra } = {}) {
      emit(`  ${MARK.cross} ${name}: ${text}`);
      for (const d of details) emit(`      ${d}`);
      if (fix) emit(`      fix: ${fix}`);
      return record('cross', name, text, { ok: false, fix: fix ?? null, details, ...extra });
    },
    /** A step that is waiting on the owner or the chain. */
    wait(name, text, { details = [], ...extra } = {}) {
      emit(`  ${MARK.wait} ${name}: ${text}`);
      for (const d of details) emit(`      ${d}`);
      return record('wait', name, text, { ok: null, details, ...extra });
    },
    /** A check that could not run here; not a failure. */
    skip(name, text, extra = {}) {
      emit(`  ${MARK.note} ${name}: skipped, ${text}`);
      return record('skip', name, text, { ok: null, skipped: true, ...extra });
    },
    /** Something the command did on its own that the owner should know, not a pass or a fail. */
    info(name, text, extra = {}) {
      emit(`  ${MARK.note} ${name}: ${text}`);
      return record('info', name, text, { ok: null, ...extra });
    },
    /** A line on its own, no mark. */
    note(text) {
      emit(`      ${text}`);
      return record('note', null, text, { ok: null });
    },
    /** A blank line then a heading (the next-steps block). */
    heading(text) {
      emit('');
      emit(`  ${text}`);
    },
    /** True when any recorded step is a cross. */
    hasCross() {
      return records.some((r) => r.kind === 'cross');
    },
    /** The `--json` body: the records plus whatever the command adds. */
    json(extra = {}) {
      return { ...extra, steps: records.filter((r) => r.kind !== 'note') };
    },
  };
}
