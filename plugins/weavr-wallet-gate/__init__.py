"""weavr-wallet-gate: a Hermes plugin hook that is the money gate.

The MCP trust tier gates direct MCP calls only. The weavr wallet tool signs and
sends through the *terminal* tool, which the tier never sees, and a shell hook
cannot help: Hermes normalises shell-hook output to ``block`` / ``modify``. A
Python plugin ``pre_tool_call`` hook may return ``{"action": "approve"}``, which
escalates the call to the same human approval surface Tier-2 dangerous
commands use (terminal prompt, Telegram buttons; non-interactive runs fail
closed). This one does exactly that for signing runs, with a message that says
what is about to happen and which wallet signs.

The wallet tool is ``sign.mjs`` (``--wallet paybox|local|link``), or one of its
aliases ``sign-solana.mjs`` (paybox) and ``sign-local.mjs`` (local), usually
run as ``node $WEAVR_SIGN_TOOL ...``. The signer named in the message comes
from, in order, a ``--wallet <mode>`` on the command line, else the alias's
file name, else ``wallet`` (the mode is not visible here). A signing flag
escalates whatever the mode: in link mode nothing is signed, but escalating a
deployment poll is harmless and simpler than parsing the mode reliably. The
wallet's lifecycle (``--wallet status|create|import``), ``--address`` and
``--balance`` move no money and are not escalated.

Install: copy or symlink this directory to ``$HERMES_HOME/plugins/weavr-wallet-gate``.
No configuration; ``hermes plugins list`` shows it. Test: ``python test_gate.py``.
"""
from __future__ import annotations

import re

# `node $WEAVR_SIGN_TOOL …`, `node "${WEAVR_SIGN_TOOL}" …` or the file path, quoted or not.
# The file name needs a boundary before it so an unrelated `design.mjs` is not a wallet run.
PATTERN = re.compile(r"(?:(?<![\w-])(sign|sign-solana|sign-local)\.mjs|\$\{?WEAVR_SIGN_TOOL\}?)[\"']?\s+(.*)$")
SIGNING_FLAGS = re.compile(r"--(deployment|deposit|withdraw|refresh-nav|file|tx)\b")
# Only a mode names the signer; a lifecycle verb after --wallet says nothing about who signs.
WALLET_FLAG = re.compile(r"--wallet\s+[\"']?(paybox|local|link)\b")
FILE_SIGNER = {"sign-solana": "paybox", "sign-local": "local"}


def describe(tail: str) -> str:
    """A human sentence for the wallet action in ``tail`` (the tool's arguments)."""
    dep = re.search(r"--deployment\s+(\S+)", tail)
    if dep:
        return f"sign the create for deployment {dep.group(1)} and wait until it is live"
    depo = re.search(r"--deposit\s+(\S+)\s+--amount\s+(\S+)", tail)
    if depo:
        return f"deposit ${depo.group(2)} into {depo.group(1)}"
    wd = re.search(r"--withdraw\s+(\S+)", tail)
    if wd:
        usd = re.search(r"--amount\s+(\S+)", tail)
        if usd:
            return f"withdraw ${usd.group(1)} from {wd.group(1)}"
        shares = re.search(r"--shares\s+(\S+)", tail)
        amount = shares.group(1) if shares else "some"
        if str(amount).lower() == "all":
            return f"withdraw everything from {wd.group(1)}"
        return f"withdraw {amount} shares from {wd.group(1)}"
    nav = re.search(r"--refresh-nav\s+(\S+)", tail)
    if nav:
        return f"refresh the valuation of {nav.group(1)} (the wallet pays the network fee)"
    if "--file" in tail:
        suffix = " and send it" if "--send" in tail else " and wait for the portfolio" if "--await" in tail else ""
        return "sign a saved payload" + suffix
    if "--tx" in tail:
        return "sign a transaction handed in on the command line"
    return "sign with the agent wallet"


def signer_label(file_stem: str | None, tail: str) -> str:
    """Which wallet signs: the ``--wallet <mode>`` flag, else the alias's file name, else ``wallet``."""
    flag = WALLET_FLAG.search(tail)
    if flag:
        return flag.group(1)
    return FILE_SIGNER.get(file_stem or "", "wallet")


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
        return None  # --address, --balance, the wallet's lifecycle and other read-only uses
    signer = signer_label(match.group(1), tail)
    return {
        "action": "approve",
        "message": f"Wallet action: {describe(tail)} (signer {signer}). Approve to let the agent wallet sign.",
        "rule_key": f"weavr-wallet:{signer}",
    }


def register(ctx):
    ctx.register_hook("pre_tool_call", gate)
