// A JSON-RPC stand-in answering getBalance and getAccountInfo from a table.
// `table.balances` maps pubkey -> lamports, `table.accounts` maps address ->
// bytes. Every call is recorded. Used in-process (the `rpc` seam) and by
// the fake server's /rpc route (the bin's real jsonRpc).
import { createRequire } from 'node:module';
import { FACTORY_CONFIG_DISCRIMINATOR } from '../../../lib/curator/chain.mjs';

const require = createRequire(import.meta.url);
const { PublicKey } = require('@solana/web3.js');

export function fakeRpc(table) {
  const calls = [];
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (method === 'getBalance') return { context: { slot: 1 }, value: table.balances?.[params[0]] ?? 0 };
    if (method === 'getAccountInfo') {
      const data = table.accounts?.[params[0]];
      return {
        context: { slot: 1 },
        value: data ? { data: [Buffer.from(data).toString('base64'), 'base64'], owner: table.owner ?? '11111111111111111111111111111111', lamports: 1, executable: false, rentEpoch: 0 } : null,
      };
    }
    throw new Error(`fake rpc has no ${method}`);
  };
  rpc.calls = calls;
  rpc.table = table;
  return rpc;
}

/** A FactoryConfig account body: discriminator, bumps, then the four keys at the pinned offsets. */
export function factoryConfigBytes({ guardian, governance, treasury, keeperProcessor, discriminator = FACTORY_CONFIG_DISCRIMINATOR }) {
  const buf = Buffer.alloc(138);
  Buffer.from(discriminator).copy(buf, 0);
  buf[8] = 254;
  buf[9] = 253;
  const put = (key, offset) => new PublicKey(key ?? '11111111111111111111111111111111').toBuffer().copy(buf, offset);
  put(governance, 10);
  put(guardian, 42);
  put(treasury, 74);
  put(keeperProcessor, 106);
  return buf;
}
