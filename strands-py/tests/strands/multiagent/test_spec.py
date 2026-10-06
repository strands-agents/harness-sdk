"""Tests for multiagent spec resolution: axis types, _resolve_spec, and _default_builder."""

import pytest

from strands import Agent
from strands.multiagent.spec import (
    _UNSET,
    AgentSpec,
    Choice,
    Fixed,
    Inherit,
    Open,
    Option,
    Preset,
    _default_builder,
    _resolve_spec,
)
from strands.tools.decorator import tool

_AXES = dict(
    presets={},
    default_preset=None,
    instructions=Open(),
    tools=Choice(["read", "shell"], multiple=True),
    mcp_servers=Inherit(),
    model=Inherit(),
)


def test_choice_normalized_wraps_strings_and_fills_unset():
    c = Choice([Option("alias", object(), "d"), Option("bare"), "raw"])
    opts = c.normalized()
    assert opts[0].value is not _UNSET and opts[0].description == "d"
    assert opts[1].value == "bare"  # _UNSET filled from name
    assert opts[2].name == "raw" and opts[2].value == "raw"


def test_choice_none_value_is_not_overwritten():
    assert Choice([Option("off", None)]).normalized()[0].value is None


def test_choice_schema_single_and_multiple():
    assert Choice(["a", "b"]).to_schema_property() == {"type": "string", "enum": ["a", "b"]}
    prop = Choice(["a"], multiple=True).to_schema_property("desc")
    assert prop["type"] == "array" and prop["description"] == "desc"


def test_choice_schema_folds_option_descriptions():
    prop = Choice([Option("x", description="info"), "y"]).to_schema_property()
    assert "- x: info" in prop["description"]
    assert "y:" not in prop["description"]


def test_choice_value_for_known_and_unknown():
    c = Choice([Option("alias", "real")])
    assert c.value_for("alias") == "real"
    assert c.value_for("missing") == "missing"


def test_resolve_spec_preset_applied_by_default():
    axes = {
        **_AXES,
        "presets": {"g": Preset(instructions="help")},
        "default_preset": "g",
    }
    spec = _resolve_spec({"task": "x"}, **axes)
    assert spec == AgentSpec(
        agent_type="g",
        instructions="help",
        tools=["read", "shell"],
    )


def test_resolve_spec_unknown_agent_type_raises():
    axes = {**_AXES, "presets": {"g": Preset()}, "default_preset": "g"}
    with pytest.raises(ValueError, match="Unknown agent_type"):
        _resolve_spec({"task": "x", "agent_type": "nope"}, **axes)


def test_resolve_spec_agent_type_rejects_prototype_keys_null_and_non_strings():
    axes = {**_AXES, "presets": {"g": Preset()}, "default_preset": "g"}
    for bad in ["constructor", "toString", "__proto__", ["g"]]:
        with pytest.raises(ValueError, match="Unknown agent_type"):
            _resolve_spec({"task": "x", "agent_type": bad}, **axes)
    # null (None) falls back to default preset instead of throwing
    spec = _resolve_spec({"task": "x", "agent_type": None}, **axes)
    assert spec == AgentSpec(
        agent_type="g",
        tools=["read", "shell"],
    )


def test_resolve_spec_ad_hoc_instructions_suppress_default_preset():
    axes = {**_AXES, "presets": {"g": Preset(instructions="default")}, "default_preset": "g"}
    spec = _resolve_spec({"task": "x", "instructions": "ad-hoc"}, **axes)
    assert spec == AgentSpec(
        instructions="ad-hoc",
        tools=["read", "shell"],
    )


def test_resolve_spec_tools_clamped_to_choice():
    spec = _resolve_spec({"task": "x", "tools": ["read", "write"]}, **_AXES)
    assert spec == AgentSpec(tools=["read"])


def test_resolve_spec_fixed_ignores_model_value():
    axes = {**_AXES, "instructions": Fixed("pinned")}
    spec = _resolve_spec({"task": "x", "instructions": "override"}, **axes)
    assert spec == AgentSpec(
        instructions="pinned",
        tools=["read", "shell"],
    )


def test_resolve_spec_choice_maps_option_value():
    sentinel = object()
    axes = {**_AXES, "model": Choice([Option("smart", sentinel)])}
    spec = _resolve_spec({"task": "x", "model": "smart"}, **axes)
    assert spec.model is sentinel


def test_default_builder_inherits_all_tools_when_spec_tools_is_none():
    @tool
    def read_tool():
        """Read."""

    @tool
    def write_tool():
        """Write."""

    parent = Agent(tools=[read_tool, write_tool])
    child = _default_builder(parent)(AgentSpec())
    assert "read_tool" in child.tool_registry.registry
    assert "write_tool" in child.tool_registry.registry


def test_default_builder_resolves_tools_and_inherits_model():
    @tool
    def read_tool():
        """Read."""

    @tool
    def write_tool():
        """Write."""

    parent = Agent(tools=[read_tool, write_tool])
    child = _default_builder(parent)(AgentSpec(tools=["read_tool"]))
    assert "read_tool" in child.tool_registry.registry
    assert "write_tool" not in child.tool_registry.registry
    assert child.model is parent.model


def test_fixed_is_frozen():
    with pytest.raises(AttributeError):
        Fixed("x").value = "y"


def test_resolve_spec_preset_tools_clamped_to_choice():
    """Covers _resolve_list preset-with-allowed-values branch."""
    axes = {
        **_AXES,
        "presets": {"worker": Preset(tools=["read", "write"])},
        "default_preset": "worker",
        "tools": Choice(["read", "shell"], multiple=True),
    }
    spec = _resolve_spec({"task": "x"}, **axes)
    assert spec == AgentSpec(
        agent_type="worker",
        tools=["read"],
    )


def test_resolve_spec_fixed_tools_list():
    """Covers _resolve_list Fixed-list branch."""
    axes = {**_AXES, "tools": Fixed(["a", "b"])}
    spec = _resolve_spec({"task": "x"}, **axes)
    assert spec == AgentSpec(
        tools=["a", "b"],
    )


def test_resolve_spec_fixed_empty_list_is_not_none():
    """Fixed([]) must resolve to [] (no tools), not None (inherit all)."""
    axes = {**_AXES, "mcp_servers": Fixed([])}
    spec = _resolve_spec({"task": "x"}, **axes)
    assert spec == AgentSpec(
        mcp_servers=[],
        tools=["read", "shell"],
    )
