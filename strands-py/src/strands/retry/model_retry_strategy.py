"""Model retry strategy with configurable retry decisions and backoff."""

import asyncio
import inspect
import logging
import math
import time
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any

from ..hooks.events import AfterInvocationEvent, AfterModelCallEvent
from ..hooks.registry import HookProvider, HookRegistry
from ..types._events import EventLoopThrottleEvent, TypedEvent
from ..types.exceptions import ModelThrottledException
from .backoff import BackoffContext, BackoffStrategy, ExponentialBackoff

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RetryDecision:
    """Decision returned by a model retry strategy.

    Attributes:
        retry: Whether the failed model call should be retried.
        delay: Seconds to wait before retrying. Required when ``retry`` is True.
    """

    retry: bool
    delay: float | None = None

    def __post_init__(self) -> None:
        """Validate the decision shape.

        Raises:
            ValueError: If the delay does not match the retry decision.
        """
        if self.retry and self.delay is None:
            raise ValueError("delay is required when retry is True")
        if not self.retry and self.delay is not None:
            raise ValueError("delay must be None when retry is False")
        if self.delay is not None and (not math.isfinite(self.delay) or self.delay < 0):
            raise ValueError("delay must be a non-negative finite number")


class ModelRetryStrategy(HookProvider):
    """Retry failed model calls with a configurable backoff strategy.

    This remains Python's concrete default strategy so existing subclasses and
    ``is_retryable`` overrides continue to work. Override
    ``compute_retry_decision`` for full control over retry policy, or pass a
    custom ``BackoffStrategy`` to compose policy with reusable delay math.

    With the legacy constructor parameters and no ``backoff``, delays remain
    deterministic: 4s, 8s, 16s, 32s, then 64s by default.

    Args:
        max_attempts: Total model attempts before re-raising the exception.
        initial_delay: Base delay in seconds for the legacy exponential backoff.
        max_delay: Maximum delay in seconds for the legacy exponential backoff.
        backoff: Strategy used to compute delays. When provided, it takes
            precedence over ``initial_delay`` and ``max_delay``.
    """

    def __init__(
        self,
        *,
        max_attempts: int = 6,
        initial_delay: float = 4,
        max_delay: float = 240,
        backoff: BackoffStrategy | None = None,
    ) -> None:
        """Initialize the retry strategy.

        Args:
            max_attempts: Total model attempts before re-raising the exception. Defaults to 6.
            initial_delay: Base delay in seconds. Defaults to 4.
            max_delay: Maximum delay in seconds. Defaults to 240.
            backoff: Custom delay strategy. Defaults to deterministic exponential backoff.

        Raises:
            ValueError: If ``max_attempts`` is not an integer greater than or equal to 1.
        """
        if isinstance(max_attempts, bool) or not isinstance(max_attempts, int) or max_attempts < 1:
            raise ValueError(f"{type(self).__name__}: max_attempts must be an integer >= 1 (got {max_attempts})")

        self._max_attempts = max_attempts
        self._initial_delay = initial_delay
        self._max_delay = max_delay
        self._backoff = (
            backoff
            if backoff is not None
            else ExponentialBackoff(
                base_delay=initial_delay,
                max_delay=max_delay,
                jitter="none",
            )
        )
        self._current_attempt = 0
        self._last_delay: float | None = None
        self._first_failure_at: float | None = None
        self._attached_registry: HookRegistry | None = None
        self._backwards_compatible_event_to_yield: TypedEvent | None = None

    def is_retryable(self, exception: Exception) -> bool:
        """Whether the exception should be retried.

        Args:
            exception: The exception raised by the model call.

        Returns:
            True if the exception should trigger a retry, False otherwise.
        """
        return isinstance(exception, ModelThrottledException)

    def compute_retry_decision(self, event: AfterModelCallEvent) -> RetryDecision | Awaitable[RetryDecision]:
        """Decide whether to retry and how long to wait.

        Args:
            event: Failed model call event. Successes and previously claimed
                retries are filtered before this method is called.

        Returns:
            The retry decision for this model call.
        """
        exception = event.exception
        if exception is None or not self.is_retryable(exception):
            return RetryDecision(retry=False)

        self._current_attempt = event.attempt_count
        if event.attempt_count >= self._max_attempts:
            logger.debug(
                "attempt_count=<%s>, max_attempts=<%s> | max retry attempts reached",
                event.attempt_count,
                self._max_attempts,
            )
            return RetryDecision(retry=False)

        if self._first_failure_at is None:
            self._first_failure_at = time.monotonic()

        delay = self._backoff.next_delay(
            BackoffContext(
                attempt=event.attempt_count,
                elapsed_time=time.monotonic() - self._first_failure_at,
                last_delay=self._last_delay,
            )
        )
        self._last_delay = delay

        logger.debug(
            "retry_delay_seconds=<%s>, attempt_count=<%s>, max_attempts=<%s> "
            "| retryable model error, delaying before retry",
            delay,
            event.attempt_count,
            self._max_attempts,
        )
        return RetryDecision(retry=True, delay=delay)

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register callbacks for model calls and invocation completion.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            ValueError: If this strategy is already attached to another agent's registry.
        """
        if self._attached_registry is not None and self._attached_registry is not registry:
            raise ValueError(
                f"{type(self).__name__}: instance is already attached to another agent; "
                "create a separate instance per agent"
            )
        self._attached_registry = registry
        registry.add_callback(AfterModelCallEvent, self._handle_after_model_call)
        registry.add_callback(AfterInvocationEvent, self._handle_after_invocation)

    def _calculate_delay(self, attempt: int) -> float:
        """Calculate a delay for a zero-based legacy attempt index.

        Args:
            attempt: Zero-based retry attempt.

        Returns:
            Delay in seconds.
        """
        return self._backoff.next_delay(
            BackoffContext(
                attempt=attempt + 1,
                elapsed_time=0,
                last_delay=self._last_delay,
            )
        )

    def _reset_retry_state(self) -> None:
        """Reset state for a new retry budget."""
        self._current_attempt = 0
        self._last_delay = None
        self._first_failure_at = None

    def _on_first_model_attempt(self) -> None:
        """Reset per-budget state when a first model attempt is observed."""
        self._reset_retry_state()

    async def _handle_after_invocation(self, event: AfterInvocationEvent) -> None:
        """Reset retry state after invocation completion.

        Args:
            event: Invocation completion event.
        """
        self._reset_retry_state()

    async def _handle_after_model_call(self, event: AfterModelCallEvent) -> None:
        """Apply a retry decision to a completed model call.

        Args:
            event: Completed model call event.
        """
        self._backwards_compatible_event_to_yield = None

        if event.attempt_count == 1:
            self._on_first_model_attempt()
        if event.retry:
            return
        if event.stop_response is not None:
            logger.debug(
                "stop_reason=<%s> | model call succeeded, resetting retry state",
                event.stop_response.stop_reason,
            )
            self._reset_retry_state()
            return
        if event.exception is None:
            self._reset_retry_state()
            return

        decision = self.compute_retry_decision(event)
        if inspect.isawaitable(decision):
            decision = await decision
        if not decision.retry:
            return

        delay = decision.delay
        if delay is None:
            raise RuntimeError("retry decision is missing a delay")

        self._backwards_compatible_event_to_yield = EventLoopThrottleEvent(delay=delay)
        await asyncio.sleep(delay)
        event.retry = True
