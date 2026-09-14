"""Hook events emitted by bidirectional agents."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from ....hooks.registry import BaseHookEvent

if TYPE_CHECKING:
    from ..agent.agent import BidiAgent
    from ..models import BidiModelTimeoutError
    from ..types.events import StopReason


@dataclass
class BidiHookEvent(BaseHookEvent):
    """Base class for BidiAgent hook events.

    Attributes:
        agent: The BidiAgent instance that triggered this event.
    """

    agent: "BidiAgent"


@dataclass
class BidiAgentStopEvent(BidiHookEvent):
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
class BidiResponseCompleteEvent(BidiHookEvent):
    """Event triggered when the model reports that a response has ended.

    A connection failure or shutdown without a model-reported completion does not
    emit this event.

    Attributes:
        response_id: Identifier of the response that ended.
        stop_reason: Why the response ended, including completion or interruption.
    """

    response_id: str
    stop_reason: "StopReason"


@dataclass
class BidiInterruptionEvent(BidiHookEvent):
    """Event triggered when model generation is interrupted.

    This event is fired when the user interrupts the assistant (e.g., by speaking
    during the assistant's response) or when an error causes interruption. This is
    specific to bidirectional streaming and doesn't exist in standard agents.

    Hook providers can use this event to log interruptions, implement custom
    interruption handling, or trigger cleanup logic.

    Attributes:
        reason: The reason for the interruption ("user_speech" or "error").
        interrupted_response_id: Optional ID of the response that was interrupted.
    """

    reason: Literal["user_speech", "error"]
    interrupted_response_id: str | None = None


@dataclass
class BidiBeforeConnectionRestartEvent(BidiHookEvent):
    """Event emitted before the agent restarts the model connection.

    A restart is triggered either reactively, after the model reports a timeout, or
    proactively, when the reconnect timer fires ahead of the provider's limit.

    Attributes:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        timeout_error: The model's timeout error on the reactive path; None when scheduled.
    """

    reason: Literal["timeout", "scheduled"]
    timeout_error: "BidiModelTimeoutError | None" = None


@dataclass
class BidiAfterConnectionRestartEvent(BidiHookEvent):
    """Event emitted after the agent attempts to restart the model connection.

    Attributes:
        reason: What triggered the restart ("timeout" reactively, "scheduled" proactively).
        exception: Populated if an exception was raised during the restart. None means success.
    """

    reason: Literal["timeout", "scheduled"]
    exception: Exception | None = None
