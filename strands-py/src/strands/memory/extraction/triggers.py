"""Built-in extraction triggers that control *when* a store's extraction runs.

* :class:`InvocationTrigger` -- fire after every agent invocation.
* :class:`IntervalTrigger` -- fire once every ``turns`` invocations.

See :class:`ExtractionTrigger` for the self-attaching trigger contract.
"""

from __future__ import annotations

from ...hooks.events import AfterInvocationEvent
from ...hooks.registry import HookOrder
from .types import ExtractionTrigger, ExtractionTriggerContext


class InvocationTrigger(ExtractionTrigger):
    """Runs extraction after every agent invocation.

    The highest-fidelity option, and the most expensive when an
    :class:`~strands.memory.extraction.types.Extractor` is configured (a model
    call per turn).

    Example:
        ```python
        ExtractionConfig(trigger=[InvocationTrigger()])
        ```
    """

    name = "invocation"

    def attach(self, context: ExtractionTriggerContext) -> None:
        """Register an after-invocation callback that fires extraction.

        Runs after the SDK's own after-invocation hooks so extraction sees the
        settled turn. The save runs in a background task, so the hook never
        blocks.
        """
        context.agent.add_hook(
            lambda event: context.fire(event.invocation_context),
            AfterInvocationEvent,
            order=HookOrder.SDK_LAST,
        )


class IntervalTrigger(ExtractionTrigger):
    """Runs extraction every ``turns`` agent invocations.

    A controllable middle ground: the high-water mark still picks up the skipped
    turns when the trigger fires.

    Example:
        ```python
        ExtractionConfig(trigger=[IntervalTrigger(turns=5)])
        ```

    Attributes:
        name: Stable identifier for this trigger kind (``interval``).
    """

    name = "interval"

    def __init__(self, turns: int) -> None:
        """Initialize the trigger with a firing cadence.

        Args:
            turns: Run extraction once every this many invocations. Must be a
                positive integer.

        Raises:
            ValueError: If ``turns`` is not a positive integer (``bool`` is
                rejected even though it subclasses ``int``).
        """
        # Reject bool explicitly (bool is a subclass of int) and any value < 1.
        if not isinstance(turns, int) or isinstance(turns, bool) or turns < 1:
            raise ValueError(f"IntervalTrigger: turns must be a positive integer, got {turns}")
        self._turns = turns

    def attach(self, context: ExtractionTriggerContext) -> None:
        """Register an after-invocation callback that fires every ``turns`` turns.

        Each ``attach`` creates a fresh closure counter, so one trigger instance
        shared across stores keeps an independent count per attachment.
        """
        # Per-attach counter so stores sharing one instance fire independently.
        count = 0

        def _callback(event: AfterInvocationEvent) -> None:
            nonlocal count
            count += 1
            # `fire` is fire-and-forget; it dispatches extraction in the background.
            if count % self._turns == 0:
                context.fire(event.invocation_context)

        context.agent.add_hook(_callback, AfterInvocationEvent, order=HookOrder.SDK_LAST)
