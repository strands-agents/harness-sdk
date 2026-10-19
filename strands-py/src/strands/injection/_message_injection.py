"""Delivery primitives for context injection.

These fold just-in-time text into the latest user message *ephemerally* — the model sees the
augmented input for one call while the agent's durable history is never touched. Reach injection
through the ``ContextInjector`` plugin or the ``MemoryManager`` rather than these primitives
directly.
"""

from __future__ import annotations

import inspect
import logging
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import TYPE_CHECKING, Any, Protocol

from .types import InjectionContext, InjectionTriggerPredicate

if TYPE_CHECKING:
    from ..middleware.stages import InvokeModelContext
    from ..types.content import ContentBlock, Message, Messages

logger = logging.getLogger(__name__)


class RenderContentCallback(Protocol):
    """Renders the text to fold into the latest user message for a model call.

    Implemented by a plain function as well — the ``**kwargs`` tail lets the calling convention
    grow new keyword arguments without breaking existing callbacks.
    """

    def __call__(self, context: InjectionContext, **kwargs: Any) -> str | None | Awaitable[str | None]:
        """Return the text to inject, ``None``/``""`` to skip, or an awaitable of either."""
        ...


# The text-rendering callback. The bare ``Callable`` arm keeps the happy path
# (``lambda context: ...``) ergonomic; the ``RenderContentCallback`` arm is the forward-compatible
# Protocol for callers that opt into future keyword arguments. A callback that raises fails open
# (injection is skipped, the model call proceeds).
RenderContent = Callable[[InjectionContext], "str | None | Awaitable[str | None]"] | RenderContentCallback


def _create_injection_middleware(
    render_content: RenderContent,
    *,
    trigger: InjectionTriggerPredicate | None = None,
) -> Callable[[InvokeModelContext], Awaitable[InvokeModelContext]]:
    """Build an ``InvokeModelStage.Input`` handler that folds injected text into the conversation.

    The handler folds ``render_content``'s text into the latest user message, ephemerally: the
    model sees the augmented input for this one call while the agent's durable history is
    never touched. The handler gates on the resolved trigger, asks ``render_content`` for the
    text, and returns a context with the folded messages. Anything that skips — the trigger
    not firing, ``render_content`` returning empty, or any callback raising — returns the
    context unchanged so the model call proceeds (fail open). The injected text never enters
    durable history because the input phase only rewrites the per-call context, not the
    agent's stored messages.

    Args:
        render_content: Renders the text to inject for this call. Sync or async.
        trigger: When to inject. An ``InjectionTrigger`` name selects a built-in policy
            (``"userTurn"`` — default — or ``"everyTurn"``); a predicate over the
            ``InjectionContext`` is the escape hatch. Defaults to ``"userTurn"``.

    Returns:
        An ``InvokeModelStage.Input`` handler that returns a (possibly) folded context.
    """
    resolved_trigger = _resolve_trigger(trigger)

    async def handler(context: InvokeModelContext) -> InvokeModelContext:
        agent = context.agent
        # Hand the callback its own list, so a callback that reorders/appends cannot perturb the
        # per-call context. The message dicts are shared, but the upstream InvokeModelContext is
        # already a defensive copy of agent state, so durable history is safe regardless.
        injection_context = InjectionContext(messages=list(context.messages), state=agent.state, agent=agent)

        if not resolved_trigger(injection_context):
            return context

        try:
            text = render_content(injection_context)
            if inspect.isawaitable(text):
                text = await text
        except Exception as error:  # noqa: BLE001 - fail open: a bad callback must not abort the model call.
            logger.warning("reason=<%s> | injection render_content raised | skipping injection", error)
            return context

        if text is None or not text.strip():
            return context

        folded, appended = _fold_into_last_user_message(context.messages, text)

        return replace(context, messages=folded, dynamic_trailing_blocks=context.dynamic_trailing_blocks + appended)

    return handler


def _resolve_trigger(trigger: InjectionTriggerPredicate | None) -> Callable[[InjectionContext], bool]:
    """Resolve an ``InjectionTrigger`` name or predicate into a single gate predicate.

    ``"userTurn"`` maps to ``_is_user_turn`` (over ``context.messages``); ``"everyTurn"`` to an
    always-true gate; a user-supplied predicate is wrapped so that a raise fails open (logs and
    skips injection rather than aborting the model call).

    Args:
        trigger: An ``InjectionTrigger`` name, a predicate, or ``None`` (defaults to ``"userTurn"``).

    Returns:
        A predicate that, given the ``InjectionContext``, returns whether to inject this call.
    """
    if trigger is None or trigger == "userTurn":
        return lambda context: _is_user_turn(context.messages)
    if trigger == "everyTurn":
        return lambda context: True

    predicate = trigger

    def guarded(context: InjectionContext) -> bool:
        try:
            return predicate(context)
        except Exception as error:  # noqa: BLE001 - fail open: a bad predicate must not abort the model call.
            logger.warning("reason=<%s> | injection trigger raised | skipping injection", error)
            return False

    return guarded


def _is_user_turn(messages: Messages) -> bool:
    """Whether the latest message is a fresh user ask: a ``user`` message carrying no tool result.

    This is the ``"userTurn"`` policy — it distinguishes a new chat ask from an autonomous
    tool-result turn.

    Args:
        messages: The current conversation, as data.

    Returns:
        ``True`` when the latest message is a plain user ask, otherwise ``False``.
    """
    if not messages:
        return False
    last = messages[-1]
    return last["role"] == "user" and not any("toolResult" in block for block in last["content"])


def _fold_into_last_user_message(messages: Messages, text: str) -> tuple[Messages, int]:
    """Fold ``text`` into the most recent ``user`` message as a text block, returning a NEW list.

    Folding into the existing user message (rather than inserting a standalone message) keeps
    role alternation valid in both chat and the autonomous tool loop.

    The text is always **appended**. A tool result has to stay the first content block in the turn
    that answers a tool use, and a trailing run is the only placement a provider can keep out of its
    cached prefix — text ahead of the stable conversation would invalidate the cache from the first
    block onward.

    The input list and its messages are never mutated. When there is no ``user`` message, the
    input list is returned unchanged.

    Args:
        messages: The conversation to fold into.
        text: The text to fold into the most recent user message.

    Returns:
        The folded conversation and how many trailing blocks of its last message are per-call
        content: 1 when the fold landed on the last message, 0 otherwise (including when there is
        no user message to fold into, in which case the input list is returned unchanged).
    """
    target_index = -1
    for index in range(len(messages) - 1, -1, -1):
        if messages[index]["role"] == "user":
            target_index = index
            break
    if target_index < 0:
        return messages, 0

    target = messages[target_index]
    # Some providers concatenate adjacent text blocks, which would run this onto the user's own words.
    has_text = any("text" in block for block in target["content"])
    separator = "\n\n" if has_text and not text.startswith("\n") else ""
    injected: ContentBlock = {"text": f"{separator}{text}"}
    content = [*target["content"], injected]

    folded: Message = {"role": target["role"], "content": content}
    if "metadata" in target:
        folded["metadata"] = target["metadata"]

    result = list(messages)
    result[target_index] = folded
    # A provider only places its cache point in the last message, so a fold elsewhere reports nothing.
    return result, (1 if target_index == len(messages) - 1 else 0)
