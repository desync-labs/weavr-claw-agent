/**
 * The link "signer": the shape of a signer for a host that has no wallet. It
 * never signs. The flow it stands for is create_portfolio with wallet "link"
 * and no creator, the signUrl sent to the owner in a private chat, the owner
 * signing in a browser, and await_portfolio with the deploymentId until the
 * portfolio is live; deposits are made on the portfolio's page. Its sign()
 * throws NO_WALLET synchronously, so no flow can sign through it by accident.
 */
export const NO_WALLET_DETAIL = 'this host has no signing wallet: call create_portfolio with wallet "link" and no creator, send the signUrl to the owner in a private chat, then await_portfolio with the deploymentId; deposits are made on the portfolio\'s page';

export function noWalletError() {
  const err = new Error(NO_WALLET_DETAIL);
  err.code = 'NO_WALLET';
  return err;
}

export function linkSigner() {
  return {
    wallet: null,
    kind: 'link',
    sign() { throw noWalletError(); },
  };
}
