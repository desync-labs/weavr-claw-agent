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


def test_escalates_signing_runs_with_a_named_action():
    r = gate(tool_name="terminal", args={"command": "node $WEAVR_SIGN_TOOL --deployment 5ed63540-645e"})
    assert r["action"] == "approve"
    assert "deployment 5ed63540-645e" in r["message"] and "signer paybox" in r["message"]
    assert r["rule_key"] == "weavr-wallet:paybox"
    r = gate(tool_name="terminal", args={"command": 'cd /x && node "${WEAVR_SIGN_TOOL}" --deposit CLAWR2 --amount 0.5'})
    assert "deposit $0.5 into CLAWR2" in r["message"]
    r = gate(tool_name="terminal", args={"command": "node /x/sign-local.mjs --tx AAAA"})
    assert r["action"] == "approve" and "signer local" in r["message"]
    r = gate(tool_name="terminal", args={"command": "node /x/sign-solana.mjs --file p.json --send"})
    assert "sign a saved payload and send it" in r["message"]


if __name__ == "__main__":
    test_ignores_other_tools_and_plain_commands()
    test_escalates_signing_runs_with_a_named_action()
    print("wallet gate: ok")
