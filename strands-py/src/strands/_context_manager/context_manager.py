"""ContextManager: first-class agent component for strategy-driven context management.

On overflow, runs the strategy pipeline (including an emergency truncation as the final step).
"""

from __future__ import annotations

import inspect
import logging
import sys
import warnings
from typing import TYPE_CHECKING, Any, Literal

from typing_extensions import deprecated

from ..agent.invocation_context import _create_auxiliary_invocation_context
from ..hooks.events import AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent
from ..models._model_proxy import _count_request_tokens
from ..plugins.plugin import Plugin
from ..storage.in_memory_storage import InMemoryStorage
from ..storage.storage import _EPHEMERAL
from ..types.exceptions import ContextWindowOverflowException
from .archive import Archive
from .message_trimming import _index_of
from .presets import _resolve_strategies
from .retrieval_tool import _create_retrieval_tool, _retrieval_calls_before
from .strategies.offload import Offload
from .strategies.offload.base import EmergencyTruncateStrategy
from .types import ArchiveConfig, ContextManagerConfig, ContextState, ContextStrategy

if TYPE_CHECKING:
    from collections.abc import Callable

    from ..agent.agent import Agent
    from ..agent.conversation_manager import ConversationManager
    from ..agent.invocation_context import InvocationContext
    from ..storage.storage import Storage

logger = logging.getLogger(__name__)

_AUTO_TRUNCATE_THRESHOLD = 1_500
_AGENTIC_TRUNCATE_THRESHOLD = 8_000
_TRUNCATE_PREVIEW_TOKENS = 750
_AUTO_SUMMARIZE_UTILIZATION = "85%"

CONTEXT_MANAGER_PRESETS: tuple[str, ...] = ("auto", "agentic")

_ARCHIVE_KEYWORDS = ("archive", "stash")
"""The keyword a strategy's optional ``init`` takes the archive under; ``stash`` is the pre-rename name."""

_RENAMED_ATTRIBUTES = {"stash": "archive", "stash_is_durable": "archive_is_durable"}
"""Pre-rename attribute names, served from ``ContextManager.__getattr__``. Removed in v1.68.0."""

ContextManagerStrategy = Literal["auto", "agentic"]
"""Supported preset strings for the ``context_manager`` parameter.

- ``"auto"``: Proactive truncation of tool results + summarization at 85% utilization.
- ``"agentic"``: Experimental. Model-driven context management via injected tools, with a higher
  truncation threshold and summarization only on overflow.
"""


class ContextManager(Plugin):
    """Manages context reduction for an agent's conversation.

    On context overflow, runs the strategy pipeline (offload, summarize, emergency truncate).
    The emergency truncation is always appended as the final strategy — it fires only if the
    window is still overflowing after the user strategies have run.

    Configured through the Agent's ``context_manager`` parameter — pass a preset
    string (``'auto'``, or the experimental ``'agentic'``) or a :class:`ContextManagerConfig`;
    the Agent constructs and registers the manager. When present, it owns overflow
    recovery and proactive compression — no separate ConversationManager is needed.
    """

    @property
    def name(self) -> str:
        """Plugin name."""
        return "strands:context-manager"

    def __init__(
        self,
        *,
        strategies: list[ContextStrategy | str] | None = None,
        archive: ArchiveConfig | bool | None = None,
        stash: ArchiveConfig | bool | None = None,
    ) -> None:
        """Initialize with an optional ordered list of strategies (defaults provided).

        Args:
            strategies: Ordered pipeline of context reduction strategies.
                Accepts concrete strategies and/or preset name strings.
            archive: L1 archive configuration. Omit or True for defaults (InMemoryStorage);
                False to disable; dict for custom storage/options.
            stash: Deprecated name for ``archive``, honored when ``archive`` is omitted.
                Removed in v1.68.0.
        """
        if archive is None and stash is not None:
            warnings.warn(
                "ContextManager(stash=...) is deprecated and will be removed in v1.68.0. Pass archive= instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            archive = stash

        user_strategies: list[ContextStrategy]
        if strategies is not None:
            user_strategies = _resolve_strategies(strategies)
        else:
            user_strategies = [
                Offload.truncate("tool_results", {"preview_tokens": _TRUNCATE_PREVIEW_TOKENS}).when(
                    block_threshold=_AUTO_TRUNCATE_THRESHOLD,
                ),
                Offload.summarize("*").when(context_utilization=_AUTO_SUMMARIZE_UTILIZATION, preserve_recent=4),
            ]
        self._strategies: list[ContextStrategy] = [*user_strategies, EmergencyTruncateStrategy()]

        archive_obj: ArchiveConfig | None = archive if isinstance(archive, dict) else None
        self._archive_disabled = archive is False
        self._archive_explicit_storage: Storage | None = archive_obj.get("storage") if archive_obj else None
        self._enable_retrieval_tool: bool = archive is not False and (
            archive_obj.get("retrieval_tool", True) if archive_obj else True
        )

        self._archive: Archive | None = None
        self._archive_is_durable: bool = False
        self._backfill_done: bool = False

        super().__init__()

    @property
    def archive(self) -> Archive | None:
        """The L1 archive instance, if archive is enabled and the agent has been initialized."""
        return self._archive

    @property
    def archive_is_durable(self) -> bool:
        """Whether the archive is backed by durable storage that survives process restarts.

        When True, archive data does not need to be embedded in session snapshots.
        """
        return self._archive_is_durable

    if TYPE_CHECKING:
        # Declared for type checkers, served at runtime from __getattr__ below. As real properties they
        # would warn on construction: plugin discovery reads every class attribute off the instance.

        @property
        @deprecated(
            "ContextManager.stash is deprecated and will be removed in v1.68.0. Use ContextManager.archive instead."
        )
        def stash(self) -> Archive | None:
            """Deprecated name for :attr:`archive`. Removed in v1.68.0."""
            ...

        @property
        @deprecated(
            "ContextManager.stash_is_durable is deprecated and will be removed in v1.68.0. "
            "Use ContextManager.archive_is_durable instead."
        )
        def stash_is_durable(self) -> bool:
            """Deprecated name for :attr:`archive_is_durable`. Removed in v1.68.0."""
            ...

    else:

        def __getattr__(self, name: str) -> Any:
            """Serve the pre-rename ``stash`` names, warning at the caller. Removed in v1.68.0.

            Args:
                name: Attribute being read.

            Returns:
                The value held under the current name.

            Raises:
                AttributeError: For any name other than the two pre-rename ones.
            """
            current_name = _RENAMED_ATTRIBUTES.get(name)
            if current_name is None:
                raise AttributeError(f"{type(self).__name__!r} object has no attribute {name!r}")
            warnings.warn(
                f"ContextManager.{name} is deprecated and will be removed in v1.68.0. "
                f"Use ContextManager.{current_name} instead.",
                DeprecationWarning,
                stacklevel=2,
            )
            return getattr(self, current_name)

    @staticmethod
    def from_strategy(
        strategy: ContextManagerStrategy | ContextManagerConfig | ContextManager | Literal[False] | None,
    ) -> ContextManager | None:
        """Resolve a ``context_manager`` parameter value into a ContextManager instance.

        Args:
            strategy: A preset string, config dict, ContextManager instance, False, or None.

        Returns:
            A ContextManager for preset strings and configs; the instance itself if already
            a ContextManager; None for False/None.

        Raises:
            ValueError: If strategy is an unknown string.
        """
        if strategy is False or strategy is None:
            return None
        if isinstance(strategy, ContextManager):
            return strategy
        if strategy == "auto":
            return ContextManager()
        if strategy == "agentic":
            agentic_strategies: list[ContextStrategy | str] = [
                Offload.truncate("tool_results", {"preview_tokens": _TRUNCATE_PREVIEW_TOKENS}).when(
                    block_threshold=_AGENTIC_TRUNCATE_THRESHOLD,
                ),
                Offload.summarize("*").when(context_utilization="100%", preserve_recent=4),
            ]
            return ContextManager(strategies=agentic_strategies)
        if isinstance(strategy, str):
            raise ValueError(
                f'Unknown context_manager preset: "{strategy}". '
                f"Valid presets: {', '.join(f'{p!r}' for p in CONTEXT_MANAGER_PRESETS)}"
            )
        if isinstance(strategy, dict):
            # Warn here rather than in __init__: the default warning filter only shows a
            # DeprecationWarning attributed to the caller's own module, and from __init__ this path
            # attributes it to the SDK.
            config: dict[str, Any] = {**strategy}
            if config.get("archive") is None and config.get("stash") is not None:
                warnings.warn(
                    'The "stash" key of a context_manager config is deprecated and will be removed in v1.68.0. '
                    'Use "archive" instead.',
                    DeprecationWarning,
                    stacklevel=3,
                )
                config["archive"] = config.pop("stash")
            return ContextManager(**config)
        raise ValueError(
            f"Unsupported context_manager value: {strategy!r}. "
            "Supported: 'auto', 'agentic', ContextManagerConfig dict, ContextManager instance, or False"
        )

    @staticmethod
    def resolve_conversation_manager(
        context_manager: ContextManagerStrategy | ContextManagerConfig | ContextManager | Literal[False] | None,
        conversation_manager: ConversationManager | None,
    ) -> ConversationManager:
        """Resolve the conversation manager given the context_manager facade value.

        When context_manager is None, falls back to the default SlidingWindowConversationManager.
        When context_manager is set, the ContextManager owns all context reduction and the
        conversation manager is set to a no-op internally.

        Args:
            context_manager: The facade value.
            conversation_manager: User-provided conversation manager.

        Returns:
            The resolved conversation manager.
        """
        from ..agent.conversation_manager import NullConversationManager, SlidingWindowConversationManager

        if context_manager is None:
            return conversation_manager if conversation_manager is not None else SlidingWindowConversationManager()
        if context_manager is False:
            return conversation_manager if conversation_manager is not None else NullConversationManager()
        if conversation_manager is not None:
            warnings.warn(
                "context_manager is set, ignoring co-provided conversation_manager",
                stacklevel=3,
            )
        return NullConversationManager()

    def init_agent(self, agent: Agent) -> None:
        """Register strategy hooks for proactive compression and overflow recovery."""
        if not self._archive_disabled:
            storage = self._archive_explicit_storage or getattr(agent, "storage", None) or InMemoryStorage()
            self._archive_is_durable = getattr(storage, "_ephemeral", None) is not _EPHEMERAL
            # Only explicit archive storage may be a shared root; agent.storage is shared with other subsystems.
            self._archive = Archive(
                storage,
                agent.session_id,
                agent.agent_id,
                custom_archive_namespace=self._archive_explicit_storage is not None,
            )

        if self._archive is not None:
            archive = self._archive

            async def _on_message_added(event: MessageAddedEvent) -> None:
                messages = event.agent.messages
                index = _index_of(messages, event.message)
                await archive.store_message(event.message, _retrieval_calls_before(messages, index))

            agent.hooks.add_callback(MessageAddedEvent, _on_message_added)

        if self._archive is not None and self._enable_retrieval_tool:
            retrieval_tool = _create_retrieval_tool(self._archive)
            self._tools.append(retrieval_tool)  # type: ignore[arg-type]

        for strategy in self._strategies:
            init = getattr(strategy, "init", None)
            if init is not None:
                _init_strategy(init, agent, self._archive)

        async def _on_before_model_call(event: BeforeModelCallEvent) -> None:
            await self._run_strategies(
                event.agent, event.projected_input_tokens, invocation_context=event.invocation_context
            )

        agent.hooks.add_callback(BeforeModelCallEvent, _on_before_model_call)

        overflow_retries = 0

        async def _on_after_model_call(event: AfterModelCallEvent) -> None:
            nonlocal overflow_retries

            if not isinstance(event.exception, ContextWindowOverflowException):
                overflow_retries = 0
                return

            if overflow_retries >= 3:
                logger.warning("agent_id=<%s> | overflow retry limit reached, giving up", event.agent.agent_id)
                overflow_retries = 0
                return

            acted = await self._run_strategies(event.agent, overflow=True, invocation_context=event.invocation_context)
            if not acted:
                logger.warning("agent_id=<%s> | no strategy made progress, skipping retry", event.agent.agent_id)
                return

            overflow_retries += 1
            event.retry = True

        agent.hooks.add_callback(AfterModelCallEvent, _on_after_model_call)

    async def _backfill_archive(self, agent: Agent) -> None:
        """Archive any messages already on the agent that were not seen by the hook.

        Covers Agent(messages=[...]) and session restore, which bypass MessageAddedEvent.
        Existing entries are kept: after a restore the archive holds the originals, while the
        matching messages on the agent may already be offloaded previews.
        """
        if self._backfill_done or self._archive is None:
            return
        self._backfill_done = True
        for index, message in enumerate(agent.messages):
            try:
                await self._archive.store_message(
                    message, _retrieval_calls_before(agent.messages, index), keep_existing=True
                )
            except Exception:
                logger.warning("agent_id=<%s> | failed to backfill archive", agent.agent_id, exc_info=True)

    async def _run_strategies(
        self,
        agent: Agent,
        precomputed_input_tokens: int | None = None,
        *,
        overflow: bool = False,
        invocation_context: InvocationContext | None = None,
    ) -> bool:
        """Run the strategy pipeline, recomputing utilization after each acting strategy."""
        await self._backfill_archive(agent)
        messages = agent.messages
        if precomputed_input_tokens is not None:
            input_tokens = precomputed_input_tokens
        else:
            try:
                input_tokens = await _count_request_tokens(agent, messages)
            except Exception:
                logger.warning("agent_id=<%s> | token counting failed, skipping strategies", agent.agent_id)
                return False

        context = ContextState(
            messages=messages,
            agent=agent,
            utilization=agent.model.estimate_utilization(input_tokens),
            overflow=overflow,
            archive=self._archive,
            invocation_context=_create_auxiliary_invocation_context(invocation_context),
        )

        any_acted = False
        for strategy in self._strategies:
            try:
                if isinstance(strategy, EmergencyTruncateStrategy) and any_acted:
                    context.overflow = False
                acted = await strategy.apply(context)
                if acted:
                    any_acted = True
                    new_tokens = await _count_request_tokens(agent, messages)
                    context.utilization = agent.model.estimate_utilization(new_tokens)
                    logger.debug("strategy=<%s>, agent_id=<%s> | strategy applied", strategy.name, agent.agent_id)
            except Exception:
                logger.warning(
                    "strategy=<%s>, agent_id=<%s> | strategy failed, continuing",
                    strategy.name,
                    agent.agent_id,
                    exc_info=True,
                )
        return any_acted


if sys.version_info >= (3, 14):
    import annotationlib

    def _signature(init: Callable[..., Any]) -> inspect.Signature:
        """Read a signature without evaluating annotations, which 3.14 defers and may not resolve."""
        return inspect.signature(init, annotation_format=annotationlib.Format.STRING)

else:
    _signature = inspect.signature


def _init_strategy(init: Callable[..., Any], agent: Agent, archive: Archive | None) -> None:
    """Call a strategy's optional ``init`` with the archive, under whichever keyword it declares.

    The keyword is read off the signature rather than tried and retried, so a ``TypeError`` raised by ``init``
    itself is never mistaken for one it does not accept. A strategy that declares neither keyword, nor
    ``**kwargs``, is called with the agent alone.

    A ``**kwargs``-only ``init`` receives ``archive=`` alone, the one pre-rename spelling that does not carry
    forward: passing ``stash=`` as well would reach an ``init`` that forwards ``**kwargs`` to a built-in
    strategy, which does not accept it.
    """
    try:
        parameters = _signature(init).parameters
    except (TypeError, ValueError):
        init(agent, archive=archive)
        return
    if any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):
        init(agent, archive=archive)
        return
    keyword = next((name for name in _ARCHIVE_KEYWORDS if name in parameters), None)
    if keyword is None:
        init(agent)
        return
    init(agent, **{keyword: archive})
