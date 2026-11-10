"""
Tests for the function-based tool decorator pattern.
"""

import warnings
from asyncio import Queue
from collections.abc import AsyncGenerator
from typing import Annotated, Any
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel, Field

import strands
from strands import Agent, LocalAgent
from strands.interrupt import Interrupt, _InterruptState
from strands.types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.tools import AgentTool, ToolContext, ToolUse


@pytest.fixture(scope="module")
def identity_invoke():
    @strands.tool
    def identity(a: int):
        return a

    return identity


@pytest.fixture(scope="module")
def identity_invoke_async():
    @strands.tool
    async def identity(a: int):
        return a

    return identity


@pytest.fixture
def identity_tool(request):
    return request.getfixturevalue(request.param)


def test__init__invalid_name():
    with pytest.raises(ValueError, match="Tool name must be a string"):

        @strands.tool(name=0)
        def identity(a):
            return a


def test_tool_func_not_decorated():
    def identity(a: int):
        return a

    tool = strands.tool(func=identity, name="identity")

    tru_name = tool._tool_func.__name__
    exp_name = "identity"

    assert tru_name == exp_name


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_name(identity_tool):
    tru_name = identity_tool.tool_name
    exp_name = "identity"

    assert tru_name == exp_name


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_spec(identity_tool):
    tru_spec = identity_tool.tool_spec
    exp_spec = {
        "name": "identity",
        "description": "identity",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "a": {
                        "description": "Parameter a",
                        "type": "integer",
                    },
                },
                "required": ["a"],
            }
        },
    }
    assert tru_spec == exp_spec


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_tool_type(identity_tool):
    tru_type = identity_tool.tool_type
    exp_type = "function"

    assert tru_type == exp_type


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_supports_hot_reload(identity_tool):
    assert identity_tool.supports_hot_reload


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
def test_get_display_properties(identity_tool):
    tru_properties = identity_tool.get_display_properties()
    exp_properties = {
        "Function": "identity",
        "Name": "identity",
        "Type": "function",
    }

    assert tru_properties == exp_properties


@pytest.mark.parametrize("identity_tool", ["identity_invoke", "identity_invoke_async"], indirect=True)
@pytest.mark.asyncio
async def test_stream(identity_tool, alist):
    stream = identity_tool.stream({"toolUseId": "t1", "input": {"a": 2}}, {})

    tru_events = await alist(stream)
    exp_events = [ToolResultEvent({"toolUseId": "t1", "status": "success", "content": [{"text": "2"}]})]

    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_stream_with_agent(alist):
    @strands.tool
    def identity(a: int, agent: dict = None):
        return a, agent

    stream = identity.stream({"input": {"a": 2}}, {"agent": {"state": 1}})

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "unknown", "status": "success", "content": [{"text": '[2, {"state": 1}]'}]})
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_stream_interrupt(alist):
    interrupt = Interrupt(
        id="v1:tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
    )

    tool_use = {"toolUseId": "test_tool_id"}

    mock_agent = MagicMock()
    mock_agent._interrupt_state = _InterruptState()

    invocation_state = {"agent": mock_agent}

    @strands.tool(context=True)
    def interrupt_tool(tool_context: ToolContext) -> str:
        return tool_context.interrupt("test_name", reason="test reason")

    stream = interrupt_tool.stream(tool_use, invocation_state)

    tru_events = await alist(stream)
    exp_events = [ToolInterruptEvent(tool_use, [interrupt])]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_stream_interrupt_resume(alist):
    interrupt = Interrupt(
        id="v1:tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
        response="test response",
    )

    tool_use = {"toolUseId": "test_tool_id"}

    mock_agent = MagicMock()
    mock_agent._interrupt_state = _InterruptState(interrupts={interrupt.id: interrupt})

    invocation_state = {"agent": mock_agent}

    @strands.tool(context=True)
    def interrupt_tool(tool_context: ToolContext) -> str:
        return tool_context.interrupt("test_name", reason="test reason")

    stream = interrupt_tool.stream(tool_use, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent(
            {
                "toolUseId": "test_tool_id",
                "status": "success",
                "content": [{"text": "test response"}],
            },
        ),
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_basic_tool_creation(alist):
    """Test basic tool decorator functionality."""

    @strands.tool
    def test_tool(param1: str, param2: int) -> str:
        """Test tool function.

        Args:
            param1: First parameter
            param2: Second parameter
        """
        return f"Result: {param1} {param2}"

    # Check TOOL_SPEC was generated correctly
    assert test_tool.tool_spec is not None
    spec = test_tool.tool_spec

    # Check basic spec properties
    assert spec["name"] == "test_tool"
    assert spec["description"] == "Test tool function."

    # Check input schema
    schema = spec["inputSchema"]["json"]
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"param1", "param2"}

    # Check parameter properties
    assert schema["properties"]["param1"]["type"] == "string"
    assert schema["properties"]["param2"]["type"] == "integer"
    assert schema["properties"]["param1"]["description"] == "First parameter"
    assert schema["properties"]["param2"]["description"] == "Second parameter"

    # Test actual usage
    tool_use = {"toolUseId": "test-id", "input": {"param1": "hello", "param2": 42}}
    stream = test_tool.stream(tool_use, {})

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "test-id", "status": "success", "content": [{"text": "Result: hello 42"}]})
    ]
    assert tru_events == exp_events

    # Make sure these are set properly
    assert test_tool.__wrapped__ is not None
    assert test_tool.__doc__ == test_tool._tool_func.__doc__


def test_tool_with_custom_name_description():
    """Test tool decorator with custom name and description."""

    @strands.tool(name="custom_name", description="Custom description")
    def test_tool(param: str) -> str:
        return f"Result: {param}"

    spec = test_tool.tool_spec

    assert spec["name"] == "custom_name"
    assert spec["description"] == "Custom description"


@pytest.mark.asyncio
async def test_tool_with_optional_params(alist):
    """Test tool decorator with optional parameters."""

    @strands.tool
    def test_tool(required: str, optional: int | None = None) -> str:
        """Test with optional param.

        Args:
            required: Required parameter
            optional: Optional parameter
        """
        if optional is None:
            return f"Result: {required}"
        return f"Result: {required} {optional}"

    spec = test_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Only required should be in required list
    assert "required" in schema["required"]
    assert "optional" not in schema["required"]

    # Test with only required param
    tool_use = {"toolUseId": "test-id", "input": {"required": "hello"}}
    stream = test_tool.stream(tool_use, {})

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "test-id", "status": "success", "content": [{"text": "Result: hello"}]})
    ]
    assert tru_events == exp_events

    # Test with both params
    tool_use = {"toolUseId": "test-id", "input": {"required": "hello", "optional": 42}}
    stream = test_tool.stream(tool_use, {})

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "test-id", "status": "success", "content": [{"text": "Result: hello 42"}]})
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_docstring_description_extraction():
    """Test that docstring descriptions are extracted correctly, excluding Args section."""

    @strands.tool
    def tool_with_full_docstring(param1: str, param2: int) -> str:
        """This is the main description.

        This is more description text.

        Args:
            param1: First parameter
            param2: Second parameter

        Returns:
            A string result

        Raises:
            ValueError: If something goes wrong
        """
        return f"{param1} {param2}"

    spec = tool_with_full_docstring.tool_spec
    assert (
        spec["description"]
        == """This is the main description.

This is more description text.

Returns:
    A string result

Raises:
    ValueError: If something goes wrong"""
    )


def test_docstring_args_variations():
    """Test that various Args section formats are properly excluded."""

    @strands.tool
    def tool_with_args(param: str) -> str:
        """Main description.

        Args:
            param: Parameter description
        """
        return param

    @strands.tool
    def tool_with_arguments(param: str) -> str:
        """Main description.

        Arguments:
            param: Parameter description
        """
        return param

    @strands.tool
    def tool_with_parameters(param: str) -> str:
        """Main description.

        Parameters:
            param: Parameter description
        """
        return param

    @strands.tool
    def tool_with_params(param: str) -> str:
        """Main description.

        Params:
            param: Parameter description
        """
        return param

    for tool in [tool_with_args, tool_with_arguments, tool_with_parameters, tool_with_params]:
        spec = tool.tool_spec
        assert spec["description"] == "Main description."


def test_docstring_no_args_section():
    """Test docstring extraction when there's no Args section."""

    @strands.tool
    def tool_no_args(param: str) -> str:
        """This is the complete description.

        Returns:
            A string result
        """
        return param

    spec = tool_no_args.tool_spec
    expected_desc = """This is the complete description.

Returns:
    A string result"""
    assert spec["description"] == expected_desc


def test_docstring_only_args_section():
    """Test docstring extraction when there's only an Args section."""

    @strands.tool
    def tool_only_args(param: str) -> str:
        """Args:
        param: Parameter description
        """
        return param

    spec = tool_only_args.tool_spec
    # Should fall back to function name when no description remains
    assert spec["description"] == "tool_only_args"


def test_docstring_empty():
    """Test docstring extraction when docstring is empty."""

    @strands.tool
    def tool_empty_docstring(param: str) -> str:
        return param

    spec = tool_empty_docstring.tool_spec
    # Should fall back to function name
    assert spec["description"] == "tool_empty_docstring"


def test_docstring_preserves_other_sections():
    """Test that non-Args sections are preserved in the description."""

    @strands.tool
    def tool_multiple_sections(param: str) -> str:
        """Main description here.

        Args:
            param: This should be excluded

        Returns:
            This should be included

        Raises:
            ValueError: This should be included

        Examples:
            This should be included

        Note:
            This should be included
        """
        return param

    spec = tool_multiple_sections.tool_spec
    description = spec["description"]

    # Should include main description and other sections
    assert "Main description here." in description
    assert "Returns:" in description
    assert "This should be included" in description
    assert "Raises:" in description
    assert "Examples:" in description
    assert "Note:" in description

    # Should exclude Args section
    assert "This should be excluded" not in description


@pytest.mark.asyncio
async def test_tool_error_handling(alist):
    """Test error handling in tool decorator."""

    @strands.tool
    def test_tool(required: str) -> str:
        """Test tool function."""
        if required == "error":
            raise ValueError("Test error")
        return f"Result: {required}"

    # Test with missing required param
    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = test_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"
    assert "validation error for test_tooltool\nrequired\n" in result["tool_result"]["content"][0]["text"].lower(), (
        "Validation error should indicate which argument is missing"
    )

    # Test with exception in tool function
    tool_use = {"toolUseId": "test-id", "input": {"required": "error"}}
    stream = test_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"
    assert "test error" in result["tool_result"]["content"][0]["text"].lower(), (
        "Runtime error should contain the original error message"
    )


def test_type_handling():
    """Test handling of basic parameter types."""

    @strands.tool
    def test_tool(
        str_param: str,
        int_param: int,
        float_param: float,
        bool_param: bool,
    ) -> str:
        """Test basic types."""
        return "Success"

    spec = test_tool.tool_spec
    schema = spec["inputSchema"]["json"]
    props = schema["properties"]

    assert props["str_param"]["type"] == "string"
    assert props["int_param"]["type"] == "integer"
    assert props["float_param"]["type"] == "number"
    assert props["bool_param"]["type"] == "boolean"


@pytest.mark.asyncio
async def test_agent_parameter_passing(alist):
    """Test passing agent parameter to tool function."""
    mock_agent = MagicMock()

    @strands.tool
    def test_tool(param: str, agent=None) -> str:
        """Test tool with agent parameter."""
        if agent:
            return f"Agent: {agent}, Param: {param}"
        return f"Param: {param}"

    tool_use = {"toolUseId": "test-id", "input": {"param": "test"}}

    # Test without agent
    stream = test_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["content"][0]["text"] == "Param: test"

    # Test with agent
    stream = test_tool.stream(tool_use, {"agent": mock_agent})

    result = (await alist(stream))[-1]
    assert "Agent:" in result["tool_result"]["content"][0]["text"]
    assert "test" in result["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_tool_decorator_with_different_return_values(alist):
    """Test tool decorator with different return value types."""

    # Test with dict return that follows ToolResult format
    @strands.tool
    def dict_return_tool(param: str) -> dict:
        """Test tool that returns a dict in ToolResult format."""
        return {"status": "success", "content": [{"text": f"Result: {param}"}]}

    # Test with non-dict return
    @strands.tool
    def string_return_tool(param: str) -> str:
        """Test tool that returns a string."""
        return f"Result: {param}"

    # Test with None return
    @strands.tool
    def none_return_tool(param: str) -> None:
        """Test tool that returns None."""
        pass

    # Test the dict return - should preserve dict format but add toolUseId
    tool_use: ToolUse = {"toolUseId": "test-id", "input": {"param": "test"}}
    stream = dict_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "Result: test"
    assert result["tool_result"]["toolUseId"] == "test-id"

    # Test the string return - should wrap in standard format
    stream = string_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "Result: test"

    # Test None return - should still create valid ToolResult with "null"
    stream = none_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "null"


@pytest.mark.asyncio
async def test_tool_decorator_preserves_non_ascii_structured_return_values(alist):
    """Test dict/list returns preserve non-ASCII text like Pydantic models."""

    class Reply(BaseModel):
        message: str

    @strands.tool
    def dict_return_tool() -> dict[str, str]:
        """Return a dict with non-ASCII content."""
        return {"message": "こんにちは 🌏"}

    @strands.tool
    def list_return_tool() -> list[str]:
        """Return a list with non-ASCII content."""
        return ["你好", "🙂"]

    @strands.tool
    def model_return_tool() -> Reply:
        """Return a Pydantic model with non-ASCII content."""
        return Reply(message="こんにちは 🌏")

    tool_use: ToolUse = {"toolUseId": "test-id", "name": "test-tool", "input": {}}

    for tool, expected_fragments in (
        (dict_return_tool, ('"message": "こんにちは 🌏"',)),
        (list_return_tool, ('"你好"', '"🙂"')),
        (model_return_tool, ('"message":"こんにちは 🌏"',)),
    ):
        events = await alist(tool.stream(tool_use, {}))
        text = events[-1]["tool_result"]["content"][0]["text"]

        assert "\\u" not in text
        for fragment in expected_fragments:
            assert fragment in text


@pytest.mark.asyncio
async def test_class_method_handling(alist):
    """Test handling of class methods with tool decorator."""

    class TestClass:
        def __init__(self, prefix):
            self.prefix = prefix

        @strands.tool
        def test_method(self, param: str) -> str:
            """Test method.

            Args:
                param: Test parameter
            """
            return f"{self.prefix}: {param}"

    # Create instance and test the method
    instance = TestClass("Test")

    # Check that tool spec exists and doesn't include self
    spec = instance.test_method.tool_spec
    assert "param" in spec["inputSchema"]["json"]["properties"]
    assert "self" not in spec["inputSchema"]["json"]["properties"]

    # Test regular method call
    result = instance.test_method("value")
    assert result == "Test: value"

    # Test tool-style call
    tool_use = {"toolUseId": "test-id", "input": {"param": "tool-value"}}
    stream = instance.test_method.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert "Test: tool-value" in result["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_tool_as_adhoc_field(alist):
    @strands.tool
    def test_method(param: str) -> str:
        return f"param: {param}"

    class MyThing: ...

    instance: Any = MyThing()
    instance.field = test_method

    result = instance.field("example")
    assert result == "param: example"

    stream = instance.field.stream({"toolUseId": "test-id", "input": {"param": "example"}}, {})
    result2 = (await alist(stream))[-1]
    assert result2 == ToolResultEvent(
        {"content": [{"text": "param: example"}], "status": "success", "toolUseId": "test-id"}
    )


@pytest.mark.asyncio
async def test_tool_as_instance_field(alist):
    """Make sure that class instance properties operate correctly."""

    class MyThing:
        def __init__(self):
            @strands.tool
            def test_method(param: str) -> str:
                return f"param: {param}"

            self.field = test_method

    instance = MyThing()

    result = instance.field("example")
    assert result == "param: example"

    stream = instance.field.stream({"toolUseId": "test-id", "input": {"param": "example"}}, {})
    result2 = (await alist(stream))[-1]
    assert result2 == ToolResultEvent(
        {"content": [{"text": "param: example"}], "status": "success", "toolUseId": "test-id"}
    )


@pytest.mark.asyncio
async def test_default_parameter_handling(alist):
    """Test handling of parameters with default values."""

    @strands.tool
    def tool_with_defaults(required: str, optional: str = "default", number: int = 42) -> str:
        """Test tool with multiple default parameters.

        Args:
            required: Required parameter
            optional: Optional with default
            number: Number with default
        """
        return f"{required} {optional} {number}"

    # Check schema has correct required fields
    spec = tool_with_defaults.tool_spec
    schema = spec["inputSchema"]["json"]
    assert "required" in schema["required"]
    assert "optional" not in schema["required"]
    assert "number" not in schema["required"]

    # Call with just required parameter
    tool_use = {"toolUseId": "test-id", "input": {"required": "hello"}}
    stream = tool_with_defaults.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["content"][0]["text"] == "hello default 42"

    # Call with some but not all optional parameters
    tool_use = {"toolUseId": "test-id", "input": {"required": "hello", "number": 100}}
    stream = tool_with_defaults.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["content"][0]["text"] == "hello default 100"


@pytest.mark.asyncio
async def test_empty_tool_use_handling(alist):
    """Test handling of empty tool use dictionaries."""

    @strands.tool
    def test_tool(required: str) -> str:
        """Test with a required parameter."""
        return f"Got: {required}"

    # Test with completely empty tool use
    stream = test_tool.stream({}, {})
    result = (await alist(stream))[-1]
    print(result)
    assert result["tool_result"]["status"] == "error"
    assert "unknown" in result["tool_result"]["toolUseId"]

    # Test with missing input
    stream = test_tool.stream({"toolUseId": "test-id"}, {})
    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"
    assert "test-id" in result["tool_result"]["toolUseId"]


@pytest.mark.asyncio
async def test_traditional_function_call(alist):
    """Test that decorated functions can still be called normally."""

    @strands.tool
    def add_numbers(a: int, b: int) -> int:
        """Add two numbers.

        Args:
            a: First number
            b: Second number
        """
        return a + b

    # Call the function directly
    result = add_numbers(5, 7)
    assert result == 12

    # Call through tool interface
    tool_use = {"toolUseId": "test-id", "input": {"a": 2, "b": 3}}
    stream = add_numbers.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "5"


@pytest.mark.asyncio
async def test_multiple_default_parameters(alist):
    """Test handling of multiple parameters with default values."""

    @strands.tool
    def multi_default_tool(
        required_param: str,
        optional_str: str = "default_str",
        optional_int: int = 42,
        optional_bool: bool = True,
        optional_float: float = 3.14,
    ) -> str:
        """Tool with multiple default parameters of different types."""
        return f"{required_param}, {optional_str}, {optional_int}, {optional_bool}, {optional_float}"

    # Check the tool spec
    spec = multi_default_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Verify that only required_param is in the required list
    assert len(schema["required"]) == 1
    assert "required_param" in schema["required"]
    assert "optional_str" not in schema["required"]
    assert "optional_int" not in schema["required"]
    assert "optional_bool" not in schema["required"]
    assert "optional_float" not in schema["required"]

    # Test calling with only required parameter
    tool_use = {"toolUseId": "test-id", "input": {"required_param": "hello"}}
    stream = multi_default_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "hello, default_str, 42, True, 3.14" in result["tool_result"]["content"][0]["text"]

    # Test calling with some optional parameters
    tool_use = {
        "toolUseId": "test-id",
        "input": {"required_param": "hello", "optional_int": 100, "optional_float": 2.718},
    }
    stream = multi_default_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert "hello, default_str, 100, True, 2.718" in result["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_return_type_validation(alist):
    """Test that return types are properly handled and validated."""

    # Define tool with explicitly typed return
    @strands.tool
    def int_return_tool(param: str) -> int:
        """Tool that returns an integer.

        Args:
            param: Input parameter
        """
        if param == "valid":
            return 42
        elif param == "invalid_type":
            return "not an int"  # This should work because Python is dynamically typed
        else:
            return None  # This should work but be wrapped correctly

    # Test with return that matches declared type
    tool_use = {"toolUseId": "test-id", "input": {"param": "valid"}}
    stream = int_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "42"

    # Test with return that doesn't match declared type
    # Note: This should still work because Python doesn't enforce return types at runtime
    # but the function will return a string instead of an int
    tool_use = {"toolUseId": "test-id", "input": {"param": "invalid_type"}}
    stream = int_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "not an int"

    # Test with None return from a non-None return type
    tool_use = {"toolUseId": "test-id", "input": {"param": "none"}}
    stream = int_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "null"

    # Define tool with Union return type
    @strands.tool
    def union_return_tool(param: str) -> dict[str, Any] | str | None:
        """Tool with Union return type.

        Args:
            param: Input parameter
        """
        if param == "dict":
            return {"key": "value"}
        elif param == "str":
            return "string result"
        else:
            return None

    # Test with each possible return type in the Union
    tool_use = {"toolUseId": "test-id", "input": {"param": "dict"}}
    stream = union_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == '{"key": "value"}'

    tool_use = {"toolUseId": "test-id", "input": {"param": "str"}}
    stream = union_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "string result"

    tool_use = {"toolUseId": "test-id", "input": {"param": "none"}}
    stream = union_return_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "null"


@pytest.mark.asyncio
async def test_tool_with_no_parameters(alist):
    """Test a tool that doesn't require any parameters."""

    @strands.tool
    def no_params_tool() -> str:
        """A tool that doesn't need any parameters."""
        return "Success - no parameters needed"

    # Check schema is still valid even with no parameters
    spec = no_params_tool.tool_spec
    schema = spec["inputSchema"]["json"]
    assert schema["type"] == "object"
    assert "properties" in schema

    # Test tool use call
    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = no_params_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "Success - no parameters needed"

    # Test direct call
    direct_result = no_params_tool()
    assert direct_result == "Success - no parameters needed"


@pytest.mark.asyncio
async def test_complex_parameter_types(alist):
    """Test handling of complex parameter types like nested dictionaries."""

    @strands.tool
    def complex_type_tool(config: dict[str, Any]) -> str:
        """Tool with complex parameter type.

        Args:
            config: A complex configuration object
        """
        return f"Got config with {len(config.keys())} keys"

    # Test with a nested dictionary
    nested_dict = {"name": "test", "settings": {"enabled": True, "threshold": 0.5}, "tags": ["important", "test"]}

    # Call via tool use
    tool_use = {"toolUseId": "test-id", "input": {"config": nested_dict}}
    stream = complex_type_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "Got config with 3 keys" in result["tool_result"]["content"][0]["text"]

    # Direct call
    direct_result = complex_type_tool(nested_dict)
    assert direct_result == "Got config with 3 keys"


@pytest.mark.asyncio
async def test_custom_tool_result_handling(alist):
    """Test that a function returning a properly formatted tool result dictionary is handled correctly."""

    @strands.tool
    def custom_result_tool(param: str) -> dict[str, Any]:
        """Tool that returns a custom tool result dictionary.

        Args:
            param: Input parameter
        """
        # Return a dictionary that follows the tool result format including multiple content items
        return {
            "status": "success",
            "content": [{"text": f"First line: {param}"}, {"text": "Second line", "type": "markdown"}],
        }

    # Test via tool use
    tool_use = {"toolUseId": "custom-id", "input": {"param": "test"}}
    stream = custom_result_tool.stream(tool_use, {})

    # The wrapper should preserve our format and just add the toolUseId
    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["toolUseId"] == "custom-id"
    assert len(result["tool_result"]["content"]) == 2
    assert result["tool_result"]["content"][0]["text"] == "First line: test"
    assert result["tool_result"]["content"][1]["text"] == "Second line"
    assert result["tool_result"]["content"][1]["type"] == "markdown"


@pytest.mark.asyncio
async def test_tool_result_json_serialization_dict(alist):
    """Test that dict results are serialized as JSON."""

    @strands.tool
    def dict_tool() -> dict:
        """Returns a dict."""
        return {"key": "value", "number": 42}

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = dict_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == '{"key": "value", "number": 42}'


@pytest.mark.asyncio
async def test_tool_result_json_serialization_list(alist):
    """Test that list results are serialized as JSON."""

    @strands.tool
    def list_tool() -> list:
        """Returns a list."""
        return [1, "two", {"three": 3}]

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = list_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == '[1, "two", {"three": 3}]'


@pytest.mark.asyncio
async def test_tool_result_json_serialization_pydantic(alist):
    """Test that Pydantic model results are serialized as JSON."""
    from pydantic import BaseModel

    class MyModel(BaseModel):
        name: str
        count: int

    @strands.tool
    def pydantic_tool() -> MyModel:
        """Returns a Pydantic model."""
        return MyModel(name="test", count=5)

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = pydantic_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == '{"name":"test","count":5}'


@pytest.mark.asyncio
async def test_tool_result_json_serialization_pydantic_non_serializable(alist):
    """Test that Pydantic models with non-serializable fields fall back to str()."""
    from pydantic import BaseModel

    class NonSerializable:
        def __repr__(self):
            return "NonSerializable()"

    class MyModel(BaseModel):
        model_config = {"arbitrary_types_allowed": True}
        data: NonSerializable

    @strands.tool
    def pydantic_tool() -> MyModel:
        """Returns a Pydantic model with non-serializable field."""
        return MyModel(data=NonSerializable())

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = pydantic_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == "data=NonSerializable()"


@pytest.mark.asyncio
async def test_tool_result_json_serialization_non_serializable(alist):
    """Test that non-JSON-serializable results fall back to str()."""

    class CustomClass:
        def __str__(self):
            return "custom_str_repr"

    @strands.tool
    def custom_tool() -> Any:
        """Returns a non-serializable object."""
        return CustomClass()

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = custom_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == "custom_str_repr"


@pytest.mark.asyncio
async def test_tool_result_string_not_json_encoded(alist):
    """Test that string results are NOT JSON-encoded (no extra quotes)."""

    @strands.tool
    def string_tool() -> str:
        """Returns a string."""
        return "hello world"

    tool_use = {"toolUseId": "test-id", "input": {}}
    stream = string_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    text = result["tool_result"]["content"][0]["text"]

    assert text == "hello world"


def test_docstring_parsing():
    """Test that function docstring is correctly parsed into tool spec."""

    @strands.tool
    def documented_tool(param1: str, param2: int = 10) -> str:
        """This is the summary line.

        This is a more detailed description that spans
        multiple lines and provides additional context.

        Args:
            param1: Description of first parameter with details
                   that continue on next line
            param2: Description of second parameter (default: 10)
                    with additional info

        Returns:
            A string with the result

        Raises:
            ValueError: If parameters are invalid
        """
        return f"{param1} {param2}"

    spec = documented_tool.tool_spec

    # Check description captures both summary and details
    assert "This is the summary line" in spec["description"]
    assert "more detailed description" in spec["description"]

    # Check parameter descriptions
    schema = spec["inputSchema"]["json"]
    assert "Description of first parameter" in schema["properties"]["param1"]["description"]
    assert "Description of second parameter" in schema["properties"]["param2"]["description"]

    # Check that default value notes from docstring don't override actual defaults
    assert "param2" not in schema["required"]


@pytest.mark.asyncio
async def test_detailed_validation_errors(alist):
    """Test detailed error messages for various validation failures."""

    @strands.tool
    def validation_tool(str_param: str, int_param: int, bool_param: bool) -> str:
        """Tool with various parameter types for validation testing.

        Args:
            str_param: String parameter
            int_param: Integer parameter
            bool_param: Boolean parameter
        """
        return "Valid"

    # Test wrong type for int
    tool_use = {
        "toolUseId": "test-id",
        "input": {
            "str_param": "hello",
            "int_param": "not an int",  # Wrong type
            "bool_param": True,
        },
    }
    stream = validation_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"
    assert "int_param" in result["tool_result"]["content"][0]["text"]

    # Test missing required parameter
    tool_use = {
        "toolUseId": "test-id",
        "input": {
            "str_param": "hello",
            # int_param missing
            "bool_param": True,
        },
    }
    stream = validation_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"
    assert "int_param" in result["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_tool_complex_validation_edge_cases(alist):
    """Test validation of complex schema edge cases."""
    from typing import Any

    # Define a tool with a complex anyOf type that could trigger edge case handling
    @strands.tool
    def edge_case_tool(param: dict[str, Any] | None) -> str:
        """Tool with complex anyOf structure.

        Args:
            param: A complex parameter that can be None or a dict
        """
        return str(param)

    # Test with None value
    tool_use = {"toolUseId": "test-id", "input": {"param": None}}
    stream = edge_case_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "None"

    # Test with empty dict
    tool_use = {"toolUseId": "test-id", "input": {"param": {}}}
    stream = edge_case_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert result["tool_result"]["content"][0]["text"] == "{}"

    # Test with a complex nested dictionary
    nested_dict = {"key1": {"nested": [1, 2, 3]}, "key2": None}
    tool_use = {"toolUseId": "test-id", "input": {"param": nested_dict}}
    stream = edge_case_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "key1" in result["tool_result"]["content"][0]["text"]
    assert "nested" in result["tool_result"]["content"][0]["text"]


@pytest.mark.asyncio
async def test_tool_method_detection_errors(alist):
    """Test edge cases in method detection logic."""

    # Define a class with a decorated method to test exception handling in method detection
    class TestClass:
        @strands.tool
        def test_method(self, param: str) -> str:
            """Test method that should be called properly despite errors.

            Args:
                param: A test parameter
            """
            return f"Method Got: {param}"

    # Create a mock instance where attribute access will raise exceptions
    class MockInstance:
        @property
        def __class__(self):
            # First access will raise AttributeError to test that branch
            raise AttributeError("Simulated AttributeError")

    class MockInstance2:
        @property
        def __class__(self):
            class MockClass:
                @property
                def test_method(self):
                    # This will raise TypeError when checking for the method name
                    raise TypeError("Simulated TypeError")

            return MockClass()

    # Create instances
    instance = TestClass()
    MockInstance()
    MockInstance2()

    # Test normal method call
    assert instance.test_method("test") == "Method Got: test"

    # Test direct function call
    stream = instance.test_method.stream({"toolUseId": "test-id", "input": {"param": "direct"}}, {})

    direct_result = (await alist(stream))[-1]
    assert direct_result["tool_result"]["status"] == "success"
    assert direct_result["tool_result"]["content"][0]["text"] == "Method Got: direct"

    # Create a standalone function to test regular function calls
    @strands.tool
    def standalone_tool(p1: str, p2: str = "default") -> str:
        """Standalone tool for testing.

        Args:
            p1: First parameter
            p2: Second parameter with default
        """
        return f"Standalone: {p1}, {p2}"

    # Test that we can call it directly with multiple parameters
    result = standalone_tool("param1", "param2")
    assert result == "Standalone: param1, param2"

    # And that it works with tool use call too
    stream = standalone_tool.stream({"toolUseId": "test-id", "input": {"p1": "value1"}}, {})

    tool_use_result = (await alist(stream))[-1]
    assert tool_use_result["tool_result"]["status"] == "success"
    assert tool_use_result["tool_result"]["content"][0]["text"] == "Standalone: value1, default"


@pytest.mark.asyncio
async def test_tool_general_exception_handling(alist):
    """Test handling of arbitrary exceptions in tool execution."""

    @strands.tool
    def failing_tool(param: str) -> str:
        """Tool that raises different exception types.

        Args:
            param: Determines which exception to raise
        """
        if param == "value_error":
            raise ValueError("Value error message")
        elif param == "type_error":
            raise TypeError("Type error message")
        elif param == "attribute_error":
            raise AttributeError("Attribute error message")
        elif param == "key_error":
            raise KeyError("key_name")
        return "Success"

    # Test with different error types
    error_types = ["value_error", "type_error", "attribute_error", "key_error"]
    for error_type in error_types:
        tool_use = {"toolUseId": "test-id", "input": {"param": error_type}}
        stream = failing_tool.stream(tool_use, {})

        result = (await alist(stream))[-1]
        assert result["tool_result"]["status"] == "error"

        error_message = result["tool_result"]["content"][0]["text"]

        # Check that error type is included
        if error_type == "value_error":
            assert "Value error message" in error_message
        elif error_type == "type_error":
            assert "TypeError" in error_message
        elif error_type == "attribute_error":
            assert "AttributeError" in error_message
        elif error_type == "key_error":
            assert "KeyError" in error_message
            assert "key_name" in error_message


@pytest.mark.asyncio
async def test_tool_with_complex_anyof_schema(alist):
    """Test handling of complex anyOf structures in the schema."""
    from typing import Any

    @strands.tool
    def complex_schema_tool(union_param: list[int] | dict[str, Any] | str | None) -> str:
        """Tool with a complex Union type that creates anyOf in schema.

        Args:
            union_param: A parameter that can be list, dict, string or None
        """
        return str(type(union_param).__name__) + ": " + str(union_param)

    # Test with a list
    tool_use = {"toolUseId": "test-id", "input": {"union_param": [1, 2, 3]}}
    stream = complex_schema_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "list: [1, 2, 3]" in result["tool_result"]["content"][0]["text"]

    # Test with a dict
    tool_use = {"toolUseId": "test-id", "input": {"union_param": {"key": "value"}}}
    stream = complex_schema_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "dict:" in result["tool_result"]["content"][0]["text"]
    assert "key" in result["tool_result"]["content"][0]["text"]

    # Test with a string
    tool_use = {"toolUseId": "test-id", "input": {"union_param": "test_string"}}
    stream = complex_schema_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "str: test_string" in result["tool_result"]["content"][0]["text"]

    # Test with None
    tool_use = {"toolUseId": "test-id", "input": {"union_param": None}}
    stream = complex_schema_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "NoneType: None" in result["tool_result"]["content"][0]["text"]


async def _run_context_injection_test(context_tool: AgentTool, additional_context=None):
    """Common test logic for context injection tests."""
    tool: AgentTool = context_tool
    generator = tool.stream(
        tool_use={
            "toolUseId": "test-id",
            "name": "context_tool",
            "input": {
                "message": "some_message"  # note that we do not include agent nor tool context
            },
        },
        invocation_state={
            "agent": Agent(name="test_agent"),
            **(additional_context or {}),
        },
    )
    tool_results = [value async for value in generator]

    assert len(tool_results) == 1
    tool_result = tool_results[0]

    assert tool_result == ToolResultEvent(
        {
            "status": "success",
            "content": [
                {"text": "Tool 'context_tool' (ID: test-id)"},
                {"text": "injected agent 'test_agent' processed: some_message"},
                {"text": "context agent 'test_agent'"},
            ],
            "toolUseId": "test-id",
        }
    )


@pytest.mark.asyncio
async def test_tool_context_injection_default():
    """Test that ToolContext is properly injected with default parameter name (tool_context)."""

    value_to_pass = Queue()  # a complex value that is not serializable

    @strands.tool(context=True)
    def context_tool(message: str, agent: Agent, tool_context: ToolContext) -> dict:
        """Tool that uses ToolContext to access tool_use_id."""
        tool_use_id = tool_context.tool_use["toolUseId"]
        tool_name = tool_context.tool_use["name"]
        agent_from_tool_context = tool_context.agent

        assert tool_context.invocation_state["test_reference"] is value_to_pass

        return {
            "status": "success",
            "content": [
                {"text": f"Tool '{tool_name}' (ID: {tool_use_id})"},
                {"text": f"injected agent '{agent.name}' processed: {message}"},
                {"text": f"context agent '{agent_from_tool_context.name}'"},
            ],
        }

    await _run_context_injection_test(
        context_tool,
        {
            "test_reference": value_to_pass,
        },
    )


@pytest.mark.asyncio
async def test_tool_context_injection_parameterized():
    """Test that parameterized ToolContext annotations are injected."""

    @strands.tool(context=True)
    def context_tool(tool_context: ToolContext[LocalAgent]) -> str:
        return tool_context.agent.name

    agent = Agent(name="test_agent")
    events = [
        event
        async for event in context_tool.stream(
            tool_use={"toolUseId": "test-id", "name": "context_tool", "input": {}},
            invocation_state={"agent": agent},
        )
    ]

    assert events == [
        ToolResultEvent({"toolUseId": "test-id", "status": "success", "content": [{"text": "test_agent"}]})
    ]


@pytest.mark.asyncio
async def test_tool_context_cancel_signal_is_agent_signal(alist):
    """The injected context carries the invoking agent's own cancellation signal."""
    signals_seen = []

    @strands.tool(context=True)
    def signal_tool(tool_context: ToolContext) -> str:
        """Record the cancellation signal handed to the tool."""
        signals_seen.append(tool_context.cancel_signal)
        return "done"

    agent = Agent(name="test_agent")

    await alist(
        signal_tool.stream(
            tool_use={"toolUseId": "test-id", "name": "signal_tool", "input": {}},
            invocation_state={"agent": agent},
        )
    )

    assert signals_seen[0] is agent.cancel_signal
    assert not signals_seen[0].is_set()


@pytest.mark.asyncio
async def test_tool_context_cancel_signal_set_after_cancel(alist):
    """A tool that cancels its agent reads the cancellation back off its own context."""
    signal_states = []

    @strands.tool(context=True)
    def cancelling_tool(tool_context: ToolContext) -> str:
        """Cancel the agent, then check the signal."""
        tool_context.agent.cancel()
        signal_states.append(tool_context.cancel_signal.is_set())
        return "done"

    await alist(
        cancelling_tool.stream(
            tool_use={"toolUseId": "test-id", "name": "cancelling_tool", "input": {}},
            invocation_state={"agent": Agent(name="test_agent")},
        )
    )

    assert signal_states == [True]


@pytest.mark.asyncio
async def test_tool_context_injection_custom_name():
    """Test that ToolContext is properly injected with custom parameter name."""

    @strands.tool(context="custom_context_name")
    def context_tool(message: str, agent: Agent, custom_context_name: ToolContext) -> dict:
        """Tool that uses ToolContext to access tool_use_id."""
        tool_use_id = custom_context_name.tool_use["toolUseId"]
        tool_name = custom_context_name.tool_use["name"]
        agent_from_tool_context = custom_context_name.agent

        return {
            "status": "success",
            "content": [
                {"text": f"Tool '{tool_name}' (ID: {tool_use_id})"},
                {"text": f"injected agent '{agent.name}' processed: {message}"},
                {"text": f"context agent '{agent_from_tool_context.name}'"},
            ],
        }

    await _run_context_injection_test(context_tool)


@pytest.mark.asyncio
async def test_tool_context_injection_disabled_missing_parameter():
    """Test that when context=False, missing tool_context parameter causes validation error."""

    @strands.tool(context=False)
    def context_tool(message: str, agent: Agent, tool_context: str) -> dict:
        """Tool that expects tool_context as a regular string parameter."""
        return {
            "status": "success",
            "content": [
                {"text": f"Message: {message}"},
                {"text": f"Agent: {agent.name}"},
                {"text": f"Tool context string: {tool_context}"},
            ],
        }

    # Verify that missing tool_context parameter causes validation error
    tool: AgentTool = context_tool
    generator = tool.stream(
        tool_use={
            "toolUseId": "test-id",
            "name": "context_tool",
            "input": {
                "message": "some_message"
                # Missing tool_context parameter - should cause validation error instead of being auto injected
            },
        },
        invocation_state={
            "agent": Agent(name="test_agent"),
        },
    )
    tool_results = [value async for value in generator]

    assert len(tool_results) == 1
    tool_result = tool_results[0]

    # Should get a validation error because tool_context is required but not provided
    assert tool_result["tool_result"]["status"] == "error"
    assert "tool_context" in tool_result["tool_result"]["content"][0]["text"].lower()
    assert "validation" in tool_result["tool_result"]["content"][0]["text"].lower()


@pytest.mark.asyncio
async def test_tool_context_injection_disabled_string_parameter():
    """Test that when context=False, tool_context can be passed as a string parameter."""

    @strands.tool(context=False)
    def context_tool(message: str, agent: Agent, tool_context: str) -> str:
        """Tool that expects tool_context as a regular string parameter."""
        return "success"

    # Verify that providing tool_context as a string works correctly
    tool: AgentTool = context_tool
    generator = tool.stream(
        tool_use={
            "toolUseId": "test-id-2",
            "name": "context_tool",
            "input": {"message": "some_message", "tool_context": "my_custom_context_string"},
        },
        invocation_state={
            "agent": Agent(name="test_agent"),
        },
    )
    tool_results = [value async for value in generator]

    assert len(tool_results) == 1
    tool_result = tool_results[0]

    # Should succeed with the string parameter
    assert tool_result == ToolResultEvent(
        {
            "status": "success",
            "content": [{"text": "success"}],
            "toolUseId": "test-id-2",
        }
    )


@pytest.mark.asyncio
async def test_tool_async_generator():
    """Test that async generators yield results appropriately."""

    @strands.tool(context=False)
    async def async_generator() -> AsyncGenerator:
        """Tool that expects tool_context as a regular string parameter."""
        yield 0
        yield "Value 1"
        yield {"nested": "value"}
        yield {
            "status": "success",
            "content": [{"text": "Looks like tool result"}],
            "toolUseId": "test-id-2",
        }
        yield "final result"

    tool: AgentTool = async_generator
    tool_use: ToolUse = {
        "toolUseId": "test-id-2",
        "name": "context_tool",
        "input": {"message": "some_message", "tool_context": "my_custom_context_string"},
    }
    generator = tool.stream(
        tool_use=tool_use,
        invocation_state={
            "agent": Agent(name="test_agent"),
        },
    )
    act_results = [value async for value in generator]
    exp_results = [
        ToolStreamEvent(tool_use, 0),
        ToolStreamEvent(tool_use, "Value 1"),
        ToolStreamEvent(tool_use, {"nested": "value"}),
        ToolStreamEvent(
            tool_use,
            {
                "status": "success",
                "content": [{"text": "Looks like tool result"}],
                "toolUseId": "test-id-2",
            },
        ),
        ToolStreamEvent(tool_use, "final result"),
        ToolResultEvent(
            {
                "status": "success",
                "content": [{"text": "final result"}],
                "toolUseId": "test-id-2",
            }
        ),
    ]

    assert act_results == exp_results


@pytest.mark.asyncio
async def test_tool_async_generator_exceptions_result_in_error():
    """Test that async generators handle exceptions."""

    @strands.tool(context=False)
    async def async_generator() -> AsyncGenerator:
        """Tool that expects tool_context as a regular string parameter."""
        yield 13
        raise ValueError("It's an error!")

    tool: AgentTool = async_generator
    tool_use: ToolUse = {
        "toolUseId": "test-id-2",
        "name": "context_tool",
        "input": {"message": "some_message", "tool_context": "my_custom_context_string"},
    }
    generator = tool.stream(
        tool_use=tool_use,
        invocation_state={
            "agent": Agent(name="test_agent"),
        },
    )
    act_results = [value async for value in generator]
    exp_results = [
        ToolStreamEvent(tool_use, 13),
        ToolResultEvent(
            {
                "status": "error",
                "content": [{"text": "Error: It's an error!"}],
                "toolUseId": "test-id-2",
            }
        ),
    ]

    assert act_results == exp_results


@pytest.mark.asyncio
async def test_tool_async_generator_yield_object_result():
    """Test that async generators handle exceptions."""

    @strands.tool(context=False)
    async def async_generator() -> AsyncGenerator:
        """Tool that expects tool_context as a regular string parameter."""
        yield 13
        yield {
            "status": "success",
            "content": [{"text": "final result"}],
            "toolUseId": "test-id-2",
        }

    tool: AgentTool = async_generator
    tool_use: ToolUse = {
        "toolUseId": "test-id-2",
        "name": "context_tool",
        "input": {"message": "some_message", "tool_context": "my_custom_context_string"},
    }
    generator = tool.stream(
        tool_use=tool_use,
        invocation_state={
            "agent": Agent(name="test_agent"),
        },
    )
    act_results = [value async for value in generator]
    exp_results = [
        ToolStreamEvent(tool_use, 13),
        ToolStreamEvent(
            tool_use,
            {
                "status": "success",
                "content": [{"text": "final result"}],
                "toolUseId": "test-id-2",
            },
        ),
        ToolResultEvent(
            {
                "status": "success",
                "content": [{"text": "final result"}],
                "toolUseId": "test-id-2",
            }
        ),
    ]

    assert act_results == exp_results


def test_function_tool_metadata_validate_signature_default_context_name_mismatch():
    with pytest.raises(ValueError, match=r"param_name=<context> | ToolContext param must be named 'tool_context'"):

        @strands.tool(context=True)
        def my_tool(context: ToolContext):
            pass


def test_function_tool_metadata_validate_signature_custom_context_name_mismatch():
    with pytest.raises(ValueError, match=r"param_name=<tool_context> | ToolContext param must be named 'my_context'"):

        @strands.tool(context="my_context")
        def my_tool(tool_context: ToolContext):
            pass


def test_function_tool_metadata_validate_signature_missing_context_config():
    with pytest.raises(ValueError, match=r"@tool\(context\) must be set if passing in ToolContext param"):

        @strands.tool
        def my_tool(tool_context: ToolContext):
            pass


def test_tool_decorator_annotated_string_description():
    """Test tool decorator with Annotated type hints for descriptions."""

    @strands.tool
    def annotated_tool(
        name: Annotated[str, "The user's full name"],
        age: Annotated[int, "The user's age in years"],
        city: str,  # No annotation - should use docstring or generic
    ) -> str:
        """Tool with annotated parameters.

        Args:
            city: The user's city (from docstring)
        """
        return f"{name}, {age}, {city}"

    spec = annotated_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Check that annotated descriptions are used
    assert schema["properties"]["name"]["description"] == "The user's full name"
    assert schema["properties"]["age"]["description"] == "The user's age in years"

    # Check that docstring is still used for non-annotated params
    assert schema["properties"]["city"]["description"] == "The user's city (from docstring)"

    # Verify all are required
    assert set(schema["required"]) == {"name", "age", "city"}


def test_tool_decorator_annotated_pydantic_field_constraints():
    """Test that using pydantic.Field in Annotated raises a NotImplementedError."""
    with pytest.raises(NotImplementedError, match="Using pydantic.Field within Annotated is not yet supported"):

        @strands.tool
        def field_annotated_tool(
            email: Annotated[str, Field(description="User's email address", pattern=r"^[\w\.-]+@[\w\.-]+\\.w+$")],
            score: Annotated[int, Field(description="Score between 0-100", ge=0, le=100)] = 50,
        ) -> str:
            """Tool with Pydantic Field annotations."""
            return f"{email}: {score}"


def test_tool_decorator_annotated_overrides_docstring():
    """Test that Annotated descriptions override docstring descriptions."""

    @strands.tool
    def override_tool(param: Annotated[str, "Description from annotation"]) -> str:
        """Tool with both annotation and docstring.

        Args:
            param: Description from docstring (should be overridden)
        """
        return param

    spec = override_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Annotated description should win
    assert schema["properties"]["param"]["description"] == "Description from annotation"


def test_tool_decorator_annotated_optional_type():
    """Test tool with Optional types in Annotated."""

    @strands.tool
    def optional_annotated_tool(
        required: Annotated[str, "Required parameter"], optional: Annotated[str | None, "Optional parameter"] = None
    ) -> str:
        """Tool with optional annotated parameter."""
        return f"{required}, {optional}"

    spec = optional_annotated_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Check descriptions
    assert schema["properties"]["required"]["description"] == "Required parameter"
    assert schema["properties"]["optional"]["description"] == "Optional parameter"

    # Check required list
    assert "required" in schema["required"]
    assert "optional" not in schema["required"]


def test_tool_decorator_annotated_complex_types():
    """Test tool with complex types in Annotated."""

    @strands.tool
    def complex_annotated_tool(
        tags: Annotated[list[str], "List of tag strings"], config: Annotated[dict[str, Any], "Configuration dictionary"]
    ) -> str:
        """Tool with complex annotated types."""
        return f"Tags: {len(tags)}, Config: {len(config)}"

    spec = complex_annotated_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Check descriptions
    assert schema["properties"]["tags"]["description"] == "List of tag strings"
    assert schema["properties"]["config"]["description"] == "Configuration dictionary"

    # Check types are preserved
    assert schema["properties"]["tags"]["type"] == "array"
    assert schema["properties"]["config"]["type"] == "object"


def test_tool_decorator_annotated_mixed_styles():
    """Test that using pydantic.Field in a mixed-style annotation raises NotImplementedError."""
    with pytest.raises(NotImplementedError, match="Using pydantic.Field within Annotated is not yet supported"):

        @strands.tool
        def mixed_tool(
            plain: str,
            annotated_str: Annotated[str, "String description"],
            annotated_field: Annotated[int, Field(description="Field description", ge=0)],
            docstring_only: int,
        ) -> str:
            """Tool with mixed parameter styles.

            Args:
                plain: Plain parameter description
                docstring_only: Docstring description for this param
            """
            return "mixed"


@pytest.mark.asyncio
async def test_tool_decorator_annotated_execution(alist):
    """Test that annotated tools execute correctly."""

    @strands.tool
    def execution_test(name: Annotated[str, "User name"], count: Annotated[int, "Number of times"] = 1) -> str:
        """Test execution with annotations."""
        return f"Hello {name} " * count

    # Test tool use
    tool_use = {"toolUseId": "test-id", "input": {"name": "Alice", "count": 2}}
    stream = execution_test.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "success"
    assert "Hello Alice Hello Alice" in result["tool_result"]["content"][0]["text"]

    # Test direct call
    direct_result = execution_test("Bob", 3)
    assert direct_result == "Hello Bob Hello Bob Hello Bob "


def test_tool_decorator_annotated_no_description_fallback():
    """Test that Annotated with a Field raises NotImplementedError."""
    with pytest.raises(NotImplementedError, match="Using pydantic.Field within Annotated is not yet supported"):

        @strands.tool
        def no_desc_annotated(
            param: Annotated[str, Field()],  # Field without description
        ) -> str:
            """Tool with Annotated but no description.

            Args:
                param: Docstring description
            """
            return param


def test_tool_decorator_annotated_empty_string_description():
    """Test handling of empty string descriptions in Annotated."""

    @strands.tool
    def empty_desc_tool(
        param: Annotated[str, ""],  # Empty string description
    ) -> str:
        """Tool with empty annotation description.

        Args:
            param: Docstring description
        """
        return param

    spec = empty_desc_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # Empty string is still a valid description, should not fall back
    assert schema["properties"]["param"]["description"] == ""


@pytest.mark.asyncio
async def test_tool_decorator_annotated_validation_error(alist):
    """Test that validation works correctly with annotated parameters."""

    @strands.tool
    def validation_tool(age: Annotated[int, "User age"]) -> str:
        """Tool for validation testing."""
        return f"Age: {age}"

    # Test with wrong type
    tool_use = {"toolUseId": "test-id", "input": {"age": "not an int"}}
    stream = validation_tool.stream(tool_use, {})

    result = (await alist(stream))[-1]
    assert result["tool_result"]["status"] == "error"


def test_tool_decorator_annotated_field_with_inner_default():
    """Test that a default value in an Annotated Field raises NotImplementedError."""
    with pytest.raises(NotImplementedError, match="Using pydantic.Field within Annotated is not yet supported"):

        @strands.tool
        def inner_default_tool(name: str, level: Annotated[int, Field(description="A level value", default=10)]) -> str:
            return f"{name} is at level {level}"


def test_tool_decorator_param_default_field_preserves_constraints():
    """Regression test for https://github.com/strands-agents/harness-sdk/issues/1914."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")

        @strands.tool
        def with_field_default(
            items: list = Field(default_factory=list),  # noqa: B008
            score: int = Field(default=0, ge=0),  # noqa: B008
            label: str = Field(default="x", description="Label override"),  # noqa: B008
        ) -> str:
            return f"{len(items)}:{score}:{label}"

    pydantic_warnings = [w for w in caught if "PydanticJsonSchemaWarning" in type(w.message).__name__]
    assert not pydantic_warnings, f"Unexpected Pydantic warnings: {pydantic_warnings}"

    properties = with_field_default.tool_spec["inputSchema"]["json"]["properties"]
    assert properties["items"] == {"description": "Parameter items", "items": {}, "type": "array"}
    assert properties["score"] == {"default": 0, "description": "Parameter score", "minimum": 0, "type": "integer"}
    assert properties["label"] == {"default": "x", "description": "Label override", "type": "string"}


@pytest.mark.asyncio
async def test_tool_result_event_carries_exception_runtime_error(alist):
    """Test that ToolResultEvent carries exception when tool raises RuntimeError."""

    @strands.tool
    def error_tool():
        """Tool that raises a RuntimeError."""
        raise RuntimeError("test runtime error")

    tool_use = {"toolUseId": "test-id", "input": {}}
    events = await alist(error_tool.stream(tool_use, {}))

    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert hasattr(result_event, "exception")
    assert isinstance(result_event.exception, RuntimeError)
    assert str(result_event.exception) == "test runtime error"
    assert result_event.tool_result["status"] == "error"


@pytest.mark.asyncio
async def test_tool_result_event_carries_exception_value_error(alist):
    """Test that ToolResultEvent carries exception when tool raises ValueError."""

    @strands.tool
    def validation_error_tool():
        """Tool that raises a ValueError."""
        raise ValueError("validation failed")

    tool_use = {"toolUseId": "test-id", "input": {}}
    events = await alist(validation_error_tool.stream(tool_use, {}))

    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert hasattr(result_event, "exception")
    assert isinstance(result_event.exception, ValueError)
    assert str(result_event.exception) == "validation failed"
    assert result_event.tool_result["status"] == "error"


@pytest.mark.asyncio
async def test_tool_result_event_no_exception_on_success(alist):
    """Test that ToolResultEvent.exception is None when tool succeeds."""

    @strands.tool
    def success_tool():
        """Tool that succeeds."""
        return "success"

    tool_use = {"toolUseId": "test-id", "input": {}}
    events = await alist(success_tool.stream(tool_use, {}))

    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert result_event.exception is None
    assert result_event.tool_result["status"] == "success"


@pytest.mark.asyncio
async def test_tool_result_event_carries_exception_assertion_error(alist):
    """Test that ToolResultEvent carries AssertionError for unexpected failures."""

    @strands.tool
    def assertion_error_tool():
        """Tool that raises an AssertionError."""
        raise AssertionError("unexpected assertion failure")

    tool_use = {"toolUseId": "test-id", "input": {}}
    events = await alist(assertion_error_tool.stream(tool_use, {}))

    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert isinstance(result_event.exception, AssertionError)
    assert "unexpected assertion failure" in str(result_event.exception)
    assert result_event.tool_result["status"] == "error"


def test_tool_nullable_required_field_preserves_anyof():
    """Test that a required nullable field preserves anyOf so the model can pass null.

    Regression test for https://github.com/strands-agents/harness-sdk/issues/1525
    """
    from enum import Enum

    class Priority(str, Enum):
        HIGH = "high"
        MEDIUM = "medium"
        LOW = "low"

    @strands.tool
    def prioritized_task(description: str, priority: Priority | None) -> str:
        """Create a task with optional priority.

        Args:
            description: Task description
            priority: Optional priority level
        """
        return f"{description}: {priority}"

    spec = prioritized_task.tool_spec
    schema = spec["inputSchema"]["json"]

    expected_schema = {
        "$defs": {
            "Priority": {
                "enum": ["high", "medium", "low"],
                "title": "Priority",
                "type": "string",
            },
        },
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "Task description",
            },
            "priority": {
                "anyOf": [
                    {"$ref": "#/$defs/Priority"},
                    {"type": "null"},
                ],
                "description": "Optional priority level",
            },
        },
        "required": ["description", "priority"],
    }

    assert schema == expected_schema


def test_tool_nullable_optional_field_simplifies_anyof():
    """Test that a non-required nullable field still gets anyOf simplified."""

    @strands.tool
    def my_tool(name: str, tag: str | None = None) -> str:
        """A tool.

        Args:
            name: The name
            tag: An optional tag
        """
        return f"{name}: {tag}"

    spec = my_tool.tool_spec
    schema = spec["inputSchema"]["json"]

    # tag has a default, so it should NOT be required
    assert "name" in schema["required"]
    assert "tag" not in schema["required"]

    # Since tag is not required, anyOf should be simplified away
    assert "anyOf" not in schema["properties"]["tag"]
    assert schema["properties"]["tag"]["type"] == "string"
