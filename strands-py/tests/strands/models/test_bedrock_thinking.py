"""Tests for thinking mode behavior in BedrockModel."""

import pytest

from strands.models.bedrock import BedrockModel


@pytest.fixture
def model_with_thinking():
    """Create a BedrockModel with thinking enabled."""
    return BedrockModel(
        model_id="anthropic.claude-sonnet-4-6",
        additional_request_fields={"thinking": {"type": "enabled", "budget_tokens": 5000}},
    )


@pytest.fixture
def model_without_thinking():
    """Create a BedrockModel without thinking."""
    return BedrockModel(model_id="anthropic.claude-sonnet-4-6")


@pytest.fixture
def model_with_thinking_and_other_fields():
    """Create a BedrockModel with thinking and other additional fields."""
    return BedrockModel(
        model_id="anthropic.claude-sonnet-4-6",
        additional_request_fields={
            "thinking": {"type": "enabled", "budget_tokens": 5000},
            "some_other_field": "value",
        },
    )


def test_thinking_removed_when_forcing_tool_any(model_with_thinking):
    """Thinking should be removed when tool_choice forces tool use with 'any'."""
    tool_choice = {"any": {}}
    result = model_with_thinking._get_additional_request_fields(tool_choice)
    assert result == {}  # thinking removed, no other fields


def test_thinking_removed_when_forcing_specific_tool(model_with_thinking):
    """Thinking should be removed when tool_choice forces a specific tool."""
    tool_choice = {"tool": {"name": "structured_output_tool"}}
    result = model_with_thinking._get_additional_request_fields(tool_choice)
    assert result == {}  # thinking removed, no other fields


def test_thinking_preserved_with_auto_tool_choice(model_with_thinking):
    """Thinking should be preserved when tool_choice is 'auto'."""
    tool_choice = {"auto": {}}
    result = model_with_thinking._get_additional_request_fields(tool_choice)
    assert result == {"additionalModelRequestFields": {"thinking": {"type": "enabled", "budget_tokens": 5000}}}


def test_thinking_preserved_with_none_tool_choice(model_with_thinking):
    """Thinking should be preserved when tool_choice is None."""
    result = model_with_thinking._get_additional_request_fields(None)
    assert result == {"additionalModelRequestFields": {"thinking": {"type": "enabled", "budget_tokens": 5000}}}


def test_other_fields_preserved_when_thinking_removed(model_with_thinking_and_other_fields):
    """Other additional fields should be preserved when thinking is removed."""
    tool_choice = {"any": {}}
    result = model_with_thinking_and_other_fields._get_additional_request_fields(tool_choice)
    assert result == {"additionalModelRequestFields": {"some_other_field": "value"}}


def test_no_fields_when_model_has_no_additional_fields(model_without_thinking):
    """Should return empty dict when model has no additional_request_fields."""
    tool_choice = {"any": {}}
    result = model_without_thinking._get_additional_request_fields(tool_choice)
    assert result == {}


def test_fields_preserved_when_no_thinking_and_forcing_tool():
    """Additional fields without thinking should be preserved when forcing tool."""
    model = BedrockModel(
        model_id="anthropic.claude-sonnet-4-6",
        additional_request_fields={"some_field": "value"},
    )
    tool_choice = {"any": {}}
    result = model._get_additional_request_fields(tool_choice)
    assert result == {"additionalModelRequestFields": {"some_field": "value"}}
