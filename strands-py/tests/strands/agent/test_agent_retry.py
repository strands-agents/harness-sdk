"""Integration tests for Agent retry_strategy parameter."""

from unittest.mock import Mock

import pytest

from strands import Agent, ModelRetryStrategy
from strands.event_loop.event_loop import INITIAL_DELAY, MAX_ATTEMPTS, MAX_DELAY
from strands.hooks import AfterModelCallEvent
from strands.types.exceptions import ModelThrottledException
from tests.fixtures.mocked_model_provider import MockedModelProvider

# Agent Retry Strategy Initialization Tests


def test_agent_with_default_retry_strategy():
    """Test that Agent uses ModelRetryStrategy by default when retry_strategy is not provided."""
    agent = Agent()

    # Should have a retry_strategy
    assert agent._retry_strategy is not None

    # Should be ModelRetryStrategy with default parameters
    assert isinstance(agent._retry_strategy, ModelRetryStrategy)
    assert agent._retry_strategy._max_attempts == 6
    assert agent._retry_strategy._initial_delay == 4
    assert agent._retry_strategy._max_delay == 240


def test_agent_with_retry_strategy_none_disables_retries():
    """Test that Agent disables retries when retry_strategy=None is explicitly passed."""
    agent = Agent(retry_strategy=None)

    # Should have a retry_strategy with max_attempts=1 (no retries)
    assert agent._retry_strategy is not None
    assert isinstance(agent._retry_strategy, ModelRetryStrategy)
    assert agent._retry_strategy._max_attempts == 1


def test_agent_with_custom_model_retry_strategy():
    """Test Agent initialization with custom ModelRetryStrategy parameters."""
    custom_strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    agent = Agent(retry_strategy=custom_strategy)

    assert agent._retry_strategy is custom_strategy
    assert agent._retry_strategy._max_attempts == 3
    assert agent._retry_strategy._initial_delay == 2
    assert agent._retry_strategy._max_delay == 60


def test_agent_rejects_invalid_retry_strategy_type():
    """Test that Agent raises ValueError for non-ModelRetryStrategy retry_strategy."""

    class FakeRetryStrategy:
        pass

    with pytest.raises(ValueError, match="retry_strategy must be an instance of ModelRetryStrategy"):
        Agent(retry_strategy=FakeRetryStrategy())


def test_agent_accepts_subclass_of_model_retry_strategy():
    """Test that Agent accepts subclasses of ModelRetryStrategy."""

    class CustomRetryStrategy(ModelRetryStrategy):
        pass

    Agent(retry_strategy=CustomRetryStrategy())  # does not raise


def test_agent_default_retry_strategy_uses_event_loop_constants():
    """Test that default retry strategy uses constants from event_loop module."""
    agent = Agent()

    assert agent._retry_strategy._max_attempts == MAX_ATTEMPTS
    assert agent._retry_strategy._initial_delay == INITIAL_DELAY
    assert agent._retry_strategy._max_delay == MAX_DELAY


def test_retry_strategy_registered_as_hook():
    """Test that retry_strategy is registered with the hook system."""
    custom_strategy = ModelRetryStrategy(max_attempts=3)
    agent = Agent(retry_strategy=custom_strategy)

    # Verify retry strategy callback is registered
    callbacks = list(agent.hooks.get_callbacks_for(AfterModelCallEvent(agent=agent, exception=None)))

    # Should have at least one callback (from retry strategy)
    assert len(callbacks) > 0

    # Verify one of the callbacks is from the retry strategy
    assert any(
        callback.__self__ is custom_strategy if hasattr(callback, "__self__") else False for callback in callbacks
    )


# Agent Retry Behavior Tests


@pytest.mark.asyncio
async def test_agent_retries_with_default_strategy(mock_sleep):
    """Test that Agent retries on throttling with default ModelRetryStrategy."""
    # Create a model that fails twice with throttling, then succeeds
    model = Mock()
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException"),
        ModelThrottledException("ThrottlingException"),
        MockedModelProvider([{"role": "assistant", "content": [{"text": "Success after retries"}]}]).stream([]),
    ]

    agent = Agent(model=model)

    result = agent.stream_async("test prompt")
    events = [event async for event in result]

    # Should have succeeded after retries - just check we got events
    assert len(events) > 0

    # Should have slept twice (for two retries)
    assert len(mock_sleep.sleep_calls) == 2
    # First retry: 4 seconds
    assert mock_sleep.sleep_calls[0] == 4
    # Second retry: 8 seconds (exponential backoff)
    assert mock_sleep.sleep_calls[1] == 8


@pytest.mark.asyncio
async def test_agent_respects_max_attempts(mock_sleep):
    """Test that Agent respects max_attempts in retry strategy."""
    # Create a model that always fails
    model = Mock()
    model.stream.side_effect = ModelThrottledException("ThrottlingException")

    # Use custom strategy with max 2 attempts
    custom_strategy = ModelRetryStrategy(max_attempts=2, initial_delay=1, max_delay=60)
    agent = Agent(model=model, retry_strategy=custom_strategy)

    with pytest.raises(ModelThrottledException):
        result = agent.stream_async("test prompt")
        _ = [event async for event in result]

    # Should have attempted max_attempts times, which means (max_attempts - 1) sleeps
    # Attempt 0: fail, sleep
    # Attempt 1: fail, no more attempts
    assert len(mock_sleep.sleep_calls) == 1


# Backwards Compatibility Tests


@pytest.mark.asyncio
async def test_event_loop_throttle_event_emitted(mock_sleep):
    """Test that EventLoopThrottleEvent is still emitted for backwards compatibility."""
    # Create a model that fails once with throttling, then succeeds
    model = Mock()
    model.stream.side_effect = [
        ModelThrottledException("ThrottlingException"),
        MockedModelProvider([{"role": "assistant", "content": [{"text": "Success"}]}]).stream([]),
    ]

    agent = Agent(model=model)

    result = agent.stream_async("test prompt")
    events = [event async for event in result]

    # Should have EventLoopThrottleEvent in the stream
    throttle_events = [e for e in events if "event_loop_throttled_delay" in e]
    assert len(throttle_events) > 0

    # Should have the correct delay value
    assert throttle_events[0]["event_loop_throttled_delay"] > 0


@pytest.mark.asyncio
async def test_agent_no_retry_when_retry_strategy_none(mock_sleep):
    """Test that Agent does not retry when retry_strategy=None."""
    # Create a model that fails with throttling
    model = Mock()
    model.stream.side_effect = ModelThrottledException("ThrottlingException")

    # Explicitly disable retries
    agent = Agent(model=model, retry_strategy=None)

    with pytest.raises(ModelThrottledException):
        result = agent.stream_async("test prompt")
        _ = [event async for event in result]

    # Should not have slept at all (no retries)
    assert len(mock_sleep.sleep_calls) == 0
