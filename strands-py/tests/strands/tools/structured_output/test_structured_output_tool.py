"""Tests for StructuredOutputTool class."""

from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel, Field

from strands.tools.structured_output._structured_output_context import StructuredOutputContext
from strands.tools.structured_output.structured_output_tool import _TOOL_SPEC_CACHE, StructuredOutputTool
from strands.types._events import ToolResultEvent


class SimpleModel(BaseModel):
    """Simple test model."""

    name: str = Field(..., description="Name field")
    value: int = Field(..., description="Value field")


class ComplexModel(BaseModel):
    """Complex test model with nested structures."""

    title: str = Field(..., description="Title field")
    count: int = Field(..., ge=0, le=100, description="Count between 0 and 100")
    tags: list[str] = Field(default_factory=list, description="List of tags")
    metadata: dict | None = Field(None, description="Optional metadata")


class ValidationTestModel(BaseModel):
    """Model for testing validation."""

    email: str = Field(..., pattern=r"^[\w\.-]+@[\w\.-]+\.\w+$", description="Email address")
    age: int = Field(..., ge=0, le=150, description="Age between 0 and 150")
    status: str = Field(..., pattern="^(active|inactive|pending)$", description="Status")


class TestStructuredOutputTool:
    """Test suite for StructuredOutputTool."""

    def test_tool_initialization_with_simple_model(self):
        """Test tool initialization with a simple Pydantic model."""
        tool = StructuredOutputTool(SimpleModel)

        assert tool.structured_output_model == SimpleModel
        assert tool.tool_name == "SimpleModel"
        assert tool.tool_type == "structured_output"
        assert isinstance(tool.tool_spec, dict)
        assert tool.tool_spec["name"] == "SimpleModel"

    def test_tool_initialization_with_complex_model(self):
        """Test tool initialization with a complex Pydantic model."""
        tool = StructuredOutputTool(ComplexModel)

        assert tool.structured_output_model == ComplexModel
        assert tool.tool_name == "ComplexModel"
        assert tool.tool_type == "structured_output"
        assert isinstance(tool.tool_spec, dict)
        assert tool.tool_spec["name"] == "ComplexModel"

    def test_get_tool_spec_caching_mechanism(self):
        """Test that tool specs are cached properly."""
        # Clear cache first
        _TOOL_SPEC_CACHE.clear()

        # First call should create and cache the spec
        tool1 = StructuredOutputTool(SimpleModel)
        spec1 = tool1.tool_spec

        # Cache should now contain the spec
        assert SimpleModel in _TOOL_SPEC_CACHE

        # Second call with same model should use cached version
        tool2 = StructuredOutputTool(SimpleModel)
        spec2 = tool2.tool_spec

        # Specs should be equal but not the same object (deepcopy is used)
        assert spec1 == spec2
        assert spec1 is not spec2

        # Cache should still have only one entry for SimpleModel
        assert len([k for k in _TOOL_SPEC_CACHE if k == SimpleModel]) == 1

    def test_tool_name_property(self):
        """Test the tool_name property."""
        tool = StructuredOutputTool(SimpleModel)
        assert tool.tool_name == "SimpleModel"

        tool2 = StructuredOutputTool(ComplexModel)
        assert tool2.tool_name == "ComplexModel"

    def test_tool_spec_property(self):
        """Test the tool_spec property."""
        tool = StructuredOutputTool(SimpleModel)
        spec = tool.tool_spec

        assert isinstance(spec, dict)
        assert "name" in spec
        assert "description" in spec
        assert "inputSchema" in spec
        assert spec["name"] == "SimpleModel"

        # Check that description includes the important message
        assert "IMPORTANT: This StructuredOutputTool should only be invoked" in spec["description"]

    def test_tool_type_property(self):
        """Test that tool_type property returns 'structured_output'."""
        tool = StructuredOutputTool(SimpleModel)
        assert tool.tool_type == "structured_output"

    def test_structured_output_model_property(self):
        """Test the structured_output_model property."""
        tool = StructuredOutputTool(SimpleModel)
        assert tool.structured_output_model == SimpleModel

        tool2 = StructuredOutputTool(ComplexModel)
        assert tool2.structured_output_model == ComplexModel

    @pytest.mark.asyncio
    async def test_stream_with_valid_input(self):
        """Test stream method with valid input."""
        tool = StructuredOutputTool(SimpleModel)
        context = StructuredOutputContext(structured_output_model=SimpleModel)

        tool_use = {"name": "SimpleModel", "toolUseId": "test_123", "input": {"name": "Test Name", "value": 42}}

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        # Should have one ToolResultEvent
        assert len(events) == 1
        assert isinstance(events[0], ToolResultEvent)

        # Check the result
        result = events[0].tool_result
        assert result["toolUseId"] == "test_123"
        assert result["status"] == "success"
        assert "Successfully validated SimpleModel" in result["content"][0]["text"]

        # Check that result was stored in context
        stored_result = context.get_result("test_123")
        assert stored_result is not None
        assert stored_result.name == "Test Name"
        assert stored_result.value == 42

    @pytest.mark.asyncio
    async def test_stream_with_missing_fields(self):
        """Test stream method with missing required fields."""
        tool = StructuredOutputTool(SimpleModel)
        context = StructuredOutputContext(structured_output_model=SimpleModel)

        tool_use = {
            "name": "SimpleModel",
            "toolUseId": "test_789",
            "input": {
                "name": "Test Name"
                # Missing required 'value' field
            },
        }

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        # Should have one ToolResultEvent with error
        assert len(events) == 1
        assert isinstance(events[0], ToolResultEvent)

        # Check the error result
        result = events[0].tool_result
        assert result["toolUseId"] == "test_789"
        assert result["status"] == "error"

        error_text = result["content"][0]["text"]
        assert "Validation failed for SimpleModel" in error_text
        assert "Field 'value'" in error_text or "field required" in error_text.lower()

    @pytest.mark.asyncio
    async def test_stream_with_unexpected_exception(self):
        """Test stream method with unexpected exceptions."""
        tool = StructuredOutputTool(SimpleModel)
        context = MagicMock()

        # Mock the context to raise an unexpected exception
        context.store_result.side_effect = RuntimeError("Unexpected error")

        tool_use = {"name": "SimpleModel", "toolUseId": "test_error", "input": {"name": "Test", "value": 1}}

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        # Should have one ToolResultEvent with error
        assert len(events) == 1
        assert isinstance(events[0], ToolResultEvent)

        # Check the error result
        result = events[0].tool_result
        assert result["toolUseId"] == "test_error"
        assert result["status"] == "error"

        error_text = result["content"][0]["text"]
        assert "Unexpected error validating SimpleModel" in error_text
        assert "Unexpected error" in error_text

    @pytest.mark.asyncio
    async def test_error_message_formatting_single_error(self):
        """Test error message formatting with a single validation error."""
        tool = StructuredOutputTool(SimpleModel)
        context = StructuredOutputContext(structured_output_model=SimpleModel)

        tool_use = {
            "name": "SimpleModel",
            "toolUseId": "test_format_1",
            "input": {
                "name": "Test",
                "value": "not an integer",  # Wrong type
            },
        }

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        result = events[0].tool_result
        error_text = result["content"][0]["text"]

        # Check error formatting
        assert "Validation failed for SimpleModel" in error_text
        assert "Please fix the following errors:" in error_text
        assert "- Field 'value':" in error_text

    @pytest.mark.asyncio
    async def test_error_message_formatting_multiple_errors(self):
        """Test error message formatting with multiple validation errors."""
        tool = StructuredOutputTool(ValidationTestModel)
        context = StructuredOutputContext(structured_output_model=ValidationTestModel)

        tool_use = {
            "name": "ValidationTestModel",
            "toolUseId": "test_format_2",
            "input": {"email": "bad-email", "age": -5, "status": "invalid"},
        }

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        result = events[0].tool_result
        error_text = result["content"][0]["text"]

        # Check that multiple errors are formatted properly
        assert "Validation failed for ValidationTestModel" in error_text
        assert "Please fix the following errors:" in error_text
        # Should have multiple error lines
        error_lines = [line for line in error_text.split("\n") if line.startswith("- Field")]
        assert len(error_lines) >= 2  # At least 2 validation errors

    @pytest.mark.asyncio
    async def test_stream_with_complex_nested_data(self):
        """Test stream method with complex nested data."""
        tool = StructuredOutputTool(ComplexModel)
        context = StructuredOutputContext(structured_output_model=ComplexModel)

        tool_use = {
            "name": "ComplexModel",
            "toolUseId": "test_complex",
            "input": {
                "title": "Test Title",
                "count": 50,
                "tags": ["tag1", "tag2", "tag3"],
                "metadata": {"key1": "value1", "key2": 123},
            },
        }

        # Call stream method
        events = []
        async for event in tool.stream(tool_use, {}, structured_output_context=context):
            events.append(event)

        # Check success
        result = events[0].tool_result
        assert result["status"] == "success"

        # Check stored result
        stored_result = context.get_result("test_complex")
        assert stored_result.title == "Test Title"
        assert stored_result.count == 50
        assert stored_result.tags == ["tag1", "tag2", "tag3"]
        assert stored_result.metadata == {"key1": "value1", "key2": 123}

    def test_tool_spec_description_modification(self):
        """Test that tool spec description is properly modified."""
        tool = StructuredOutputTool(SimpleModel)
        spec = tool.tool_spec

        # Check that the IMPORTANT message is prepended
        assert spec["description"].startswith("IMPORTANT: This StructuredOutputTool should only be invoked")
        assert "last and final tool" in spec["description"]
        assert "<description>" in spec["description"]
        assert "</description>" in spec["description"]
