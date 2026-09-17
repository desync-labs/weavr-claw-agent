/**
 * Command line parsing for weavr-curator. Pure: argv in, `{ opts, positional }`
 * out. `--name value` sets a string, `--name` with no value (or followed by
 * another switch) sets true, and every switch named in `booleans` never eats
 * the word after it, so `--wait --wait-secs 60` reads as two switches.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) {
      opts[name] = true;
    } else {
      opts[name] = argv[i + 1];
      i += 1;
    }
  }
  return { opts, positional };
}

/** The string value of `--name`, or a usage error when absent or valueless. */
export function requireOpt(opts, name, hint = `--${name} <value>`) {
  const value = opts[name];
  if (value === undefined || value === true) throw usage(`${hint} is required`);
  return value;
}

/** A usage error: the command line prints it with the usage text and exits 1. */
export function usage(message) {
  const err = new Error(message);
  err.code = 'USAGE';
  return err;
}

export const INIT_BOOLEANS = Object.freeze(['wait', 'yes', 'json']);
export const DOCTOR_BOOLEANS = Object.freeze(['json']);
export const OPS_BOOLEANS = Object.freeze(['clear']);

export const USAGE_TEXT = `weavr-curator: set up, check and operate the weavr curator on your own host

  weavr-curator init --portfolio <ticker|mint> [--home <dir>] [--policy standard|rehearsal]
                     [--api <url>] [--mcp <url>] [--rpc <url>] [--transfer-wallet paybox|local|none]
                     [--wait] [--wait-secs N] [--yes] [--json]
      resolve the portfolio, make or reuse the curator key, hand curation to it, derive the
      chain facts, validate the policy preset against the book, write the tokens and env files
      and render the agent profile into <home> (default ~/.config/weavr-curator/<TICKER>/).
      Exit 0 done, 2 stopped on a cross (the line says the fix), 3 the key needs funding.

  weavr-curator doctor [--home <dir>] [--signer-url <url>] [--json]
      check the key, the SOL balance, the portfolio row against the policy and the env files,
      the chain facts, the running signer, the agent home and the compose stack; edits nothing.
      Exit 1 on any cross.

  weavr-curator ops <status|resume|unlock|request-review|rotate-curator|set-delay>
                    [--why <text>] [--text <text>] [--clear] [--new-curator <pubkey>]
                    [--rebalance-delay-secs N] [--url <signer url>] [--home <dir>]
      the ops-token routes of the signer; the token is read from <home>/curator/ops-token
      (mode 0600) and never from the command line. Exit 1 when the signer refuses.

  weavr-curator --help
`;
