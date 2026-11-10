"""ContextInjector plugin for injecting just-in-time context into the model input.

This module provides the ContextInjector plugin, which folds just-in-time text into the model
input before each call without touching durable history.

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

from typing import TYPE_CHECKING

from ...injection._message_injection import RenderContent, _create_injection_middleware
from ...injection.types import InjectionTriggerPredicate
from ...middleware.stages import InvokeModelStage
from ...plugins import Plugin

if TYPE_CHECKING:
    from ...agent.agent import Agent

_DEFAULT_NAME = "strands:context-injector"
"""Default plugin name; override to tell multiple injectors apart."""


class ContextInjector(Plugin):
    """Plugin that injects just-in-time context into the model input before each call.

    Before each model call, the plugin asks ``render_content`` for text and makes it available
    to the model for that call, gated by ``trigger``. The injected text is ephemeral: it
    augments the model input for that one call and never persists into the durable conversation
    or session.

    Multiple injectors may be registered; each contributes its text independently, in
    plugin-registration order.

    Args:
        render_content: Renders the text to inject for this call, or ``None``/``""`` to skip.
            Sync or async. The text reaches the model verbatim, so it is a prompt-injection
            surface: escape any attacker-influenced fields yourself. A callback that raises
            fails open (injection is skipped, the model call proceeds).
        name: Plugin name, for logging and duplicate detection. Defaults to
            ``"strands:context-injector"``. Set a distinct name when registering more than one
            injector so they can be told apart.
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
            render_content: Renders the text to inject for this call. Sync or async.
            name: Plugin name. Defaults to ``"strands:context-injector"``.
            trigger: When to inject. Defaults to ``"userTurn"``.
        """
        self.name = name or _DEFAULT_NAME
        self._render_content = render_content
        self._trigger = trigger
        super().__init__()

    def init_agent(self, agent: Agent) -> None:
        """Register the injection middleware on the agent's ``InvokeModelStage`` input phase."""
        agent.add_middleware(
            InvokeModelStage.Input,
            _create_injection_middleware(self._render_content, trigger=self._trigger),
        )
