// A stand-in for @paybox-sh/sdk's cli.js: answers `credentials` with one
// granted wallet and `sign` with a "signed" copy of the intent. Never signs
// anything real. Fails `sign` when FAKE_PAYBOX_DECLINE is set, answers like
// PayBox's 403 when FAKE_PAYBOX_REVOKED is set, and produces a real signature
// when FAKE_PAYBOX_KEYPAIR (a JSON secret key, test-only) is set.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2).filter((a) => a !== '--json');
const wallet = process.env.FAKE_PAYBOX_WALLET;
if (args[0] === 'credentials') {
  process.stdout.write(JSON.stringify({ credentials: [{ credential: { id: 'cred-1', name: 'sol-test', metadata: { address: wallet } }, grant: { approval_mode: 'autonomous' } }] }));
  process.exit(0);
}
if (args[0] === 'sign') {
  if (process.env.PAYBOX_SIGNING_KEY !== 'pbxk1.fake-key') { process.stdout.write(JSON.stringify({ status: 'error', error: 'no signing key' })); process.exit(0); }
  if (process.env.FAKE_PAYBOX_DECLINE) { process.stdout.write(JSON.stringify({ status: 'pending_signature', request_id: 'r1', output: null })); process.exit(0); }
  if (process.env.FAKE_PAYBOX_REVOKED) { process.stdout.write(JSON.stringify({ error: 'paybox POST /agent/requests/r1/moonx-sign failed (403): {"error":"agent signer has been revoked"}' })); process.exit(1); }
  const intentPath = args[args.indexOf('--intent') + 1].replace(/^@/, '');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  let signed = 'signed:' + intent.transactionBase64.slice(0, 16);
  if (process.env.FAKE_PAYBOX_KEYPAIR) {
    const { Keypair, Transaction } = require('@solana/web3.js');
    const tx = Transaction.from(Buffer.from(intent.transactionBase64, 'base64'));
    tx.partialSign(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.FAKE_PAYBOX_KEYPAIR))));
    signed = tx.serialize({ requireAllSignatures: false }).toString('base64');
  }
  process.stdout.write(JSON.stringify({ status: 'success', request_id: 'r1', output: { output_type: 'signature', value: { signedTransactionBase64: signed } } }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ error: 'unknown command' }));
process.exit(1);
