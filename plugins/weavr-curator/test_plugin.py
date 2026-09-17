"""Planted cases for the weavr-curator plugin. Pure Python, no Hermes import:
``python3 test_plugin.py`` or pytest.

Every branch of the gate is exercised on a case that must be refused, not
only on ones that pass (a gate that has only ever been seen to pass is
indistinguishable from a gate that cannot fail). The signer is a fake
``urlopen``; nothing here touches the network.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import tempfile
import urllib.error
import urllib.parse

_spec = importlib.util.spec_from_file_location("weavr_curator_plugin", pathlib.Path(__file__).with_name("__init__.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
gate = _mod.gate
handle = _mod._handle
command = _mod.command

TOKEN = "unit-test-agent-token-0123456789abcdef-never-printed"
OPS = "unit-test-ops-token-0123456789abcdef-never-printed"
MIX = [{"asset": "SOL", "percent": 40}, {"asset": "CBBTC", "percent": 30}, {"asset": "JITOSOL", "percent": 30}]


@contextlib.contextmanager
def env(**values):
    """Set/unset environment variables for one block (``None`` unsets)."""
    saved = {k: os.environ.get(k) for k in values}
    try:
        for k, v in values.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def cron():
    return env(HERMES_CRON_SESSION="1")


def chat():
    return env(HERMES_CRON_SESSION=None)


class FakeResponse:
    def __init__(self, payload, status=200):
        self._raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        self.status = status

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeSigner:
    """Stands in for ``urllib.request.urlopen``; records every request.

    ``routes`` maps a path to ``(status, body)`` for the tests that need the
    signer to answer differently per route (a 404 on /policy and a 200 on
    /status); a status of 400 or more is raised as ``HTTPError`` the way
    ``urlopen`` does. Paths not in ``routes`` fall through to ``payload``."""

    def __init__(self, payload=None, status=200, raise_http=None, raise_exc=None, routes=None):
        self.payload = payload if payload is not None else {"ok": True}
        self.status = status
        self.raise_http = raise_http  # (code, body dict)
        self.raise_exc = raise_exc
        self.routes = routes or {}
        self.calls = []

    def __call__(self, req, timeout=None):
        self.calls.append({
            "method": req.get_method(),
            "url": req.full_url,
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data) if req.data else None,
            "timeout": timeout,
        })
        if self.raise_exc is not None:
            raise self.raise_exc
        if self.raise_http is not None:
            code, body = self.raise_http
            raise urllib.error.HTTPError(req.full_url, code, "refused", {}, io.BytesIO(json.dumps(body).encode()))
        path = urllib.parse.urlsplit(req.full_url).path
        if path in self.routes:
            code, body = self.routes[path]
            if code >= 400:
                raise urllib.error.HTTPError(req.full_url, code, "refused", {}, io.BytesIO(json.dumps(body).encode()))
            return FakeResponse(body, code)
        return FakeResponse(self.payload, self.status)


@contextlib.contextmanager
def signer(**kwargs):
    fake = FakeSigner(**kwargs)
    previous = _mod._urlopen
    _mod._urlopen = fake
    try:
        with env(CURATOR_SIGNER_URL="http://curator.test:8091/", CURATOR_SIGNER_TOKEN=TOKEN):
            yield fake
    finally:
        _mod._urlopen = previous


# --------------------------------------------------------------------------- gate

def test_cron_passes_the_allowlisted_verbs():
    with cron():
        assert gate(tool_name="weavr_curator", args={"verb": "propose", "mix": MIX, "why": "drift"}) is None
        for verb in ("apply", "cancel", "refresh_nav", "refresh-nav", "deposit"):
            assert gate(tool_name="weavr_curator", args={"verb": verb, "why": "x", "amountUsd": 5}) is None, verb


def test_the_approval_text_names_the_book_and_notice_the_host_configured():
    """The agent host sets both; the text must follow them, not a default."""
    with chat(), env(CURATOR_PORTFOLIO_SYMBOL="CLAWA1", CURATOR_REBALANCE_DELAY_SECS="60"):
        a = gate(tool_name="weavr_curator", args={"verb": "propose", "mix": MIX, "why": "SOL momentum"})
        assert "on CLAWA1 with a 60 s notice" in a["message"], a["message"]
        r = gate(tool_name="weavr_curator", args={"verb": "apply", "why": "x"})
        assert "on CLAWA1" in r["message"]
    with chat(), env(CURATOR_PORTFOLIO_SYMBOL="WEAVR", CURATOR_REBALANCE_DELAY_SECS="86400"):
        a = gate(tool_name="weavr_curator", args={"verb": "propose", "mix": MIX, "why": "SOL momentum"})
        assert "on WEAVR with a 24 h notice" in a["message"], a["message"]


def test_cron_blocks_withdraw_and_anything_else():
    with cron():
        r = gate(tool_name="weavr_curator", args={"verb": "withdraw", "amountUsd": 100})
        assert r["action"] == "block" and "cron" in r["message"] and "withdraw" in r["message"]
        r = gate(tool_name="weavr_curator", args={"verb": "rotate_curator"})
        assert r["action"] == "block" and "unknown verb" in r["message"]
        r = gate(tool_name="weavr_curator", args={})
        assert r["action"] == "block"


def test_chat_escalates_writes_with_a_named_action_and_a_per_args_rule_key():
    with chat():
        a = gate(tool_name="weavr_curator", args={"verb": "propose", "mix": MIX, "why": "SOL momentum"})
        assert a["action"] == "approve"
        # No CURATOR_PORTFOLIO_SYMBOL / CURATOR_REBALANCE_DELAY_SECS here: the
        # text names no book and announces no notice rather than guessing one.
        assert "propose 40% SOL / 30% CBBTC / 30% JITOSOL on the portfolio" in a["message"]
        assert "notice" not in a["message"]
        assert "SOL momentum" in a["message"]
        assert a["rule_key"].startswith("weavr-curator:propose:") and len(a["rule_key"].split(":")[2]) == 12
        other = [{"asset": "pSOL", "percent": 50}, {"asset": "pUSDC", "percent": 50}]
        b = gate(tool_name="weavr_curator", args={"verb": "propose", "mix": other, "why": "SOL momentum"})
        assert b["rule_key"] != a["rule_key"], "two mixes must not share an [a]lways grain"
        again = gate(tool_name="weavr_curator", args={"why": "SOL momentum", "mix": MIX, "verb": "propose"})
        assert again["rule_key"] == a["rule_key"], "key order must not change the grain"
        for verb, needle in (
            ("withdraw", "withdraw $250 from the portfolio"),
            ("deposit", "deposit $250 into the portfolio"),
            ("apply", "apply the announced rebalance on the portfolio"),
            ("cancel", "cancel the announced rebalance on the portfolio"),
            ("refresh_nav", "refresh the NAV of the portfolio"),
        ):
            r = gate(tool_name="weavr_curator", args={"verb": verb, "amountUsd": 250, "why": "risk exit"})
            assert r["action"] == "approve" and needle in r["message"], (verb, r)
            assert r["rule_key"].startswith(f"weavr-curator:{verb}:")
        assert "risk exit" in gate(tool_name="weavr_curator", args={"verb": "cancel", "why": "risk exit"})["message"]
        # an unknown verb is not approvable in chat either
        assert gate(tool_name="weavr_curator", args={"verb": "set_delay"})["action"] == "block"


def test_read_verbs_never_escalate():
    for session in (cron, chat):
        with session():
            for verb in ("status", "review", "policy", "simulate", "journal", "note", "pause"):
                assert gate(tool_name="weavr_curator", args={"verb": verb, "mix": MIX, "text": "t", "n": 5}) is None, verb


def test_policy_is_a_read_verb_in_cron_and_chat():
    """The live policy must be readable from an unattended run: a gate that
    escalated it would leave the cron review deciding from prose."""
    assert "policy" in _mod.READ_VERBS and "policy" not in _mod.CRON_ALLOWED
    with cron():
        assert gate(tool_name="weavr_curator", args={"verb": "policy"}) is None
    with chat():
        assert gate(tool_name="weavr_curator", args={"verb": "policy"}) is None


def test_describe_without_the_delay_env_announces_no_notice():
    """Without CURATOR_REBALANCE_DELAY_SECS the approval text must not claim a
    notice length. The check is proven sensitive by planting one: only a
    notice the env derives may appear."""
    with env(CURATOR_REBALANCE_DELAY_SECS=None, CURATOR_PORTFOLIO_SYMBOL=None):
        text = _mod.describe("propose", {"mix": MIX, "why": "x"})
    assert "notice" not in text, text
    assert not re.search(r"\b\d+\s?(?:h|hours?|s|secs?|d|days?)\b", text), text
    original = _mod._notice
    _mod._notice = lambda: "24 h"
    try:
        with env(CURATOR_REBALANCE_DELAY_SECS=None):
            planted = _mod.describe("propose", {"mix": MIX, "why": "x"})
    finally:
        _mod._notice = original
    assert "with a 24 h notice" in planted, "the planted notice must show, or the assertion above proves nothing"


def test_describe_never_renders_a_model_supplied_turnover():
    """``turnoverBps`` is not in SCHEMA, not validated and never sent to the
    signer, so an untrusted model could put any figure there. Planted in the
    args, it must not reach the text the human approves: they see the mix and
    the why, and the turnover that counts is the signer's own (simulate)."""
    args = {"verb": "propose", "mix": MIX, "why": "steady hand", "turnoverBps": 1250}
    with chat(), env(CURATOR_PORTFOLIO_SYMBOL=None, CURATOR_REBALANCE_DELAY_SECS=None):
        r = gate(tool_name="weavr_curator", args=args)
    assert r["action"] == "approve"
    assert "propose 40% SOL / 30% CBBTC / 30% JITOSOL on the portfolio" in r["message"], "the text is rendered from these args"
    assert "steady hand" in r["message"]
    for needle in ("turnover", "Turnover", "1250", "12.5"):
        assert needle not in r["message"], (needle, r["message"])
    text = _mod.describe("propose", args)
    for needle in ("turnover", "1250", "12.5"):
        assert needle not in text, (needle, text)
    # and the figure never leaves for the signer either: the body is targets and why
    _method, _path, body, _query = _mod.request_for("propose", args)
    assert set(body) == {"targets", "why"} and "turnoverBps" not in json.dumps(body)


def test_other_tools_are_untouched():
    with chat():
        assert gate(tool_name="terminal", args={"command": "curl -X POST /withdraw"}) is None
        assert gate(tool_name="mcp__weavr__list_assets", args={"verb": "withdraw"}) is None
        assert gate(tool_name=None, args=None) is None
    with cron():
        assert gate(tool_name="weavr_curator_other", args={"verb": "withdraw"}) is None


def test_gate_fails_closed_when_it_breaks():
    original = _mod.describe
    _mod.describe = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        with chat():
            r = gate(tool_name="weavr_curator", args={"verb": "propose", "mix": MIX, "why": "x"})
            assert r["action"] == "block" and "failed closed" in r["message"]
    finally:
        _mod.describe = original


# --------------------------------------------------------------------------- handler

def test_handler_posts_the_signer_body_with_session_and_caller_headers():
    with chat(), signer(payload={"ok": True, "verb": "propose", "deploymentId": "d1", "signatures": ["s1"]}) as fake:
        out = json.loads(handle({"verb": "propose", "mix": MIX, "why": "drift"}))
    assert out == {"ok": True, "verb": "propose", "deploymentId": "d1", "signatures": ["s1"]}
    call = fake.calls[0]
    assert call["method"] == "POST" and call["url"] == "http://curator.test:8091/propose"
    assert call["headers"]["authorization"] == f"Bearer {TOKEN}"
    assert call["headers"]["x-curator-session"] == "chat"
    assert call["headers"]["x-curator-caller"] == "hermes"
    assert call["headers"]["content-type"] == "application/json"
    assert call["timeout"] == 30.0
    assert call["body"] == {
        "targets": [
            {"poolId": "pSOL@solana", "weightBps": 4000},
            {"poolId": "pCBBTC@solana", "weightBps": 3000},
            {"poolId": "pJITOSOL@solana", "weightBps": 3000},
        ],
        "why": "drift",
    }
    with cron(), signer() as fake:
        handle({"verb": "apply"})
        handle({"verb": "journal", "n": 7})
        handle({"verb": "deposit", "amountUsd": "12.5"})
    assert fake.calls[0]["headers"]["x-curator-session"] == "cron"
    assert fake.calls[0]["body"] == {}
    assert fake.calls[1]["method"] == "GET" and fake.calls[1]["url"].endswith("/journal?n=7") and fake.calls[1]["body"] is None
    assert fake.calls[2]["url"].endswith("/deposit") and fake.calls[2]["body"] == {"amountUsd": 12.5}


POLICY_DOC = {
    "version": 1,
    "universe": {"chains": ["solana"], "requireStatus": "active", "requirePythFeedId": True, "maxRiskTier": 3,
                 "maxExecutionLossBps": 77, "allowlist": ["pSOL", "pCBBTC", "pUSDS"],
                 "categories": {"sol": ["pSOL"], "btc": ["pCBBTC"], "stable": ["pUSDS"]}},
    "shape": {"minLegs": 4, "maxLegs": 6, "pageLimit": 8, "minLegWeightBps": 700, "maxLegWeightBps": 3300,
              "stableCategory": "stable", "stableMinBps": 900, "stableMaxBps": 4100, "categoryMaxBps": 5900, "sumBps": 10000},
    "turnover": {"maxTurnoverBps": 3456},
    "cost": {"maxEstimatedCostBps": 27},
    "cadence": {"minSecsSinceLastRebalance": 123456, "maxProposalsPer30d": 5, "quotaWindowSecs": 2592000,
                "requireInputsComplete": True, "riskExitExemptFromInputs": True, "proposeWindowUtc": {"fromHour": 9, "toHour": 11}},
    "reason": {"required": True, "maxChars": 321},
    "deposit": {"dailyCapUsd": 1234, "launchDayCapUsd": 2345, "launchDay": None, "requireBookFresh": True},
    "withdraw": {"chatOnly": True, "dailyCapUsd": 567, "toSignerAtaOnly": True},
    "verbs": {"agent": ["status", "policy"], "ops": ["resume"], "denied": ["create"], "cronDenied": ["withdraw"]},
    "rate": {"maxWriteAttemptsPerHour": 19, "minSignerLamports": 21000000},
    "invariants": {"rebalanceDelaySecs": 4321, "compositionLocked": False, "pendingCuratorMustBeNone": True},
    "apply": {"tickSecs": 31, "armBeforeEffectiveSecs": 121, "windowAfterEffectiveSecs": 21601, "maxSendsPerTick": 3,
              "sendFailedTicksBeforeEscalate": 3, "refreshNavWhenBookStaleSecs": 901, "applyInFlightWaitSlots": 320,
              "applyInFlightMaxAttempts": 3, "missingCustodyRetries": 1, "escalateAfterSecs": {"BOOK_NOT_FRESH": 1801}},
    "review": {"monthlyReviewWeekday": 2, "legNeedsInflowGates": 4, "legNoInflowDays": 8, "publisherParkHours": 7,
               "drawdown30dPct": -36, "briefMaxChars": 4096},
}
POLICY_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
POLICY_BODY = {"version": 1, "sha256": POLICY_SHA, "policy": POLICY_DOC}


def test_policy_tool_gets_the_signer_document_and_posts_nothing():
    with cron(), signer(payload=POLICY_BODY) as fake:
        out = json.loads(handle({"verb": "policy"}))
    (call,) = fake.calls
    assert call["method"] == "GET" and call["url"] == "http://curator.test:8091/policy" and call["body"] is None
    assert call["headers"]["x-curator-session"] == "cron"
    assert out["source"] == "signer" and out["sha256"] == POLICY_SHA and out["version"] == 1
    assert out["policy"]["turnover"]["maxTurnoverBps"] == 3456
    # a refused /policy (401) is returned as the signer's own error, not swallowed into a fallback
    with chat(), signer(raise_http=(401, {"error": {"code": "UNAUTHORIZED"}})) as fake:
        out = json.loads(handle({"verb": "policy"}))
    assert out["ok"] is False and out["status"] == 401 and out["error"]["code"] == "UNAUTHORIZED"
    assert [c["url"].split("/")[-1] for c in fake.calls] == ["policy"], "no fallback on a non-404 error"


def test_policy_tool_falls_back_on_404_env_then_status():
    routes = {"/policy": (404, {"error": {"code": "NOT_FOUND"}}), "/status": (200, {"ok": True, "policy": {"version": 1}})}
    with chat(), env(CURATOR_POLICY_JSON=None), signer(routes=routes) as fake:
        out = json.loads(handle({"verb": "policy"}))
    assert [c["url"].split("/")[-1] for c in fake.calls] == ["policy", "status"]
    assert out["source"] == "status" and out["policy"] == {"version": 1} and "no /policy route" in out["hint"]
    local = json.dumps(POLICY_DOC)
    with chat(), env(CURATOR_POLICY_JSON=local), signer(routes=routes) as fake:
        out = json.loads(handle({"verb": "policy"}))
    assert [c["url"].split("/")[-1] for c in fake.calls] == ["policy"], "the env answers before /status is asked"
    assert out["source"] == "env" and out["policy"]["cost"]["maxEstimatedCostBps"] == 27
    assert out["sha256"] == __import__("hashlib").sha256(local.encode()).hexdigest()
    assert "CURATOR_POLICY_JSON" in out["hint"]
    # env set but not JSON: fall through to /status rather than crash
    with chat(), env(CURATOR_POLICY_JSON="{not json"), signer(routes=routes) as fake:
        out = json.loads(handle({"verb": "policy"}))
    assert out["source"] == "status"


def test_handler_drops_transaction_bearing_keys_at_any_depth():
    # A bare ``tx`` (ZZZZ, FFFF) sits outside every other dropped parent so the
    # test fails if ``tx`` alone leaves the drop set; the signer's own
    # scrubber strips tx/signed/walletPayload, and this is its mirror.
    leaky = {
        "ok": True,
        "deploymentId": "d2",
        "tx": "ZZZZ",
        "transactions": [{"tx": "AAAA"}],
        "walletPayload": {"tx": "BBBB"},
        "signed": ["CCCC"],
        "detail": {"signed": ["DDDD"], "steps": [{"transactions": ["EEEE"], "step": "propose", "tx": "FFFF"}]},
    }
    with chat(), signer(payload=leaky):
        text = handle({"verb": "propose", "mix": MIX, "why": "x"})
    out = json.loads(text)
    assert out == {"ok": True, "deploymentId": "d2", "detail": {"steps": [{"step": "propose"}]}}
    for needle in ("AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "ZZZZ", "FFFF", '"tx"', "transactions", "walletPayload", "signed"):
        assert needle not in text, needle
    assert _mod.scrub({"tx": "GGGG", "a": [{"tx": "HHHH", "b": 1}]}) == {"a": [{"b": 1}]}
    # the slash command path scrubs through the same set
    with chat(), signer(payload={"ok": True, "wallet": "w1", "tx": "IIII", "transactions": [{"tx": "JJJJ"}]}):
        text = command("status")
    assert '"wallet": "w1"' in text
    for needle in ("IIII", "JJJJ", '"tx"', "transactions"):
        assert needle not in text, needle


def test_handler_returns_the_signer_refusal_verbatim():
    with chat(), signer(raise_http=(422, {"error": {"code": "TURNOVER_CAP", "message": "3400 bps > 3000"}})):
        out = json.loads(handle({"verb": "propose", "mix": MIX, "why": "x"}))
    assert out["ok"] is False and out["status"] == 422 and out["error"]["code"] == "TURNOVER_CAP"


def test_handler_rejects_bad_input_before_the_network():
    with chat(), signer() as fake:
        assert "unknown verb" in json.loads(handle({"verb": "set_delay"}))["error"]["message"]
        assert "why is required" in json.loads(handle({"verb": "propose", "mix": MIX}))["error"]["message"]
        assert "mix must be" in json.loads(handle({"verb": "simulate"}))["error"]["message"]
        assert "percent" in json.loads(handle({"verb": "simulate", "mix": [{"asset": "SOL", "percent": "lots"}]}))["error"]["message"]
        assert "twice" in json.loads(handle({"verb": "simulate", "mix": [{"asset": "SOL", "percent": 50}, {"asset": "pSOL", "percent": 50}]}))["error"]["message"]
        assert "amountUsd" in json.loads(handle({"verb": "deposit", "amountUsd": -1}))["error"]["message"]
        assert "text is required" in json.loads(handle({"verb": "note"}))["error"]["message"]
        assert "between 1 and 500" in json.loads(handle({"verb": "journal", "n": 900}))["error"]["message"]
        assert fake.calls == [], "no request may leave on a shape error"


def test_missing_signer_url_is_a_clear_error_without_secrets():
    with chat(), env(CURATOR_SIGNER_URL=None, CURATOR_SIGNER_TOKEN=TOKEN):
        text = handle({"verb": "status"})
    out = json.loads(text)
    assert out["ok"] is False and "CURATOR_SIGNER_URL" in out["error"]["message"]
    assert TOKEN not in text
    with chat(), env(CURATOR_SIGNER_URL="http://curator.test:8091", CURATOR_SIGNER_TOKEN=None):
        text = handle({"verb": "status"})
    assert "CURATOR_SIGNER_TOKEN" in text and "Bearer" not in text
    with chat(), signer(raise_exc=urllib.error.URLError("[Errno 111] Connection refused")):
        text = handle({"verb": "status"})
    assert "unreachable" in text and TOKEN not in text and "curator.test" not in text


def test_mix_normalisation():
    assert _mod.symbol_of("SOL") == "pSOL"
    assert _mod.symbol_of("pSOL") == "pSOL"
    assert _mod.symbol_of("sol") == "pSOL"
    assert _mod.symbol_of(" jitosol ") == "pJITOSOL"
    assert _mod.symbol_of("pst") == "pPST"
    assert _mod.symbol_of("pPST") == "pPST"
    assert _mod.pool_id_of("CBBTC") == "pCBBTC@solana"
    assert _mod.pool_id_of("pWSTETH@ethereum") == "pWSTETH@ethereum"
    for bad in ("", None, "SOL/USDC", "p"):
        try:
            _mod.symbol_of(bad)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} accepted")
    assert _mod.targets_from_mix([{"asset": "USDT", "percent": 33.33}]) == [{"poolId": "pUSDT@solana", "weightBps": 3333}]


# --------------------------------------------------------------------------- slash command

def test_command_routes_and_refuses_resume_without_the_ops_token():
    with chat(), env(CURATOR_OPS_TOKEN=None), signer(payload={"ok": True, "paused": True}) as fake:
        text = command("resume")
        assert "CURATOR_OPS_TOKEN" in text and "ops token" in text and fake.calls == []
        assert command("status").startswith("{") and fake.calls[-1]["url"].endswith("/status")
        assert fake.calls[-1]["headers"]["x-curator-session"] == "chat"
        assert "cancel <why>" in command("cancel")
        command("cancel risk exit")
        assert fake.calls[-1]["url"].endswith("/cancel") and fake.calls[-1]["body"] == {"why": "risk exit"}
        command("journal 5")
        assert fake.calls[-1]["url"].endswith("/journal?n=5")
        assert "between 1 and 500" in command("journal 0")
        command("note keep an eye on pINF")
        assert fake.calls[-1]["body"] == {"text": "keep an eye on pINF"}
        command("pause manual hold")
        assert fake.calls[-1]["url"].endswith("/pause") and fake.calls[-1]["body"] == {"why": "manual hold"}
        command("apply")
        assert fake.calls[-1]["url"].endswith("/apply")
        assert command("") == _mod.USAGE and command("frobnicate") == _mod.USAGE
    with chat(), env(CURATOR_OPS_TOKEN=OPS), signer(payload={"ok": True, "paused": False}) as fake:
        text = command("resume drift fixed")
        assert fake.calls[-1]["url"].endswith("/resume") and fake.calls[-1]["headers"]["authorization"] == f"Bearer {OPS}"
        assert OPS not in text and TOKEN not in text
    with chat(), signer(payload={"brief": "HOLD: nothing to do", "triggers": [], "wakeAgent": False}):
        text = command("review")
        assert text.startswith("HOLD: nothing to do") and '"wakeAgent":false' in text


def test_command_policy_renders_the_document_it_was_given():
    """Every number on the summary comes from the fake /policy body; none of
    the standard preset's values may appear, which proves nothing is
    hand-written into the renderer."""
    with chat(), env(CURATOR_POLICY_JSON=None), signer(payload=POLICY_BODY) as fake:
        text = command("policy")
    assert fake.calls[-1]["url"].endswith("/policy") and fake.calls[-1]["method"] == "GET"
    assert fake.calls[-1]["headers"]["x-curator-session"] == "chat"
    for needle in (
        "policy version 1 (signer)",
        "max execution loss 77 bps", "allowlist pSOL, pCBBTC, pUSDS", "max risk tier 3",
        "sol pSOL", "stable pUSDS",
        "legs 4–6 (page 8)", "leg weight 700–3300 bps", "stable band 900–4100 bps", "category cap 5900 bps",
        "turnover: cap 3456 bps", "cost: cap 27 bps",
        "at least 123456 s since the last rebalance", "5 proposals per 2592000 s", "propose window 09:00–11:00 UTC",
        "max 321 chars", "cap 1234 USD per UTC day", "launch day 2345 USD", "cap 567 USD per UTC day",
        "agent status, policy", "cron-denied withdraw",
        "19 write attempts per hour", "21000000 lamports",
        "notice 4321 s", "tick 31 s", "BOOK_NOT_FRESH 1801",
        "weekday 2", "publisher park 7 h", "drawdown -36 %",
        f"sha256 {POLICY_SHA[:12]}",
    ):
        assert needle in text, (needle, text)
    assert POLICY_SHA not in text, "the full digest is noise on a phone; the prefix is enough"
    for hand_written in ("3000", "25 bps", "08:00–12:00", "604800", "1000 USD", "500 USD", "86400"):
        assert hand_written not in text, hand_written
    # a document missing whole sections renders ? rather than a default number
    with chat(), signer(payload={"version": 2, "sha256": "ab" * 32, "policy": {"version": 2}}):
        sparse = command("policy")
    assert "policy version 2 (signer)" in sparse and "turnover: cap ? bps" in sparse and "propose window ?" in sparse
    assert "sha256 abababababab" in sparse


def test_command_policy_404_fallback_renders_env_then_status():
    routes = {"/policy": (404, {"error": {"code": "NOT_FOUND"}}), "/status": (200, {"ok": True, "policy": {"version": 1}})}
    with chat(), env(CURATOR_POLICY_JSON=json.dumps(POLICY_DOC)), signer(routes=routes) as fake:
        text = command("policy")
    assert [c["url"].split("/")[-1] for c in fake.calls] == ["policy"]
    assert "policy version 1 (env)" in text and "turnover: cap 3456 bps" in text and "CURATOR_POLICY_JSON" in text
    with chat(), env(CURATOR_POLICY_JSON=None), signer(routes=routes) as fake:
        text = command("policy")
    assert [c["url"].split("/")[-1] for c in fake.calls] == ["policy", "status"]
    assert '"version": 1' in text and "no /policy route" in text, text
    # a signer that refuses the route outright is reported, not worked around
    with chat(), env(CURATOR_POLICY_JSON=json.dumps(POLICY_DOC)), signer(raise_http=(401, {"error": {"code": "UNAUTHORIZED"}})) as fake:
        text = command("policy")
    assert text.startswith("HTTP 401") and "UNAUTHORIZED" in text and len(fake.calls) == 1


def test_register_wires_tool_hook_and_command():
    class Ctx:
        def __init__(self):
            self.tools, self.hooks, self.commands = [], [], []

        def register_tool(self, **kw):
            self.tools.append(kw)

        def register_hook(self, name, fn):
            self.hooks.append((name, fn))

        def register_command(self, name, fn, description="", args_hint=""):
            self.commands.append((name, fn, args_hint))

    ctx = Ctx()
    _mod.register(ctx)
    (tool,) = ctx.tools
    assert tool["name"] == "weavr_curator" and tool["toolset"] == "weavr-curator" and tool["handler"] is handle
    assert tool["schema"]["parameters"]["properties"]["verb"]["enum"] == list(_mod.VERBS)
    assert set(_mod.VERBS) == set(_mod.ROUTES)
    assert "policy" in _mod.VERBS and _mod.ROUTES["policy"] == ("GET", "/policy")
    assert tool["requires_env"] == ["CURATOR_SIGNER_URL", "CURATOR_SIGNER_TOKEN"]
    with env(CURATOR_SIGNER_URL=None):
        assert tool["check_fn"]() is False
    with env(CURATOR_SIGNER_URL="http://curator.test:8091", CURATOR_SIGNER_TOKEN=TOKEN):
        assert tool["check_fn"]() is True
    assert ctx.hooks == [("pre_tool_call", gate)]
    ((name, fn, hint),) = ctx.commands
    assert name == "weavr-curator" and fn is command and "resume" in hint


# --------------------------------------------------------------------------- policy presets

POLICY_DIR = pathlib.Path(__file__).resolve().parents[2] / "curator" / "policy"
PRESETS = ("standard", "rehearsal")
# Agent-token routes the profile's cron scripts call that the tool has no verb
# for (curator-health.sh: GET /alerts, POST /hermes-heartbeat).
SCRIPT_ROUTES = frozenset({"alerts", "hermes-heartbeat"})


def _presets_settle_every_plugin_route(policy_dir):
    """The signer's verb check is list membership, so a route the plugin calls
    that no list names is refused at run time, not at boot. Each preset must
    therefore settle every route in ROUTES (agent or denied, never both), keep
    every read the gate never escalates in ``agent`` (an unattended review
    that cannot read the policy decides from prose), put no plugin route in
    ``ops`` (the agent token would get OPS_ONLY), and name nothing in
    ``agent`` that neither the plugin nor the profile's scripts call, so a
    misspelt verb is reported rather than left as a silent refusal."""
    routes = {path.lstrip("/") for _method, path in _mod.ROUTES.values()}
    reads = {_mod.ROUTES[verb][1].lstrip("/") for verb in _mod.READ_VERBS}
    for name in PRESETS:
        verbs = json.loads((policy_dir / f"{name}.json").read_text())["verbs"]
        agent, ops, denied = set(verbs["agent"]), set(verbs["ops"]), set(verbs["denied"])
        unsettled = sorted(routes - agent - denied)
        assert not unsettled, f"{name}.json: neither verbs.agent nor verbs.denied names {unsettled}"
        assert not agent & denied, f"{name}.json: {sorted(agent & denied)} in both verbs.agent and verbs.denied"
        assert not routes & ops, f"{name}.json: plugin routes {sorted(routes & ops)} in verbs.ops"
        assert reads <= agent, f"{name}.json: read verbs {sorted(reads - agent)} missing from verbs.agent"
        stray = sorted(agent - routes - SCRIPT_ROUTES)
        assert not stray, f"{name}.json: verbs.agent names {stray}, which nothing on the agent calls"


def test_every_preset_settles_every_route_the_plugin_uses():
    _presets_settle_every_plugin_route(POLICY_DIR)
    # Planted: the same check on copies with ``policy`` dropped from
    # verbs.agent must report it by name, or the assertions prove nothing.
    with tempfile.TemporaryDirectory() as tmp:
        for name in PRESETS:
            doc = json.loads((POLICY_DIR / f"{name}.json").read_text())
            doc["verbs"]["agent"] = [verb for verb in doc["verbs"]["agent"] if verb != "policy"]
            (pathlib.Path(tmp) / f"{name}.json").write_text(json.dumps(doc))
        try:
            _presets_settle_every_plugin_route(pathlib.Path(tmp))
        except AssertionError as exc:
            assert "policy" in str(exc) and "standard.json" in str(exc), exc
        else:
            raise AssertionError("dropping policy from verbs.agent went unreported")


TESTS = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]

if __name__ == "__main__":
    for test in TESTS:
        test()
    print(f"weavr-curator plugin: ok ({len(TESTS)} tests)")
