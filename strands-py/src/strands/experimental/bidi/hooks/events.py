"""Hook events emitted by bidirectional agents."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from ....hooks.registry import BaseHookEvent

if TYPE_CHECKING:
    from ..agent.agent import BidiAgent
    from ..models import ConnectionTimeoutError
    from ..types.events import StopReason


@dataclass
class _HookEvent(BaseHookEvent):
    """Base class for BidiAgent hook events.

    Attributes:
        agent: The BidiAgent instance that triggered this event.
    """

    agent: "BidiAgent"


@dataclass
class BidiAgentStopEvent(_HookEvent):
    """Event triggered after BidiAgent attempts to stop its streaming session.

    This event is fired after background-task and model cleanup have been attempted,
    including when cleanup raises an exception.
    Hook providers can use this event for cleanup, logging, or state persistence.

    Note: This event uses reverse callback ordering, meaning callbacks registered
    later will be invoked first during cleanup.

    This event is triggered at the end of agent.stop().
    """

    @property
    def should_reverse_callbacks(self) -> bool:
        """True to invoke callbacks in reverse order."""
        return True


@dataclass
class BidiResponseCompleteEvent(_HookEvent):
    """Event triggered when the model reports that a response has ended.

    A connection failure or shutdown without a model-reported completion does not
    emit this event.

    Attributes:
        response_id: Identifier of the response that ended.
        stop_reason: Why the response ended, including completion or barge-in.
    """

    response_id: str
    stop_reason: "StopReason"


@dataclass
class BidiBargeInEvent(_HookEvent):
    """Event triggered to stop current response generation or playback.

    This event is fired when the user barges in (e.g., by speaking during the
    assistant's response) or when an error stops output. This is
    specific to bidirectional streaming and doesn't exist in standard agents.

    Hook providers can use this event to log barge-ins, implement custom
    barge-in handling, or trigger cleanup logic.

    Attributes:
        reason: Why response output should stop ("user_speech" or "error").
        response_id: Optional ID of the affected response.
    """

    reason: Literal["user_speech", "error"]
    response_id: str | None = None


@dataclass
class BidiBeforeConnectionRestartEvent(_HookEvent):
    """Event emitted before the agent restarts the model connection.

    A restart is triggered either reactively, after the model reports a timeout, or
    proactively, when the reconnect timer fires ahead of the provider's limit.

    Attributes:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        timeout_error: The model's timeout error on the reactive path; None when scheduled.
    """

    reason: Literal["timeout", "scheduled"]
    timeout_error: "ConnectionTimeoutError | None" = None


@dataclass
class BidiAfterConnectionRestartEvent(_HookEvent):
    """Event emitted after the agent attempts to restart the model connection.

    Attributes:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        exception: Populated if an exception was raised during the restart. None means success.
    """

    reason: Literal["timeout", "scheduled"]
    exception: Exception | None = None
