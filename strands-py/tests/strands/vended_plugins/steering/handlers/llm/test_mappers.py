"""Unit tests for LLM steering prompt mappers."""

from strands.vended_plugins.steering.core.context import SteeringContext
from strands.vended_plugins.steering.handlers.llm.mappers import _STEERING_PROMPT_TEMPLATE, DefaultPromptMapper


def test_create_steering_prompt_with_tool_use():
    """Test prompt creation with tool use."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    steering_context.data.set("user_id", "123")
    steering_context.data.set("session", "abc")
    tool_use = {"name": "get_weather", "input": {"location": "Seattle"}}

    result = mapper.create_steering_prompt(steering_context, tool_use=tool_use)

    assert "# Steering Evaluation" in result
    assert "Tool: get_weather" in result
    assert '"location": "Seattle"' in result
    assert "tool call" in result
    assert "Tool Call" in result  # title case
    assert '"user_id": "123"' in result
    assert '"session": "abc"' in result


def test_create_steering_prompt_with_empty_context():
    """Test prompt creation with empty context."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    tool_use = {"name": "test_tool", "input": {}}

    result = mapper.create_steering_prompt(steering_context, tool_use=tool_use)

    assert "No context available" in result
    assert "Tool: test_tool" in result


def test_create_steering_prompt_general_evaluation():
    """Test prompt creation with no tool_use or kwargs."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    steering_context.data.set("data", "test")

    result = mapper.create_steering_prompt(steering_context)

    assert "# Steering Evaluation" in result
    assert "General evaluation" in result
    assert "action" in result
    assert '"data": "test"' in result


def test_prompt_contains_agent_sop_structure():
    """Test that prompt follows Agent SOP structure."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    steering_context.data.set("test", "data")

    result = mapper.create_steering_prompt(steering_context)

    # Check for Agent SOP sections
    assert "## Overview" in result
    assert "## Context" in result
    assert "## Event to Evaluate" in result
    assert "## Steps" in result
    assert "### 1. Analyze the Action" in result
    assert "### 2. Make Steering Decision" in result

    # Check for constraints
    assert "**Constraints:**" in result
    assert "You MUST" in result
    assert "You SHOULD" in result
    assert "You MAY" in result

    # Check for decision options
    assert '"proceed"' in result
    assert '"guide"' in result
    assert '"interrupt"' in result


def test_tool_use_input_field_handling():
    """Test that tool_use uses 'input' field correctly."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    tool_use = {"name": "calculator", "input": {"operation": "add", "a": 1, "b": 2}}

    result = mapper.create_steering_prompt(steering_context, tool_use=tool_use)

    assert "Tool: calculator" in result
    assert '"operation": "add"' in result
    assert '"a": 1' in result
    assert '"b": 2' in result


def test_context_json_formatting():
    """Test that context is properly JSON formatted."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    steering_context.data.set("nested", {"key": "value"})
    steering_context.data.set("list", [1, 2, 3])
    steering_context.data.set("string", "test")

    result = mapper.create_steering_prompt(steering_context)

    # Check that JSON is properly indented
    assert '{\n  "nested": {\n    "key": "value"\n  }' in result
    assert '"list": [\n    1,\n    2,\n    3\n  ]' in result


def test_template_constant_usage():
    """Test that the STEERING_PROMPT_TEMPLATE constant is used correctly."""
    mapper = DefaultPromptMapper()
    steering_context = SteeringContext()
    steering_context.data.set("test", "value")

    result = mapper.create_steering_prompt(steering_context)

    # Verify the template structure is present
    expected_sections = [
        "# Steering Evaluation",
        "## Overview",
        "## Context",
        "## Event to Evaluate",
        "## Steps",
        "### 1. Analyze the Action",
        "### 2. Make Steering Decision",
    ]

    for section in expected_sections:
        assert section in result
    # Verify template has placeholder structure
    assert "### 1. Analyze the {action_type_title}" in _STEERING_PROMPT_TEMPLATE
