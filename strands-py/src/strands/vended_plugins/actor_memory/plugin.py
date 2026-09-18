"""ActorMemory plugin for persisting facts about an actor across sessions.

This module provides the ActorMemory plugin, which lets an agent remember
durable facts about an actor (a user, tenant, or other stable identity) and
recall them in later sessions. This is deliberately distinct from
``SessionManager``: a ``SessionManager`` persists one conversation's full
transcript and state, keyed by ``session_id`` — starting a new session starts
blank. ``ActorMemory`` persists a small, curated set of facts keyed by
``actor_id``, which survives across many separate sessions for the same actor.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from ..._identifier import Identifier
from ..._identifier import validate as validate_identifier
from ...hooks.events import BeforeInvocationEvent
from ...plugins import Plugin, hook
from ...storage import LocalFileStorage, Storage
from ...storage.storage import _NAMESPACED, _NamespacedStorage
from ...tools.decorator import tool
from ...types.content import SystemContentBlock

if TYPE_CHECKING:
    from ...agent.agent import Agent

logger = logging.getLogger(__name__)

_DEFAULT_STATE_KEY = "actor_memory"
_DEFAULT_MAX_FACTS = 200

_ACTOR_MEMORY_NAMESPACE = "actor_memory"
_FACTS_KEY_SUFFIX = "facts.json"


def _resolve_storage(storage: Storage) -> Storage:
    """Namespace raw storage under "actor_memory"; pass an already namespaced view through."""
    if getattr(storage, "_namespaced", None) is _NAMESPACED:
        return storage
    return _NamespacedStorage(storage, _ACTOR_MEMORY_NAMESPACE)


def _facts_key(actor_id: str) -> str:
    """Return the namespace-relative storage key for an actor's facts."""
    return f"{actor_id}/{_FACTS_KEY_SUFFIX}"


class ActorMemory(Plugin):
    """Plugin that persists facts about an actor across separate agent sessions.

    The plugin provides:

    1. A ``remember`` tool the agent calls to persist a fact worth keeping
       long term.
    2. Injection of previously remembered facts into the system prompt before
       each invocation, so a new session (a new ``session_id``, a new process,
       a new ``Agent`` instance) still recalls what was learned before.

    Facts are stored under a key scoped to ``actor_id``, not ``session_id`` —
    the same actor's facts are visible across every session, while two
    different actors never see each other's facts.

    Args:
        actor_id: Stable identity the facts are scoped to (a user, tenant, etc.).
        storage: Backend for persisting facts. When omitted, resolves from the
            agent's ``storage`` during initialization; if the agent has none either,
            falls back to ``LocalFileStorage()`` (a ``./.strands/`` directory), so the
            plugin works with no additional setup. Pass a shared backend (e.g. an
            ``S3Storage`` already used elsewhere in the app) to persist facts
            alongside other agent data.
        max_facts: Maximum number of facts retained per actor. Oldest facts are
            dropped once the limit is exceeded.

    Example:
        ```python
        from strands import Agent
        from strands.vended_plugins.actor_memory import ActorMemory

        agent = Agent(plugins=[ActorMemory(actor_id="user-123")])
        ```
    """

    name = "actor_memory"

    def __init__(
        self,
        actor_id: str,
        storage: Storage | None = None,
        max_facts: int = _DEFAULT_MAX_FACTS,
    ) -> None:
        """Initialize the ActorMemory plugin.

        Args:
            actor_id: Stable identity the facts are scoped to.
            storage: Backend for persisting facts. When omitted, resolved from
                ``agent.storage`` (or ``LocalFileStorage()``) during ``init_agent``.
            max_facts: Maximum number of facts retained per actor.

        Raises:
            ValueError: If ``actor_id`` is empty, is a relative-path segment (``.`` or ``..``),
                normalizes to empty, or contains a path separator; or if ``max_facts`` is less
                than 1.
        """
        actor_id = validate_identifier(actor_id, Identifier.ACTOR)
        # validate_identifier permits ""/"."/".."/whitespace, which either collapse the actor's
        # storage key onto another actor's or another namespace entirely. Reject those here.
        if not actor_id.strip() or actor_id in (".", ".."):
            raise ValueError(f"actor_id is not a valid actor identifier: {actor_id!r}")

        if max_facts < 1:
            raise ValueError("max_facts must be at least 1")

        self._actor_id = actor_id
        self._max_facts = max_facts
        self._storage: Storage | None = _resolve_storage(storage) if storage is not None else None
        self._facts_cache: list[str] | None = None
        super().__init__()

    async def init_agent(self, agent: Agent) -> None:
        """Resolve the storage backend, defaulting to the agent's own storage.

        Args:
            agent: The agent instance to extend with actor memory.
        """
        if self._storage is None:
            base_storage = agent.storage if agent.storage is not None else LocalFileStorage()
            self._storage = _resolve_storage(base_storage)

    @property
    def _resolved_storage(self) -> Storage:
        """Return the resolved storage, raising if the plugin was never attached to an agent."""
        if self._storage is None:
            raise RuntimeError(
                "ActorMemory requires a storage backend. Provide storage in the constructor or "
                "attach the plugin to an Agent via plugins=[...]."
            )
        return self._storage

    async def _load_facts(self) -> list[str]:
        """Load facts, from cache after the first read."""
        if self._facts_cache is not None:
            return list(self._facts_cache)

        data = await self._resolved_storage.read(_facts_key(self._actor_id))
        facts: list[str] = json.loads(data) if data else []
        self._facts_cache = facts
        return list(facts)

    async def _save_facts(self, facts: list[str]) -> None:
        """Persist facts to storage and update the cache."""
        await self._resolved_storage.write(_facts_key(self._actor_id), json.dumps(facts).encode("utf-8"))
        self._facts_cache = facts

    @tool
    async def remember(self, fact: str) -> str:
        """Persist a fact about this actor so it is recalled in future sessions.

        Use this when the user states a durable preference or a fact that
        should hold beyond this conversation (e.g. "always answer in Spanish").
        Do not use it for information relevant only to the current task.

        Args:
            fact: The fact to remember, stated concisely and in a way that
                will still make sense read out of context in a future session.
        """
        facts = await self._load_facts()
        if fact in facts:
            return "Already remembered."

        facts.append(fact)
        if len(facts) > self._max_facts:
            dropped_count, facts = len(facts) - self._max_facts, facts[-self._max_facts :]
            logger.warning(
                "actor_id=<%s>, max_facts=<%d>, dropped_count=<%d> | oldest facts dropped to stay within max_facts",
                self._actor_id,
                self._max_facts,
                dropped_count,
            )

        await self._save_facts(facts)
        logger.debug("actor_id=<%s>, fact_count=<%d> | fact remembered", self._actor_id, len(facts))
        return "Remembered."

    def _get_state(self, agent: Agent) -> dict[str, Any]:
        """Get this plugin's agent state dict, raising if it was overwritten with a non-dict."""
        state_data = agent.state.get(_DEFAULT_STATE_KEY)
        if state_data is not None and not isinstance(state_data, dict):
            raise TypeError(f"expected dict for state key '{_DEFAULT_STATE_KEY}', got {type(state_data).__name__}")
        return state_data if state_data is not None else {}

    @staticmethod
    def _format_facts(facts: list[str]) -> str:
        """Render remembered facts as a system-prompt block, or "" if there are none."""
        if not facts:
            return ""
        lines = "\n".join(f"- {fact}" for fact in facts)
        return f"<remembered_facts>\n{lines}\n</remembered_facts>"

    @hook
    async def _on_before_invocation(self, event: BeforeInvocationEvent) -> None:
        """Inject remembered facts into the system prompt before each invocation.

        Removes the previously injected block (if any) via exact match and
        appends a fresh one, so re-invocation never duplicates facts. Uses
        agent state to track the injected text, mirroring the approach used by
        the ``AgentSkills`` plugin for its own system-prompt injection. Leaves
        the prompt and state untouched when there are no facts and nothing
        previously injected to remove.

        Args:
            event: The before-invocation event containing the agent reference.
        """
        agent = event.agent
        facts = await self._load_facts()
        facts_text = self._format_facts(facts)

        state_data = self._get_state(agent)
        last_injected = state_data.get("last_injected_text")

        if not facts_text and last_injected is None:
            return

        content = agent.system_prompt_content
        if content is not None:
            blocks: list[SystemContentBlock] = list(content)
            if last_injected is not None:
                injected_block: SystemContentBlock = {"text": last_injected}
                if injected_block in blocks:
                    blocks.remove(injected_block)
                else:
                    logger.warning("unable to find previously injected memory block in system prompt, re-appending")
            if facts_text:
                blocks.append({"text": facts_text})
            agent.system_prompt = blocks
        else:
            current_prompt = agent.system_prompt or ""
            if last_injected and last_injected in current_prompt:
                current_prompt = current_prompt.replace(last_injected, "")
            injection = f"\n\n{facts_text}" if current_prompt and facts_text else facts_text
            agent.system_prompt = f"{current_prompt}{injection}" if current_prompt else injection
            facts_text = injection

        state_data["last_injected_text"] = facts_text or None
        agent.state.set(_DEFAULT_STATE_KEY, state_data)
