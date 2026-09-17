/**
 * `weavr-curator init`: the eight steps that turn a portfolio the owner
 * created into a home directory the compose stack can start from. Each step
 * prints one line and the command stops on the first cross (exit 2; exit 3
 * when the key only needs funding) unless `--wait` covers it. Everything
 * impure is a seam in `deps`: `fetchImpl` for the api, `rpc` for the chain,
 * `fs`, `now`, `sleep`, `prompt`, `keygen`, `makeSigner`, `log`.
 *
 * Nothing printed or returned carries a secret: the key file is named, the
 * public key is printed, tokens are described as generated or reused, and a
 * transaction is never printed, only its signature.
 */
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll } from '../../tools/lib/tx-checks.mjs';
import { localSigner, readKeypairFile } from '../../tools/lib/local-signer.mjs';
import { resolveAllowed, signerFor } from '../../tools/lib/cli.mjs';
import { makeReport } from './report.mjs';
import {
  DEFAULT_ROOT, ensureDir, exists, generateToken, homePaths, readEnvFile, readTokenFile, writeNewSecret, writeSecret,
} from './home.mjs';
import { factoryProgramFrom, lamportsToSol, readBalance, readFactoryConfig } from './chain.mjs';
import {
  DEFAULT_API, DEFAULT_MCP, apiClient, buildAcceptCurator, buildTransferCurator, legsOf, legsText, listPools, resolvePortfolio, sendSigned,
} from './weavr-api.mjs';
import { PRESETS, loadPreset, presetOf, validatePolicyAgainstBook } from './policy-check.mjs';
import { copyProfile, providerFor, readConfigModel, renderAgentEnv, renderComposeEnv, renderSignerEnv } from './render.mjs';

const require = createRequire(import.meta.url);
const { Keypair } = require('@solana/web3.js');

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TRANSFER_WALLETS = Object.freeze(['paybox', 'local', 'none']);
export const DEFAULT_WAIT_SECS = 1800;
export const POLL_SECS = 15;
export const EXIT_INIT = Object.freeze({ OK: 0, USAGE: 1, CROSS: 2, UNFUNDED: 3 });

/** The exit code and the JSON body of one run; the bin prints the body under --json. */
export async function init(opts, deps = {}) {
  const {
    env = process.env,
    fs = nodeFs,
    fetchImpl = fetch,
    rpc,
    now = Date.now,
    log = console.log,
    prompt = null,
    interactive = false,
    sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }),
    keygen = () => Keypair.generate(),
    makeSigner = signerFor,
    repoRoot = REPO_ROOT,
    root = DEFAULT_ROOT(),
    uid = typeof process.getuid === 'function' ? process.getuid() : 10000,
    gid = typeof process.getgid === 'function' ? process.getgid() : 10000,
  } = deps;
  if (typeof rpc !== 'function') throw new Error('init needs an rpc seam');
  // The api and MCP URLs: the flag, else what a previous run wrote into the
  // home, else the public endpoints. Read before the api is called, because
  // the remembered api is the one the portfolio is resolved against.
  const remembered = rememberedUrls(opts, { root, fs });
  const apiUrl = opts.api ?? (remembered.api || DEFAULT_API);
  const mcpUrl = opts.mcp ?? (remembered.mcp || DEFAULT_MCP);
  const apiUrlFrom = opts.api ? 'flag' : remembered.api ? 'home' : 'default';
  const mcpUrlFrom = opts.mcp ? 'flag' : remembered.mcp ? 'home' : 'default';
  const transferWallet = opts.transferWallet ?? 'none';
  // --json prints one object at the end and never prompts: a confirmation it
  // would have asked for is a cross telling the owner to pass --yes.
  const canPrompt = interactive && typeof prompt === 'function' && !opts.json;
  const noPrompt = opts.json ? '--json never prompts' : 'stdin is not interactive';
  const waitSecs = Number(opts.waitSecs ?? DEFAULT_WAIT_SECS);
  const report = makeReport({ log, json: Boolean(opts.json) });
  const facts = { home: null, portfolio: null, key: null, guardian: null, treasury: null, notice: null, signatures: [] };
  const done = (exit) => ({ exit, ...report.json({ ok: exit === 0, exit, ...facts }) });

  if (!opts.portfolio) {
    report.cross('portfolio', 'no portfolio named', { fix: 'pass --portfolio <ticker or mint>' });
    return done(EXIT_INIT.USAGE);
  }
  if (opts.policy !== undefined && !PRESETS.includes(opts.policy)) {
    report.cross('policy', `unknown preset ${JSON.stringify(opts.policy)}`, { fix: `pass --policy ${PRESETS.join(' or ')}` });
    return done(EXIT_INIT.USAGE);
  }
  if (!TRANSFER_WALLETS.includes(transferWallet)) {
    report.cross('curation', `unknown --transfer-wallet ${JSON.stringify(transferWallet)}`, { fix: `pass --transfer-wallet ${TRANSFER_WALLETS.join(', ')}` });
    return done(EXIT_INIT.USAGE);
  }

  try {
    // 1. The portfolio.
    const api = apiClient({ apiUrl, fetchImpl });
    let row = await resolvePortfolio(api, opts.portfolio);
    if (!row) {
      report.cross('portfolio', `no portfolio ${opts.portfolio} at ${apiUrl}`, { fix: 'pass the ticker or the shares mint as the weavr app shows it' });
      return done(EXIT_INIT.CROSS);
    }
    const pools = await listPools(api);
    const mint = row.mint;
    const symbol = row.symbol;
    const legs = legsOf(row, pools);
    facts.portfolio = { mint, symbol, name: row.name, creator: row.creator, curator: row.curator, pendingCurator: row.pendingCurator ?? null, feeRecipient: row.feeRecipient, rebalanceDelaySecs: row.rebalanceDelaySecs, legs: legs.map(({ poolId, symbol: s, weightBps }) => ({ poolId, symbol: s, weightBps })) };
    report.ok('portfolio', `${symbol} read from chain`, {
      details: [
        `name ${row.name}  ticker ${symbol}  mint ${mint}`,
        `creator ${row.creator}  curator ${row.curator}${row.pendingCurator ? `  pending curator ${row.pendingCurator}` : ''}`,
        `fee recipient ${row.feeRecipient}  notice ${row.rebalanceDelaySecs}s  legs ${legsText(legs)}`,
      ],
    });

    // The home.
    const home = opts.home ? resolve(String(opts.home)) : join(root, symbol);
    const paths = homePaths(home);
    facts.home = home;
    // A directory that exists, holds something and carries nothing init made
    // (curator/ from a previous run, or the key file placed there for init to
    // reuse) is somebody else's: init would chmod it to 0700 and write beside
    // whatever it holds. Refused unless --yes says to.
    const madeForInit = exists(paths.curatorDir, fs) || exists(paths.keyFile, fs);
    if (!madeForInit && exists(home, fs) && dirEntries(home, fs).length) {
      if (!opts.yes) {
        report.cross('home', `${home} exists and was not made by weavr-curator init; pass an empty or new directory`, { fix: `pass --home <an empty or new directory>, or --yes to write into ${home} anyway (it becomes mode 0700)` });
        return done(EXIT_INIT.CROSS);
      }
      report.info('home', `${home} exists and was not made by weavr-curator init; writing into it (--yes)`);
    }
    ensureDir(home, 0o700, fs);
    ensureDir(paths.solanaDir, 0o700, fs);
    ensureDir(paths.curatorDir, 0o700, fs);
    // The preset: --policy, else the one the policy file in the home was
    // written from (a rehearsal home stays on rehearsal across a re-run, even
    // when the book admits both), else standard. A file that matches no
    // shipped preset apart from the notice holds the owner's edits; step 5
    // asks before writing over it.
    const previousPolicy = readPolicyFile(paths.policyFile, { repoRoot, fs });
    const policyName = opts.policy ?? previousPolicy.preset ?? 'standard';
    const policyFrom = opts.policy ? 'flag' : previousPolicy.preset ? 'home' : 'default';
    const preset = loadPreset(policyName, { repoRoot, fs });

    // 2. The curator key and its SOL.
    let keypair;
    let generated = false;
    if (exists(paths.keyFile, fs)) {
      try {
        keypair = readKeypairFile(paths.keyFile);
      } catch (e) {
        report.cross('curator key', `${paths.keyFile}: ${String(e.message).replace('SIGN_LOCAL_KEYPAIR_FILE', 'the key file')}`, { fix: 'a 64-byte JSON array at mode 0600, or move it away and let init generate one' });
        return done(EXIT_INIT.CROSS);
      }
    } else {
      keypair = keygen();
      writeNewSecret(paths.keyFile, `${JSON.stringify([...keypair.secretKey])}\n`, fs);
      generated = true;
    }
    const key = keypair.publicKey.toBase58();
    facts.key = key;
    report.ok('curator key', `${key} (${generated ? 'generated' : 'reused'}, ${paths.keyFile})`);

    const floor = Number(preset.rate.minSignerLamports);
    let lamports = await readBalance(rpc, key);
    if (lamports < floor) {
      const fund = `fund ${key} with at least ${lamportsToSol(floor)} SOL`;
      if (!opts.wait) {
        report.cross('signer SOL', `${lamportsToSol(lamports)} SOL, under the policy floor of ${lamportsToSol(floor)} SOL`, { fix: `${fund}, then run init again (or pass --wait)` });
        return done(EXIT_INIT.UNFUNDED);
      }
      report.wait('signer SOL', `${fund} (polling every ${POLL_SECS} s for up to ${waitSecs} s)`);
      const deadline = now() + waitSecs * 1000;
      while (lamports < floor) {
        if (now() >= deadline) {
          report.cross('signer SOL', `still ${lamportsToSol(lamports)} SOL after ${waitSecs} s`, { fix: `${fund}, then run init again` });
          return done(EXIT_INIT.UNFUNDED);
        }
        await sleep(POLL_SECS * 1000);
        lamports = await readBalance(rpc, key);
      }
    }
    report.ok('signer SOL', `${lamportsToSol(lamports)} SOL (the policy floor is ${lamportsToSol(floor)} SOL)`);

    // 3. The handover.
    const allowed = resolveAllowed(env);
    const readRow = async () => (await resolvePortfolio(api, mint)) ?? row;
    const pollRow = async (until, { everySecs, maxSecs }) => {
      const deadline = now() + maxSecs * 1000;
      for (;;) {
        const fresh = await readRow();
        if (until(fresh)) return fresh;
        if (now() >= deadline) return null;
        await sleep(everySecs * 1000);
      }
    };
    // Nothing is signed until the owner has said so: `--yes`, or a y at the
    // prompt. A non-interactive run without `--yes` stops here with nothing
    // built, so an unattended init never moves curation onchain by itself.
    const confirmSigning = async (who, what) => {
      report.wait('curation', `${who} is about to sign ${what} for ${symbol}; it lands onchain${opts.yes ? ' (--yes)' : ''}`);
      if (opts.yes) return true;
      if (!canPrompt) {
        report.cross('curation', `${noPrompt}, so the signing above cannot be confirmed here; nothing built, nothing signed`, { fix: 'pass --yes to sign and send' });
        return false;
      }
      const answer = String(await prompt('sign and send? [y/N] ')).trim();
      if (!/^y(es)?$/i.test(answer)) {
        report.cross('curation', 'not confirmed; nothing built, nothing signed', { fix: 'run again and answer y, or pass --yes' });
        return false;
      }
      return true;
    };
    const accept = async () => {
      if (!(await confirmSigning(key, 'the accept of curation'))) return false;
      const txs = await buildAcceptCurator(api, mint, key);
      const encoded = txs.map((t) => t.tx);
      const check = checkAll(encoded, { wallet: key, allowed });
      if (!check.ok) {
        report.cross('curation', `accept refused before signing: ${check.error}, ${check.detail}`, { fix: 'the api built something this tool will not sign; report it', code: check.error });
        return false;
      }
      const signed = await localSigner({ keypairFile: paths.keyFile }).sign(encoded);
      const sent = await sendSigned(api, signed);
      if (sent.status !== 'confirmed' || !sent.signatures.length) {
        report.cross('curation', `accept sent but ${sent.status}`, { fix: 'run init again; the accept is rebuilt and re-sent' });
        return false;
      }
      facts.signatures.push(...sent.signatures);
      report.ok('curation', `accepted by ${key}: ${sent.signatures.join(', ')}`, { signatures: sent.signatures });
      return true;
    };
    if (row.curator === key) {
      report.ok('curation', `${key} already curates ${symbol}`);
    } else if (row.pendingCurator === key) {
      if (!(await accept())) return done(EXIT_INIT.CROSS);
      row = await readRow();
    } else if (transferWallet === 'none') {
      report.wait('curation', `the current curator ${row.curator} must hand ${symbol} to ${key}`, {
        details: [
          `from an MCP host holding that wallet: build_transfer_curator { portfolio: "${mint}", signer: "${row.curator}", newCurator: "${key}" }, then send_signed with what the wallet returned`,
          '(or the weavr web app, once it has the button)',
          opts.wait ? `polling the portfolio every ${POLL_SECS} s for up to ${waitSecs} s` : 'then run init again, or pass --wait to keep polling until it lands',
        ],
      });
      if (!opts.wait) return done(EXIT_INIT.CROSS);
      const flipped = await pollRow((r) => r.pendingCurator === key || r.curator === key, { everySecs: POLL_SECS, maxSecs: waitSecs });
      if (!flipped) {
        report.cross('curation', `no handover to ${key} within ${waitSecs} s`, { fix: 'have the current curator send the transfer, then run init again' });
        return done(EXIT_INIT.CROSS);
      }
      row = flipped;
      if (row.curator !== key && !(await accept())) return done(EXIT_INIT.CROSS);
      row = await readRow();
    } else {
      let signer;
      try {
        signer = makeSigner(transferWallet, env);
      } catch (e) {
        report.cross('curation', `${transferWallet} wallet: ${String(e.message).slice(0, 200)}`, { fix: transferWallet === 'local' ? 'set SIGN_LOCAL_KEYPAIR_FILE to the current curator\'s keypair file (mode 0600)' : 'set PAYBOX_CLI, PAYBOX_CONFIG_DIR and PAYBOX_CREDENTIAL_ID for the wallet that curates today' });
        return done(EXIT_INIT.CROSS);
      }
      if (signer.wallet !== row.curator) {
        report.cross('curation', `WRONG_PAYER: the ${transferWallet} wallet ${signer.wallet} is not the current curator ${row.curator}; nothing signed`, {
          fix: `sign with the wallet that curates ${symbol} today, or pass --transfer-wallet none and hand over from that wallet yourself`,
          code: 'WRONG_PAYER',
        });
        return done(EXIT_INIT.CROSS);
      }
      if (!(await confirmSigning(signer.wallet, `the transfer of curation to ${key}`))) return done(EXIT_INIT.CROSS);
      const txs = await buildTransferCurator(api, mint, row.curator, key);
      const encoded = txs.map((t) => t.tx);
      const check = checkAll(encoded, { wallet: signer.wallet, allowed });
      if (!check.ok) {
        report.cross('curation', `transfer refused before signing: ${check.error}, ${check.detail}`, { fix: 'the api built something this tool will not sign; report it', code: check.error });
        return done(EXIT_INIT.CROSS);
      }
      const signed = await signer.sign(encoded);
      const sent = await sendSigned(api, signed);
      if (sent.status !== 'confirmed' || !sent.signatures.length) {
        report.cross('curation', `transfer sent but ${sent.status}`, { fix: 'run init again; the transfer is rebuilt and re-sent' });
        return done(EXIT_INIT.CROSS);
      }
      facts.signatures.push(...sent.signatures);
      report.ok('curation', `transfer to ${key} signed by ${signer.wallet}: ${sent.signatures.join(', ')}`, { signatures: sent.signatures });
      const flipped = await pollRow((r) => r.pendingCurator === key || r.curator === key, { everySecs: 5, maxSecs: 120 });
      if (!flipped) {
        report.cross('curation', `the transfer confirmed but ${symbol} does not show ${key} pending yet`, { fix: 'run init again in a minute; it accepts as soon as the row shows the handover' });
        return done(EXIT_INIT.CROSS);
      }
      row = flipped;
      if (row.curator !== key && !(await accept())) return done(EXIT_INIT.CROSS);
      row = await readRow();
    }

    // 4. The chain facts.
    let factoryProgram;
    try {
      factoryProgram = factoryProgramFrom(JSON.parse(fs.readFileSync(join(repoRoot, 'manifest.json'), 'utf8')));
    } catch {
      factoryProgram = factoryProgramFrom(null);
    }
    const factory = await readFactoryConfig(rpc, factoryProgram);
    if (!factory.ok) {
      report.cross('chain facts', `FactoryConfig ${factory.address}: ${factory.reason}`, { fix: 'not guessing the guardian; check the RPC endpoint and the portfolio_factory id in manifest.json' });
      return done(EXIT_INIT.CROSS);
    }
    const guardian = factory.guardian;
    const treasury = row.feeRecipient;
    const notice = Number(row.rebalanceDelaySecs);
    Object.assign(facts, { guardian, treasury, notice });
    report.ok('chain facts', `guardian ${guardian}  treasury ${treasury}  notice ${notice}s`, { guardian, treasury, notice });
    if (opts.yes) {
      report.ok('confirm', 'chain facts accepted (--yes)');
    } else if (!canPrompt) {
      report.cross('confirm', `${noPrompt}, so the chain facts above cannot be confirmed here`, { fix: 'pass --yes to accept them' });
      return done(EXIT_INIT.CROSS);
    } else {
      const answer = String(await prompt('write these into the signer config? [y/N] ')).trim();
      if (!/^y(es)?$/i.test(answer)) {
        report.cross('confirm', 'not confirmed', { fix: 'run again and answer y, or pass --yes' });
        return done(EXIT_INIT.CROSS);
      }
      report.ok('confirm', 'chain facts confirmed');
    }

    // 5. The policy.
    const policy = JSON.parse(JSON.stringify(preset));
    const presetNotice = Number(policy.invariants.rebalanceDelaySecs);
    if (presetNotice !== notice) {
      policy.invariants.rebalanceDelaySecs = notice;
      report.info('policy notice', `the ${policyName} preset expects a ${presetNotice}s notice; ${symbol} announces ${notice}s, so invariants.rebalanceDelaySecs is written as ${notice}`, { presetNotice, notice });
    }
    const alternatives = Object.fromEntries(PRESETS.filter((n) => n !== policyName).map((n) => [n, loadPreset(n, { repoRoot, fs })]));
    const items = validatePolicyAgainstBook(policy, row, pools, { presetName: `the ${policyName} preset`, alternatives });
    if (items.length) {
      report.cross('policy', `the ${policyName} preset refuses ${symbol} as it stands (${items.length} item${items.length === 1 ? '' : 's'})`, {
        details: items.flatMap((i) => [`${i.code}: ${i.message}`, `  fix: ${i.fix}`]),
        items,
      });
      return done(EXIT_INIT.CROSS);
    }
    // What the file holds now: the same preset (nothing to say), another
    // shipped preset (a switch the owner asked for with --policy, said on its
    // own line), or a document that matches none, which is the owner's edits
    // or not JSON at all: written over only on --yes or a y at the prompt,
    // and the line says to put the edits back.
    if (previousPolicy.present && previousPolicy.preset === null) {
      const what = previousPolicy.doc === null ? 'is not valid JSON' : 'matches no shipped preset (edited by hand)';
      const was = previousPolicy.doc === null ? 'was not valid JSON' : 'matched no shipped preset (edited by hand)';
      const after = 'put your edits back and restart the signer';
      if (opts.yes) {
        report.info('policy file', `${paths.policyFile} ${was}; the ${policyName} preset is written over it (--yes); ${after}`, { previousPreset: null });
      } else if (!canPrompt) {
        report.cross('policy file', `${paths.policyFile} ${what}; ${noPrompt}, so writing the ${policyName} preset over it cannot be confirmed here; it is left as it is`, { fix: 'pass --yes to write the preset over it (put your edits back after), or change the file yourself and restart the signer' });
        return done(EXIT_INIT.CROSS);
      } else {
        const answer = String(await prompt(`write the ${policyName} preset over ${paths.policyFile}, which ${previousPolicy.doc === null ? 'is not valid JSON' : 'was edited by hand'}? [y/N] `)).trim();
        if (!/^y(es)?$/i.test(answer)) {
          report.cross('policy file', `${paths.policyFile} ${what}; not confirmed, so it is left as it is`, { fix: 'run again and answer y, or pass --yes, to write the preset over it (put your edits back after); or change the file yourself and restart the signer' });
          return done(EXIT_INIT.CROSS);
        }
        report.info('policy file', `${paths.policyFile} ${was}; the ${policyName} preset is written over it (confirmed); ${after}`, { previousPreset: null });
      }
    } else if (previousPolicy.present && previousPolicy.preset !== policyName) {
      report.info('policy file', `${paths.policyFile} held the ${previousPolicy.preset} preset; the ${policyName} preset is written over it (--policy ${policyName})`, { previousPreset: previousPolicy.preset });
    }
    fs.writeFileSync(paths.policyFile, `${JSON.stringify(policy, null, 2)}\n`);
    report.ok('policy', `the ${policyName} preset${policyFrom === 'home' ? ` (remembered from ${paths.policyFile}; pass --policy to change it)` : ''} admits ${legsText(legs)}; written to ${paths.policyFile}`, { preset: policyName, presetFrom: policyFrom });

    // 6. Tokens and env.
    const tokenOf = (file) => {
      if (exists(file, fs)) {
        const r = readTokenFile(file, fs);
        if (!r.ok) throw Object.assign(new Error(r.reason), { step: 'tokens', fix: 'a 64-hex-char token at mode 0600 with no whitespace, or move the file away and let init generate one' });
        return { token: r.token, generated: false };
      }
      const token = generateToken();
      writeNewSecret(file, token, fs);
      return { token, generated: true };
    };
    const signerTok = tokenOf(paths.signerToken);
    const opsTok = tokenOf(paths.opsToken);
    if (signerTok.token === opsTok.token) {
      report.cross('tokens', 'the agent token and the ops token are equal; the signer refuses to boot on that', { fix: `move ${paths.opsToken} away and run init again` });
      return done(EXIT_INIT.CROSS);
    }
    // The token files are what the env files are written from. A copy in an
    // env file that differs from a reused token file is a rotation done in
    // the env files (or a tampered line), and rewriting it would silently
    // undo it: refuse and name the two files. A copy left behind by a token
    // file generated on this run is stale by definition; it is replaced,
    // and the line below says so.
    const previousSignerEnv = readEnvFile(paths.signerEnv, fs).values;
    const previousAgent = readEnvFile(paths.agentEnv, fs).values;
    const disagree = [];
    const stale = [];
    const compareCopy = (label, file, value, tok, tokenFile) => {
      const copy = String(value ?? '').trim();
      if (!copy || copy === tok.token) return;
      (tok.generated ? stale : disagree).push(tok.generated ? `${label} in ${file}` : `${label} in ${file} is not the value in ${tokenFile}`);
    };
    compareCopy('CURATOR_SIGNER_TOKEN', paths.signerEnv, previousSignerEnv.CURATOR_SIGNER_TOKEN, signerTok, paths.signerToken);
    compareCopy('CURATOR_OPS_TOKEN', paths.signerEnv, previousSignerEnv.CURATOR_OPS_TOKEN, opsTok, paths.opsToken);
    compareCopy('CURATOR_SIGNER_TOKEN', paths.agentEnv, previousAgent.CURATOR_SIGNER_TOKEN, signerTok, paths.signerToken);
    if (disagree.length) {
      report.cross('tokens', `${disagree.join('; ')}; the env files are left as they are`, {
        fix: 'if the env file holds a token you rotated to, write that value into the token file (mode 0600, no newline); if the token file is right, delete the line from the env file; then run init again, which writes both env files from the token files',
      });
      return done(EXIT_INIT.CROSS);
    }
    if (stale.length) report.info('tokens', `${stale.join(' and ')} held a value from before the token file was generated; replaced`);
    // The RPC endpoint: --rpc, else SOLANA_RPC_URL from the owner's shell (a
    // private endpoint carries a key, and an argument is visible to every
    // process on the host), else the value a previous run wrote. Never printed.
    const shellRpc = String(env.SOLANA_RPC_URL ?? '').trim();
    const previousRpc = String(previousSignerEnv.SOLANA_RPC_URL ?? '').trim();
    const rpcUrl = (opts.rpc && String(opts.rpc).trim()) || shellRpc || previousRpc || '';
    const rpcUrlFrom = opts.rpc ? 'flag' : shellRpc ? 'shell' : previousRpc ? 'home' : 'none';
    writeSecret(paths.signerEnv, renderSignerEnv({ signerToken: signerTok.token, opsToken: opsTok.token, rpcUrl }), fs);
    const yml = fs.readFileSync(join(repoRoot, 'curator', 'compose', 'curator.yml'), 'utf8');
    const previousCompose = readEnvFile(paths.composeEnv, fs).values;
    const composeValues = {
      CURATOR_PORTFOLIO_MINT: mint,
      CURATOR_TREASURY: treasury,
      CURATOR_EXPECTED_GUARDIAN: guardian,
      CURATOR_API_URL: apiUrl,
      CURATOR_KEY_FILE: paths.keyFile,
      CURATOR_POLICY_FILE: paths.policyFile,
      CURATOR_SIGNER_ENV: paths.signerEnv,
      HERMES_HOME: paths.hermesHome,
      HERMES_UID: String(uid),
      HERMES_GID: String(gid),
    };
    for (const k of ['CURATOR_SIGNER_IMAGE', 'HERMES_IMAGE', 'CURATOR_START_PAUSED', 'CURATOR_TICK_MS']) {
      if (previousCompose[k] && String(previousCompose[k]).trim() !== '') composeValues[k] = previousCompose[k];
    }
    fs.writeFileSync(paths.composeEnv, renderComposeEnv(yml, composeValues));
    const rpcNote = { flag: 'SOLANA_RPC_URL from --rpc', shell: 'SOLANA_RPC_URL from your shell environment', home: 'SOLANA_RPC_URL kept from the previous run', none: 'SOLANA_RPC_URL left for you to set' }[rpcUrlFrom];
    const keptUrls = [apiUrlFrom === 'home' ? 'the api URL from compose.env' : null, mcpUrlFrom === 'home' ? 'the MCP URL from hermes-home/.env' : null].filter(Boolean);
    report.ok('tokens and env', `agent token ${signerTok.generated ? 'generated' : 'reused'}, ops token ${opsTok.generated ? 'generated' : 'reused'}; ${paths.signerEnv} (0600), ${rpcNote}; ${paths.composeEnv}${keptUrls.length ? `; kept ${keptUrls.join(' and ')}` : ''}`, { rpcUrlSet: Boolean(rpcUrl), rpcUrlFrom, apiUrlFrom, mcpUrlFrom });

    // 7. The agent home.
    const copied = copyProfile({
      profileDir: join(repoRoot, 'curator', 'profile'),
      pluginDir: join(repoRoot, 'plugins', 'weavr-curator'),
      hermesHome: paths.hermesHome,
      pluginTarget: paths.pluginDir,
    }, fs);
    if (copied.kept.length || copied.merged.length || copied.replaced.length) {
      report.info('agent home', `re-rendered: kept ${copied.kept.length ? copied.kept.join(', ') : 'nothing'} (the agent's own notes); merged ${copied.merged.length ? copied.merged.join(', ') : 'nothing'} (job state kept, definitions from the profile); replaced ${copied.replaced.length ? copied.replaced.join(', ') : 'nothing'} from the profile`, { kept: copied.kept, merged: copied.merged, replaced: copied.replaced });
    }
    const model = readConfigModel(fs.readFileSync(paths.configYaml, 'utf8'));
    const provider = providerFor(model.provider);
    const rendered = renderAgentEnv({
      provider: model.provider,
      providerVariable: provider?.variable ?? null,
      signerToken: signerTok.token,
      mcpUrl,
      apiUrl,
      symbol,
      rebalanceDelaySecs: notice,
      existing: previousAgent,
    });
    writeSecret(paths.agentEnv, rendered.text, fs);
    const toFill = rendered.ownerKeys.filter((k) => !(previousAgent[k] && String(previousAgent[k]).trim() !== ''));
    facts.toFill = toFill;
    report.ok('agent home', `profile and plugin rendered into ${paths.hermesHome}; .env (0600) still needs ${toFill.length ? toFill.join(', ') : 'nothing'}`, { toFill });

    // 8. Next.
    report.heading('next:');
    let n = 1;
    if (toFill.length) report.note(`${n++}. fill ${toFill.join(', ')} in ${paths.agentEnv}`);
    if (!rpcUrl) report.note(`${n++}. set SOLANA_RPC_URL in ${paths.signerEnv} to a private endpoint (the public one rate-limits the signer's tick)`);
    report.note(`${n++}. docker compose --env-file ${paths.composeEnv} -f ${join(repoRoot, 'curator', 'compose', 'curator.yml')} up -d`);
    report.note(`${n++}. weavr-curator doctor --home ${home}`);
    report.note(`${n++}. weavr-curator ops resume --home ${home}   (the signer boots paused)`);
    return done(EXIT_INIT.OK);
  } catch (e) {
    report.cross(e.step ?? 'init', String(e.message ?? e).slice(0, 300), { fix: e.fix ?? 'fix the cause above and run init again; it reuses what it already wrote' });
    return done(EXIT_INIT.CROSS);
  }
}

/**
 * The policy file a previous run left in the home: `present`, its parsed
 * `doc` (null when it is not JSON) and the shipped `preset` it was written
 * from (null when it matches none apart from the notice).
 */
function readPolicyFile(file, { repoRoot, fs }) {
  if (!exists(file, fs)) return { present: false, doc: null, preset: null };
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { present: true, doc: null, preset: null };
  }
  return { present: true, doc, preset: presetOf(doc, { repoRoot, fs }) };
}

/** The entries of a directory, or none when it cannot be read. */
function dirEntries(dir, fs) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The api and MCP URLs a previous run wrote: CURATOR_API_URL in compose.env
 * (else WEAVR_API_URL in hermes-home/.env) and WEAVR_MCP_URL in
 * hermes-home/.env. Read from --home; without it the home is named after
 * the ticker the api answers, so the previous run is the directory under
 * the root named like the ticker given (case-insensitively) or whose
 * compose.env names the mint given. Empty strings when there is none.
 */
export function rememberedUrls(opts, { root, fs = nodeFs } = {}) {
  const none = { home: null, api: '', mcp: '' };
  let home = opts.home ? resolve(String(opts.home)) : null;
  if (!home) {
    const given = String(opts.portfolio ?? '');
    if (!given || !root) return none;
    let names = [];
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return none;
    }
    const name = names.find((n) => n.toLowerCase() === given.toLowerCase())
      ?? names.find((n) => readEnvFile(homePaths(join(root, n)).composeEnv, fs).values.CURATOR_PORTFOLIO_MINT === given);
    if (!name) return none;
    home = join(root, name);
  }
  const compose = readEnvFile(homePaths(home).composeEnv, fs).values;
  const agent = readEnvFile(homePaths(home).agentEnv, fs).values;
  return {
    home,
    api: String(compose.CURATOR_API_URL ?? '').trim() || String(agent.WEAVR_API_URL ?? '').trim(),
    mcp: String(agent.WEAVR_MCP_URL ?? '').trim(),
  };
}
