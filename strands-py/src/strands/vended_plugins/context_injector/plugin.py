"""ContextInjector plugin for injecting just-in-time context into the model input.

This module provides the ContextInjector plugin, which writes just-in-time text into the latest
user message before each model call, as an ``injected`` block that stays in the conversation.

Example:
    ```python
    import datetime

    from strands import Agent
    from strands.vended_plugins.context_injector import ContextInjector

    agent = Agent(
        plugins=[
            ContextInjector(lambda context: f"<now>{datetime.datetime.now().isoformat()}</now>")
        ]
    )
    ```
"""

from __future__ import annotations

import copy
import inspect
import logging
from dataclasses import replace
from typing import TYPE_CHECKING

from ...injection._message_injection import RenderContent, _resolve_trigger
from ...injection.types import InjectionContext, InjectionTriggerPredicate
from ...middleware.stages import InvokeModelStage
from ...plugins import Plugin
from ...types.content import ContentBlock, Message, Messages

if TYPE_CHECKING:
    from ...agent.agent import Agent
    from ...middleware.stages import InvokeModelContext

logger = logging.getLogger(__name__)

_DEFAULT_NAME = "strands:context-injector"
"""Default plugin name; override to tell multiple injectors apart."""


class ContextInjector(Plugin):
    """Plugin that injects just-in-time context into the model input before each call.

    Before each model call, the plugin asks ``render_content`` for text, gated by ``trigger``, and
    writes it into the latest user message as an ``injected`` block. The block stays in the
    conversation and in snapshot sessions; the File and S3 session managers save each message once,
    when it is added, so they don't keep it. When the model takes temporary messages (``AnthropicModel`` on
    supported Claude models), the model receives each block as a system message it reads only until
    the next user message, so the stored history is sent unchanged on every call. Every other model
    receives only the latest user message's blocks, as text.

    Multiple injectors may be registered; each contributes its text independently, in
    plugin-registration order.

    Args:
        render_content: Renders the text to write into the latest user message, or ``None``/``""``
            to skip. Sync or async. The text reaches the model verbatim, so it is a prompt-injection
            surface: escape any attacker-influenced fields yourself. On a model that takes temporary
            messages it arrives as a system message, which the model ranks above the user, so never
            put content from outside the conversation (tool output, retrieved documents) in it.
            Called at most once per user message: a retry or a resume sends the text it returned
            the first time. A forced structured output call appends its own user message (unlike TS,
            which retries the same message), so the trigger fires again for it and a second block is
            written. A callback that raises fails open
            (injection is skipped, the model call proceeds).
        name: Plugin name, for logging and duplicate detection. Defaults to
            ``"strands:context-injector"``. The name is stored with every block the injector writes
            and keeps a retried call from writing again, including after a session restore, so keep
            it stable and give each injector its own.
        trigger: When to inject. An ``InjectionTrigger`` name selects a built-in policy
            (``"userTurn"`` — default — or ``"everyTurn"``); a predicate over the
            ``InjectionContext`` is the escape hatch. A predicate that raises fails open
            (injection is skipped). Defaults to ``"userTurn"``.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.context_injector import ContextInjector

        agent = Agent(
            plugins=[
                ContextInjector(lambda context: f"<context>{derive(context.messages)}</context>")
            ]
        )
        ```
    """

    name = _DEFAULT_NAME

    def __init__(
        self,
        render_content: RenderContent,
        *,
        name: str | None = None,
        trigger: InjectionTriggerPredicate | None = None,
    ) -> None:
        """Initialize the ContextInjector plugin.

        Args:
            render_content: Renders the text to write into the latest user message. Sync or async.
            name: Plugin name. Defaults to ``"strands:context-injector"``.
            trigger: When to inject. Defaults to ``"userTurn"``.
        """
        self.name = name or _DEFAULT_NAME
        self._render_content = render_content
        self._trigger = _resolve_trigger(trigger)
        super().__init__()

    def init_agent(self, agent: Agent) -> None:
        """Register the injection handler on the agent's ``InvokeModelStage`` input phase."""
        agent.add_middleware(InvokeModelStage.Input, self._inject)

    async def _inject(self, context: InvokeModelContext) -> InvokeModelContext:
        """Write the rendered text into the latest user message of the conversation and of this call.

        It runs as model input, after hooks and background task results have added their messages, and the model has
        not answered that message yet, so the stored history before it never changes. A message gets at most one block
        from this injector, so a retry, a forced structured output call or a resume sends the same request again, also
        after a session restore. Anything that skips leaves the conversation unchanged (fail open).
        """
        history = context.agent.messages
        latest = history[-1] if history else None
        if latest is None or latest["role"] != "user" or any(self._wrote(block) for block in latest["content"]):
            return context
        index = _call_message_index(context.messages, latest.get("tracking_id"))
        if index < 0:
            return context
        injection_context = InjectionContext(
            messages=list(context.messages), state=context.agent.state, agent=context.agent
        )
        if not self._trigger(injection_context):
            return context
        text = await self._render(injection_context)
        if text is None or not text.strip():
            return context
        block = ContentBlock(injected={"text": text, "source": self.name})
        # After the stored content, so text other middleware adds for this call only stays last.
        position = len(latest["content"])
        history[-1] = _with_block(latest, block, position)
        messages = list(context.messages)
        messages[index] = _with_block(messages[index], copy.deepcopy(block), position)
        return replace(context, messages=messages)

    async def _render(self, context: InjectionContext) -> str | None:
        try:
            text = self._render_content(context)
            if inspect.isawaitable(text):
                text = await text
            return text
        except Exception as error:  # noqa: BLE001 - fail open: a bad callback must not abort the model call.
            logger.warning("reason=<%s> | injection render_content raised | skipping injection", error)
            return None

    def _wrote(self, block: ContentBlock) -> bool:
        return "injected" in block and block["injected"]["source"] == self.name


def _call_message_index(call_messages: Messages, tracking_id: str | None) -> int:
    """Index of the stored latest message in this call's messages, which another middleware may have replaced, or -1."""
    if tracking_id is None:
        # A message a hook appended this cycle has no id yet; only the call's last message can be it.
        last = len(call_messages) - 1
        return last if last >= 0 and call_messages[last].get("tracking_id") is None else -1
    return next((index for index, message in enumerate(call_messages) if message.get("tracking_id") == tracking_id), -1)


def _with_block(message: Message, block: ContentBlock, position: int) -> Message:
    content = message["content"]
    copied: Message = {**message, "content": [*content[:position], block, *content[position:]]}
    return copied
