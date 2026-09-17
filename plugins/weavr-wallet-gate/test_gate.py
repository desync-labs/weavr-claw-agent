"""Planted cases for the money gate. Pure Python, no Hermes import:
``python test_gate.py`` or pytest."""
import importlib.util
import pathlib

_spec = importlib.util.spec_from_file_location("weavr_wallet_gate", pathlib.Path(__file__).with_name("__init__.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
gate = _mod.gate


def test_ignores_other_tools_and_plain_commands():
    assert gate(tool_name="mcp__weavr__list_assets", args={}) is None
    assert gate(tool_name="terminal", args={"command": "ls -la"}) is None
    assert gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --address"}) is None
    assert gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --wallet paybox --address"}) is None
    assert gate(tool_name="terminal", args={"command": "node /x/sign.mjs --wallet local --address"}) is None
    # an unrelated tool whose name merely ends in sign.mjs is not a wallet run
    assert gate(tool_name="terminal", args={"command": "node /x/design.mjs --tx AAAA"}) is None


def test_escalates_signing_runs_with_a_named_action():
    # WEAVR_SIGN_TOOL may point at any of the three tools: without a --wallet flag the
    # signer is unknown here, and the message says so rather than guessing paybox.
    r = gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --deployment 5ed63540-645e"})
    assert r["action"] == "approve"
    assert "deployment 5ed63540-645e" in r["message"] and "signer wallet" in r["message"]
    assert r["rule_key"] == "weavr-wallet:wallet"
    r = gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --wallet paybox --deployment 5ed63540-645e"})
    assert "deployment 5ed63540-645e" in r["message"] and "signer paybox" in r["message"]
    assert r["rule_key"] == "weavr-wallet:paybox"
    r = gate(tool_name="terminal", args={"command": 'cd /x && node "${WEAVR_SIGN_TOOL}" --deposit CLAWR2 --amount 0.5'})
    assert "deposit $0.5 into CLAWR2" in r["message"]
    r = gate(tool_name="terminal", args={"command": "node /x/sign-local.mjs --tx AAAA"})
    assert r["action"] == "approve" and "signer local" in r["message"]
    assert r["rule_key"] == "weavr-wallet:local"
    r = gate(tool_name="terminal", args={"command": "node /x/sign-solana.mjs --file p.json --send"})
    assert "sign a saved payload and send it" in r["message"] and "signer paybox" in r["message"]


def test_sign_mjs_and_the_wallet_flag():
    r = gate(tool_name="terminal", args={"command": "node /x/sign.mjs --wallet local --deployment dep-1"})
    assert r["action"] == "approve" and "signer local" in r["message"]
    assert r["rule_key"] == "weavr-wallet:local"
    r = gate(tool_name="terminal", args={"command": 'node "/x/sign.mjs" --deposit CLAWR2 --amount 1'})
    assert r["action"] == "approve" and "signer wallet" in r["message"]
    assert r["rule_key"] == "weavr-wallet:wallet"
    # a quoted flag value reads the same
    r = gate(tool_name="terminal", args={"command": "node /x/sign.mjs --wallet 'paybox' --tx AAAA"})
    assert "signer paybox" in r["message"] and r["rule_key"] == "weavr-wallet:paybox"
    # link mode signs nothing, but a deployment poll is escalated all the same
    r = gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --wallet link --deployment dep-1"})
    assert r["action"] == "approve" and "signer link" in r["message"]
    assert r["rule_key"] == "weavr-wallet:link"
    # the flag beats the alias's file name for the label (the tool itself refuses this conflict)
    r = gate(tool_name="terminal", args={"command": "node /x/sign-local.mjs --wallet paybox --tx AAAA"})
    assert "signer paybox" in r["message"]


if __name__ == "__main__":
    test_ignores_other_tools_and_plain_commands()
    test_escalates_signing_runs_with_a_named_action()
    test_sign_mjs_and_the_wallet_flag()
    print("wallet gate: ok")
