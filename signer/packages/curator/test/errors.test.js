/**
 * The error tables are the signer's vocabulary for what the chain said. A
 * table that drifted from the enum names the wrong error with full
 * confidence, so the embedded copy is checked against the Rust source when
 * a checkout is present and against the stoken IDL's own `errors` block
 * always; the parser itself is proven to fail on a malformed enum rather
 * than skip a variant.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { idlFor, programId } from '@composable-portfolios/chain';
import {
  ANCHOR_CUSTOM_ERROR_BASE,
  FACTORY_ERRORS,
  REFUSAL_STATUS,
  Refusal,
  STOKEN_ERRORS,
  loadKnownProgramIds,
  nameProgramError,
} from '../src/errors.js';
import { SOURCES, parseErrorEnum, readErrorTables, renderModule, umbrellaRoot, OUTPUT } from '../scripts/generate-program-errors.mjs';

const FACTORY_ID = programId('portfolio_factory').toBase58();
const STOKEN_ID = programId('stoken').toBase58();
const code = (table, name) => ANCHOR_CUSTOM_ERROR_BASE + table.indexOf(name);

describe('error tables', () => {
  it('embed every variant of both enums in order', () => {
    assert.equal(FACTORY_ERRORS.length, 65);
    assert.equal(STOKEN_ERRORS.length, 122);
    assert.equal(FACTORY_ERRORS[0], 'CreationPaused');
    assert.equal(FACTORY_ERRORS[20], 'RebalanceTooSoon');
    assert.equal(FACTORY_ERRORS[64], 'Unauthorized');
    assert.equal(STOKEN_ERRORS[0], 'Unauthorized');
    assert.equal(STOKEN_ERRORS[121], 'InvalidProgramData');
    assert.ok(Object.isFrozen(FACTORY_ERRORS));
    assert.ok(Object.isFrozen(STOKEN_ERRORS));
    assert.equal(new Set(FACTORY_ERRORS).size, FACTORY_ERRORS.length);
    assert.equal(new Set(STOKEN_ERRORS).size, STOKEN_ERRORS.length);
  });

  it('agree with the stoken IDL errors block (code = 6000 + index)', () => {
    const { errors } = idlFor('stoken');
    assert.equal(errors.length, STOKEN_ERRORS.length);
    for (const entry of errors) {
      assert.equal(STOKEN_ERRORS[entry.code - ANCHOR_CUSTOM_ERROR_BASE], entry.name, `code ${entry.code}`);
    }
  });

  it('match a re-parse of the Rust enums when the sibling checkout is present', (t) => {
    const umbrella = umbrellaRoot();
    const present = umbrella && Object.values(SOURCES).every((spec) => existsSync(join(umbrella, spec.path)));
    if (!present) {
      t.skip(umbrella ? `no program checkout under ${umbrella}` : 'COMPOSABLE_PORTFOLIOS_UMBRELLA unset: the Rust sources are in the program repos beside it');
      return;
    }
    const tables = readErrorTables(umbrella);
    assert.deepEqual([...FACTORY_ERRORS], tables.portfolio_factory);
    assert.deepEqual([...STOKEN_ERRORS], tables.stoken);
    assert.equal(readFileSync(OUTPUT, 'utf8'), renderModule(tables), 'generated module is stale; run scripts/generate-program-errors.mjs');
  });

  it('parser: multi-line #[msg] attributes, comments and trailing commas', () => {
    const source = `
      //! doc comment with a brace {
      use anchor_lang::prelude::*;
      #[error_code]
      pub enum Sample {
          #[msg("first, with a comma")]
          First,
          // a comment, mentioning Second, that must not count
          #[msg(
              "spans lines and has a } brace"
          )]
          Second,
          #[msg("last")]
          Third
      }
      pub enum Other { Nope, }
    `;
    assert.deepEqual(parseErrorEnum(source, 'Sample'), ['First', 'Second', 'Third']);
    assert.deepEqual(parseErrorEnum(source, 'Other'), ['Nope']);
  });

  it('parser: refuses a line it does not understand instead of skipping it', () => {
    const planted = 'pub enum Bad {\n  #[msg("a")]\n  Alpha,\n  beta = 7,\n  Gamma,\n}';
    assert.throws(() => parseErrorEnum(planted, 'Bad'), /unexpected line in enum Bad: beta = 7/);
    assert.throws(() => parseErrorEnum('pub enum Missing {}', 'Nope'), /no `pub enum Nope`/);
    assert.throws(() => parseErrorEnum('pub enum Dup {\n  A,\n  A,\n}', 'Dup'), /repeats a variant/);
  });
});

describe('nameProgramError', () => {
  it('names a hex custom error with a program hint', () => {
    assert.deepEqual(
      nameProgramError('Transaction simulation failed: custom program error: 0x1798', { program: 'portfolio_factory' }),
      { code: 6040, name: 'PendingWithdrawalsBlockTargets', program: 'portfolio_factory' },
    );
    assert.deepEqual(
      nameProgramError('custom program error: 0x1798', { program: 'stoken' }),
      { code: 6040, name: 'LimitExceedsMaximum', program: 'stoken' },
    );
  });

  it('names a decimal Error Number and a JSON Custom code the same way', () => {
    assert.deepEqual(
      nameProgramError('Error Number: 6040', { program: 'portfolio_factory' }),
      { code: 6040, name: 'PendingWithdrawalsBlockTargets', program: 'portfolio_factory' },
    );
    assert.deepEqual(
      nameProgramError('{"InstructionError":[1,{"Custom":6042}]}', { program: 'stoken' }),
      { code: 6042, name: 'PricePending', program: 'stoken' },
    );
  });

  it('attributes a bare number to the program whose id is in the text', async () => {
    await loadKnownProgramIds();
    assert.deepEqual(
      nameProgramError(`Program ${FACTORY_ID} failed: custom program error: 0x1772`),
      { code: 6002, name: 'DuplicatePool', program: 'portfolio_factory' },
    );
    assert.deepEqual(
      nameProgramError(`Program ${STOKEN_ID} failed: custom program error: 0x1772`),
      { code: 6002, name: 'InvalidPrice', program: 'stoken' },
    );
    // Explicit map wins over the manifest and works with either orientation.
    const fake = 'FakeProgram1111111111111111111111111111111';
    assert.equal(nameProgramError(`Program ${fake} failed: Error Number: 6000`, { programIds: { [fake]: 'stoken' } }).program, 'stoken');
  });

  it('attributes by a name that exists in exactly one table', () => {
    assert.deepEqual(
      nameProgramError('AnchorError thrown. Error Code: RebalanceTooSoon. Error Number: 6020. Error Message: …'),
      { code: 6020, name: 'RebalanceTooSoon', program: 'portfolio_factory' },
    );
    assert.deepEqual(nameProgramError('Error Code: PricePending'), { code: code(STOKEN_ERRORS, 'PricePending'), name: 'PricePending', program: 'stoken' });
  });

  it('uses the number to settle a name both programs declare', () => {
    const factoryVaultPaused = code(FACTORY_ERRORS, 'VaultPaused');
    const stokenVaultPaused = code(STOKEN_ERRORS, 'VaultPaused');
    assert.notEqual(factoryVaultPaused, stokenVaultPaused);
    assert.equal(nameProgramError(`Error Code: VaultPaused. Error Number: ${factoryVaultPaused}.`).program, 'portfolio_factory');
    assert.equal(nameProgramError(`Error Code: VaultPaused. Error Number: ${stokenVaultPaused}.`).program, 'stoken');
    const bare = nameProgramError('Error Code: Unauthorized');
    assert.equal(bare.program, 'unknown');
    assert.equal(bare.name, 'Unauthorized');
  });

  it('reports candidates rather than guessing for an unattributable number', () => {
    const result = nameProgramError('custom program error: 0x1798');
    assert.equal(result.program, 'unknown');
    assert.equal(result.code, 6040);
    assert.equal(result.name, null);
    assert.deepEqual(result.candidates, { portfolio_factory: 'PendingWithdrawalsBlockTargets', stoken: 'LimitExceedsMaximum' });
  });

  it('lets the number win over a log line that names a different error', () => {
    assert.deepEqual(
      nameProgramError('Error Code: RebalanceTooSoon. Error Number: 6021.', { program: 'portfolio_factory' }),
      { code: 6021, name: 'RebalanceDelayTooShort', program: 'portfolio_factory' },
    );
  });

  it('returns null for text without an error, and no name for a framework code', () => {
    assert.equal(nameProgramError(''), null);
    assert.equal(nameProgramError(undefined), null);
    assert.equal(nameProgramError('Blockhash not found'), null);
    assert.deepEqual(nameProgramError('custom program error: 0x7d1'), { code: 2001, name: null, program: 'unknown', candidates: {} });
    assert.deepEqual(nameProgramError('Error Number: 9999', { program: 'stoken' }), { code: 9999, name: null, program: 'stoken' });
  });
});

describe('Refusal', () => {
  it('carries the code, the mapped status and optional detail', () => {
    const r = new Refusal('WRONG_PAYER', 'not the curator', { payer: 'x' });
    assert.equal(r.code, 'WRONG_PAYER');
    assert.equal(r.status, 502);
    assert.equal(r.name, 'Refusal');
    assert.deepEqual(r.detail, { payer: 'x' });
    assert.ok(r instanceof Error);
    assert.equal(new Refusal('SOMETHING_NEW', 'x').status, 422);
    assert.equal(new Refusal('UNAUTHORIZED', 'x').status, 401);
    assert.equal('detail' in new Refusal('OPS_ONLY', 'x'), false);
  });

  it('maps every decode code to 502', () => {
    for (const code of ['NOT_A_TRANSACTION', 'WRONG_PAYER', 'FOREIGN_PROGRAM', 'FOREIGN_LOOKUP_TABLE', 'UNKNOWN_INSTRUCTION',
      'UNEXPECTED_INSTRUCTIONS', 'WRONG_PORTFOLIO', 'WRONG_ACCOUNT', 'TARGETS_MISMATCH', 'UNEXPECTED_STEP']) {
      assert.equal(REFUSAL_STATUS[code], 502, code);
    }
  });
});
