/**
 * Which wallet the tool signs with. Pure: argv and env in, the mode and where
 * it came from out, so the precedence is unit-testable without a key or a
 * network. The order is `--wallet <x>` on the command line, then WEAVR_WALLET,
 * then inference from what is configured: local when SIGN_LOCAL_KEYPAIR_FILE
 * is set (a keypair file is the more explicit thing), paybox when any PayBox
 * variable is set, else link (this host has no signer; the owner signs from
 * the sign link). Any PayBox variable, not only PAYBOX_CLI, so that a half
 * configured PayBox host resolves to paybox and the PayBox signer reports the
 * missing variable as CONFIG, instead of link telling the agent to send the
 * owner a sign link. Link is inferred only when nothing at all is configured.
 * An empty variable counts as unset, so a sourced env.example changes nothing.
 */
export const WALLET_MODES = Object.freeze(['paybox', 'local', 'link']);

/** The PayBox variables; any one of them set means this host meant to use PayBox. */
export const PAYBOX_VARIABLES = Object.freeze(['PAYBOX_CLI', 'PAYBOX_CONFIG_DIR', 'PAYBOX_CREDENTIAL_ID', 'PAYBOX_SIGNING_KEY_FILE']);

function config(message) {
  const err = new Error(message);
  err.code = 'CONFIG';
  return err;
}

function accept(value, where) {
  if (!WALLET_MODES.includes(value)) {
    throw config(`unknown wallet ${JSON.stringify(value ?? null)} from ${where}: accepted values are ${WALLET_MODES.join(', ')}`);
  }
  return value;
}

/**
 * Resolve the wallet mode. Returns `{ mode, source, rest }` where `source` is
 * 'flag', 'env' or 'inferred' and `rest` is argv with every `--wallet <x>`
 * pair removed. Throws a CONFIG error on an unknown value, a `--wallet` with
 * no value, or two `--wallet` flags that disagree (an alias prepends its own,
 * so a contrary flag on its command line is refused rather than ignored).
 */
export function resolveWalletMode({ argv = [], env = {} } = {}) {
  const rest = [];
  const flagged = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--wallet') { rest.push(argv[i]); continue; }
    if (i + 1 >= argv.length) throw config(`--wallet needs a value: ${WALLET_MODES.join(', ')}`);
    flagged.push(accept(argv[i + 1], '--wallet'));
    i += 1;
  }
  if (flagged.length) {
    const distinct = [...new Set(flagged)];
    if (distinct.length > 1) throw config(`conflicting --wallet values ${distinct.join(', ')}: an alias decides its own mode, run tools/sign.mjs to choose`);
    return { mode: distinct[0], source: 'flag', rest };
  }
  if (env.WEAVR_WALLET) return { mode: accept(env.WEAVR_WALLET, 'WEAVR_WALLET'), source: 'env', rest };
  if (env.SIGN_LOCAL_KEYPAIR_FILE) return { mode: 'local', source: 'inferred', rest };
  if (PAYBOX_VARIABLES.some((k) => env[k])) return { mode: 'paybox', source: 'inferred', rest };
  return { mode: 'link', source: 'inferred', rest };
}
