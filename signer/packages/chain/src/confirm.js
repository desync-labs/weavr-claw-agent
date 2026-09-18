/**
 * Public RPCs throw 429 / Internal error / timeouts mid-call.
 * Catalogue reads and confirm polls must back off, not fail the API.
 */
export const RPC_RETRY =
  /Internal error|429|Too Many|timed out|fetch failed|ECONNRESET|ETIMEDOUT|502|503/i;

export async function withRpcRetry(fn, attempts = 8) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error?.message ?? String(error);
      if (!RPC_RETRY.test(msg)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** i, 8_000)));
    }
  }
  throw lastError;
}

export async function confirmSignature(connection, spec, commitment = 'confirmed', attempts = 8) {
  return withRpcRetry(() => connection.confirmTransaction(spec, commitment), attempts);
}

const ALREADY_PROCESSED = /already been processed|already processed/i;
const BLOCKHASH_EXPIRED = /expired|block height exceeded/i;

function confirmed(status, commitment) {
  if (!status || status.err) return false;
  const level = status.confirmationStatus;
  if (commitment === 'finalized') return level === 'finalized';
  return level === 'confirmed' || level === 'finalized';
}

/**
 * Public RPCs drop a raw tx and then `confirmTransaction` waits until the
 * blockhash dies. Resubmit the same bytes until it lands or the height expires.
 */
export async function sendRawUntilConfirmed(
  connection,
  raw,
  { signature, lastValidBlockHeight },
  commitment = 'confirmed',
  { pollMs = 1_500 } = {},
) {
  const send = async () => {
    try {
      return await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    } catch (error) {
      const msg = error?.message ?? String(error);
      if (ALREADY_PROCESSED.test(msg) || RPC_RETRY.test(msg)) return undefined;
      throw error;
    }
  };

  let sig = signature ?? await send();
  if (!sig) {
    sig = await withRpcRetry(() => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }));
  }
  for (;;) {
    const height = await withRpcRetry(() => connection.getBlockHeight(commitment));
    if (Number(height) > Number(lastValidBlockHeight)) {
      throw new Error(`Signature ${sig} has expired: block height exceeded.`);
    }
    const statuses = await withRpcRetry(() => connection.getSignatureStatuses([sig]));
    const status = statuses?.value?.[0];
    if (status?.err) {
      throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    }
    if (confirmed(status, commitment)) return sig;
    await send();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** New blockhash + resign when the first window expires. */
export async function sendSignedUntilConfirmed(
  connection,
  buildAndSign,
  { commitment = 'confirmed', attempts = 4 } = {},
) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    const { raw, signature, lastValidBlockHeight } = await buildAndSign();
    try {
      return await sendRawUntilConfirmed(
        connection,
        raw,
        { signature, lastValidBlockHeight },
        commitment,
      );
    } catch (error) {
      lastError = error;
      const msg = error?.message ?? String(error);
      if (!BLOCKHASH_EXPIRED.test(msg)) throw error;
    }
  }
  throw lastError;
}
