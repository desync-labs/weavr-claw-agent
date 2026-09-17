# Fork patches

Pinned fork: `Clawpump/claw-agent` **7b81ee9** (28 Aug 2026, "fix(package): exclude
desktop release artifacts"), upstream `hermes-agent 0.20.6`. Re-verify every
item here after each upstream sync; the fix is one line by function name so it
survives a rebase.

## 1. Trust gate reads the wrong field (required)

`tools/mcp_tool.py::_annotation_read_only_hint` reads `annotations.readOnlyHint`
with `getattr`; mcp ≥ 2.0 (the fork installs 2.0.0) renamed the SDK field to
`read_only_hint`, so the tier records every tool on an `untrusted` server as
write-capable and the reads ask for consent too. Replace the `getattr` line with
`mcp_field(annotations, "read_only_hint", "readOnlyHint")` — the helper the same
file already uses for every other renamed field. Diff: `trust-gate-read-only-hint.patch`.
Test: `test_trust_gate.py` (run inside the fork venv). Verified 6 Sep 2026: the
SDK object gives `True` after the fix and `None` before; `hermes mcp test weavr`
still discovers 30 tools; in a live gateway session the reads ran freely and
`create_portfolio` asked.

Upstream: `hermes-agent` PR pending; the fork inherits it whenever it syncs.

## 3. The TUI never shows the trust-gate prompt (required for `claw` / `hermes` in a terminal)

In the TUI, `create_portfolio` on the `untrusted` weavr server was denied in
0.0 s with no panel: `tools/approval.py::request_elicitation_consent` calls
`prompt_dangerous_approval` without a callback, and that function passes the
`None` on instead of resolving the per-thread CLI/TUI callback the way
`_human_approval_gate` does, so the prompt_toolkit fail-closed guard fires
("approval requested on a thread with no approval callback while
prompt_toolkit is active"). Add one line to `prompt_dangerous_approval`:
`approval_callback = _resolve_cli_approval_callback(approval_callback)`.
Diff: `tui-elicitation-approval-callback.patch`. Test:
`test_tui_elicitation_callback.py` (run inside the fork venv). Telegram
sessions never hit this path, which is why the 6 Sep rehearsal did not see it.
The plugin money gate (`request_tool_approval`) already resolves the callback
and renders in the TUI. Seen 17 Sep 2026.

## 2. The money gate is a plugin hook, not the trust tier (no fork change)

`trust: untrusted` gates direct MCP calls. The wallet tool signs and sends
through the **terminal** tool, which the tier never sees, so a deposit through
the wrapper had no approval at all (observed 6 Sep 10:02Z). The gate that
covers money is the plugin in `../plugins/weavr-wallet-gate`: its
`pre_tool_call` hook matches `sign-solana.mjs` / `sign-local.mjs` /
`$WEAVR_SIGN_TOOL` signing runs (quoted or not) and returns
`{"action": "approve", "message": ..., "rule_key": ...}`, which
`tools/approval.py::request_tool_approval` escalates to the same human
approval surface Tier-2 dangerous commands use (terminal prompt, Telegram
buttons, `[o]nce/[s]ession/[a]lways/[d]eny`), with a message that names the
action ("deposit $5 into CLAWR2 (signer paybox)"). Non-interactive runs fail
closed. Verified 6 Sep 10:27Z: `hermes chat -q "Deposit 5 dollars…"` stopped at
"BLOCKED: Tool 'terminal' requires approval (Wallet action: deposit $5 into
CLAWR2 …)" and signed nothing.

A **shell** hook cannot do this — tried first (10:19Z) and the deposit went
through: `agent/shell_hooks.py` keeps only `block` / `modify` from shell-hook
output. User plugins are "not enabled" until `hermes plugins enable
weavr-wallet-gate` (the enable prints a harmless tools-override capability
note; the plugin defines no tools). Test: `python plugins/weavr-wallet-gate/test_gate.py`,
also run by `tests/unit/integrations`.

Keep `trust: untrusted` as well: it still covers a model that calls
`create_portfolio`, `send_signed` or a `build_*` tool directly, and the generic
consent text there is the reason the hook message must say what is happening.
