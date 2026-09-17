"""weavr-curator: the Hermes side of the weavr curator.

The curator key lives in the signer process (the weavr curator signer, HTTP
:8091). Hermes never sees a transaction, a key or an RPC URL: this plugin is
a thin HTTP client plus the two things only the Hermes side can know:

* **which session is calling.** A cron job runs unattended; a chat turn has a
  human on the other end. The signer is told through ``X-Curator-Session`` and
  applies its own rules (``withdraw`` is chat-only, ``WITHDRAW_CRON_BLOCKED``),
  but the plugin also gates *before* the call so a blocked verb never reaches
  the signer's journal as a refusal.
* **the human approval gate.** In chat, every write verb returns
  ``{"action": "approve"}`` from ``pre_tool_call``, the same surface Tier-2
  dangerous shell commands use (terminal prompt, Telegram buttons;
  non-interactive runs fail closed). The ``rule_key`` carries a hash of the
  canonical args, so an ``[a]lways`` answer covers exactly that mix and that
  amount, never "every propose".

The ``policy`` verb is the durable fix for prose drift: the model reads the
signer's live policy document (``GET /policy``: version, sha256, document)
instead of any number written on a page. An older signer without the route
answers 404; the plugin then falls back to ``CURATOR_POLICY_JSON`` on the
agent host and, failing that, to the ``policy`` block of ``/status``, and
always says which source answered.

Why the gate is fail-closed: Hermes logs and *ignores* an exception raised by
a ``pre_tool_call`` callback (``PluginManager.invoke_hook``), which would let
a broken gate approve everything. ``gate()`` therefore catches its own
failures and blocks.

Hermes modules (``gateway.session_context``) are imported lazily inside the
functions that need them so ``test_plugin.py`` can import this file by path
with no Hermes on ``sys.path``.

Install: copy or symlink this directory to ``$HERMES_HOME/plugins/weavr-curator``
and set ``CURATOR_SIGNER_URL`` + ``CURATOR_SIGNER_TOKEN`` in the agent's
environment (the ops token is never given to the agent).
Test: ``python3 test_plugin.py``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

TOOL_NAME = "weavr_curator"
TOOLSET = "weavr-curator"
# The plan says ``/curator``; the fork already ships a built-in ``/curator``
# (hermes_cli/commands.py: "Background skill maintenance"), and
# ``register_command`` silently skips a name that resolves to a built-in.
COMMAND_NAME = "weavr-curator"
CALLER = "hermes"
TIMEOUT_SECS = 30.0
DEFAULT_CHAIN = "solana"  # the api's poolId is `<symbol>@<chain>`; the policy's chain list is the signer's to refuse

# Verb classes. ``note`` and ``pause`` write only to the journal / the
# signer's own state, never to chain, so they count as reads here: the agent
# must always be able to pause itself without a human in the loop. ``policy``
# is a pure read of the signer's document.
READ_VERBS = frozenset({"status", "review", "policy", "simulate", "journal", "note", "pause"})
CRON_ALLOWED = frozenset({"propose", "apply", "cancel", "refresh_nav", "deposit"})
VERBS = (
    "status", "review", "policy", "simulate", "propose", "apply", "cancel",
    "deposit", "withdraw", "refresh_nav", "pause", "note", "journal",
)
# verb -> (method, signer route). Only agent-token routes; the ops routes are
# reachable from the slash command alone, and only when CURATOR_OPS_TOKEN is set.
ROUTES = {
    "status": ("GET", "/status"),
    "review": ("GET", "/review"),
    "policy": ("GET", "/policy"),
    "simulate": ("POST", "/simulate"),
    "propose": ("POST", "/propose"),
    "apply": ("POST", "/apply"),
    "cancel": ("POST", "/cancel"),
    "deposit": ("POST", "/deposit"),
    "withdraw": ("POST", "/withdraw"),
    "refresh_nav": ("POST", "/refresh-nav"),
    "pause": ("POST", "/pause"),
    "note": ("POST", "/note"),
    "journal": ("GET", "/journal"),
}
# Keys that could only ever carry transaction bytes: the names the signer's
# own journal scrubber refuses (``tx``, ``signed``, ``walletPayload``) plus the
# api's ``transactions`` list. The signer contract says it never returns them;
# dropping them here is the belt to that brace, at any depth, so a future
# signer bug cannot put a payload in front of the model.
DROP_KEYS = frozenset({"tx", "transactions", "walletPayload", "signed"})
TRUTHY = frozenset({"1", "true", "yes", "on"})
MAX_RESULT_CHARS = 12_000

SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Operate the one weavr portfolio the curator signer is pinned to (status names it). Reads: "
        "status, review, policy, simulate, journal. policy returns the live policy document the signer "
        "enforces (with version and sha256): read it once per run before deciding; its numbers beat "
        "anything written on any page. Writes (policy-checked, built, IDL-verified, signed and sent by "
        "the signer, never by you): propose (mix + why), apply, cancel (why), deposit (amountUsd), "
        "withdraw (amountUsd, chat only), refresh_nav. Housekeeping: pause, note (text). Amounts are "
        "USD; percents are percents. The reply is compact JSON; a refusal comes back as "
        "{ok:false, error:{code,message}} and the message carries the limit that bound."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "verb": {"type": "string", "enum": list(VERBS), "description": "What to do."},
            "mix": {
                "type": "array",
                "description": "propose/simulate: the full target mix, percents summing to 100. "
                               "asset is the pool symbol with or without the leading p (SOL, CBBTC, JITOSOL).",
                "items": {
                    "type": "object",
                    "properties": {
                        "asset": {"type": "string"},
                        "percent": {"type": "number"},
                    },
                    "required": ["asset", "percent"],
                },
            },
            "why": {"type": "string", "description": "propose/cancel/pause: the reason, journaled; the policy's reason limit applies (WHY_REQUIRED names it)."},
            "amountUsd": {"type": "number", "description": "deposit/withdraw: amount in USD."},
            "text": {"type": "string", "description": "note: free text for the journal (at most 2 KB)."},
            "n": {"type": "integer", "description": "journal: how many records (default 50, max 500)."},
        },
        "required": ["verb"],
    },
}


class SignerConfigError(RuntimeError):
    """The plugin cannot reach the signer because its own environment is incomplete."""


# ---------------------------------------------------------------------------
# session
# ---------------------------------------------------------------------------

def is_cron_session() -> bool:
    """True inside a Hermes cron job.

    The gateway binds ``HERMES_CRON_SESSION`` as a context variable per job so
    one job cannot taint a concurrent chat turn; ``get_session_env`` reads that
    first and falls back to ``os.environ`` (CLI, tests). Without Hermes on the
    path only the environment is consulted.
    """
    value = None
    try:
        from gateway.session_context import get_session_env  # lazy: no Hermes in tests

        value = get_session_env("HERMES_CRON_SESSION", "")
    except Exception:
        value = os.environ.get("HERMES_CRON_SESSION", "")
    return str(value or "").strip().lower() in TRUTHY


def session_kind() -> str:
    return "cron" if is_cron_session() else "chat"


def normalize_verb(raw) -> str:
    return str(raw or "").strip().lower().replace("-", "_")


# ---------------------------------------------------------------------------
# mix -> targets
# ---------------------------------------------------------------------------

_LEADING_P = re.compile(r"^p(?=[A-Z0-9])")


def symbol_of(asset) -> str:
    """``SOL`` / ``sol`` / ``pSOL`` -> ``pSOL``. A leading lowercase ``p`` is the
    weavr prefix only when what follows is upper-case (``pst`` is the PST asset)."""
    text = str(asset or "").strip()
    if not text:
        raise ValueError("mix[].asset must be a non-empty pool symbol such as SOL or pSOL")
    chain = None
    if "@" in text:
        text, chain = text.split("@", 1)
    text = _LEADING_P.sub("", text).upper()
    if not re.fullmatch(r"[A-Z0-9]{2,}", text):
        raise ValueError(f"mix[].asset {asset!r} is not a pool symbol")
    return f"p{text}" + (f"@{chain.strip().lower()}" if chain else "")


def pool_id_of(asset) -> str:
    """The api's pool id, ``<symbol>@<chain>`` (``catalogue.js poolIdOf``); the
    policy universe is Solana-only, so the chain defaults to ``solana`` unless
    the asset spells one (``pWSTETH@ethereum``)."""
    symbol = symbol_of(asset)
    return symbol if "@" in symbol else f"{symbol}@{DEFAULT_CHAIN}"


def targets_from_mix(mix) -> list:
    """``[{asset, percent}]`` -> ``[{poolId, weightBps}]``; sums and caps are the
    signer's job (WEIGHTS_SUM etc.), shape errors are caught here so a typo
    never becomes a journaled refusal."""
    if not isinstance(mix, list) or not mix:
        raise ValueError("mix must be a non-empty list of {asset, percent}")
    targets = []
    seen = set()
    for index, leg in enumerate(mix):
        if not isinstance(leg, dict):
            raise ValueError(f"mix[{index}] must be an object {{asset, percent}}")
        pool_id = pool_id_of(leg.get("asset"))
        if pool_id in seen:
            raise ValueError(f"mix lists {pool_id} twice")
        seen.add(pool_id)
        try:
            percent = float(leg.get("percent"))
        except (TypeError, ValueError):
            raise ValueError(f"mix[{index}].percent must be a number") from None
        if not percent > 0 or percent > 100:
            raise ValueError(f"mix[{index}].percent must be in (0, 100]")
        targets.append({"poolId": pool_id, "weightBps": int(round(percent * 100))})
    return targets


def _amount(raw) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError("amountUsd must be a positive number") from None
    if not value > 0:
        raise ValueError("amountUsd must be a positive number")
    return value


def _why(args: dict, verb: str) -> str:
    why = str(args.get("why") or "").strip()
    if not why:
        raise ValueError(f"why is required for {verb} (it is journaled)")
    return why


def request_for(verb: str, args: dict):
    """``(method, path, body|None, query|None)`` for a verb, or ValueError."""
    method, path = ROUTES[verb]
    body, query = None, None
    if verb in ("simulate", "propose"):
        body = {"targets": targets_from_mix(args.get("mix"))}
        if verb == "propose":
            body["why"] = _why(args, verb)
    elif verb == "cancel":
        body = {"why": _why(args, verb)}
    elif verb in ("deposit", "withdraw"):
        body = {"amountUsd": _amount(args.get("amountUsd"))}
    elif verb == "pause":
        why = str(args.get("why") or "").strip()
        body = {"why": why} if why else {}
    elif verb == "note":
        text = str(args.get("text") or "").strip()
        if not text:
            raise ValueError("text is required for note")
        body = {"text": text}
    elif verb == "journal":
        n = args.get("n")
        if n is not None:
            try:
                n = int(n)
            except (TypeError, ValueError):
                raise ValueError("n must be an integer") from None
            if not 1 <= n <= 500:
                raise ValueError("n must be between 1 and 500")
            query = {"n": n}
    elif method == "POST":
        body = {}
    return method, path, body, query


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

_urlopen = urllib.request.urlopen  # tests replace this with a fake


def scrub(value):
    """Drop transaction-bearing keys at any depth."""
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k not in DROP_KEYS}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def _signer_url() -> str:
    url = os.environ.get("CURATOR_SIGNER_URL", "").strip()
    if not url:
        raise SignerConfigError(
            "CURATOR_SIGNER_URL is not set in the Hermes environment; the curator signer cannot be reached."
        )
    return url.rstrip("/")


def _token(env_name: str) -> str:
    token = os.environ.get(env_name, "").strip()
    if not token:
        raise SignerConfigError(f"{env_name} is not set in the Hermes environment.")
    return token


def _parse(raw: bytes):
    text = raw.decode("utf-8", "replace") if raw else ""
    if not text.strip():
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {"error": {"code": "BAD_UPSTREAM", "message": text[:300]}}


def call_signer(method: str, path: str, body=None, query=None, *, token_env="CURATOR_SIGNER_TOKEN", session=None):
    """One request to the signer. Returns ``(status, json)``; a non-2xx status
    is returned, not raised, so the model sees the signer's ``{error:{code}}``
    verbatim. Raises SignerConfigError only for this process' own env."""
    base = _signer_url()
    token = _token(token_env)  # read at call time: rotation needs no restart
    url = base + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "X-Curator-Session": session or session_kind(),
        "X-Curator-Caller": CALLER,
    }
    if method == "POST":
        data = json.dumps(body if body is not None else {}, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _urlopen(req, timeout=TIMEOUT_SECS) as resp:
            return int(getattr(resp, "status", 200) or 200), _parse(resp.read())
    except urllib.error.HTTPError as exc:
        return int(exc.code), _parse(exc.read())


def _compact(obj) -> str:
    text = json.dumps(scrub(obj), separators=(",", ":"), ensure_ascii=False)
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + '…"truncated":true}'
    return text


def _error(message: str) -> str:
    return json.dumps({"ok": False, "error": {"code": "PLUGIN", "message": str(message)}}, ensure_ascii=False)


# ---------------------------------------------------------------------------
# policy: the live document, from the signer first
# ---------------------------------------------------------------------------

POLICY_HINT_ENV = (
    "the signer has no /policy route (older signer); this is the document from CURATOR_POLICY_JSON "
    "on the agent host, which may differ from the one the signer enforces"
)
POLICY_HINT_STATUS = (
    "the signer has no /policy route and exposes only the policy version through /status; upgrade "
    "the signer, or set CURATOR_POLICY_JSON on the agent host, for the full document"
)


def fetch_policy(session=None):
    """``(status, payload, source)``: the signer's ``GET /policy`` first
    (``{version, sha256, policy}``), ``CURATOR_POLICY_JSON`` second when the
    signer answers 404, the ``policy`` block of ``/status`` last. ``source``
    is ``signer`` | ``env`` | ``status`` so the caller can say who answered.
    A non-404 error from ``/policy`` is returned as is."""
    status, payload = call_signer("GET", "/policy", session=session)
    if status != 404:
        if not isinstance(payload, dict):
            payload = {"result": payload}
        return status, payload, "signer"
    local = os.environ.get("CURATOR_POLICY_JSON", "").strip()
    if local:
        try:
            doc = json.loads(local)
        except ValueError:
            doc = None
        if isinstance(doc, dict):
            digest = hashlib.sha256(local.encode("utf-8")).hexdigest()
            return 200, {"version": doc.get("version"), "sha256": digest, "policy": doc, "hint": POLICY_HINT_ENV}, "env"
    status, payload = call_signer("GET", "/status", session=session)
    policy = payload.get("policy") if isinstance(payload, dict) else None
    return status, {"policy": policy, "hint": POLICY_HINT_STATUS}, "status"


def _get(doc, *path):
    node = doc
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _v(value) -> str:
    if value is None:
        return "?"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list):
        return ", ".join(str(x) for x in value) if value else "none"
    return str(value)


def _window(w) -> str:
    if not isinstance(w, dict):
        return "?"
    try:
        return f"{int(w.get('fromHour')):02d}:00–{int(w.get('toHour')):02d}:00 UTC"
    except (TypeError, ValueError):
        return "?"


def render_policy(doc: dict, version=None, sha256=None, source="signer") -> str:
    """One line per section of the policy document, every number taken from
    the document itself. Nothing here is hand-written: a missing key renders
    as ``?`` rather than a default."""
    g = lambda *path: _get(doc, *path)  # noqa: E731
    cats = g("universe", "categories")
    cat_line = "; ".join(
        f"{name} {_v(members)}" for name, members in (cats.items() if isinstance(cats, dict) else []) if not str(name).startswith("_")
    ) or "?"
    escalate = g("apply", "escalateAfterSecs")
    esc_line = "; ".join(f"{k} {_v(v)}" for k, v in (escalate.items() if isinstance(escalate, dict) else [])) or "?"
    lines = [
        f"policy version {_v(version if version is not None else g('version'))} ({source})",
        f"universe: chains {_v(g('universe', 'chains'))}; status {_v(g('universe', 'requireStatus'))}; "
        f"price feed required {_v(g('universe', 'requirePythFeedId'))}; max risk tier {_v(g('universe', 'maxRiskTier'))}; "
        f"max execution loss {_v(g('universe', 'maxExecutionLossBps'))} bps; allowlist {_v(g('universe', 'allowlist'))}",
        f"categories: {cat_line}",
        f"shape: legs {_v(g('shape', 'minLegs'))}–{_v(g('shape', 'maxLegs'))} (page {_v(g('shape', 'pageLimit'))}); "
        f"leg weight {_v(g('shape', 'minLegWeightBps'))}–{_v(g('shape', 'maxLegWeightBps'))} bps; "
        f"{_v(g('shape', 'stableCategory'))} band {_v(g('shape', 'stableMinBps'))}–{_v(g('shape', 'stableMaxBps'))} bps; "
        f"category cap {_v(g('shape', 'categoryMaxBps'))} bps; sum {_v(g('shape', 'sumBps'))}",
        f"turnover: cap {_v(g('turnover', 'maxTurnoverBps'))} bps per proposal",
        f"cost: cap {_v(g('cost', 'maxEstimatedCostBps'))} bps of NAV",
        f"cadence: at least {_v(g('cadence', 'minSecsSinceLastRebalance'))} s since the last rebalance; "
        f"{_v(g('cadence', 'maxProposalsPer30d'))} proposals per {_v(g('cadence', 'quotaWindowSecs'))} s; "
        f"propose window {_window(g('cadence', 'proposeWindowUtc'))}; inputs required {_v(g('cadence', 'requireInputsComplete'))} "
        f"(risk exit exempt {_v(g('cadence', 'riskExitExemptFromInputs'))})",
        f"reason: required {_v(g('reason', 'required'))}; max {_v(g('reason', 'maxChars'))} chars",
        f"deposit: cap {_v(g('deposit', 'dailyCapUsd'))} USD per UTC day; launch day {_v(g('deposit', 'launchDayCapUsd'))} USD "
        f"(launchDay {'none' if g('deposit', 'launchDay') is None else _v(g('deposit', 'launchDay'))}); "
        f"book must be fresh {_v(g('deposit', 'requireBookFresh'))}",
        f"withdraw: chat only {_v(g('withdraw', 'chatOnly'))}; cap {_v(g('withdraw', 'dailyCapUsd'))} USD per UTC day; "
        f"to the signer's own account only {_v(g('withdraw', 'toSignerAtaOnly'))}",
        f"verbs: agent {_v(g('verbs', 'agent'))}; ops {_v(g('verbs', 'ops'))}; denied {_v(g('verbs', 'denied'))}; "
        f"cron-denied {_v(g('verbs', 'cronDenied'))}",
        f"rate: {_v(g('rate', 'maxWriteAttemptsPerHour'))} write attempts per hour; signer floor {_v(g('rate', 'minSignerLamports'))} lamports",
        f"invariants: notice {_v(g('invariants', 'rebalanceDelaySecs'))} s; composition locked {_v(g('invariants', 'compositionLocked'))}; "
        f"pending curator must be none {_v(g('invariants', 'pendingCuratorMustBeNone'))}",
        f"apply: tick {_v(g('apply', 'tickSecs'))} s; arm {_v(g('apply', 'armBeforeEffectiveSecs'))} s before effectiveAt; "
        f"window {_v(g('apply', 'windowAfterEffectiveSecs'))} s after; refresh NAV when stale {_v(g('apply', 'refreshNavWhenBookStaleSecs'))} s; "
        f"escalate after: {esc_line}",
        f"review: monthly review weekday {_v(g('review', 'monthlyReviewWeekday'))}; leg needs inflow after "
        f"{_v(g('review', 'legNeedsInflowGates'))} gates and {_v(g('review', 'legNoInflowDays'))} d without inflow; "
        f"publisher park {_v(g('review', 'publisherParkHours'))} h; drawdown {_v(g('review', 'drawdown30dPct'))} %; "
        f"brief max {_v(g('review', 'briefMaxChars'))} chars",
        f"sha256 {str(sha256)[:12] if sha256 else '?'}",
    ]
    return "\n".join(lines)


def _handle(args: dict, **kwargs) -> str:
    """Tool handler: ``registry.dispatch`` calls ``handler(args, **kwargs)`` and
    expects a JSON string back."""
    args = args if isinstance(args, dict) else {}
    verb = normalize_verb(args.get("verb"))
    if verb not in ROUTES:
        return _error(f"unknown verb {args.get('verb')!r}; one of {', '.join(VERBS)}")
    try:
        method, path, body, query = request_for(verb, args)
    except ValueError as exc:
        return _error(str(exc))
    try:
        if verb == "policy":
            status, payload, source = fetch_policy()
            if isinstance(payload, dict) and status < 400:
                payload = dict(payload, source=source)
        else:
            status, payload = call_signer(method, path, body, query)
    except SignerConfigError as exc:
        return _error(str(exc))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        # URLError/HTTPError/timeout strings carry a reason, never the URL or the token.
        reason = getattr(exc, "reason", None) or exc
        return _error(f"curator signer unreachable: {type(exc).__name__}: {reason}")
    if not isinstance(payload, dict):
        payload = {"result": payload}
    if status >= 400:
        out = {"ok": False, "status": status}
        out.update(payload)
        return _compact(out)
    return _compact(payload)


# ---------------------------------------------------------------------------
# pre_tool_call gate
# ---------------------------------------------------------------------------

def _portfolio() -> str:
    """The book's ticker for the approval text, or a name that claims nothing.

    The fallback names no book on purpose. An approval prompt is the last
    thing a human reads before a write, so it must never name a book the
    signer is not pointed at.
    """
    return os.environ.get("CURATOR_PORTFOLIO_SYMBOL", "").strip() or "the portfolio"


def _notice() -> str | None:
    """The announced notice for the describe text, or None when it is unknown.

    From CURATOR_REBALANCE_DELAY_SECS, which the agent host sets to the book's
    on-chain delay. Unset returns None and the clause is dropped: claiming a
    day-long notice on a book that announces for a minute is worse than saying
    nothing.
    """
    raw = os.environ.get("CURATOR_REBALANCE_DELAY_SECS", "").strip()
    if raw.isdigit() and int(raw) > 0:
        secs = int(raw)
        return f"{secs // 3600} h" if secs % 3600 == 0 else f"{secs} s"
    return None


def _pct(value) -> str:
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return "?"


def _display_asset(asset) -> str:
    try:
        return symbol_of(asset).split("@", 1)[0][1:]
    except ValueError:
        return str(asset)


def _quote(text, limit=120) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return f': "{text}"' if text else ""


def describe(verb: str, args: dict) -> str:
    """One short sentence naming the action for the approval prompt."""
    args = args if isinstance(args, dict) else {}
    book = _portfolio()
    if verb == "propose":
        mix = args.get("mix") if isinstance(args.get("mix"), list) else []
        legs = " / ".join(
            f"{_pct(leg.get('percent'))}% {_display_asset(leg.get('asset'))}"
            for leg in mix if isinstance(leg, dict)
        ) or "an empty mix"
        notice = _notice()
        text = f"propose {legs} on {book}"
        if notice:
            text += f" with a {notice} notice"
        # Only the mix and the why are rendered. Anything else the model puts in
        # the args (a turnover, a cost) is not in SCHEMA, is not validated and
        # never reaches the signer, so rendering it would put a model-supplied
        # figure in front of the human as fact. The signer computes turnover
        # and cost itself (simulate) and refuses on its own numbers.
        return text + _quote(args.get("why"))
    if verb == "apply":
        return f"apply the announced rebalance on {book} now (one forced attempt through the pre-flight gates)"
    if verb == "cancel":
        return f"cancel the announced rebalance on {book}" + _quote(args.get("why"))
    if verb == "deposit":
        return f"deposit ${_pct(args.get('amountUsd'))} into {book} from the curator wallet"
    if verb == "withdraw":
        return f"withdraw ${_pct(args.get('amountUsd'))} from {book} to the curator wallet"
    if verb == "refresh_nav":
        return f"refresh the NAV of {book} (the curator pays the crank fee)"
    return f"run weavr_curator {verb}"


def rule_key(verb: str, args: dict) -> str:
    canonical = json.dumps(args if isinstance(args, dict) else {}, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    return f"weavr-curator:{verb}:{digest}"


def gate(tool_name: str | None = None, args: dict | None = None, **kwargs):
    """pre_tool_call: read verbs pass; cron passes the allowlist and blocks the
    rest (withdraw above all); chat escalates every write to the human gate."""
    if tool_name != TOOL_NAME:
        return None
    try:
        args = args if isinstance(args, dict) else {}
        verb = normalize_verb(args.get("verb"))
        if verb in READ_VERBS:
            return None
        if verb not in ROUTES:
            return {"action": "block", "message": f"weavr_curator: unknown verb {args.get('verb')!r}; one of {', '.join(VERBS)}."}
        if is_cron_session():
            if verb in CRON_ALLOWED:
                return None
            return {
                "action": "block",
                "message": f"weavr_curator {verb} is not allowed from a cron session; "
                           f"cron may run {', '.join(sorted(CRON_ALLOWED))}. Ask the operator in chat.",
            }
        return {
            "action": "approve",
            "message": f"Curator action: {describe(verb, args)}. Approve to let the signer build, verify, sign and send it.",
            "rule_key": rule_key(verb, args),
        }
    except Exception as exc:  # a raising hook is ignored by Hermes; fail closed instead
        return {"action": "block", "message": f"weavr-curator gate failed closed: {type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# /weavr-curator slash command
# ---------------------------------------------------------------------------

USAGE = (
    f"/{COMMAND_NAME} status | review | journal [n] | policy | pause [why] | resume [why] "
    "| cancel <why> | apply | note <text>"
)
_TELEGRAM_CHARS = 3_800


def _pretty(status: int, payload) -> str:
    payload = scrub(payload)
    head = "" if status < 400 else f"HTTP {status}\n"
    if isinstance(payload, dict) and isinstance(payload.get("brief"), str):
        rest = {k: v for k, v in payload.items() if k != "brief"}
        text = payload["brief"].rstrip() + "\n" + json.dumps(rest, separators=(",", ":"), ensure_ascii=False)
    else:
        text = json.dumps(payload, indent=2, ensure_ascii=False)
    text = head + text
    return text if len(text) <= _TELEGRAM_CHARS else text[:_TELEGRAM_CHARS] + "\n… truncated"


def command(raw_args: str = "") -> str:
    """``fn(raw_args) -> str``. A human typed this, so the session is ``chat``
    and no approval gate runs; ``resume`` still needs the ops token, which the
    agent deliberately does not have."""
    parts = str(raw_args or "").strip().split(None, 1)
    if not parts:
        return USAGE
    sub = parts[0].lower().replace("_", "-")
    rest = parts[1].strip() if len(parts) > 1 else ""
    try:
        if sub == "status":
            return _pretty(*call_signer("GET", "/status", session="chat"))
        if sub == "review":
            return _pretty(*call_signer("GET", "/review", session="chat"))
        if sub == "journal":
            query = None
            if rest:
                if not rest.isdigit() or not 1 <= int(rest) <= 500:
                    return "journal takes a count between 1 and 500."
                query = {"n": int(rest)}
            return _pretty(*call_signer("GET", "/journal", query=query, session="chat"))
        if sub == "policy":
            status, payload, source = fetch_policy(session="chat")
            doc = payload.get("policy") if isinstance(payload, dict) else None
            if status >= 400 or source == "status" or not isinstance(doc, dict):
                return _pretty(status, payload)
            text = render_policy(doc, version=payload.get("version"), sha256=payload.get("sha256"), source=source)
            if payload.get("hint"):
                text += "\n" + str(payload["hint"])
            return text if len(text) <= _TELEGRAM_CHARS else text[:_TELEGRAM_CHARS] + "\n… truncated"
        if sub == "pause":
            return _pretty(*call_signer("POST", "/pause", {"why": rest} if rest else {}, session="chat"))
        if sub == "resume":
            if not os.environ.get("CURATOR_OPS_TOKEN", "").strip():
                return (
                    "resume needs the ops token and CURATOR_OPS_TOKEN is not set here; by design the agent "
                    "never holds it. Run it from your own machine: weavr-curator ops resume."
                )
            return _pretty(*call_signer("POST", "/resume", {"why": rest} if rest else {}, token_env="CURATOR_OPS_TOKEN", session="chat"))
        if sub == "cancel":
            if not rest:
                return f"cancel needs a reason: /{COMMAND_NAME} cancel <why>"
            return _pretty(*call_signer("POST", "/cancel", {"why": rest}, session="chat"))
        if sub == "apply":
            return _pretty(*call_signer("POST", "/apply", {}, session="chat"))
        if sub == "note":
            if not rest:
                return f"note needs text: /{COMMAND_NAME} note <text>"
            return _pretty(*call_signer("POST", "/note", {"text": rest}, session="chat"))
        return USAGE
    except SignerConfigError as exc:
        return str(exc)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", None) or exc
        return f"curator signer unreachable: {type(exc).__name__}: {reason}"


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------

def _configured() -> bool:
    return bool(os.environ.get("CURATOR_SIGNER_URL", "").strip() and os.environ.get("CURATOR_SIGNER_TOKEN", "").strip())


def register(ctx):
    ctx.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET,
        schema=SCHEMA,
        handler=_handle,
        check_fn=_configured,
        requires_env=["CURATOR_SIGNER_URL", "CURATOR_SIGNER_TOKEN"],
        description="Operate the signer's one weavr portfolio through the curator signer (policy-checked, never signs here).",
        emoji="🧭",
    )
    ctx.register_hook("pre_tool_call", gate)
    ctx.register_command(
        COMMAND_NAME,
        command,
        description="weavr curator signer: status, review, journal, policy, pause, resume, cancel, apply, note",
        args_hint="status|review|journal [n]|policy|pause|resume|cancel <why>|apply|note <text>",
    )
    # There is no ctx API to strip an env var from the terminal tool's children
    # (only a registered TerminalEnvironmentProvider's strip_env_keys, and
    # register_redaction_patterns takes token-format regexes and logs a rejected
    # pattern verbatim). The curator profile disables the terminal and
    # code_execution toolsets instead; see README.md.
