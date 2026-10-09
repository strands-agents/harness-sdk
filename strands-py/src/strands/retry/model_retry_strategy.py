"""Retry strategy for model invocations.

Retry strategies implement the HookProvider protocol and register callbacks for AfterModelCallEvent to determine
when and how to retry failed model calls.
"""

import asyncio
import inspect
import logging
import time
from collections.abc import Awaitable
from typing import Any

from ..hooks.events import AfterInvocationEvent, AfterModelCallEvent
from ..hooks.registry import HookProvider, HookRegistry
from ..types._events import EventLoopThrottleEvent, TypedEvent
from ..types.exceptions import ModelThrottledException
from .backoff_strategy import BackoffContext, BackoffStrategy, ExponentialBackoff
from .retry_strategy import RetryDecision

logger = logging.getLogger(__name__)

_DEFAULT_INITIAL_DELAY = 4
_DEFAULT_MAX_DELAY = 240


class ModelRetryStrategy(HookProvider):
    """Default retry strategy for model throttling.

    Retries model calls on retryable exceptions, waiting between attempts for the delay computed by ``backoff``.
    Without ``backoff``, delay doubles after each attempt: initial_delay, initial_delay*2, initial_delay*4, etc.,
    capped at max_delay. State resets after successful calls.

    With defaults (initial_delay=4, max_delay=240, max_attempts=6), delays are:
    4s → 8s → 16s → 32s → 64s (5 retries before giving up on the 6th attempt).

    The attempt budget counts only failures this strategy retries; retries requested by other hooks do not consume
    it.

    Extension points:

    - Override ``is_retryable`` to expand or narrow the set of retryable exceptions.
    - Pass a ``BackoffStrategy`` to change the delay between retries.
    - Override ``compute_retry_decision`` for full control over whether and how long to wait.

    Args:
        max_attempts: Total model attempts before re-raising the exception.
        initial_delay: Base delay in seconds for the default exponential backoff.
        max_delay: Upper bound in seconds for the default exponential backoff.
        backoff: Strategy that computes the delay between retries.
    """

    def __init__(
        self,
        *,
        max_attempts: int = 6,
        initial_delay: float | None = None,
        max_delay: float | None = None,
        backoff: BackoffStrategy | None = None,
    ):
        """Initialize the retry strategy.

        Args:
            max_attempts: Total model attempts before re-raising the exception. Defaults to 6.
            initial_delay: Base delay in seconds for the default exponential backoff; used for the first retry,
                then doubles. Defaults to 4.
            max_delay: Upper bound in seconds for the default exponential backoff. Defaults to 240.
            backoff: Strategy that computes the delay between retries. Defaults to a jitter-free
                ``ExponentialBackoff`` built from ``initial_delay`` and ``max_delay``.

        Raises:
            ValueError: If ``backoff`` is combined with ``initial_delay`` or ``max_delay``.
        """
        if backoff is not None and (initial_delay is not None or max_delay is not None):
            raise ValueError(
                f"{type(self).__name__}: initial_delay and max_delay cannot be combined with backoff; "
                "configure the delays on the backoff instead"
            )

        self._max_attempts = max_attempts
        self._initial_delay = _DEFAULT_INITIAL_DELAY if initial_delay is None else initial_delay
        self._max_delay = _DEFAULT_MAX_DELAY if max_delay is None else max_delay
        self._backoff: BackoffStrategy = backoff or ExponentialBackoff(
            base_delay=self._initial_delay, max_delay=self._max_delay, jitter="none"
        )
        self._current_attempt = 0
        self._last_delay: float | None = None
        self._first_failure_at: float | None = None
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
        """Decide whether to retry the failed model call, and how long to wait first.

        Called only for failed model calls that no other hook has already marked for retry. Overrides may be
        synchronous or ``async``; the base implementation is synchronous.

        Args:
            event: The AfterModelCallEvent for the failed model call.

        Returns:
            ``RetryDecision(retry=False)`` to let the exception propagate, or ``RetryDecision(retry=True, delay=...)``
            to retry after sleeping for ``delay`` seconds.
        """
        if event.exception is None or not self.is_retryable(event.exception):
            return RetryDecision(retry=False)

        self._current_attempt += 1
        if self._current_attempt >= self._max_attempts:
            logger.debug(
                "current_attempt=<%d>, max_attempts=<%d> | max retry attempts reached, not retrying",
                self._current_attempt,
                self._max_attempts,
            )
            return RetryDecision(retry=False)

        now = time.monotonic()
        if self._first_failure_at is None:
            self._first_failure_at = now
        delay = self._backoff.next_delay(
            BackoffContext(
                attempt=self._current_attempt,
                elapsed=now - self._first_failure_at,
                last_delay=self._last_delay,
            )
        )
        self._last_delay = delay

        logger.debug(
            "retry_delay_seconds=<%s>, max_attempts=<%s>, current_attempt=<%s> "
            "| %s encountered | delaying before next retry",
            delay,
            self._max_attempts,
            self._current_attempt,
            type(event.exception).__name__,
        )
        return RetryDecision(retry=True, delay=delay)

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register callbacks for AfterModelCallEvent and AfterInvocationEvent.

        Args:
            registry: The hook registry to register callbacks with.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        registry.add_callback(AfterModelCallEvent, self._handle_after_model_call)
        registry.add_callback(AfterInvocationEvent, self._handle_after_invocation)

    def _reset_retry_state(self) -> None:
        """Reset retry state to initial values."""
        self._current_attempt = 0
        self._last_delay = None
        self._first_failure_at = None

    async def _handle_after_invocation(self, event: AfterInvocationEvent) -> None:
        """Reset retry state after invocation completes.

        Args:
            event: The AfterInvocationEvent signaling invocation completion.
        """
        self._reset_retry_state()

    async def _handle_after_model_call(self, event: AfterModelCallEvent) -> None:
        """Handle model call completion and determine if retry is needed.

        If the call failed and ``compute_retry_decision`` asks for a retry, sleeps for the decided delay and sets
        event.retry to True. On successful calls, resets the retry state to prepare for future calls.

        Args:
            event: The AfterModelCallEvent containing call results or exception.
        """
        self._backwards_compatible_event_to_yield = None

        # Another hook already triggered a retry; don't stack additional delay on top.
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
        if not decision.retry or decision.delay is None:
            return

        self._backwards_compatible_event_to_yield = EventLoopThrottleEvent(delay=decision.delay)
        await asyncio.sleep(decision.delay)
        event.retry = True
