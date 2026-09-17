"""Proves the TUI elicitation fix: the MCP trust gate's consent prompt uses the
per-thread CLI/TUI approval callback, so under prompt_toolkit it renders the
panel instead of denying fail-closed. Run from the fork checkout with its venv:
`python test_tui_elicitation_callback.py`."""
import os
import sys

os.environ.setdefault("HERMES_INTERACTIVE", "1")

import tools.approval as approval
from tools.terminal_tool import set_approval_callback


class _FakeApp:
    """Stands in for a running prompt_toolkit Application."""


def _with_fake_tui(fn):
    """Run `fn` while prompt_toolkit reports an active application."""
    import prompt_toolkit.application.current as cur

    real = cur.get_app_or_none
    cur.get_app_or_none = lambda: _FakeApp()
    try:
        return fn()
    finally:
        cur.get_app_or_none = real


def test_trust_gate_consent_uses_thread_callback_under_tui():
    seen = []

    def cb(command, description, **kw):
        seen.append((command, kw))
        return "once"

    set_approval_callback(cb)
    try:
        answer = _with_fake_tui(lambda: approval.request_elicitation_consent(
            "MCP tool 'create_portfolio' on UNTRUSTED server 'weavr' wants to run.",
            "Approve to run 'create_portfolio' once, or deny to block it.",
            timeout_seconds=5,
        ))
    finally:
        set_approval_callback(None)
    assert answer == "accept", answer
    assert seen and "create_portfolio" in seen[0][0]
    assert seen[0][1].get("allow_permanent") is False  # elicitation never offers [a]lways


def test_no_callback_under_tui_still_fails_closed():
    set_approval_callback(None)
    answer = _with_fake_tui(lambda: approval.request_elicitation_consent(
        "MCP tool 'x' on UNTRUSTED server 'y' wants to run.", "desc", timeout_seconds=1,
    ))
    assert answer == "decline", answer


def test_deny_from_callback_is_decline():
    set_approval_callback(lambda *a, **k: "deny")
    try:
        answer = _with_fake_tui(lambda: approval.request_elicitation_consent("m", "d", timeout_seconds=1))
    finally:
        set_approval_callback(None)
    assert answer == "decline", answer


if __name__ == "__main__":
    test_trust_gate_consent_uses_thread_callback_under_tui()
    test_no_callback_under_tui_still_fails_closed()
    test_deny_from_callback_is_decline()
    print("tui elicitation callback: ok")
