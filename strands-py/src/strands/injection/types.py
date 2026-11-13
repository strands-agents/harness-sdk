"""Configuration types shared by injection consumers.

Consumed by the ``ContextInjector`` plugin and the ``MemoryManager``.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from typing_extensions import TypedDict

if TYPE_CHECKING:
    from ..agent.state import AgentState
    from ..types.agent import LocalAgent
    from ..types.content import Messages

InjectionTrigger = Literal["userTurn", "everyTurn"]
"""Determines when injection runs before a model call.

- ``"userTurn"``: only when the latest message is a fresh user ask (a ``user`` message with
  no tool result) — the common case for chat agents, where it keeps the user's ask the final
  message the model sees.
- ``"everyTurn"``: before every model call, including mid-task tool-result turns — for
  autonomous agents that should consult injected context at each step.

For finer control, pass a predicate instead of a trigger name.
"""


@dataclass
class InjectionContext:
    """The context an injection consumer receives on each model call.

    Passed to the ``render_content`` callback and to a predicate trigger.

    Attributes:
        messages: The current conversation, as data.
        state: Durable agent state shared across calls, hooks, and tools — read what a tool
            stashed last turn.
        agent: The agent the injection is attached to (escape hatch for advanced consumers).
    """

    messages: Messages
    state: AgentState
    agent: LocalAgent


class TriggerCallback(Protocol):
    """A predicate that decides whether to inject on a given model call.

    Implemented by a plain function as well — the ``**kwargs`` tail lets the calling
    convention grow new keyword arguments without breaking existing predicates.
    """

    def __call__(self, context: InjectionContext, **kwargs: Any) -> bool:
        """Return whether to inject this call, given the injection context."""
        ...


# A trigger name, or a predicate over the injection context. The bare ``Callable`` arm keeps the
# happy path (``lambda context: ...``) ergonomic; the ``TriggerCallback`` arm is the forward-
# compatible Protocol for callers that opt into future keyword arguments.
InjectionTriggerPredicate = InjectionTrigger | Callable[[InjectionContext], bool] | TriggerCallback


class InjectionConfig(TypedDict, total=False):
    """Configuration common to every injection consumer: when to inject.

    What text to inject is a consumer concern, added by the configs that extend this one
    (e.g. ``MemoryInjectionConfig``).

    Attributes:
        trigger: When injection runs. An ``InjectionTrigger`` name selects a built-in policy;
            a predicate is the escape hatch — it receives the ``InjectionContext`` and returns
            whether to inject this call. A predicate that raises fails open (injection is
            skipped, the model call proceeds). Defaults to ``"userTurn"``.
    """

    trigger: InjectionTriggerPredicate
