"""Retry strategy implementations for handling model throttling and other retry scenarios.

This module provides hook-based retry strategies that can be configured on the Agent
to control retry behavior for model invocations. Retry strategies implement the
HookProvider protocol and register callbacks for AfterModelCallEvent to determine
when and how to retry failed model calls.
"""

import asyncio
import logging
from typing import Any

from ..hooks.events import AfterInvocationEvent, AfterModelCallEvent
from ..hooks.registry import HookProvider, HookRegistry
from ..types._events import EventLoopThrottleEvent, TypedEvent
from ..types.exceptions import ModelThrottledException

logger = logging.getLogger(__name__)


class ModelRetryStrategy(HookProvider):
    """Default retry strategy for model throttling with exponential backoff.

    Retries model calls on retryable exceptions using exponential backoff.
    Delay doubles after each attempt: initial_delay, initial_delay*2, initial_delay*4,
    etc., capped at max_delay. State resets after successful calls.

    With defaults (initial_delay=4, max_delay=240, max_attempts=6), delays are:
    4s → 8s → 16s → 32s → 64s (5 retries before giving up on the 6th attempt).

    Subclass and override ``is_retryable`` to expand or narrow the set of
    retryable exceptions without reimplementing the rest of the retry policy.

    Args:
        max_attempts: Total model attempts before re-raising the exception.
        initial_delay: Base delay in seconds; used for first two retries, then doubles.
        max_delay: Upper bound in seconds for the exponential backoff.
    """

    def __init__(
        self,
        *,
        max_attempts: int = 6,
        initial_delay: int = 4,
        max_delay: int = 240,
    ):
        """Initialize the retry strategy.

        Args:
            max_attempts: Total model attempts before re-raising the exception. Defaults to 6.
            initial_delay: Base delay in seconds; used for first two retries, then doubles.
                Defaults to 4.
            max_delay: Upper bound in seconds for the exponential backoff. Defaults to 240.
        """
        self._max_attempts = max_attempts
        self._initial_delay = initial_delay
        self._max_delay = max_delay
        self._current_attempt = 0
        self._backwards_compatible_event_to_yield: TypedEvent | None = None

    def is_retryable(self, exception: Exception) -> bool:
        """Whether the exception should be retried.

        Args:
            exception: The exception raised by the model call.

        Returns:
            True if the exception should trigger a retry, False otherwise.
        """
        return isinstance(exception, ModelThrottledException)

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register callbacks for AfterModelCallEvent and AfterInvocationEvent.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        registry.add_callback(AfterModelCallEvent, self._handle_after_model_call)
        registry.add_callback(AfterInvocationEvent, self._handle_after_invocation)

    def _calculate_delay(self, attempt: int) -> int:
        """Calculate retry delay using exponential backoff.

        Args:
            attempt: The attempt number (0-indexed) to calculate delay for.

        Returns:
            Delay in seconds for the given attempt.
        """
        delay: int = self._initial_delay * (2**attempt)
        return min(delay, self._max_delay)

    def _reset_retry_state(self) -> None:
        """Reset retry state to initial values."""
        self._current_attempt = 0

    async def _handle_after_invocation(self, event: AfterInvocationEvent) -> None:
        """Reset retry state after invocation completes.

        Args:
            event: The AfterInvocationEvent signaling invocation completion.
        """
        self._reset_retry_state()

    async def _handle_after_model_call(self, event: AfterModelCallEvent) -> None:
        """Handle model call completion and determine if retry is needed.

        This callback is invoked after each model call. If the call failed with
        a retryable exception and we haven't exceeded max_attempts, it sets
        event.retry to True and sleeps for the current delay before returning.

        On successful calls, it resets the retry state to prepare for future calls.

        Args:
            event: The AfterModelCallEvent containing call results or exception.
        """
        delay = self._calculate_delay(self._current_attempt)

        self._backwards_compatible_event_to_yield = None

        # If already retrying, skip processing (another hook may have triggered retry)
        if event.retry:
            return

        # If model call succeeded, reset retry state
        if event.stop_response is not None:
            logger.debug(
                "stop_reason=<%s> | model call succeeded, resetting retry state",
                event.stop_response.stop_reason,
            )
            self._reset_retry_state()
            return

        # Check if we have an exception and reset state if no exception
        if event.exception is None:
            self._reset_retry_state()
            return

        if not self.is_retryable(event.exception):
            return

        # Increment attempt counter first
        self._current_attempt += 1

        # Check if we've exceeded max attempts
        if self._current_attempt >= self._max_attempts:
            logger.debug(
                "current_attempt=<%d>, max_attempts=<%d> | max retry attempts reached, not retrying",
                self._current_attempt,
                self._max_attempts,
            )
            return

        self._backwards_compatible_event_to_yield = EventLoopThrottleEvent(delay=delay)

        # Retry the model call
        logger.debug(
            "retry_delay_seconds=<%s>, max_attempts=<%s>, current_attempt=<%s> "
            "| %s encountered | delaying before next retry",
            delay,
            self._max_attempts,
            self._current_attempt,
            type(event.exception).__name__,
        )

        # Sleep for current delay
        await asyncio.sleep(delay)

        # Set retry flag and track that this strategy triggered it
        event.retry = True
