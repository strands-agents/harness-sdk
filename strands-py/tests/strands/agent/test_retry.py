"""Unit tests for retry strategy implementations."""

from unittest.mock import Mock

import pytest

from strands import ModelRetryStrategy
from strands.hooks import AfterInvocationEvent, AfterModelCallEvent, HookRegistry
from strands.types._events import EventLoopThrottleEvent
from strands.types.exceptions import ModelThrottledException

# ModelRetryStrategy Tests


def test_model_retry_strategy_init_with_defaults():
    """Test ModelRetryStrategy initialization with default parameters."""
    strategy = ModelRetryStrategy()
    assert strategy._max_attempts == 6
    assert strategy._initial_delay == 4
    assert strategy._max_delay == 240
    assert strategy._current_attempt == 0


def test_model_retry_strategy_init_with_custom_parameters():
    """Test ModelRetryStrategy initialization with custom parameters."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    assert strategy._max_attempts == 3
    assert strategy._initial_delay == 2
    assert strategy._max_delay == 60
    assert strategy._current_attempt == 0


def test_model_retry_strategy_calculate_delay_with_different_attempts():
    """Test _calculate_delay returns correct exponential backoff for different attempt numbers."""
    strategy = ModelRetryStrategy(initial_delay=2, max_delay=32)

    # Test exponential backoff: 2 * (2^attempt)
    assert strategy._calculate_delay(0) == 2  # 2 * 2^0 = 2
    assert strategy._calculate_delay(1) == 4  # 2 * 2^1 = 4
    assert strategy._calculate_delay(2) == 8  # 2 * 2^2 = 8
    assert strategy._calculate_delay(3) == 16  # 2 * 2^3 = 16
    assert strategy._calculate_delay(4) == 32  # 2 * 2^4 = 32 (at max)
    assert strategy._calculate_delay(5) == 32  # 2 * 2^5 = 64, capped at 32
    assert strategy._calculate_delay(10) == 32  # Large attempt, still capped


def test_model_retry_strategy_calculate_delay_respects_max_delay():
    """Test _calculate_delay respects max_delay cap."""
    strategy = ModelRetryStrategy(initial_delay=10, max_delay=50)

    assert strategy._calculate_delay(0) == 10  # 10 * 2^0 = 10
    assert strategy._calculate_delay(1) == 20  # 10 * 2^1 = 20
    assert strategy._calculate_delay(2) == 40  # 10 * 2^2 = 40
    assert strategy._calculate_delay(3) == 50  # 10 * 2^3 = 80, capped at 50
    assert strategy._calculate_delay(4) == 50  # 10 * 2^4 = 160, capped at 50


def test_model_retry_strategy_register_hooks():
    """Test that ModelRetryStrategy registers AfterModelCallEvent and AfterInvocationEvent callbacks."""
    strategy = ModelRetryStrategy()
    registry = HookRegistry()

    strategy.register_hooks(registry)

    # Verify AfterModelCallEvent callback was registered
    assert AfterModelCallEvent in registry._registered_callbacks
    assert len(registry._registered_callbacks[AfterModelCallEvent]) == 1

    # Verify AfterInvocationEvent callback was registered
    assert AfterInvocationEvent in registry._registered_callbacks
    assert len(registry._registered_callbacks[AfterInvocationEvent]) == 1


@pytest.mark.asyncio
async def test_model_retry_strategy_retry_on_throttle_exception_first_attempt(mock_sleep):
    """Test retry behavior on first ModelThrottledException."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )

    await strategy._handle_after_model_call(event)

    # Should set retry to True
    assert event.retry is True
    # Should sleep for initial_delay (attempt 0: 2 * 2^0 = 2)
    assert mock_sleep.sleep_calls == [2]
    assert mock_sleep.sleep_calls[0] == strategy._calculate_delay(0)
    # Should increment attempt
    assert strategy._current_attempt == 1


@pytest.mark.asyncio
async def test_model_retry_strategy_exponential_backoff(mock_sleep):
    """Test exponential backoff calculation."""
    strategy = ModelRetryStrategy(max_attempts=5, initial_delay=2, max_delay=16)
    mock_agent = Mock()

    # Simulate multiple retries
    for _ in range(4):
        event = AfterModelCallEvent(
            agent=mock_agent,
            exception=ModelThrottledException("Throttled"),
        )
        await strategy._handle_after_model_call(event)
        assert event.retry is True

    # Verify exponential backoff with max_delay cap
    # attempt 0: 2*2^0=2, attempt 1: 2*2^1=4, attempt 2: 2*2^2=8, attempt 3: 2*2^3=16 (capped)
    assert mock_sleep.sleep_calls == [2, 4, 8, 16]
    for i, sleep_delay in enumerate(mock_sleep.sleep_calls):
        assert sleep_delay == strategy._calculate_delay(i)


@pytest.mark.asyncio
async def test_model_retry_strategy_no_retry_after_max_attempts(mock_sleep):
    """Test that retry is not set after reaching max_attempts."""
    strategy = ModelRetryStrategy(max_attempts=2, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    # First attempt
    event1 = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )
    await strategy._handle_after_model_call(event1)
    assert event1.retry is True
    assert strategy._current_attempt == 1

    # Second attempt (at max_attempts)
    event2 = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )
    await strategy._handle_after_model_call(event2)
    # Should NOT retry after reaching max_attempts
    assert event2.retry is False
    assert strategy._current_attempt == 2


@pytest.mark.asyncio
async def test_model_retry_strategy_no_retry_on_non_throttle_exception():
    """Test that retry is not set for non-throttling exceptions."""
    strategy = ModelRetryStrategy()
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=ValueError("Some other error"),
    )

    await strategy._handle_after_model_call(event)

    # Should not retry on non-throttling exceptions
    assert event.retry is False
    assert strategy._current_attempt == 0


@pytest.mark.asyncio
async def test_model_retry_strategy_no_retry_on_success():
    """Test that retry is not set when model call succeeds."""
    strategy = ModelRetryStrategy()
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={"role": "assistant", "content": [{"text": "Success"}]},
            stop_reason="end_turn",
        ),
    )

    await strategy._handle_after_model_call(event)

    # Should not retry on success
    assert event.retry is False


@pytest.mark.asyncio
async def test_model_retry_strategy_reset_on_success(mock_sleep):
    """Test that strategy resets attempt counter on successful call."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    # First failure
    event1 = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )
    await strategy._handle_after_model_call(event1)
    assert event1.retry is True
    assert strategy._current_attempt == 1
    # Should sleep for initial_delay (attempt 0: 2 * 2^0 = 2)
    assert mock_sleep.sleep_calls == [2]
    assert mock_sleep.sleep_calls[0] == strategy._calculate_delay(0)

    # Success - should reset
    event2 = AfterModelCallEvent(
        agent=mock_agent,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={"role": "assistant", "content": [{"text": "Success"}]},
            stop_reason="end_turn",
        ),
    )
    await strategy._handle_after_model_call(event2)
    assert event2.retry is False
    # Should reset to initial state
    assert strategy._current_attempt == 0
    assert strategy._calculate_delay(0) == 2


@pytest.mark.asyncio
async def test_model_retry_strategy_skips_if_already_retrying():
    """Test that strategy skips processing if event.retry is already True."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )
    # Simulate another hook already set retry to True
    event.retry = True

    await strategy._handle_after_model_call(event)

    # Should not modify state since another hook already triggered retry
    assert strategy._current_attempt == 0
    assert event.retry is True


@pytest.mark.asyncio
async def test_model_retry_strategy_reset_on_after_invocation():
    """Test that strategy resets state on AfterInvocationEvent."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    # Simulate some retry attempts
    strategy._current_attempt = 3

    event = AfterInvocationEvent(agent=mock_agent, result=Mock())
    await strategy._handle_after_invocation(event)

    # Should reset to initial state
    assert strategy._current_attempt == 0


@pytest.mark.asyncio
async def test_model_retry_strategy_backwards_compatible_event_set_on_retry(mock_sleep):
    """Test that _backwards_compatible_event_to_yield is set when retrying."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )

    await strategy._handle_after_model_call(event)

    # Should have set the backwards compatible event
    assert strategy._backwards_compatible_event_to_yield is not None
    assert isinstance(strategy._backwards_compatible_event_to_yield, EventLoopThrottleEvent)
    assert strategy._backwards_compatible_event_to_yield["event_loop_throttled_delay"] == 2


@pytest.mark.asyncio
async def test_model_retry_strategy_backwards_compatible_event_cleared_on_success():
    """Test that _backwards_compatible_event_to_yield is cleared on success."""
    strategy = ModelRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    # Set a previous backwards compatible event
    strategy._backwards_compatible_event_to_yield = EventLoopThrottleEvent(delay=2)

    event = AfterModelCallEvent(
        agent=mock_agent,
        stop_response=AfterModelCallEvent.ModelStopResponse(
            message={"role": "assistant", "content": [{"text": "Success"}]},
            stop_reason="end_turn",
        ),
    )

    await strategy._handle_after_model_call(event)

    # Should have cleared the backwards compatible event
    assert strategy._backwards_compatible_event_to_yield is None


@pytest.mark.asyncio
async def test_model_retry_strategy_backwards_compatible_event_not_set_on_max_attempts(mock_sleep):
    """Test that _backwards_compatible_event_to_yield is not set when max attempts reached."""
    strategy = ModelRetryStrategy(max_attempts=1, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=ModelThrottledException("Throttled"),
    )

    await strategy._handle_after_model_call(event)

    # Should not have set the backwards compatible event since max attempts reached
    assert strategy._backwards_compatible_event_to_yield is None
    assert event.retry is False


@pytest.mark.asyncio
async def test_model_retry_strategy_no_retry_when_no_exception_and_no_stop_response():
    """Test that retry is not set when there's no exception and no stop_response."""
    strategy = ModelRetryStrategy()
    mock_agent = Mock()

    # Event with neither exception nor stop_response
    event = AfterModelCallEvent(
        agent=mock_agent,
        exception=None,
        stop_response=None,
    )

    await strategy._handle_after_model_call(event)

    # Should not retry and should reset state
    assert event.retry is False
    assert strategy._current_attempt == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exception, expect_retry",
    [
        (TimeoutError("timed out"), True),
        (ModelThrottledException("Throttled"), True),
        (ValueError("unrelated"), False),
    ],
)
async def test_model_retry_strategy_subclass_overrides_is_retryable(mock_sleep, exception, expect_retry):
    """Test that subclassing and overriding is_retryable controls which exceptions are retried."""

    class PermissiveRetryStrategy(ModelRetryStrategy):
        def is_retryable(self, exception: Exception) -> bool:
            return super().is_retryable(exception) or isinstance(exception, TimeoutError)

    strategy = PermissiveRetryStrategy(max_attempts=3, initial_delay=2, max_delay=60)
    mock_agent = Mock()

    event = AfterModelCallEvent(agent=mock_agent, exception=exception)
    await strategy._handle_after_model_call(event)

    assert event.retry is expect_retry
