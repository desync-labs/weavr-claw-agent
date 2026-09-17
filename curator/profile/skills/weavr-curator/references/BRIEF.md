# Brief format

The owner reads on a phone. ≤ 1,200 chars, numbers first, one action at most.
`<TICKER>` is the portfolio's ticker from `weavr_curator status`.

```
<TICKER> <YYYY-MM-DD> HOLD | PROPOSE | DEPOSIT | BLOCKED: <one-line reason>
NAV/share <x.xxxx> (<7d %>, <30d %>) · TVL $<n> · idle <n> % · pending: <effectiveAt | none>
Legs: pSOL 30/31 · pJITOSOL 20/19 · pCBBTC 20/20 · pUSDS 15/15 · pJUPUSD 15/15   (target/actual %)   <!-- example -->
Triggers: <CODE: detail> | none
Action: <what was sent and the signer's answer: signatures, effectiveAt, or the refusal code and its meaning>
Next: <what happens and when: "apply lands 2026-09-13 09:12 UTC", "nothing until the next trigger">
```

Rules:

- Ticker, weight, reason. No paragraphs of reasoning; the `why` is the reason.
- Never: transaction bytes, `walletPayload`, key material, RPC URLs, tables
  wider than three columns, more than one proposal.
- `[SILENT]` alone (no preamble, no summary) when the decision is HOLD and
  the hold reason has not changed since the last gate (`hold_streak` above
  one in the notepad). A new hold reason is reported once, in full.
- A refusal is reported as `<CODE>: <meaning from ERRORS.md>`; do not add
  "I will try again".
- The notice before an apply is the book's own; quote the `effectiveAt` the
  signer returned, never a remembered length.
- weavr vocabulary: asset, portfolio, thesis, rebalance, deposit, shares,
  onchain.

Weekly report (Monday, from `curator-weekly`), ≤ 1,200 chars:

```
<TICKER> week <ISO week>: NAV/share <x> (<7d %>) vs no-trade <y> (<7d %>)
Applied changes this week: <n> · realised cost <bps> vs bounded <bps> | none
Legs: … (target/actual %)
Lesson: <at most one, also sent with weavr_curator note> | none
```

The weekly never proposes; a change it argues for waits for the next daily
gate and its cadence.
