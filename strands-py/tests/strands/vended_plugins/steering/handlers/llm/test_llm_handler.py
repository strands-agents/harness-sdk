"""Unit tests for LLM steering handler."""

from unittest.mock import AsyncMock, Mock, patch

import pytest

from strands.vended_plugins.steering.core.action import Guide, Interrupt, Proceed
from strands.vended_plugins.steering.handlers.llm.llm_handler import LLMSteeringHandler, _LLMSteering
from strands.vended_plugins.steering.handlers.llm.mappers import DefaultPromptMapper


def _mock_host_agent():
    agent = Mock()

    async def invoke_auxiliary_async(auxiliary_agent, prompt, *, source, **kwargs):
        return await auxiliary_agent.invoke_async(prompt, **kwargs)

    agent.invoke_auxiliary_async = invoke_auxiliary_async
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
@patch("strands.agent.Agent")
async def test_steer_proceed_decision(mock_agent_class):
    """Test steer method with proceed decision."""
    system_prompt = "Test prompt"
    handler = LLMSteeringHandler(system_prompt)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    mock_result = Mock()
    mock_result.structured_output = _LLMSteering(decision="proceed", reason="Tool call is safe")
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert result.reason == "Tool call is safe"


@pytest.mark.asyncio
@patch("strands.agent.Agent")
async def test_steer_guide_decision(mock_agent_class):
    """Test steer method with guide decision."""
    system_prompt = "Test prompt"
    handler = LLMSteeringHandler(system_prompt)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    mock_result = Mock()
    mock_result.structured_output = _LLMSteering(decision="guide", reason="Consider security implications")
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Guide)
    assert result.reason == "Consider security implications"


@pytest.mark.asyncio
@patch("strands.agent.Agent")
async def test_steer_interrupt_decision(mock_agent_class):
    """Test steer method with interrupt decision."""
    system_prompt = "Test prompt"
    handler = LLMSteeringHandler(system_prompt)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    mock_result = Mock()
    mock_result.structured_output = _LLMSteering(decision="interrupt", reason="Human approval required")
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Interrupt)
    assert result.reason == "Human approval required"


@pytest.mark.asyncio
@patch("strands.agent.Agent")
async def test_steer_unknown_decision(mock_agent_class):
    """Test steer method with unknown decision defaults to proceed."""
    system_prompt = "Test prompt"
    handler = LLMSteeringHandler(system_prompt)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    # Mock _LLMSteering with unknown decision (bypass validation)
    mock_steering_decision = Mock()
    mock_steering_decision.decision = "unknown"
    mock_steering_decision.reason = "Invalid decision"

    mock_result = Mock()
    mock_result.structured_output = mock_steering_decision
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    result = await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    assert isinstance(result, Proceed)
    assert "Unknown LLM decision, defaulting to proceed" in result.reason


@pytest.mark.asyncio
@patch("strands.agent.Agent")
async def test_steer_uses_custom_model(mock_agent_class):
    """Test steer method uses custom model when provided."""
    system_prompt = "Test prompt"
    custom_model = Mock()
    handler = LLMSteeringHandler(system_prompt, model=custom_model)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    mock_result = Mock()
    mock_result.structured_output = _LLMSteering(decision="proceed", reason="OK")
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    agent.model = Mock()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    mock_agent_class.assert_called_once_with(system_prompt=system_prompt, model=custom_model, callback_handler=None)


@pytest.mark.asyncio
@patch("strands.agent.Agent")
async def test_steer_uses_agent_model_when_no_custom_model(mock_agent_class):
    """Test steer method uses agent's model when no custom model provided."""
    system_prompt = "Test prompt"
    handler = LLMSteeringHandler(system_prompt)

    mock_steering_agent = Mock()
    mock_agent_class.return_value = mock_steering_agent

    mock_result = Mock()
    mock_result.structured_output = _LLMSteering(decision="proceed", reason="OK")
    mock_steering_agent.invoke_async = AsyncMock(return_value=mock_result)

    agent = _mock_host_agent()
    agent.model = Mock()
    tool_use = {"name": "test_tool", "input": {"param": "value"}}

    await handler.steer_before_tool(agent=agent, tool_use=tool_use)

    mock_agent_class.assert_called_once_with(system_prompt=system_prompt, model=agent.model, callback_handler=None)


def test_llm_steering_model():
    """Test _LLMSteering pydantic model."""
    steering = _LLMSteering(decision="proceed", reason="Test reason")

    assert steering.decision == "proceed"
    assert steering.reason == "Test reason"


def test_llm_steering_invalid_decision():
    """Test _LLMSteering with invalid decision raises validation error."""
    with pytest.raises(ValueError):
        _LLMSteering(decision="invalid", reason="Test reason")
