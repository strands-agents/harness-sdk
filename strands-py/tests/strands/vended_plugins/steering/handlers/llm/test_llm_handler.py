"""Unit tests for LLM steering handler."""

from unittest.mock import AsyncMock, MagicMock, Mock

import pytest

from strands.vended_plugins.steering.core.action import Guide, Interrupt, Proceed
from strands.vended_plugins.steering.handlers.llm.llm_handler import LLMSteeringHandler, _LLMSteering
from strands.vended_plugins.steering.handlers.llm.mappers import DefaultPromptMapper
from tests.fixtures.mocked_structured_output_model import MockedStructuredOutputModel


def _mock_agent(model=None):
    """Build an agent stand-in the auxiliary model call can fire hooks and metrics on."""
    agent = Mock()
    agent.model = model
    agent.hooks.invoke_callbacks_async = AsyncMock()
    agent.event_loop_metrics = MagicMock()
    return agent


def test_llm_steering_handler_initialization():
    """Test LLMSteeringHandler initialization."""
    system_prompt = "You are a security evaluator"
    handler = LLMSteeringHandler(system_prompt)

    assert handler.system_prompt == system_prompt
    assert isinstance(handler.prompt_mapper, DefaultPromptMapper)
    assert handler.model is None


def test_llm_steering_handler_with_custom_mapper():
    """Test LLMSteeringHandler with custom prompt mapper."""
    system_prompt = "Test prompt"
    custom_mapper = Mock()
    handler = LLMSteeringHandler(system_prompt, prompt_mapper=custom_mapper)

    assert handler.prompt_mapper == custom_mapper


def test_llm_steering_handler_with_custom_context_providers():
    """Test LLMSteeringHandler with custom context providers."""
    system_prompt = "Test prompt"
    custom_provider = Mock()
    custom_provider.context_providers.return_value = [Mock(), Mock()]

    handler = LLMSteeringHandler(system_prompt, context_providers=[custom_provider])

    # Verify the provider's context_providers method was called
    custom_provider.context_providers.assert_called_once()
    # Verify the callbacks were stored
    assert len(handler._context_callbacks) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("decision", "exp_action"),
    [("proceed", Proceed), ("guide", Guide), ("interrupt", Interrupt)],
)
async def test_steer_maps_decision_to_action(decision, exp_action):
    """Test steer method maps each LLM decision to its steering action."""
    handler = LLMSteeringHandler("Test prompt")
    model = MockedStructuredOutputModel(_LLMSteering(decision=decision, reason="Because"))
    agent = _mock_agent(model)
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, exp_action)
    assert result.reason == "Because"
    assert model.system_prompts == ["Test prompt"]
    assert "test_tool" in model.prompts[0][0]["content"][0]["text"]


@pytest.mark.asyncio
async def test_steer_unknown_decision():
    """Test steer method with unknown decision defaults to proceed."""
    handler = LLMSteeringHandler("Test prompt")
    # model_construct bypasses the Literal validation an unknown decision would fail
    unknown = _LLMSteering.model_construct(decision="unknown", reason="Invalid decision")
    agent = _mock_agent(MockedStructuredOutputModel(unknown))
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert "Unknown LLM decision, defaulting to proceed" in result.reason


@pytest.mark.asyncio
async def test_steer_uses_custom_model():
    """Test steer method uses custom model when provided."""
    custom_model = MockedStructuredOutputModel(_LLMSteering(decision="proceed", reason="OK"))
    handler = LLMSteeringHandler("Test prompt", model=custom_model)
    agent = _mock_agent(MockedStructuredOutputModel(_LLMSteering(decision="interrupt", reason="Agent model")))
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert len(custom_model.prompts) == 1
    assert agent.model.prompts == []


@pytest.mark.asyncio
async def test_steer_uses_agent_model_when_no_custom_model():
    """Test steer method uses agent's model when no custom model provided."""
    handler = LLMSteeringHandler("Test prompt")
    agent = _mock_agent(MockedStructuredOutputModel(_LLMSteering(decision="proceed", reason="OK")))
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert len(agent.model.prompts) == 1


def test_llm_steering_model():
    """Test _LLMSteering pydantic model."""
    steering = _LLMSteering(decision="proceed", reason="Test reason")

    assert steering.decision == "proceed"
    assert steering.reason == "Test reason"


def test_llm_steering_invalid_decision():
    """Test _LLMSteering with invalid decision raises validation error."""
    with pytest.raises(ValueError):
        _LLMSteering(decision="invalid", reason="Test reason")
