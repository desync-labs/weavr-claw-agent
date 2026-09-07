"""Proves the trust-gate fix: an SDK ToolAnnotations(readOnlyHint=True) is
recorded read-only, everything else stays write-capable. Run from the fork
checkout with its venv: `python -m pytest integrations/.../test_trust_gate.py`
or plainly `python test_trust_gate.py`."""
from mcp.types import Tool, ToolAnnotations
from tools.mcp_tool import _annotation_read_only_hint


class _Plain:
    pass


def test_sdk_read_only_is_true():
    tool = Tool(name="a", inputSchema={"type": "object"}, annotations=ToolAnnotations(readOnlyHint=True))
    assert _annotation_read_only_hint(tool) is True


def test_sdk_write_and_missing_stay_false():
    rw = Tool(name="b", inputSchema={"type": "object"}, annotations=ToolAnnotations(readOnlyHint=False))
    none = Tool(name="c", inputSchema={"type": "object"})
    assert _annotation_read_only_hint(rw) is False
    assert _annotation_read_only_hint(none) is False


def test_cache_dict_shape_still_works():
    cached = _Plain()
    cached.annotations = {"readOnlyHint": True}
    assert _annotation_read_only_hint(cached) is True


if __name__ == "__main__":
    test_sdk_read_only_is_true()
    test_sdk_write_and_missing_stay_false()
    test_cache_dict_shape_still_works()
    print("trust gate: ok")
