"""weavr-wallet-gate — a Hermes plugin hook that is the money gate.

The MCP trust tier gates direct MCP calls only. The weavr wallet tool signs and
sends through the *terminal* tool, which the tier never sees, and a shell hook
cannot help: Hermes normalises shell-hook output to ``block`` / ``modify``. A
Python plugin ``pre_tool_call`` hook may return ``{"action": "approve"}``, which
escalates the call to the same human approval surface Tier-2 dangerous
commands use (terminal prompt, Telegram buttons; non-interactive runs fail
closed). This one does exactly that for signing runs, with a message that says
what is about to happen.

Install: copy or symlink this directory to ``$HERMES_HOME/plugins/weavr-wallet-gate``.
No configuration; ``hermes plugins list`` shows it. Test: ``python test_gate.py``.
"""
from __future__ import annotations

import re

# `node $WEAVR_SIGN_TOOL …`, `node "${WEAVR_SIGN_TOOL}" …` or the file path, quoted or not.
PATTERN = re.compile(r"(?:sign-(solana|local)\.mjs|\$\{?WEAVR_SIGN_TOOL\}?)[\"']?\s+(.*)$")
SIGNING_FLAGS = re.compile(r"--(deployment|deposit|file|tx)\b")


def describe(tail: str) -> str:
    """A human sentence for the wallet action in ``tail`` (the tool's arguments)."""
    dep = re.search(r"--deployment\s+(\S+)", tail)
    if dep:
        return f"sign the create for deployment {dep.group(1)} and wait until it is live"
    depo = re.search(r"--deposit\s+(\S+)\s+--amount\s+(\S+)", tail)
    if depo:
        return f"deposit ${depo.group(2)} into {depo.group(1)}"
    if "--file" in tail:
        suffix = " and send it" if "--send" in tail else " and wait for the portfolio" if "--await" in tail else ""
        return "sign a saved payload" + suffix
    if "--tx" in tail:
        return "sign a transaction handed in on the command line"
    return "sign with the agent wallet"


def gate(tool_name: str | None = None, args: dict | None = None, **kwargs):
    """pre_tool_call: escalate wallet signing runs; ignore everything else."""
    if tool_name != "terminal":
        return None
    command = str((args or {}).get("command") or "")
    match = PATTERN.search(command)
    if not match:
        return None
    tail = match.group(2)
    if not SIGNING_FLAGS.search(tail):
        return None  # --address and other read-only uses
    signer = "local" if match.group(1) == "local" else "paybox"
    return {
        "action": "approve",
        "message": f"Wallet action: {describe(tail)} (signer {signer}). Approve to let the agent wallet sign.",
        "rule_key": f"weavr-wallet:{signer}",
    }


def register(ctx):
    ctx.register_hook("pre_tool_call", gate)
