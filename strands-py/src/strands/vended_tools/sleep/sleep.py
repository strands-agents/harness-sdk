"""Sleep tool: pause execution for a bounded, cooperative duration.

Provides :func:`make_sleep` (a factory that lets the caller configure the
maximum permitted duration) and :data:`sleep` (a default instance with a 60-second
cap). Sleeps are implemented with :func:`asyncio.sleep`, which unblocks
immediately when the surrounding task is cancelled. When the tool is invoked
through the standard :class:`DecoratedFunctionTool` path, the raised
:class:`asyncio.CancelledError` is caught by the tool executor and surfaced as
a tool-error result; direct callers awaiting the underlying coroutine observe
the cancellation directly.
"""

from __future__ import annotations

import asyncio
import math
from typing import TYPE_CHECKING

from ...tools.decorator import tool
from .types import DEFAULT_MAX_DURATION, sleep_description

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool


def make_sleep(
    *,
    max_duration: float = DEFAULT_MAX_DURATION,
    name: str = "sleep",
    description: str | None = None,
) -> DecoratedFunctionTool:
    """Create a sleep tool with a configurable maximum duration.

    The returned tool pauses execution for ``duration`` seconds via
    :func:`asyncio.sleep`. Cancelling the surrounding task unblocks the sleep
    immediately rather than waiting for the full duration; the resulting
    :class:`asyncio.CancelledError` is caught by the standard tool executor
    when the tool is invoked through :class:`DecoratedFunctionTool` and
    surfaced as a tool-error result to the model.

    Args:
        max_duration: Upper bound on ``duration`` in seconds. Must be a finite,
            positive number. Defaults to :data:`DEFAULT_MAX_DURATION` (60 s).
        name: Tool name. Defaults to ``"sleep"``.
        description: Tool description shown to the model.

    Returns:
        A decorated tool that pauses execution for the requested duration.

    Raises:
        ValueError: If ``max_duration`` is not a positive, finite number.
    """
    if not isinstance(max_duration, (int, float)) or isinstance(max_duration, bool):
        raise ValueError(f"max_duration must be a number, got {type(max_duration).__name__}")
    if not math.isfinite(max_duration) or max_duration <= 0:
        raise ValueError(f"max_duration must be positive and finite, got {max_duration!r}")

    resolved_max = float(max_duration)
    resolved_description = description if description is not None else sleep_description(resolved_max)

    @tool(name=name, description=resolved_description)
    async def sleep_tool(duration: float) -> str:
        """Pauses execution for the given number of seconds.

        The sleep is cooperative: it uses :func:`asyncio.sleep` and aborts
        immediately if the enclosing task is cancelled. Negative, non-finite,
        non-numeric, or oversized durations are rejected before the sleep begins.

        Args:
            duration: Seconds to pause. Must be a finite, non-negative number
                no larger than the tool's configured maximum.
        """
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise ValueError(f"duration must be a number, got {type(duration).__name__}")
        seconds = float(duration)
        if not math.isfinite(seconds):
            raise ValueError(f"duration must be a finite number, got {duration!r}")
        if seconds < 0:
            raise ValueError(f"duration must be non-negative, got {seconds}")
        if seconds > resolved_max:
            raise ValueError(f"duration {seconds} exceeds maximum of {resolved_max} seconds")

        await asyncio.sleep(seconds)
        return f"Slept for {duration} seconds"

    return sleep_tool


sleep = make_sleep()
"""Default sleep tool with a 60-second maximum duration."""
