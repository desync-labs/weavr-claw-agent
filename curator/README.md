# Running the weavr curator yourself

An autonomous curator for one weavr portfolio, on your own host. This page is
for the person who created a portfolio and wants an agent to keep its mix
honest without holding a key or being trusted with one. It states no policy
number on purpose: every threshold lives in the signer's policy document,
and `curator/policy/README.md` explains how to read and change it.

## What it is

Three parts, two of them yours.

- **The agent** decides. A Hermes gateway (the Claw Agent fork) runs the
  curator profile in `curator/profile/`: a daily review gate, a universe
  watch, a weekly report, and a Telegram DM with you. It reads weavr through
  the MCP read tools and talks to the signer through one tool,
  `weavr_curator`. It has no shell, no browser and no scheduler of its own,
  and it never sees a key, a transaction or an RPC URL.
- **The signer** holds the curator key and refuses under a policy. Every
  write the agent asks for goes policy check, build at the weavr api, IDL
  decode of every instruction, sign, send, journal. A refusal names its code
  and the limit that bound; the signer never clamps. It also runs the apply
  loop: an announced rebalance is applied by the signer itself once the
  portfolio's notice has elapsed, and the onchain invariants (who the curator
  is, whether a handover is pending, the notice, the treasury and guardian)
  are checked every tick. Any drift locks every write until you clear it.
- **The keeper** is weavr's. It allocates deposits to the targets, trims,
  unwinds removed legs, fulfils withdrawals and cranks NAV. The curator's
  only lever is the target set.

## The trust boundaries, in plain words

- The curator role cannot withdraw user funds. It can change the target set
  inside the factory's own limits, and it can start a curator handover.
- A stolen curator key can therefore churn the book inside those limits and
  start a handover. That is why three things exist: the notice (every change
  is announced onchain and lands only after the portfolio's own delay), the
  guardian cancel (weavr's guardian can cancel an announced change), and
  rotate-curator (the real revoke, described under operations).
- The guardian and the keeper are weavr's. You do not run them and the signer
  only checks that they are who the chain says.
- Your own wallet, the one that curates the portfolio today, stays on your
  machine and signs exactly one thing for this: the handover of curation to
  the signer key. The signer key is a separate, dedicated keypair with a
  small SOL balance for fees.
- Two bearer tokens. The agent token lets the agent read, simulate, propose,
  apply, cancel, deposit, pause and journal. The ops token, which only your
  machine holds, is needed to resume, unlock, rotate, set the delay and
  request a review. The agent never has it, so a compromised agent cannot
  un-pause itself.
- The policy document is the only place a threshold lives. The agent reads
  it live before every decision; none of the prose it reads repeats a number,
  and `npm run curator-test` fails if one is written in.

## What you need

- A weavr portfolio you created, and the wallet that curates it today (the
  top-level README covers creating one from a thesis).
- A model API key (the template uses the OpenAI API; any provider Hermes
  supports works, one line in `config.yaml`).
- A Telegram bot token from BotFather, your numeric Telegram user id, and
  the chat id the briefs should land in.
- Docker with compose v2, and the two images: the signer image weavr
  publishes (`CURATOR_SIGNER_IMAGE` in compose.env; you do not clone the
  backend), and the agent image, built from the Claw Agent checkout. The
  header of `curator/compose/curator.yml` names both. The signer talks to
  the demo environment (`https://api.weavr.sh`, `WEAVR_PROGRAM_IDS=demo`).
- Node 20 or newer, for the `weavr-curator` command and the tests.
- A little SOL for the curator key, and a private Solana RPC endpoint.

## Setup

Two commands, in this order; each prints one line per step, a check mark or
a cross with the fix under it, and stops on the first cross.

`weavr-curator init --portfolio <ticker or mint>`

Everything it writes goes under one home directory, mode 0700, new or empty
or one init made: `~/.config/weavr-curator/<TICKER>/`, or `--home <dir>`.

1. Reads the portfolio from weavr's api: shares mint, curator and any
   pending handover, fee recipient, notice (the onchain delay) and legs.
2. Generates the curator keypair into `<home>/solana/curator.json` (0600),
   or reuses the one there; only the public key is printed, and the compose
   file mounts the file read-only. Then it reads the key's SOL against the
   floor in the preset's `rate` section: under it, init stops with exit 3
   and the amount to send, or with `--wait` polls until the SOL lands (for
   as long as `--wait-secs` allows).
3. Hands curation to the key: a transfer signed by the wallet that curates
   today, then an accept signed by the new key. With `--transfer-wallet
   none`, the default, init prints the transfer for that wallet to make from
   wherever it lives (`build_transfer_curator`, then `send_signed`, on an
   MCP host) and stops with exit 2, or with `--wait` polls until the
   handover shows, then accepts. With `--transfer-wallet paybox` or `local`,
   init signs the transfer with that wallet, which must be the current
   curator (`WRONG_PAYER` otherwise, nothing signed), then accepts once the
   row shows the key pending. Every signature is announced first, naming
   who signs what, and lands only after you answer y at the prompt or pass
   `--yes`; with no terminal and no `--yes` init stops there, nothing
   signed. A key that already curates skips this step.
4. Derives the chain facts the signer's invariants will hold, the guardian
   from the factory's config account, the treasury (the fee recipient) and
   the notice, and asks before writing them (`--yes` accepts).
5. Settles the policy: the preset named by `--policy`, else `standard` on a
   first run, else the `<home>/curator/policy.json` already there, edits and
   all; its notice is rewritten to the portfolio's own, and said. It is then
   validated against the book (every held leg allowlisted and in a category,
   on an allowed chain, with the required status, inside the risk, cost and
   weight bands, the sleeves inside theirs; a number a rule needs and cannot
   find is a cross too) and written to `<home>/curator/policy.json`, a kept
   file only for its notice. A refusal names the code, leg and fix.
6. Generates the two bearer tokens into `<home>/curator/signer-token` and
   `<home>/curator/ops-token` (0600), or reuses the ones there, and writes
   `<home>/curator/signer.env` from them, with `SOLANA_RPC_URL` from
   `--rpc`, else from your shell (the better place: an argument is visible
   to every process), else kept from before, else left commented for you to
   set. `<home>/compose.env` gets the non-secret compose variables; an image
   override or `CURATOR_START_PAUSED` you set there before is kept, and so
   are `--api` and `--mcp` once given.
7. Renders `curator/profile/` and the plugin into `<home>/hermes-home/` and
   writes its `.env` (0600): the signer URL and token, the MCP and api URLs,
   the ticker and the notice, with the provider key line,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` and `TELEGRAM_HOME_CHANNEL`
   left empty for you; init lists which still are, then prints the compose
   command, the doctor and the resume.

Run it again after a cross or whenever something changed. A re-run reuses
the key and both tokens, keeps every value you typed into `.env`, the RPC
URL, your `policy.json`, the agent's memories and its cron job state, and
rewrites the rest from the profile and from chain; it asks the same
confirmation before writing the chain facts and signs nothing when the key
already curates. `--json` prints one document and never prompts: pass `--yes`.

`weavr-curator doctor`

Reads everything and edits nothing, on the host and on chain. The files: the
home, the key file and the token files, each present and 0600, and the token
copies in `curator/signer.env` and `hermes-home/.env` against them, naming any
copy that is empty or differs; `compose.env` complete and pointing into the
home. The chain: the key's SOL against the policy floor; that the key curates
the portfolio with no handover pending (a handover away from the key is a
cross with the cancel recipe under it; one towards it says to run init, which
accepts); the onchain notice against `invariants.rebalanceDelaySecs`; the
policy against the book; the treasury and the guardian against what init
wrote. The signer, once up: answering and ticking, taking the agent token (a
`401` is a token mismatch, named), neither paused nor self-locked (a lock
shows its drift), invariants holding, the file's policy document loaded (by
digest), the key in hand. The agent home: the provider's credential set and
answering, the profile's cron jobs present and on the same model, the plugin
enabled and present, `.env` carrying the ticker and notice as onchain, the
Telegram lines filled, `TELEGRAM_ALLOWED_USERS` numeric and not empty (an
empty allow-list is fail-open, so the doctor refuses it), the bot token
answering, the health job ticking. Docker, both images, both containers
running. A check that cannot run here is a note, not a cross. Exit 1 on any
cross; `--json` for the whole list. Without `--home`, `doctor` and `ops` use
the only home under `~/.config/weavr-curator/`; with several, pass `--home`.

## Run it

```bash
docker compose --env-file ~/.config/weavr-curator/<TICKER>/compose.env -f curator/compose/curator.yml up -d
```

init prints this line with your home filled in. Keep the `--env-file`:
`docker compose -f curator/compose/curator.yml up -d` on its own reads no
`compose.env` and stops on a variable it cannot fill. The signer boots
paused. When the doctor is green:

```bash
weavr-curator ops resume
```

Then, in a Telegram DM with your bot: `/weavr-curator status`,
`/weavr-curator policy` (the document it is enforcing, with its digest),
`review`, `journal`, `pause`, `cancel`, `apply` and `note`. `/weavr-curator
resume` answers that the agent holds no ops token and points you here.

## The daily life

- **09:00 UTC, the gate.** The signer computes the brief and the triggers.
  On a quiet day nothing wakes the model and nothing is sent. On a trigger
  (a held pool went inactive, a publisher park, a drawdown past the policy's
  floor, a raised risk tier, the monthly thesis review, a request from you)
  the agent reads the live policy, reviews, simulates, and then proposes,
  deposits or holds, and posts a brief.
- **`[SILENT]` days.** A HOLD with the same reason as yesterday is not
  repeated; you hear about a hold once, when its reason changes.
- **A proposal** is announced onchain with its `why`, posted to you, and
  applied by the signer after the portfolio's notice. You can cancel it in
  the meantime from your phone.
- **Every six hours** the universe watch diffs the catalogue (status, tier,
  weight cap, chain) and wakes the agent only on a change.
- **Monday** the weekly report compares NAV per share with the no-trade
  counterfactual for every change applied that week, with at most one
  lesson, journaled. The weekly never proposes.
- **Every quarter hour** the health job relays the signer's alerts (a low
  SOL balance, a self-lock, a blocked apply) without a model call, and
  silence means nothing is wrong.

The brief format is `curator/profile/skills/weavr-curator/references/BRIEF.md`:
short, numbers first, never a transaction.

## Operations

Fastest first. `<home>` is the directory init wrote.

1. **Pause** from Telegram: `/weavr-curator pause <why>`. Disarms the apply
   loop and refuses every write except cancel. The agent can do this on its
   own too. `/weavr-curator cancel <why>` cancels an announced change.
2. **Stop the signer**:
   `docker compose --env-file <home>/compose.env -f curator/compose/curator.yml stop signer`.
   The journal lives in a named volume and survives.
3. **The ops verbs**, with the ops token from your machine, read from
   `<home>/curator/ops-token` and never from the command line (`--token` is
   refused); exit 1 with the signer's code when it refuses.
   `weavr-curator ops status`; `weavr-curator ops resume`;
   `weavr-curator ops unlock --why "<reason>"`, only once the drift it
   locked on is gone (while locked every write is refused, set-delay
   included); `weavr-curator ops request-review --text "<what to look at>"
   --why "<reason>"`, a trigger for the next daily gate (`--clear` withdraws
   it); `weavr-curator ops set-delay --rebalance-delay-secs N --why
   "<reason>"` changes the notice onchain, and the signer locks on its next
   tick: run init again (it rewrites the notice in `policy.json` and `.env`),
   restart both services, then `ops unlock`; a restart keeps the lock.
4. **Rotate the agent token.** The token files under `<home>/curator/` are
   the source of truth; the doctor crosses until every copy agrees. Write
   the new value into `<home>/curator/signer-token` (0600, no trailing
   newline), run init again, which rewrites the copy in both env files from
   the file and says so, then restart both services. A missing token file
   with a value still in an env file is a cross, never a token adopted from
   the copy; delete the `CURATOR_SIGNER_TOKEN=` lines from both env files to
   have init generate a fresh one. The ops token rotates the same way.
5. **Rotate the curator key**, the real revoke, in two halves:
   `weavr-curator ops rotate-curator --new-curator <pubkey> --why "<reason>"`
   makes the signer sign the curator transfer with the current key; then the
   accept is signed by the new key from your machine, never inside the
   signer: fund the new key, move the old `<home>/solana/curator.json` away,
   put the new key file in its place (0600) and run init again, which sees
   the handover pending towards the key and accepts with it. Restart the
   signer, run the doctor, `ops unlock` once the drift is gone, drain the
   old wallet. A pending handover you did not start means the key has
   leaked: the doctor prints the cancel to sign with it; then rotate.

Change the policy by editing `<home>/curator/policy.json` and restarting
the signer (the compose line above, with `restart signer`); a document with
an unknown or missing key refuses to boot, and the doctor compares the
running digest with the file. A re-run of init keeps your edited file and
touches only its notice; `--policy` on it is a cross unless you pass `--yes`,
which writes the preset over it. Change the thesis by editing `MANDATE.md`
in the profile and running init again, which re-renders it; words, no numbers.

## What stays private, and what is weavr's

- The signer is a Docker image weavr publishes. You pull it and set
  `CURATOR_SIGNER_IMAGE`. You do not need the backend repository. The stack
  talks to demo (`https://api.weavr.sh`, `WEAVR_PROGRAM_IDS=demo`).
- The guardian, the keeper, the api and the MCP server are weavr's. Your
  host talks to the api over HTTPS and sends signed transactions through it.
- Everything else, the key, the tokens, the journal, the policy and the
  profile, stays on your host. Nothing here phones home.
