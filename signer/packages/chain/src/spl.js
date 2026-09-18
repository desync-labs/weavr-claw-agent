/**
 * SPL addresses and instruction encoding, derived rather than imported.
 *
 * Deriving the few pieces the keeper needs keeps its dependency surface to
 * web3.js and the Anchor coder. A keeper is a hot-key service; every package it
 * pulls in is a package that can reach that key.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

export function associatedTokenAddress(mint, owner, tokenProgram = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Idempotent ATA creation (instruction 1).
 *
 * The keeper creates fee-recipient ATAs before the first distribution and does
 * not track whether it already has: the idempotent variant makes a repeat a
 * no-op instead of a failed transaction, so the tick stays stateless.
 */
export function createAssociatedTokenAccountIdempotent(
  payer,
  owner,
  mint,
  tokenProgram = TOKEN_PROGRAM_ID,
) {
  const address = associatedTokenAddress(mint, owner, tokenProgram);
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: address, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
