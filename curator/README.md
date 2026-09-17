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
  is, what the notice is, who the treasury and guardian are) are checked
  every tick. Any drift locks every write until you clear it.
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
- Your own wallet, the one that created the portfolio, stays on your machine
  and signs exactly one thing for this: the handover of curation to the
  signer key. The signer key is a separate, dedicated keypair with a small
  SOL balance for fees.
- Two bearer tokens. The agent token lets the agent read, simulate, propose,
  apply, cancel, deposit, pause and journal. The ops token, which only your
  machine holds, is needed to resume, unlock, rotate and request a review.
  The agent never has it, so a compromised agent cannot un-pause itself.
- The policy document is the only place a threshold lives. The agent reads
  it live before every decision; none of the prose it reads repeats a number,
  and `npm run curator-test` fails if one is written in.

## What you need

- A weavr portfolio you created, and the wallet that created it (the
  top-level README covers creating one from a thesis).
- A model API key (the template uses the OpenAI API; any provider Hermes
  supports works, one line in `config.yaml`).
- A Telegram bot token, from BotFather, and your numeric Telegram user id.
- Docker with compose v2, and the two images: the signer image, built today
  from a checkout of the weavr backend (a published image is pending), and
  the agent image, built from the Claw Agent checkout. The header of
  `curator/compose/curator.yml` names both and how to build them.
- Node 20 or newer, for the `weavr-curator` command and the tests.

## Setup

Two commands, in this order. Both are described here in words; the command
itself drives you through them.

`weavr-curator init --portfolio <ticker or mint>`

1. Generates the curator keypair into a directory only you can read, or
   reuses the one it finds there. The key never enters this repository, an
   environment variable or a process argument; the compose file mounts the
   file read-only.
2. Reads the portfolio from chain: its shares mint, its fee recipient, the
   guardian, its legs and their weights, its rebalance delay, and who
   curates it today.
3. Hands curation over to the key: a curator transfer signed by your wallet,
   then an accept signed by the new key. The signer's invariant check
   refuses to work until this has happened.
4. Asks you to pick a policy preset (`curator/policy/README.md`: rehearsal
   first, standard once you mean it) and validates it against the book: the
   legs it holds must be inside the preset's universe and shape, and the
   preset's notice must equal the portfolio's onchain delay.
5. Writes the signer's env file (the two tokens it generates, and the RPC
   URL you give it) and the agent's `.env` (the provider key, the Telegram
   bot and your id, the signer URL and the agent token), both mode 0600.
6. Renders `curator/profile/` into the agent's home directory, plugin
   included, and writes the non-secret compose variables beside the compose
   file.

`weavr-curator doctor`

Checks everything without touching chain state: the key file and its mode,
the shape of the tokens, that both images exist locally, that the policy
file loads and still matches the onchain delay and legs, that the rendered
home directory is complete and `TELEGRAM_ALLOWED_USERS` is not empty (an
empty allow-list is fail-open, so the doctor refuses it), and once the stack
is up, that the signer answers and its invariants hold. Run it again after
any change; it is the thing you run when something feels off.

## Run it

```bash
docker compose -f curator/compose/curator.yml up -d
```

The signer boots paused. When the doctor is green:

```bash
weavr-curator ops resume
```

Then, in a Telegram DM with your bot: `/weavr-curator status` (the portfolio
the signer is pinned to, the signer wallet, the apply state, the invariants)
and `/weavr-curator policy` (the document it is enforcing, one line per
section, with its digest).

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

Fastest first.

1. **Pause** from Telegram: `/weavr-curator pause <why>`. Disarms the apply
   loop and refuses every write except cancel. The agent can do this on its
   own too. `/weavr-curator cancel <why>` cancels an announced change.
2. **Stop the signer**: `docker compose -f curator/compose/curator.yml stop signer`.
   The journal lives in a named volume and survives.
3. **Resume, unlock, request a review**, with the ops token from your
   machine: `weavr-curator ops resume`, `weavr-curator ops unlock` (only once
   the drift it locked on is gone), `weavr-curator ops request-review` (the
   next daily gate treats it as a trigger).
4. **Rotate the agent token**: a new value in both env files, then restart
   both services. The old token stops working at once; the journal shows
   the agent's refused calls until the agent restarts with the new one.
5. **Rotate the curator key**, the real revoke, in two halves:
   `weavr-curator ops rotate-curator --new-curator <pubkey> --why "<reason>"`
   makes the signer sign the curator transfer with the current key; then the
   accept is signed by the new key from your machine, never inside the
   signer. Swap the key file, restart the signer, run the doctor, fund the
   new signer wallet, drain the old one.

Change the policy by editing the file and restarting the signer; a document
with an unknown or missing key refuses to boot. Change the thesis by editing
`MANDATE.md` in the profile and re-rendering; it holds words, never numbers.

## What stays private, and what is weavr's

- The signer image is built from weavr's backend, which is not public today;
  the compose file documents the local build and the doctor checks the image
  exists. A published image will replace that step.
- The guardian, the keeper, the api and the MCP server are weavr's. Your
  host talks to the api over HTTPS and sends signed transactions through it.
- Everything else, the key, the tokens, the journal, the policy and the
  profile, stays on your host. Nothing here phones home.
