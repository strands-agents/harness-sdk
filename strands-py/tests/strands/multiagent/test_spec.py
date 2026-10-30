"""Tests for multiagent spec resolution: axis types, _resolve_specs, and _default_builder."""

from unittest.mock import MagicMock

import pytest
from mcp.types import Tool as MCPTool

from strands import Agent
from strands.interventions.actions import Deny
from strands.interventions.handler import InterventionHandler
from strands.multiagent.spec import (
    _AXIS_DESCRIPTIONS,
    _UNSET,
    AgentSpec,
    Choice,
    Fixed,
    Inherit,
    Open,
    Option,
    Preset,
    _default_builder,
    _resolve_specs,
    _to_schema_properties,
)
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.tools.decorator import tool
from strands.tools.mcp import MCPAgentTool, MCPClient
from tests.fixtures.mocked_model_provider import MockedModelProvider


def _resolve_one(model_input, **kwargs):
    [spec] = _resolve_specs([{"name": "a", **model_input}], **kwargs)
    return spec


_AXES = dict(
    presets={},
    default_preset=None,
    instructions=Open(),
    tools=Choice(["read", "shell"], multiple=True),
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


def test_to_schema_properties():
    d = _AXIS_DESCRIPTIONS
    props = _to_schema_properties(
        presets={"g": Preset(description="general")},
        default_preset="g",
        instructions=Open(),
        tools=Choice(["a"], multiple=True),
        model=Fixed("x"),
    )
    assert props == {
        "agent_type": {
            "type": "string",
            "enum": ["g"],
            "description": f"{d['agent_type']} Omit to use the default ('g').\nOptions:\n- g: general",
        },
        "instructions": {"type": "string", "description": d["instructions"]},
        "tools": {"type": "array", "items": {"type": "string", "enum": ["a"]}, "description": d["tools"]},
    }
    # No presets → no agent_type; None axes are hidden.
    empty = {k: None for k in ("instructions", "tools", "model")}
    assert _to_schema_properties(presets={}, default_preset=None, **empty) == {}


@pytest.mark.parametrize(
    "axis,match",
    [
        ({"tools": Choice([])}, "offers no options"),
        ({"tools": Choice(["read", "shell"])}, "must be multiple"),
        ({"instructions": Choice([])}, "offers no options"),
        ({"model": Choice([])}, "offers no options"),
    ],
)
def test_invalid_choice_raises(axis, match):
    with pytest.raises(ValueError, match=match):
        _to_schema_properties(**{**_AXES, **axis})


def test_choice_value_for_known_and_unknown():
    c = Choice([Option("alias", "real")])
    assert c.value_for("alias") == "real"
    assert c.value_for("missing") == "missing"


def test_resolve_spec_preset_applied_by_default():
    axes = {**_AXES, "presets": {"g": Preset(instructions="help")}, "default_preset": "g"}
    spec = _resolve_one({"task": "x"}, **axes)
    assert spec == AgentSpec(name="a", agent_type="g", instructions="help", tools=["read", "shell"])


def test_resolve_spec_unknown_agent_type_raises():
    axes = {**_AXES, "presets": {"g": Preset()}, "default_preset": "g"}
    with pytest.raises(ValueError, match="Unknown agent_type"):
        _resolve_one({"task": "x", "agent_type": "nope"}, **axes)


def test_resolve_spec_agent_type_rejects_prototype_keys_null_and_non_strings():
    axes = {**_AXES, "presets": {"g": Preset()}, "default_preset": "g"}
    for bad in ["constructor", "toString", "__proto__", ["g"]]:
        with pytest.raises(ValueError, match="Unknown agent_type"):
            _resolve_one({"task": "x", "agent_type": bad}, **axes)
    # null (None) falls back to default preset instead of throwing
    spec = _resolve_one({"task": "x", "agent_type": None}, **axes)
    assert spec == AgentSpec(
        name="a",
        agent_type="g",
        tools=["read", "shell"],
    )


def test_resolve_spec_ad_hoc_instructions_suppress_default_preset():
    axes = {**_AXES, "presets": {"g": Preset()}, "default_preset": "g"}
    spec = _resolve_one({"task": "x", "instructions": "ad-hoc"}, **axes)
    assert spec == AgentSpec(
        name="a",
        instructions="ad-hoc",
        tools=["read", "shell"],
    )


def test_resolve_spec_tools_clamped_to_choice():
    spec = _resolve_one({"task": "x", "tools": ["read", "write"]}, **_AXES)
    assert spec == AgentSpec(name="a", tools=["read"])


def test_resolve_spec_fixed_ignores_model_value():
    axes = {**_AXES, "instructions": Fixed("pinned")}
    spec = _resolve_one({"task": "x", "instructions": "override"}, **axes)
    assert spec == AgentSpec(
        name="a",
        instructions="pinned",
        tools=["read", "shell"],
    )


def test_resolve_spec_choice_maps_option_value():
    sentinel = object()
    axes = {**_AXES, "model": Choice([Option("smart", sentinel)])}
    spec = _resolve_one({"task": "x", "model": "smart"}, **axes)
    assert spec.model is sentinel


@pytest.mark.parametrize(
    "inputs,match",
    [
        ("abc", "must be a list"),
        (["not a dict"], "must be a dict"),
        ([{}], "non-empty 'name'"),
        ([{"name": "  "}], "non-empty 'name'"),
        ([{"name": "a"}, {"name": " a "}], "Duplicate"),
    ],
)
def test_resolve_specs_rejects_invalid_entries(inputs, match):
    with pytest.raises(ValueError, match=match):
        _resolve_specs(inputs, **_AXES)


def test_resolve_specs_preset_reusable_and_clamped_to_choice():
    axes = {**_AXES, "presets": {"w": Preset(tools=["read", "write"])}, "default_preset": "w"}
    specs = _resolve_specs([{"name": "a", "agent_type": "w"}, {"name": " b "}], **axes)
    assert [(s.name, s.agent_type, s.tools) for s in specs] == [("a", "w", ["read"]), ("b", "w", ["read"])]
    # Without a Choice to clamp to, preset tools pass through unchanged.
    assert _resolve_one({}, **{**axes, "tools": Inherit()}).tools == ["read", "write"]


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


def test_default_builder_skips_parent_context_manager_tools():
    class StatefulModel(MockedModelProvider):
        stateful = True

    parent = Agent(model=MockedModelProvider([]), context_manager="auto")
    assert "retrieve_context" in parent.tool_registry.registry

    # A stateful child has no context manager, so it must not inherit the parent's retrieve_context.
    child = _default_builder(parent)(AgentSpec(model=StatefulModel([])))
    assert "retrieve_context" not in child.tool_registry.registry


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


def test_resolve_spec_fixed_tools_list():
    """Covers _resolve_list Fixed-list branch."""
    axes = {**_AXES, "tools": Fixed(["a", "b"])}
    spec = _resolve_one({"task": "x"}, **axes)
    assert spec == AgentSpec(
        name="a",
        tools=["a", "b"],
    )


def test_resolve_spec_fixed_empty_list_is_not_none():
    """Fixed([]) must resolve to [] (no tools), not None (inherit all)."""
    axes = {**_AXES, "tools": Fixed([])}
    spec = _resolve_one({"task": "x"}, **axes)
    assert spec == AgentSpec(name="a", tools=[])


def test_default_builder_propagates_sandbox():
    """Child must inherit the parent's sandbox so tools route through it."""
    sandbox = NotASandboxLocalEnvironment()
    parent = Agent(sandbox=sandbox)
    child = _default_builder(parent)(AgentSpec())
    assert child.sandbox is sandbox


def test_default_builder_propagates_trace_attributes():
    """trace_attributes from the parent appear on the child."""
    parent = Agent(trace_attributes={"team": "infra"})
    child = _default_builder(parent)(AgentSpec())
    assert child.trace_attributes == {"team": "infra"}


def test_default_builder_uses_auto_context_manager():
    """Child must get context_manager='auto' so it has proactive truncation and summarization."""
    parent = Agent()
    child = _default_builder(parent)(AgentSpec())
    assert child.context_manager is not None


def test_default_builder_skips_context_manager_for_stateful_model():
    """Stateful models manage context server-side; context_manager must be None to avoid ValueError."""
    from unittest.mock import MagicMock

    stateful_model = MagicMock()
    stateful_model.stateful = True
    parent = Agent()
    child = _default_builder(parent)(AgentSpec(model=stateful_model))
    assert child.context_manager is None


def test_default_builder_warns_on_unknown_tools(caplog):
    """Requesting tools the parent doesn't own logs a warning and skips them."""
    import logging

    @tool
    def read() -> str:
        """Read a file."""
        return ""

    parent = Agent(tools=[read])
    with caplog.at_level(logging.WARNING, logger="strands.multiagent.spec"):
        child = _default_builder(parent)(AgentSpec(tools=["read", "missing"]))

    assert any("missing" in r.message and "tool" in r.message for r in caplog.records)
    # "read" was found; "missing" was skipped
    child_tool_names = [t.tool_name for t in child.tool_registry.registry.values()]
    assert "read" in child_tool_names
    assert "missing" not in child_tool_names


@pytest.mark.parametrize("tools,expected", [(None, ["read", "gh_issue"]), (["gh_issue"], ["gh_issue"])])
def test_default_builder_selects_mcp_tools_by_name(tools, expected):
    """MCP tools resolve through the tools axis like any other parent tool, sharing the parent's client."""

    @tool
    def read() -> str:
        """Read a file."""
        return ""

    mcp_tool = MCPAgentTool(
        MCPTool(name="gh_issue", description="Open an issue.", inputSchema={"type": "object"}),
        MagicMock(spec=MCPClient),
    )
    parent = Agent(tools=[read, mcp_tool])
    child = _default_builder(parent)(AgentSpec(tools=tools))

    registry = child.tool_registry.registry
    assert [name for name in registry if name in ("read", "gh_issue")] == expected
    assert registry["gh_issue"] is mcp_tool


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(None, id="suppressed"),
        pytest.param(lambda **kw: None, id="custom"),
    ],
)
def test_default_builder_propagates_callback_handler(handler):
    """callback_handler on the parent flows to the child."""
    parent = Agent(callback_handler=handler)
    child = _default_builder(parent)(AgentSpec())
    assert child.callback_handler is parent.callback_handler


class _DenyToolCalls(InterventionHandler):
    name = "deny-tool-calls"

    def before_tool_call(self, event):
        return Deny(reason="not authorized")


def test_default_builder_propagates_interventions():
    """The child shares the parent's intervention handler instances."""
    handler = _DenyToolCalls()
    parent = Agent(interventions=[handler])
    child = _default_builder(parent)(AgentSpec())
    assert child._intervention_registry.handlers == [handler]


def test_default_builder_child_tool_calls_go_through_parent_interventions():
    """A tool the child inherits is gated by the parent's interventions when the child's model calls it."""
    calls = []

    @tool
    def danger_tool() -> str:
        """Do something that requires authorization."""
        calls.append("called")
        return "done"

    child_model = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": "t1", "name": "danger_tool", "input": {}}}],
            },
            {"role": "assistant", "content": [{"text": "finished"}]},
        ]
    )
    parent = Agent(tools=[danger_tool], interventions=[_DenyToolCalls()])
    child = _default_builder(parent)(AgentSpec(model=child_model))

    child("run danger_tool")

    assert calls == []
