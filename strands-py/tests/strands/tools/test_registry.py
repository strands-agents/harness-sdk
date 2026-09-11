"""
Tests for the SDK tool registry module.
"""

import copy
import json
import logging
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

import strands
from strands.tools import PythonAgentTool, ToolProvider
from strands.tools.decorator import DecoratedFunctionTool, tool
from strands.tools.loader import _TOOL_MODULE_PREFIX
from strands.tools.mcp import MCPClient
from strands.tools.registry import ToolRegistry
from strands.tools.tools import normalize_tool_spec


@pytest.fixture(autouse=True)
def _restore_sys_state():
    """Snapshot and restore sys.modules keys and sys.path entries introduced by a test.

    Loading directory tools mutates global state: the tool module lands in sys.modules under
    its namespaced key, sibling imports land under their own bare names (a known limitation),
    and the tool directory is briefly added to sys.path. Restoring this state keeps the tests
    order-independent.
    """
    original_modules = dict(sys.modules)
    original_path = list(sys.path)
    try:
        yield
    finally:
        for key in set(sys.modules) - set(original_modules):
            del sys.modules[key]
        for key, value in original_modules.items():
            sys.modules[key] = value
        sys.path[:] = original_path


@pytest.mark.filterwarnings("ignore:load_tool_from_filepath is deprecated:DeprecationWarning")
def test_load_tool_from_filepath_failure():
    """Test error handling when load_tool fails."""
    tool_registry = ToolRegistry()
    error_message = "Failed to load tool failing_tool: Tool file not found: /path/to/failing_tool.py"

    with pytest.raises(ValueError, match=error_message):
        tool_registry.load_tool_from_filepath("failing_tool", "/path/to/failing_tool.py")


def test_process_tools_with_invalid_path():
    """Test that process_tools raises an exception when a non-path string is passed."""
    tool_registry = ToolRegistry()
    invalid_path = "not a filepath"

    with pytest.raises(
        ValueError,
        match=f'Failed to load tool {invalid_path}: Tool string: "{invalid_path}" is not a valid tool string',
    ):
        tool_registry.process_tools([invalid_path])


def test_register_tool_with_similar_name_raises():
    tool_1 = PythonAgentTool(tool_name="tool-like-this", tool_spec=MagicMock(), tool_func=lambda: None)
    tool_2 = PythonAgentTool(tool_name="tool_like_this", tool_spec=MagicMock(), tool_func=lambda: None)

    tool_registry = ToolRegistry()

    tool_registry.register_tool(tool_1)

    with pytest.raises(ValueError) as err:
        tool_registry.register_tool(tool_2)

    assert (
        str(err.value) == "Tool name 'tool_like_this' already exists as 'tool-like-this'. "
        "Cannot add a duplicate tool which differs by a '-' or '_'"
    )


def test_get_all_tool_specs_returns_right_tool_specs():
    tool_1 = strands.tool(lambda a: a, name="tool_1")
    tool_2 = strands.tool(lambda b: b, name="tool_2")
    # Deep copy: tool_1.tool_spec is checked for mutation below, so the snapshot must not
    # share any nested dict with it (a shallow .copy() would, and could hide a regression).
    raw_tool_1_spec = copy.deepcopy(tool_1.tool_spec)
    raw_tool_2_spec = copy.deepcopy(tool_2.tool_spec)

    tool_registry = ToolRegistry()

    tool_registry.register_tool(tool_1)
    tool_registry.register_tool(tool_2)

    tool_specs = tool_registry.get_all_tool_specs()

    # Compared against the normalized form (get_all_tool_specs fills in defaults); the
    # tool's own tool_spec must stay untouched (#3910).
    assert tool_specs == [
        normalize_tool_spec(raw_tool_1_spec),
        normalize_tool_spec(raw_tool_2_spec),
    ]
    assert tool_1.tool_spec == raw_tool_1_spec
    assert tool_2.tool_spec == raw_tool_2_spec


def test_scan_module_for_tools():
    @tool
    def tool_function_1(a):
        return a

    @tool
    def tool_function_2(b):
        return b

    def tool_function_3(c):
        return c

    def tool_function_4(d):
        return d

    tool_function_4.tool_spec = "invalid"

    mock_module = MagicMock()
    mock_module.tool_function_1 = tool_function_1
    mock_module.tool_function_2 = tool_function_2
    mock_module.tool_function_3 = tool_function_3
    mock_module.tool_function_4 = tool_function_4

    tool_registry = ToolRegistry()

    tools = tool_registry._scan_module_for_tools(mock_module)

    assert len(tools) == 2
    assert all(isinstance(tool, DecoratedFunctionTool) for tool in tools)


def test_process_tools_flattens_lists_and_tuples_and_sets():
    def function() -> str:
        return "done"

    tool_a = tool(name="tool_a")(function)
    tool_b = tool(name="tool_b")(function)
    tool_c = tool(name="tool_c")(function)
    tool_d = tool(name="tool_d")(function)
    tool_e = tool(name="tool_e")(function)
    tool_f = tool(name="tool_f")(function)

    registry = ToolRegistry()

    all_tools = [tool_a, (tool_b, tool_c), [{tool_d, tool_e}, [tool_f]]]

    tru_tool_names = sorted(registry.process_tools(all_tools))
    exp_tool_names = [
        "tool_a",
        "tool_b",
        "tool_c",
        "tool_d",
        "tool_e",
        "tool_f",
    ]
    assert tru_tool_names == exp_tool_names


def test_register_tool_duplicate_name_without_hot_reload():
    """Test that registering a tool with duplicate name raises ValueError when hot reload is not supported."""
    # Create mock tools that don't support hot reload
    tool_1 = MagicMock()
    tool_1.tool_name = "duplicate_tool"
    tool_1.supports_hot_reload = False
    tool_1.is_dynamic = False

    tool_2 = MagicMock()
    tool_2.tool_name = "duplicate_tool"
    tool_2.supports_hot_reload = False
    tool_2.is_dynamic = False

    tool_registry = ToolRegistry()
    tool_registry.register_tool(tool_1)

    with pytest.raises(
        ValueError, match="Tool name 'duplicate_tool' already exists. Cannot register tools with exact same name."
    ):
        tool_registry.register_tool(tool_2)


def test_register_tool_duplicate_name_with_hot_reload():
    """Test that registering a tool with duplicate name succeeds when hot reload is supported."""
    # Create mock tools with hot reload support
    tool_1 = MagicMock(spec=PythonAgentTool)
    tool_1.tool_name = "hot_reload_tool"
    tool_1.supports_hot_reload = True
    tool_1.is_dynamic = False

    tool_2 = MagicMock(spec=PythonAgentTool)
    tool_2.tool_name = "hot_reload_tool"
    tool_2.supports_hot_reload = True
    tool_2.is_dynamic = False

    tool_registry = ToolRegistry()
    tool_registry.register_tool(tool_1)

    tool_registry.register_tool(tool_2)

    # Verify the second tool replaced the first
    assert tool_registry.registry["hot_reload_tool"] == tool_2


def test_register_strands_tools_from_module():
    tool_registry = ToolRegistry()
    tool_registry.process_tools(["tests.fixtures.say_tool"])

    assert len(tool_registry.registry) == 2
    assert "say" in tool_registry.registry
    assert "dont_say" in tool_registry.registry


def test_register_strands_tools_specific_tool_from_module():
    tool_registry = ToolRegistry()
    tool_registry.process_tools(["tests.fixtures.say_tool:say"])

    assert len(tool_registry.registry) == 1
    assert "say" in tool_registry.registry
    assert "dont_say" not in tool_registry.registry


def test_register_strands_tools_specific_tool_from_module_tool_missing():
    tool_registry = ToolRegistry()

    with pytest.raises(ValueError, match="Failed to load tool tests.fixtures.say_tool:nay: "):
        tool_registry.process_tools(["tests.fixtures.say_tool:nay"])


def test_register_strands_tools_specific_tool_from_module_not_a_tool():
    tool_registry = ToolRegistry()

    with pytest.raises(ValueError, match="Failed to load tool tests.fixtures.say_tool:not_a_tool: "):
        tool_registry.process_tools(["tests.fixtures.say_tool:not_a_tool"])


def test_register_strands_tools_with_dict():
    tool_registry = ToolRegistry()
    tool_registry.process_tools([{"path": "tests.fixtures.say_tool"}])

    assert len(tool_registry.registry) == 2
    assert "say" in tool_registry.registry
    assert "dont_say" in tool_registry.registry


def test_register_strands_tools_specific_tool_with_dict():
    tool_registry = ToolRegistry()
    tool_registry.process_tools([{"path": "tests.fixtures.say_tool", "name": "say"}])

    assert len(tool_registry.registry) == 1
    assert "say" in tool_registry.registry


def test_register_strands_tools_specific_tool_with_dict_not_found():
    tool_registry = ToolRegistry()

    with pytest.raises(
        ValueError,
        match="Failed to load tool {'path': 'tests.fixtures.say_tool'"
        ", 'name': 'nay'}: Tool \"nay\" not found in \"tests.fixtures.say_tool\"",
    ):
        tool_registry.process_tools([{"path": "tests.fixtures.say_tool", "name": "nay"}])


def test_register_strands_tools_module_no_spec():
    tool_registry = ToolRegistry()

    with pytest.raises(
        ValueError,
        match="Failed to load tool tests.fixtures.mocked_model_provider: "
        "The module mocked_model_provider is not a valid module",
    ):
        tool_registry.process_tools(["tests.fixtures.mocked_model_provider"])


def test_register_strands_tools_module_no_function():
    tool_registry = ToolRegistry()

    with pytest.raises(
        ValueError,
        match="Failed to load tool tests.fixtures.tool_with_spec_but_no_function: "
        "Module-based tool tool_with_spec_but_no_function missing function tool_with_spec_but_no_function",
    ):
        tool_registry.process_tools(["tests.fixtures.tool_with_spec_but_no_function"])


def test_register_strands_tools_module_non_callable_function():
    tool_registry = ToolRegistry()

    with pytest.raises(
        ValueError,
        match="Failed to load tool tests.fixtures.tool_with_spec_but_non_callable_function:"
        " Tool tool_with_spec_but_non_callable_function function is not callable",
    ):
        tool_registry.process_tools(["tests.fixtures.tool_with_spec_but_non_callable_function"])


def test_tool_registry_cleanup_with_mcp_client():
    """Test that ToolRegistry cleanup properly handles MCP clients without orphaning threads."""
    # Create a mock MCP client that simulates a real tool provider
    mock_transport = MagicMock()
    mock_client = MCPClient(mock_transport)

    # Mock the client to avoid actual network operations
    mock_client.load_tools = AsyncMock(return_value=[])

    registry = ToolRegistry()

    # Use process_tools to properly register the client
    registry.process_tools([mock_client])

    # Verify the client was registered as a consumer
    assert registry._registry_id in mock_client._consumers

    # Test cleanup calls remove_consumer
    registry.cleanup()

    # Verify cleanup was attempted
    assert registry._registry_id not in mock_client._consumers


def test_tool_registry_cleanup_exception_handling():
    """Test that ToolRegistry cleanup attempts all providers even if some fail."""
    # Create mock providers - one that fails, one that succeeds
    failing_provider = MagicMock()
    failing_provider.remove_consumer.side_effect = Exception("Cleanup failed")

    working_provider = MagicMock()

    registry = ToolRegistry()
    registry._tool_providers = [failing_provider, working_provider]

    # Cleanup should attempt both providers and raise the first exception
    with pytest.raises(Exception, match="Cleanup failed"):
        registry.cleanup()

    # Verify both providers were attempted
    failing_provider.remove_consumer.assert_called_once()
    working_provider.remove_consumer.assert_called_once()


def test_tool_registry_cleanup_idempotent():
    """Test that ToolRegistry cleanup is idempotent."""
    provider = MagicMock(spec=ToolProvider)
    provider.load_tools = AsyncMock(return_value=[])

    registry = ToolRegistry()

    # Use process_tools to properly register the provider
    registry.process_tools([provider])

    # First cleanup should call remove_consumer
    registry.cleanup()
    provider.remove_consumer.assert_called_once_with(registry._registry_id)

    # Reset mock call count
    provider.remove_consumer.reset_mock()

    # Second cleanup should call remove_consumer again (not idempotent yet)
    # This test documents current behavior - registry cleanup is not idempotent
    registry.cleanup()
    provider.remove_consumer.assert_called_once_with(registry._registry_id)


def test_tool_registry_process_tools_exception_after_add_consumer():
    """Test that tool provider is still tracked for cleanup even if load_tools fails."""
    # Create a mock tool provider that fails during load_tools
    mock_provider = MagicMock(spec=ToolProvider)
    mock_provider.add_consumer = MagicMock()
    mock_provider.remove_consumer = MagicMock()

    async def failing_load_tools():
        raise Exception("Failed to load tools")

    mock_provider.load_tools = AsyncMock(side_effect=failing_load_tools)

    registry = ToolRegistry()

    # Processing should fail but provider should still be tracked
    with pytest.raises(ValueError, match="Failed to load tool"):
        registry.process_tools([mock_provider])

    # Verify provider was added to registry for cleanup tracking
    assert mock_provider in registry._tool_providers

    # Verify add_consumer was called before the failure
    mock_provider.add_consumer.assert_called_once_with(registry._registry_id)

    # Cleanup should still work
    registry.cleanup()
    mock_provider.remove_consumer.assert_called_once_with(registry._registry_id)


def test_tool_registry_add_consumer_before_load_tools():
    """Test that add_consumer is called before load_tools to ensure cleanup tracking."""
    # Create a mock tool provider that tracks call order
    mock_provider = MagicMock(spec=ToolProvider)
    call_order = []

    def track_add_consumer(*args, **kwargs):
        call_order.append("add_consumer")

    async def track_load_tools(*args, **kwargs):
        call_order.append("load_tools")
        return []

    mock_provider.add_consumer.side_effect = track_add_consumer
    mock_provider.load_tools = AsyncMock(side_effect=track_load_tools)

    registry = ToolRegistry()

    # Process the tool provider
    registry.process_tools([mock_provider])

    # Verify add_consumer was called before load_tools
    assert call_order == ["add_consumer", "load_tools"]

    # Verify the provider was added to the registry for cleanup
    assert mock_provider in registry._tool_providers

    # Verify add_consumer was called with the registry ID
    mock_provider.add_consumer.assert_called_once_with(registry._registry_id)


def test_validate_tool_spec_with_anyof_property():
    """Test that validate_tool_spec does not add type: 'string' to anyOf properties.

    This is important for MCP tools that use anyOf for optional/union types like
    Optional[List[str]]. Adding type: 'string' causes models to return string-encoded
    JSON instead of proper arrays/objects.
    """
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "regular_field": {},  # Should get type: "string"
                    "anyof_field": {
                        "anyOf": [
                            {"type": "array", "items": {"type": "string"}},
                            {"type": "null"},
                        ]
                    },
                },
            }
        },
    }

    registry = ToolRegistry()
    registry.validate_tool_spec(tool_spec)

    props = tool_spec["inputSchema"]["json"]["properties"]

    # Regular field should get default type: "string"
    assert props["regular_field"]["type"] == "string"
    assert props["regular_field"]["description"] == "Property regular_field"

    # anyOf field should NOT get type: "string" added
    assert "type" not in props["anyof_field"], "anyOf property should not have type added"
    assert "anyOf" in props["anyof_field"], "anyOf should be preserved"
    assert props["anyof_field"]["description"] == "Property anyof_field"


def test_validate_tool_spec_with_composition_keywords():
    """Test that validate_tool_spec does not add type: 'string' to composition keyword properties.

    JSON Schema composition keywords (anyOf, oneOf, allOf, not) define type constraints.
    Properties using these should not get a default type added.
    """
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "regular_field": {},  # Should get type: "string"
                    "oneof_field": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "integer"},
                        ]
                    },
                    "allof_field": {
                        "allOf": [
                            {"minimum": 0},
                            {"maximum": 100},
                        ]
                    },
                    "not_field": {"not": {"type": "null"}},
                },
            }
        },
    }

    registry = ToolRegistry()
    registry.validate_tool_spec(tool_spec)

    props = tool_spec["inputSchema"]["json"]["properties"]

    # Regular field should get default type: "string"
    assert props["regular_field"]["type"] == "string"

    # Composition keyword fields should NOT get type: "string" added
    assert "type" not in props["oneof_field"], "oneOf property should not have type added"
    assert "oneOf" in props["oneof_field"], "oneOf should be preserved"

    assert "type" not in props["allof_field"], "allOf property should not have type added"
    assert "allOf" in props["allof_field"], "allOf should be preserved"

    assert "type" not in props["not_field"], "not property should not have type added"
    assert "not" in props["not_field"], "not should be preserved"

    # All should have descriptions
    for field in ["oneof_field", "allof_field", "not_field"]:
        assert props[field]["description"] == f"Property {field}"


def test_validate_tool_spec_with_ref_property():
    """Test that validate_tool_spec does not modify $ref properties."""
    tool_spec = {
        "name": "test_tool",
        "description": "A test tool",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "ref_field": {"$ref": "#/$defs/SomeType"},
                },
            }
        },
    }

    registry = ToolRegistry()
    registry.validate_tool_spec(tool_spec)

    props = tool_spec["inputSchema"]["json"]["properties"]

    # $ref field should not be modified
    assert props["ref_field"] == {"$ref": "#/$defs/SomeType"}
    assert "type" not in props["ref_field"]
    assert "description" not in props["ref_field"]


def test_tool_registry_replace_existing_tool():
    """Test replacing an existing tool."""
    old_tool = MagicMock()
    old_tool.tool_name = "my_tool"
    old_tool.is_dynamic = False
    old_tool.supports_hot_reload = False

    new_tool = MagicMock()
    new_tool.tool_name = "my_tool"
    new_tool.is_dynamic = False

    registry = ToolRegistry()
    registry.register_tool(old_tool)
    registry.replace(new_tool)

    assert registry.registry["my_tool"] == new_tool


def test_tool_registry_replace_nonexistent_tool():
    """Test replacing a tool that doesn't exist raises ValueError."""
    new_tool = MagicMock()
    new_tool.tool_name = "my_tool"

    registry = ToolRegistry()

    with pytest.raises(ValueError, match="Cannot replace tool 'my_tool' - tool does not exist"):
        registry.replace(new_tool)


def test_tool_registry_replace_dynamic_tool():
    """Test replacing a dynamic tool updates both registries."""
    old_tool = MagicMock()
    old_tool.tool_name = "dynamic_tool"
    old_tool.is_dynamic = True
    old_tool.supports_hot_reload = True

    new_tool = MagicMock()
    new_tool.tool_name = "dynamic_tool"
    new_tool.is_dynamic = True

    registry = ToolRegistry()
    registry.register_tool(old_tool)
    registry.replace(new_tool)

    assert registry.registry["dynamic_tool"] == new_tool
    assert registry.dynamic_tools["dynamic_tool"] == new_tool


def test_tool_registry_replace_dynamic_with_non_dynamic():
    """Test replacing a dynamic tool with non-dynamic tool removes from dynamic_tools."""
    old_tool = MagicMock()
    old_tool.tool_name = "my_tool"
    old_tool.is_dynamic = True
    old_tool.supports_hot_reload = True

    new_tool = MagicMock()
    new_tool.tool_name = "my_tool"
    new_tool.is_dynamic = False

    registry = ToolRegistry()
    registry.register_tool(old_tool)

    assert "my_tool" in registry.dynamic_tools

    registry.replace(new_tool)

    assert registry.registry["my_tool"] == new_tool
    assert "my_tool" not in registry.dynamic_tools


def test_tool_registry_replace_non_dynamic_with_dynamic():
    """Test replacing a non-dynamic tool with dynamic tool adds to dynamic_tools."""
    old_tool = MagicMock()
    old_tool.tool_name = "my_tool"
    old_tool.is_dynamic = False
    old_tool.supports_hot_reload = False

    new_tool = MagicMock()
    new_tool.tool_name = "my_tool"
    new_tool.is_dynamic = True

    registry = ToolRegistry()
    registry.register_tool(old_tool)

    assert "my_tool" not in registry.dynamic_tools

    registry.replace(new_tool)

    assert registry.registry["my_tool"] == new_tool
    assert registry.dynamic_tools["my_tool"] == new_tool


# --- Agent-as-tool sugar ---


def test_process_tools_with_agent_instance():
    """Test that passing an Agent instance in tools list auto-wraps it with as_tool()."""
    from strands.agent.agent import Agent

    sub_agent = Agent(name="research_agent", description="Finds information", callback_handler=None)

    registry = ToolRegistry()
    tool_names = registry.process_tools([sub_agent])

    assert "research_agent" in tool_names
    assert "research_agent" in registry.registry
    assert registry.registry["research_agent"].tool_type == "agent"


def test_process_tools_with_agent_instance_uses_agent_name():
    """Test that the auto-wrapped tool uses the agent's name."""
    from strands.agent.agent import Agent

    sub_agent = Agent(name="my_custom_agent", callback_handler=None)

    registry = ToolRegistry()
    registry.process_tools([sub_agent])

    assert "my_custom_agent" in registry.registry
    spec = registry.registry["my_custom_agent"].tool_spec
    assert spec["name"] == "my_custom_agent"


def test_process_tools_with_agent_instance_uses_agent_description():
    """Test that the auto-wrapped tool uses the agent's description."""
    from strands.agent.agent import Agent

    sub_agent = Agent(name="helper", description="A helpful assistant", callback_handler=None)

    registry = ToolRegistry()
    registry.process_tools([sub_agent])

    spec = registry.registry["helper"].tool_spec
    assert spec["description"] == "A helpful assistant"


def test_process_tools_with_agent_in_nested_list():
    """Test that Agent instances in nested iterables are auto-wrapped."""
    from strands.agent.agent import Agent

    agent_a = Agent(name="agent_a", callback_handler=None)
    agent_b = Agent(name="agent_b", callback_handler=None)

    registry = ToolRegistry()
    tool_names = sorted(registry.process_tools([[agent_a, agent_b]]))

    assert tool_names == ["agent_a", "agent_b"]


def test_process_tools_with_mixed_agents_and_tools():
    """Test that Agent instances can be mixed with regular tools."""
    from strands.agent.agent import Agent

    def function() -> str:
        return "done"

    regular_tool = tool(name="regular_tool")(function)
    sub_agent = Agent(name="sub_agent", callback_handler=None)

    registry = ToolRegistry()
    tool_names = sorted(registry.process_tools([regular_tool, sub_agent]))

    assert tool_names == ["regular_tool", "sub_agent"]
    assert registry.registry["sub_agent"].tool_type == "agent"


def test_process_tools_with_multiple_agents():
    """Test that multiple Agent instances can be passed."""
    from strands.agent.agent import Agent

    agent_1 = Agent(name="researcher", description="Does research", callback_handler=None)
    agent_2 = Agent(name="writer", description="Writes content", callback_handler=None)
    agent_3 = Agent(name="reviewer", description="Reviews work", callback_handler=None)

    registry = ToolRegistry()
    tool_names = sorted(registry.process_tools([agent_1, agent_2, agent_3]))

    assert tool_names == ["researcher", "reviewer", "writer"]
    assert all(registry.registry[name].tool_type == "agent" for name in tool_names)


def test_get_all_tools_config_skips_tool_with_too_deeply_nested_schema(caplog):
    """A tool with a pathologically deep inputSchema is skipped without taking down the others."""
    deep_schema = {"type": "object", "properties": {"value": {"type": "string"}}}
    for _ in range(100):
        deep_schema = {"type": "object", "properties": {"child": deep_schema}}

    hostile_tool = PythonAgentTool(
        tool_name="hostile_tool",
        tool_spec={
            "name": "hostile_tool",
            "description": "tool with a deeply nested inputSchema",
            "inputSchema": {"json": deep_schema},
        },
        tool_func=lambda: None,
    )
    valid_tool = strands.tool(lambda a: a, name="valid_tool")

    tool_registry = ToolRegistry()
    tool_registry.register_tool(hostile_tool)
    tool_registry.register_tool(valid_tool)

    with caplog.at_level(logging.WARNING):
        tool_config = tool_registry.get_all_tools_config()

    assert "hostile_tool" not in tool_config
    assert "valid_tool" in tool_config
    assert "hostile_tool" in caplog.text


_STDLIB_TOOL_SOURCE = """
TOOL_SPEC = {
    "name": "json",
    "description": "a tool whose name collides with a stdlib module",
    "inputSchema": {"json": {"type": "object", "properties": {}, "required": []}},
}


def json(tool, **kwargs):
    return {"status": "success", "content": [{"text": "ok"}]}
"""


def _write_stdlib_named_tool(tmp_path):
    """Write a tool file named after a stdlib module and return its directory."""
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    (tools_dir / "json.py").write_text(_STDLIB_TOOL_SOURCE)
    return tools_dir


def test_reload_tool_does_not_clobber_stdlib_module(tmp_path, monkeypatch):
    """Reloading a tool named "json" must not replace the stdlib json module in sys.modules.

    Guards against a sys.modules collision: dynamically loaded tool
    modules are registered under a namespaced key, leaving imported modules untouched.
    """
    tools_dir = _write_stdlib_named_tool(tmp_path)
    monkeypatch.setattr(ToolRegistry, "get_tools_dirs", lambda self: [tools_dir])

    tool_registry = ToolRegistry()
    tool_registry.reload_tool("json")

    assert tool_registry.registry["json"].tool_name == "json"
    assert sys.modules["json"] is json
    assert sys.modules["json"].dumps({"a": 1}) == '{"a": 1}'
    assert f"{_TOOL_MODULE_PREFIX}json" in sys.modules


_SIBLING_MODULE_SOURCE = """
GREETING = "hello from sibling"
"""

_SIBLING_TOOL_SOURCE = """
import sibling_helper

TOOL_SPEC = {
    "name": "needs_sibling",
    "description": "a tool that imports a sibling module from its own directory",
    "inputSchema": {"json": {"type": "object", "properties": {}, "required": []}},
}


def needs_sibling(tool, **kwargs):
    return {"status": "success", "content": [{"text": sibling_helper.GREETING}]}
"""


def _write_sibling_importing_tool(tmp_path):
    """Write a tool that imports a sibling module from the same directory and return its directory."""
    tools_dir = tmp_path / "tools"
    tools_dir.mkdir()
    (tools_dir / "sibling_helper.py").write_text(_SIBLING_MODULE_SOURCE)
    (tools_dir / "needs_sibling.py").write_text(_SIBLING_TOOL_SOURCE)
    return tools_dir


def test_reload_tool_supports_sibling_imports(tmp_path, monkeypatch):
    """Reloading a tool must let it import a sibling module from its own directory.

    Guards against a regression where a directory tool doing a top-level
    ``import <sibling>`` failed: the tool directory is on sys.path while the module executes.
    """
    tools_dir = _write_sibling_importing_tool(tmp_path)
    monkeypatch.setattr(ToolRegistry, "get_tools_dirs", lambda self: [tools_dir])

    tool_registry = ToolRegistry()
    tool_registry.reload_tool("needs_sibling")

    assert tool_registry.registry["needs_sibling"].tool_name == "needs_sibling"
    assert str(tools_dir) not in sys.path


def test_initialize_tools_supports_sibling_imports(tmp_path, monkeypatch):
    """Initializing tools from a directory must let a tool import a sibling module.

    Guards against the same regression for the directory-load path.
    """
    tools_dir = _write_sibling_importing_tool(tmp_path)
    monkeypatch.setattr(ToolRegistry, "get_tools_dirs", lambda self: [tools_dir])

    tool_registry = ToolRegistry()
    tool_registry.initialize_tools(load_tools_from_directory=True)

    assert tool_registry.registry["needs_sibling"].tool_name == "needs_sibling"
    assert str(tools_dir) not in sys.path


def test_initialize_tools_does_not_clobber_stdlib_module(tmp_path, monkeypatch):
    """Initializing tools from a directory must not replace the stdlib json module in sys.modules.

    Guards against the same sys.modules collision for the directory-load path.
    """
    tools_dir = _write_stdlib_named_tool(tmp_path)
    monkeypatch.setattr(ToolRegistry, "get_tools_dirs", lambda self: [tools_dir])

    tool_registry = ToolRegistry()
    tool_registry.initialize_tools(load_tools_from_directory=True)

    assert tool_registry.registry["json"].tool_name == "json"
    assert sys.modules["json"] is json
    assert sys.modules["json"].dumps({"a": 1}) == '{"a": 1}'
    assert f"{_TOOL_MODULE_PREFIX}json" in sys.modules
