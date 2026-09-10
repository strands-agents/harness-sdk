"""ContextManager: first-class agent component for strategy-driven context management.

On overflow, runs the strategy pipeline (including an emergency truncation as the final step).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..hooks.events import AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent
from ..plugins.plugin import Plugin
from ..storage.in_memory_storage import InMemoryStorage
from ..types.exceptions import ContextWindowOverflowException
from .retrieval_tool import _create_retrieval_tool, _track_retrieval_tool_use_ids
from .stash import Stash
from .strategies.offload import Offload
from .strategies.offload.truncate import EmergencyTruncateStrategy
from .types import ContextState, ContextStrategy, StashConfig

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..storage.storage import Storage

logger = logging.getLogger(__name__)

DEFAULT_STRATEGIES: list[ContextStrategy] = [
    Offload.truncate("tool_results").when(threshold=2500),
    Offload.summarize("*").when(threshold=1000, utilization=0.85),
]


class ContextManager(Plugin):
    """Manages context reduction for an agent's conversation.

    On context overflow, runs the strategy pipeline (offload, summarize, emergency truncate).
    The emergency truncation is always appended as the final strategy — it recomputes
    utilization and only fires if the window is still overflowing after user strategies.

    Pass via the ``context_manager`` parameter on the Agent constructor. When present,
    it owns overflow recovery — no separate ConversationManager is needed.
    """

    @property
    def name(self) -> str:
        """Plugin name."""
        return "strands:context-manager"

    def __init__(
        self,
        *,
        strategies: list[ContextStrategy] | None = None,
        stash: StashConfig | bool | None = None,
    ) -> None:
        """Initialize with an optional ordered list of strategies (defaults provided).

        Args:
            strategies: Ordered pipeline of context reduction strategies.
            stash: L1 stash configuration. Omit or True for defaults (InMemoryStorage);
                False to disable; dict for custom storage/options.
        """
        self._strategies: list[ContextStrategy] = [
            *(strategies if strategies is not None else DEFAULT_STRATEGIES),
            EmergencyTruncateStrategy(),
        ]

        stash_obj: StashConfig | None = stash if isinstance(stash, dict) else None
        self._stash_disabled = stash is False
        self._stash_explicit_storage: Storage | None = stash_obj.get("storage") if stash_obj else None
        self._enable_retrieval_tool: bool = stash is not False and (
            stash_obj.get("retrieval_tool", True) if stash_obj else True
        )

        self._stash: Stash | None = None
        self._retrieval_tool_use_ids: set[str] = set()
        self._backfill_done: bool = False

        super().__init__()

    def init_agent(self, agent: Agent) -> None:
        """Register strategy hooks for proactive compression and overflow recovery."""
        if not self._stash_disabled:
            storage = self._stash_explicit_storage or getattr(agent, "storage", None) or InMemoryStorage()
            self._stash = Stash(storage, agent.session_id, agent.agent_id)

        # Stash hook must register before strategy init so it captures pre-offload content.
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

            acted = await self._run_strategies(event.agent)
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

    async def _run_strategies(self, agent: Agent, precomputed_input_tokens: int | None = None) -> bool:
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
            stash=self._stash,
        )

        any_acted = False
        for strategy in self._strategies:
            try:
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
