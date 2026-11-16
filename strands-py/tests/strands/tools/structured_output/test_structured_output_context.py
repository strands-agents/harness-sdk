"""Tests for StructuredOutputContext class."""

import pytest
from pydantic import BaseModel, Field

from strands.tools.registry import ToolRegistry
from strands.tools.structured_output._structured_output_context import (
    _NO_STRUCTURED_OUTPUT_MESSAGE,
    DEFAULT_STRUCTURED_OUTPUT_PROMPT,
    StructuredOutputContext,
    json_object_from_message,
)
from strands.tools.structured_output.structured_output_tool import StructuredOutputTool
from strands.types.exceptions import StructuredOutputException
from tests.fixtures.mock_agent_tool import MockAgentTool


class SampleModel(BaseModel):
    """Test Pydantic model for testing."""

    name: str = Field(..., description="Name field")
    age: int = Field(..., description="Age field", ge=0)
    email: str | None = Field(None, description="Optional email field")


class AnotherSampleModel(BaseModel):
    """Another test Pydantic model."""

    value: str
    count: int


class TestStructuredOutputContext:
    """Test suite for StructuredOutputContext."""

    def test_initialization_with_structured_output_model(self):
        """Test initialization with a structured output model."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        assert context.structured_output_model == SampleModel
        assert isinstance(context.structured_output_tool, StructuredOutputTool)
        assert context.expected_tool_name == "SampleModel"
        assert context.results == {}
        assert context.forced_mode is False
        assert context.tool_choice is None
        assert context.stop_loop is False
        assert context.structured_output_prompt == DEFAULT_STRUCTURED_OUTPUT_PROMPT

    def test_initialization_without_structured_output_model(self):
        """Test initialization without a structured output model."""
        context = StructuredOutputContext(structured_output_model=None)

        assert context.structured_output_model is None
        assert context.structured_output_tool is None
        assert context.expected_tool_name is None
        assert context.results == {}
        assert context.forced_mode is False
        assert context.tool_choice is None
        assert context.stop_loop is False
        assert context.structured_output_prompt == DEFAULT_STRUCTURED_OUTPUT_PROMPT

    def test_initialization_with_custom_prompt(self):
        """Test initialization with a custom structured output prompt."""
        custom_prompt = "Please format your response using the output schema."
        context = StructuredOutputContext(
            structured_output_model=SampleModel,
            structured_output_prompt=custom_prompt,
        )

        assert context.structured_output_model == SampleModel
        assert context.structured_output_prompt == custom_prompt

    def test_initialization_with_none_prompt_uses_default(self):
        """Test that None prompt falls back to default."""
        context = StructuredOutputContext(
            structured_output_model=SampleModel,
            structured_output_prompt=None,
        )

        assert context.structured_output_prompt == DEFAULT_STRUCTURED_OUTPUT_PROMPT

    def test_default_prompt_constant_value(self):
        """Test the default prompt constant has expected value."""
        assert DEFAULT_STRUCTURED_OUTPUT_PROMPT == "You must format the previous response as structured output."

    def test_is_enabled_property(self):
        """Test the is_enabled property."""
        # Test with model
        context_with_model = StructuredOutputContext(structured_output_model=SampleModel)
        assert context_with_model.is_enabled is True

        # Test without model
        context_without_model = StructuredOutputContext(structured_output_model=None)
        assert context_without_model.is_enabled is False

    def test_store_result_and_get_result(self):
        """Test storing and retrieving results."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        # Create test result
        test_result = SampleModel(name="John Doe", age=30, email="john@example.com")
        tool_use_id = "test_tool_use_123"

        # Store result
        context.store_result(tool_use_id, test_result)
        assert tool_use_id in context.results
        assert context.results[tool_use_id] == test_result

        # Retrieve result
        retrieved_result = context.get_result(tool_use_id)
        assert retrieved_result == test_result

        # Test retrieving non-existent result
        non_existent = context.get_result("non_existent_id")
        assert non_existent is None

    def test_set_forced_mode_with_tool_choice(self):
        """Test set_forced_mode with custom tool_choice."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        custom_tool_choice = {"specific": {"tool": "SampleModel"}}
        context.set_forced_mode(tool_choice=custom_tool_choice)

        assert context.forced_mode is True
        assert context.tool_choice == custom_tool_choice

    def test_set_forced_mode_without_tool_choice(self):
        """Test set_forced_mode without tool_choice (default)."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        context.set_forced_mode()

        assert context.forced_mode is True
        assert context.tool_choice == {"any": {}}

    def test_set_forced_mode_when_disabled(self):
        """Test set_forced_mode when context is not enabled."""
        context = StructuredOutputContext(structured_output_model=None)

        # Should not change state when not enabled
        context.set_forced_mode(tool_choice={"test": "value"})

        assert context.forced_mode is False
        assert context.tool_choice is None

    def test_has_structured_output_tool(self):
        """Test has_structured_output_tool method."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        # Create tool uses with the expected tool
        tool_uses_with_output = [
            {"name": "SampleModel", "toolUseId": "123", "input": {}},
            {"name": "OtherTool", "toolUseId": "456", "input": {}},
        ]

        # Should find the structured output tool
        assert context.has_structured_output_tool(tool_uses_with_output) is True

        # Create tool uses without the expected tool
        tool_uses_without_output = [
            {"name": "OtherTool", "toolUseId": "456", "input": {}},
            {"name": "AnotherTool", "toolUseId": "789", "input": {}},
        ]

        # Should not find the structured output tool
        assert context.has_structured_output_tool(tool_uses_without_output) is False

        # Test with empty list
        assert context.has_structured_output_tool([]) is False

    def test_has_structured_output_tool_when_disabled(self):
        """Test has_structured_output_tool when no expected tool name."""
        context = StructuredOutputContext(structured_output_model=None)

        tool_uses = [
            {"name": "SampleModel", "toolUseId": "123", "input": {}},
        ]

        # Should return False when no expected tool name
        assert context.has_structured_output_tool(tool_uses) is False

    def test_get_tool_spec(self):
        """Test get_tool_spec method."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        tool_spec = context.get_tool_spec()
        assert tool_spec is not None
        assert isinstance(tool_spec, dict)
        assert "name" in tool_spec
        assert tool_spec["name"] == "SampleModel"
        assert "description" in tool_spec
        assert "inputSchema" in tool_spec

    def test_get_tool_spec_when_disabled(self):
        """Test get_tool_spec when no structured output tool."""
        context = StructuredOutputContext(structured_output_model=None)

        tool_spec = context.get_tool_spec()
        assert tool_spec is None

    def test_extract_result(self):
        """Test extract_result method."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        # Store some results
        result1 = SampleModel(name="Alice", age=25)
        result2 = SampleModel(name="Bob", age=30)
        context.store_result("tool_use_1", result1)
        context.store_result("tool_use_2", result2)

        # Create tool uses with matching tool
        tool_uses = [
            {"name": "SampleModel", "toolUseId": "tool_use_1", "input": {}},
            {"name": "OtherTool", "toolUseId": "tool_use_3", "input": {}},
        ]

        # Extract result should return and remove the first matching result
        extracted = context.extract_result(tool_uses)
        assert extracted == result1
        assert "tool_use_1" not in context.results
        assert "tool_use_2" in context.results  # Other result should remain

    def test_extract_result_no_matching_tool(self):
        """Test extract_result when no matching tool in tool_uses."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        result = SampleModel(name="Alice", age=25)
        context.store_result("tool_use_1", result)

        # Tool uses without the expected tool name
        tool_uses = [
            {"name": "OtherTool", "toolUseId": "tool_use_1", "input": {}},
        ]

        # Should return None
        extracted = context.extract_result(tool_uses)
        assert extracted is None
        assert "tool_use_1" in context.results  # Result should remain

    def test_extract_result_no_stored_result(self):
        """Test extract_result when no stored result for tool use."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        # Tool uses with matching tool but no stored result
        tool_uses = [
            {"name": "SampleModel", "toolUseId": "tool_use_1", "input": {}},
        ]

        # Should return None
        extracted = context.extract_result(tool_uses)
        assert extracted is None

    def test_extract_result_multiple_matching_tools(self):
        """Test extract_result with multiple matching tool uses."""
        context = StructuredOutputContext(structured_output_model=SampleModel)

        # Store multiple results
        result1 = SampleModel(name="Alice", age=25)
        result2 = SampleModel(name="Bob", age=30)
        context.store_result("tool_use_1", result1)
        context.store_result("tool_use_2", result2)

        # Multiple matching tool uses
        tool_uses = [
            {"name": "SampleModel", "toolUseId": "tool_use_1", "input": {}},
            {"name": "SampleModel", "toolUseId": "tool_use_2", "input": {}},
        ]

        # Should extract the first matching result
        extracted = context.extract_result(tool_uses)
        assert extracted == result1
        assert "tool_use_1" not in context.results
        assert "tool_use_2" in context.results

        # Extract again for the second result
        extracted2 = context.extract_result(tool_uses)
        assert extracted2 == result2
        assert "tool_use_2" not in context.results


@pytest.mark.parametrize("registration", ["regular", "dynamic", "temporary", "missing"])
def test_cleanup_removes_only_structured_output_tool(registration):
    context = StructuredOutputContext(structured_output_model=SampleModel)
    registry = ToolRegistry()
    retained_tool = MockAgentTool("retained")
    retained_tool.mark_dynamic()
    registry.register_tool(retained_tool)
    output_tool = context.structured_output_tool
    if registration == "dynamic":
        output_tool.mark_dynamic()
    if registration == "temporary":
        context.register_tool(registry)
    elif registration != "missing":
        registry.register_tool(output_tool)

    context.cleanup(registry)
    context.cleanup(registry)

    tru_registries = (registry.registry, registry.dynamic_tools)
    exp_registries = ({retained_tool.tool_name: retained_tool}, {retained_tool.tool_name: retained_tool})
    assert tru_registries == exp_registries


def test_cleanup_when_disabled():
    context = StructuredOutputContext(structured_output_model=None)
    registry = ToolRegistry()
    retained_tool = MockAgentTool("retained")
    registry.register_tool(retained_tool)

    context.cleanup(registry)

    tru_registries = (registry.registry, registry.dynamic_tools)
    exp_registries = ({retained_tool.tool_name: retained_tool}, {})
    assert tru_registries == exp_registries


def _text_message(*texts):
    return {"role": "assistant", "content": [{"text": text} for text in texts]}


@pytest.mark.parametrize(
    ("message", "exp_data"),
    [
        (_text_message('{"name": "Alice", "age": 25}'), {"name": "Alice", "age": 25}),
        (_text_message('{"name": "Alice",', ' "age": 25}'), {"name": "Alice", "age": 25}),
        (_text_message("[1, 2]"), None),
        (_text_message('Here it is: {"name": "Alice"}'), None),
        (
            {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "SampleModel", "input": {}}}]},
            None,
        ),
    ],
)
def test_json_object_from_message(message, exp_data):
    tru_data = json_object_from_message(message)

    assert tru_data == exp_data


def test_result_from_text():
    context = StructuredOutputContext(structured_output_model=SampleModel)

    tru_result = context.result_from_text(_text_message('{"name": "Alice", "age": 25}'))
    exp_result = SampleModel(name="Alice", age=25)

    assert tru_result == exp_result


@pytest.mark.parametrize(
    ("structured_output_model", "text", "exp_message"),
    [
        (SampleModel, "Alice is 25", _NO_STRUCTURED_OUTPUT_MESSAGE),
        (None, '{"name": "Alice", "age": 25}', _NO_STRUCTURED_OUTPUT_MESSAGE),
        (SampleModel, '{"name": "Alice", "age": -1}', "Structured output failed validation for SampleModel"),
    ],
)
def test_result_from_text_without_valid_json_object(structured_output_model, text, exp_message):
    context = StructuredOutputContext(structured_output_model=structured_output_model)

    with pytest.raises(StructuredOutputException, match=exp_message):
        context.result_from_text(_text_message(text))
