"""ContextManager: first-class agent component for strategy-driven context management.

On overflow, runs the strategy pipeline (including an emergency truncation as the final step).
"""

from __future__ import annotations

import logging
import warnings
from typing import TYPE_CHECKING, Literal

from ..hooks.events import AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent
from ..plugins.plugin import Plugin
from ..storage.in_memory_storage import InMemoryStorage
from ..storage.storage import _EPHEMERAL
from ..types.exceptions import ContextWindowOverflowException
from .presets import _resolve_strategies
from .retrieval_tool import _create_retrieval_tool, _track_retrieval_tool_use_ids
from .stash import Stash
from .strategies.offload import Offload
from .strategies.offload.truncate import EmergencyTruncateStrategy
from .types import ContextManagerConfig, ContextState, ContextStrategy, StashConfig

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..agent.conversation_manager import ConversationManager
    from ..storage.storage import Storage

logger = logging.getLogger(__name__)

_AUTO_TRUNCATE_THRESHOLD = 1_500
_AGENTIC_TRUNCATE_THRESHOLD = 8_000
_TRUNCATE_PREVIEW_TOKENS = 750
_AUTO_SUMMARIZE_UTILIZATION = 0.85

CONTEXT_MANAGER_PRESETS: tuple[str, ...] = ("auto", "agentic")

ContextManagerStrategy = Literal["auto", "agentic"]
"""Supported preset strings for the ``context_manager`` parameter.

- ``"auto"``: Proactive truncation of tool results + summarization at 85% utilization.
- ``"agentic"``: Model-driven context management via injected tools, with a higher
  truncation threshold and summarization only on overflow.
"""


class ContextManager(Plugin):
    """Manages context reduction for an agent's conversation.

    On context overflow, runs the strategy pipeline (offload, summarize, emergency truncate).
    The emergency truncation is always appended as the final strategy — it recomputes
    utilization and only fires if the window is still overflowing after user strategies.

    Configured through the Agent's ``context_manager`` parameter — pass a preset
    string (``'auto'``, ``'agentic'``) or a :class:`ContextManagerConfig`; the Agent
    constructs and registers the manager. When present, it owns overflow
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
        stash: StashConfig | bool | None = None,
    ) -> None:
        """Initialize with an optional ordered list of strategies (defaults provided).

        Args:
            strategies: Ordered pipeline of context reduction strategies.
                Accepts concrete strategies and/or preset name strings.
            stash: L1 stash configuration. Omit or True for defaults (InMemoryStorage);
                False to disable; dict for custom storage/options.
        """
        user_strategies: list[ContextStrategy]
        if strategies is not None:
            user_strategies = _resolve_strategies(strategies)
        else:
            user_strategies = [
                Offload.truncate("tool_results", {"preview_tokens": _TRUNCATE_PREVIEW_TOKENS}).when(
                    threshold=_AUTO_TRUNCATE_THRESHOLD,
                ),
                Offload.summarize("*").when(utilization=_AUTO_SUMMARIZE_UTILIZATION, preserve_recent=4),
            ]
        self._strategies: list[ContextStrategy] = [*user_strategies, EmergencyTruncateStrategy()]

        stash_obj: StashConfig | None = stash if isinstance(stash, dict) else None
        self._stash_disabled = stash is False
        self._stash_explicit_storage: Storage | None = stash_obj.get("storage") if stash_obj else None
        self._enable_retrieval_tool: bool = stash is not False and (
            stash_obj.get("retrieval_tool", True) if stash_obj else True
        )

        self._stash: Stash | None = None
        self._stash_is_durable: bool = False
        self._retrieval_tool_use_ids: set[str] = set()
        self._backfill_done: bool = False

        super().__init__()

    @property
    def stash(self) -> Stash | None:
        """The L1 stash instance, if stash is enabled and the agent has been initialized."""
        return self._stash

    @property
    def stash_is_durable(self) -> bool:
        """Whether the stash is backed by durable storage that survives process restarts.

        When True, stash data does not need to be embedded in session snapshots.
        """
        return self._stash_is_durable

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
                    threshold=_AGENTIC_TRUNCATE_THRESHOLD,
                ),
                Offload.summarize("*").when(utilization=1, preserve_recent=4),
            ]
            return ContextManager(strategies=agentic_strategies)
        if isinstance(strategy, str):
            raise ValueError(
                f'Unknown context_manager preset: "{strategy}". '
                f"Valid presets: {', '.join(f'{p!r}' for p in CONTEXT_MANAGER_PRESETS)}"
            )
        if isinstance(strategy, dict):
            return ContextManager(**strategy)
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
        if not self._stash_disabled:
            storage = self._stash_explicit_storage or getattr(agent, "storage", None) or InMemoryStorage()
            self._stash_is_durable = getattr(storage, "_ephemeral", None) is not _EPHEMERAL
            self._stash = Stash(storage, agent.session_id, agent.agent_id)

        if self._stash is not None:
            stash = self._stash
            skip_set = self._retrieval_tool_use_ids

            async def _on_message_added(event: MessageAddedEvent) -> None:
                _track_retrieval_tool_use_ids(event.message, skip_set)
                await stash.store_message(event.message, frozenset(skip_set))

            agent.hooks.add_callback(MessageAddedEvent, _on_message_added)

        if self._stash is not None and self._enable_retrieval_tool:
            retrieval_tool = _create_retrieval_tool(self._stash)
            self._tools.append(retrieval_tool)  # type: ignore[arg-type]

        for strategy in self._strategies:
            init = getattr(strategy, "init", None)
            if init is not None:
                try:
                    init(agent, stash=self._stash)
                except TypeError:
                    init(agent)

        async def _on_before_model_call(event: BeforeModelCallEvent) -> None:
            await self._run_strategies(event.agent, event.projected_input_tokens)

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

            acted = await self._run_strategies(event.agent, overflow=True)
            if not acted:
                logger.warning("agent_id=<%s> | no strategy made progress, skipping retry", event.agent.agent_id)
                return

            overflow_retries += 1
            event.retry = True

        agent.hooks.add_callback(AfterModelCallEvent, _on_after_model_call)

    async def _backfill_stash(self, agent: Agent) -> None:
        """Stash any messages already on the agent that were not seen by the hook.

        Covers Agent(messages=[...]) and session restore, which bypass MessageAddedEvent.
        """
        if self._backfill_done or self._stash is None:
            return
        self._backfill_done = True
        skip = frozenset(self._retrieval_tool_use_ids)
        for message in agent.messages:
            try:
                await self._stash.store_message(message, skip)
            except Exception:
                logger.warning("agent_id=<%s> | failed to backfill stash", agent.agent_id, exc_info=True)

    async def _run_strategies(
        self,
        agent: Agent,
        precomputed_input_tokens: int | None = None,
        *,
        overflow: bool = False,
    ) -> bool:
        """Run the strategy pipeline, recomputing utilization after each acting strategy."""
        await self._backfill_stash(agent)
        messages = agent.messages
        if precomputed_input_tokens is not None:
            input_tokens = precomputed_input_tokens
        else:
            try:
                input_tokens = await agent.model.count_tokens(messages)
            except Exception:
                logger.warning("agent_id=<%s> | token counting failed, skipping strategies", agent.agent_id)
                return False

        context = ContextState(
            messages=messages,
            agent=agent,
            utilization=agent.model.estimate_utilization(input_tokens),
            overflow=overflow,
            stash=self._stash,
        )

        any_acted = False
        for strategy in self._strategies:
            try:
                if isinstance(strategy, EmergencyTruncateStrategy) and any_acted:
                    context.overflow = False
                acted = await strategy.apply(context)
                if acted:
                    any_acted = True
                    new_tokens = await agent.model.count_tokens(messages)
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
