"""Middleware type system."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable, Callable
from typing import Any, Generic, TypeVar

TContext = TypeVar("TContext")
TResult = TypeVar("TResult")
TEvent = TypeVar("TEvent")


class MiddlewareInputPhase(Generic[TContext, TResult, TEvent]):
    """Phase sub-token for Input handlers — transforms context before execution."""

    __slots__ = ("_stage", "_phase")

    def __init__(self, stage: MiddlewareStage[TContext, TResult, TEvent]) -> None:
        """Bind this phase sub-token to its parent stage."""
        self._stage = stage
        self._phase = "input"


class MiddlewareWrapPhase(Generic[TContext, TResult, TEvent]):
    """Phase sub-token for Wrap handlers — full async generator wrap."""

    __slots__ = ("_stage", "_phase")

    def __init__(self, stage: MiddlewareStage[TContext, TResult, TEvent]) -> None:
        """Bind this phase sub-token to its parent stage."""
        self._stage = stage
        self._phase = "wrap"


class MiddlewareOutputPhase(Generic[TContext, TResult, TEvent]):
    """Phase sub-token for Output handlers — transforms result after execution."""

    __slots__ = ("_stage", "_phase")

    def __init__(self, stage: MiddlewareStage[TContext, TResult, TEvent]) -> None:
        """Bind this phase sub-token to its parent stage."""
        self._stage = stage
        self._phase = "output"


class MiddlewareStage(Generic[TContext, TResult, TEvent]):
    """A stage token identifying a middleware interception point.

    Only the SDK's built-in tokens (``InvokeModelStage``, ``ExecuteToolStage``) are invoked;
    constructing a custom stage is unsupported.

    Attributes:
        name: Human-readable name for debugging and logging.
        result_type: The wrapper class Output handlers receive and return (``TResult``).
        result_event: The event class that is this stage's result; the registry and the call
            sites select it from the stream by type, so Wrap handlers may yield other events
            before or after it.
    """

    __slots__ = ("name", "result_type", "result_event", "Input", "Wrap", "Output")

    def __init__(self, name: str, *, result_type: type[TResult], result_event: type[Any]) -> None:
        """Create a stage token with its Input/Wrap/Output phase sub-tokens."""
        self.name = name
        self.result_type = result_type
        self.result_event = result_event
        self.Input: MiddlewareInputPhase[TContext, TResult, TEvent] = MiddlewareInputPhase(self)
        self.Wrap: MiddlewareWrapPhase[TContext, TResult, TEvent] = MiddlewareWrapPhase(self)
        self.Output: MiddlewareOutputPhase[TContext, TResult, TEvent] = MiddlewareOutputPhase(self)

    def __repr__(self) -> str:
        """Return a debug representation naming the stage."""
        return f"MiddlewareStage(name={self.name!r})"

    def __hash__(self) -> int:
        """Hash by identity so each stage token is a distinct registry key."""
        return id(self)

    def __eq__(self, other: object) -> bool:
        """Compare by identity — a stage token equals only itself."""
        return self is other


# Wrap handlers deal in the raw event stream, so only Output handlers (which receive the wrapped
# result explicitly) are generic over TResult.
MiddlewareNext = Callable[[TContext], AsyncGenerator[TEvent, None]]
MiddlewareHandler = Callable[[TContext, MiddlewareNext[TContext, TEvent]], AsyncGenerator[TEvent, None]]
MiddlewareInputHandler = Callable[[TContext], TContext | Awaitable[TContext]]
MiddlewareOutputHandler = Callable[[TResult], TResult | Awaitable[TResult]]
