"""Internal continuation handling for agent invocations.

Coordinates continuation inputs contributed by hooks, including preparation,
interrupt deferral, input combination, and append or abandonment callbacks.
"""

import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import cast

from ..hooks.events import AfterInvocationEvent, BeforeModelCallEvent
from ..types.agent import AgentInput
from ..types.content import Messages

logger = logging.getLogger(__name__)

_ContinuationEvent = AfterInvocationEvent | BeforeModelCallEvent
_STATE_ATTRIBUTE = "_continuation_state"
_DEFERRED_INPUTS_ATTRIBUTE = "_deferred_continuation_inputs"


@dataclass(frozen=True)
class _ContinuationInput:
    """One internal input contribution to an agent or model invocation.

    When both callbacks are supplied, exactly one runs once. Callback failures
    are logged and do not change the agent result.

    Attributes:
        args: Input that normalizes to one or more complete messages.
        on_appended: Runs after the input is incorporated into agent history.
        on_abandoned: Runs when the input cannot be incorporated into agent history.
    """

    args: AgentInput
    on_appended: Callable[[], Awaitable[None] | None] | None = None
    on_abandoned: Callable[[object], Awaitable[None] | None] | None = None


@dataclass
class _ContinuationState:
    inputs: list[_ContinuationInput] = field(default_factory=list)
    messages: Messages | None = None


def add_input(event: _ContinuationEvent, input_: _ContinuationInput) -> None:
    """Add an input contribution for an invocation event.

    Args:
        event: Event that owns the continuation input.
        input_: Input and optional settlement callbacks to register.
    """
    state = _get_state(event) or _ContinuationState()
    state.inputs.append(input_)
    _set_state(event, state)


async def prepare(
    event: _ContinuationEvent,
    normalize_input: Callable[[AgentInput], Awaitable[Messages]],
    stop_reason: str | None = None,
) -> Messages | None:
    """Normalize registered inputs and prepare complete message sequences.

    Args:
        event: Event whose continuation inputs should be prepared.
        normalize_input: Converts invocation input into messages.
        stop_reason: Stop reason that determines whether inputs continue now or are deferred.

    Returns:
        The prepared messages, or ``None`` when no continuation is ready.
    """
    if stop_reason == "interrupt":
        inputs = _consume_inputs(event)
        if inputs:
            stored_inputs = cast(list[_ContinuationInput], getattr(event.agent, _DEFERRED_INPUTS_ATTRIBUTE, []))
            setattr(event.agent, _DEFERRED_INPUTS_ATTRIBUTE, [*stored_inputs, *inputs])
        return None
    if stop_reason is not None and stop_reason not in ("end_turn", "stop_sequence"):
        return None

    deferred_inputs: list[_ContinuationInput] = []
    if isinstance(event, AfterInvocationEvent):
        deferred_inputs = cast(
            list[_ContinuationInput],
            getattr(event.agent, _DEFERRED_INPUTS_ATTRIBUTE, []),
        )
        if hasattr(event.agent, _DEFERRED_INPUTS_ATTRIBUTE):
            delattr(event.agent, _DEFERRED_INPUTS_ATTRIBUTE)
    inputs = [*deferred_inputs, *_consume_inputs(event)]
    accepted_inputs: list[_ContinuationInput] = []
    messages: Messages = []
    preparing_state = _ContinuationState(inputs=inputs)
    _set_state(event, preparing_state)

    for index, input_ in enumerate(inputs):
        try:
            normalized = await normalize_input(input_.args)
            if not _is_complete_message_input(normalized):
                raise TypeError("Continuation input must contain a complete message sequence")
            messages.extend(normalized)
            accepted_inputs.append(input_)
        except Exception as error:
            preparing_state.inputs = [*accepted_inputs, *inputs[index + 1 :]]
            await _notify_abandoned(input_, error)

    if not accepted_inputs:
        _clear_state(event)
        return None

    _set_state(event, _ContinuationState(inputs=accepted_inputs, messages=messages))
    return messages


def combine(event: _ContinuationEvent | None, messages: Messages) -> Messages:
    """Prepend prepared continuation messages to invocation messages.

    Args:
        event: Event whose prepared messages should be applied.
        messages: Invocation messages to combine with the prepared messages.

    Returns:
        The combined messages, or the original messages when no continuation is ready.
    """
    state = _get_state(event) if event else None
    if state is None or state.messages is None:
        return messages
    return [*state.messages, *messages]


async def mark_appended(event: _ContinuationEvent | None) -> None:
    """Mark prepared inputs as incorporated into agent history.

    Args:
        event: Event whose prepared inputs were appended.
    """
    if event is None:
        return
    state = _get_state(event)
    if state is None or state.messages is None:
        return

    for input_ in _consume_inputs(event):
        try:
            if input_.on_appended is not None:
                result = input_.on_appended()
                if inspect.isawaitable(result):
                    await result
        except Exception as error:
            logger.warning("error=<%s> | continuation append callback failed", error)


async def abandon(event: _ContinuationEvent | None, reason: object) -> None:
    """Abandon the inputs registered for an event.

    Args:
        event: Event whose inputs should be abandoned.
        reason: Reason the inputs could not be incorporated.
    """
    if event is None:
        return
    for input_ in _consume_inputs(event):
        await _notify_abandoned(input_, reason)


# Hook events are unhashable and write-guarded, so continuation state uses private object attributes.
def _get_state(event: _ContinuationEvent) -> _ContinuationState | None:
    return getattr(event, _STATE_ATTRIBUTE, None)


def _clear_state(event: _ContinuationEvent) -> None:
    if hasattr(event, _STATE_ATTRIBUTE):
        object.__delattr__(event, _STATE_ATTRIBUTE)


def _set_state(event: _ContinuationEvent, state: _ContinuationState) -> None:
    object.__setattr__(event, _STATE_ATTRIBUTE, state)


def _consume_inputs(event: _ContinuationEvent) -> list[_ContinuationInput]:
    state = _get_state(event)
    _clear_state(event)
    return state.inputs if state else []


def _is_complete_message_input(messages: Messages) -> bool:
    if not messages or messages[-1]["role"] != "user":
        return False

    pending_tool_use_ids: set[str] = set()
    for message in messages:
        if pending_tool_use_ids and message["role"] != "user":
            return False

        next_tool_use_ids: set[str] = set()
        for block in message["content"]:
            if "toolUse" in block:
                tool_use_id = block["toolUse"]["toolUseId"]
                if message["role"] != "assistant" or tool_use_id in next_tool_use_ids:
                    return False
                next_tool_use_ids.add(tool_use_id)
            elif "toolResult" in block:
                tool_use_id = block["toolResult"]["toolUseId"]
                if message["role"] != "user" or tool_use_id not in pending_tool_use_ids:
                    return False
                pending_tool_use_ids.remove(tool_use_id)

        if message["role"] == "user" and pending_tool_use_ids:
            return False
        pending_tool_use_ids = next_tool_use_ids

    return not pending_tool_use_ids


async def _notify_abandoned(input_: _ContinuationInput, reason: object) -> None:
    try:
        if input_.on_abandoned is not None:
            result = input_.on_abandoned(reason)
            if inspect.isawaitable(result):
                await result
    except Exception as error:
        logger.warning("error=<%s> | continuation abandon callback failed", error)
