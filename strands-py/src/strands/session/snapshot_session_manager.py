"""Snapshot-based session manager.

Persists an agent as a single versioned :class:`~strands.types._snapshot.Snapshot`
blob on each lifecycle event, mirroring the TypeScript SDK's ``SessionManager``:

- A mutable ``snapshot_latest`` is overwritten on each save, for crash/restart resume.
- Append-only immutable snapshots (time-ordered keys) are written when a ``snapshot_trigger``
  fires, enabling checkpointing — restore to any prior state, not just the latest.

The manager persists snapshots through the unified :class:`~strands.storage.storage.Storage`
primitive (``write``/``read``/``delete``/``list`` over byte blobs). It owns the key layout,
snapshot-id scheme, and serialization; the storage backend only moves bytes, so the same
``Storage`` instance can back sessions, memory, and other subsystems.

This is distinct from the older message-log session managers
(:class:`~strands.session.repository_session_manager.RepositorySessionManager` and its
subclasses), which persist each message individually. Snapshots capture the whole agent
in one atomic blob and are the recommended path for new agents.
"""

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any, Literal, Protocol, get_args, runtime_checkable

from .._async import run_async
from .._identifier import Identifier, is_uuid7
from .._identifier import new_uuid7 as _new_snapshot_id
from .._identifier import validate as validate_identifier
from ..experimental.hooks.events import BidiAgentInitializedEvent
from ..hooks.events import (
    AfterInvocationEvent,
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    AgentInitializedEvent,
    BeforeMultiAgentInvocationEvent,
    MessageAddedEvent,
    MultiAgentInitializedEvent,
)
from ..hooks.registry import HookRegistry
from ..storage.local_file_storage import LocalFileStorage
from ..storage.storage import _NAMESPACED, Storage, _NamespacedStorage
from ..types._snapshot import Snapshot
from ..types.content import Message
from ..types.exceptions import SnapshotException
from ..types.session import decode_bytes_values, encode_bytes_values
from .session_manager import SessionManager

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..multiagent.base import MultiAgentBase

logger = logging.getLogger(__name__)

SaveLatestStrategy = Literal["message", "invocation", "trigger"]
"""Controls how often ``snapshot_latest`` is saved automatically.

- ``"invocation"``: after every agent invocation completes (default; balances durability and I/O).
- ``"message"``: after every message added (most durable, highest I/O).
- ``"trigger"``: only when ``snapshot_trigger`` fires (or manually via ``save_snapshot``).

Guardrail redactions are flushed immediately under every strategy, including ``"trigger"``,
so pre-redaction content never sits at rest. This diverges from the TypeScript SDK, which
does not flush redactions under ``"trigger"``; see :meth:`SnapshotSessionManager.redact_latest_message`.
"""

# Derived from the Literal above so the accepted runtime values cannot drift from the type.
_SAVE_LATEST_STRATEGIES = get_args(SaveLatestStrategy)

MultiAgentSaveLatestStrategy = Literal["node", "invocation"]
"""Controls how often an orchestrator's ``snapshot_latest`` is saved automatically.

- ``"node"``: after every node completes (default; a mid-run crash resumes at the last node).
- ``"invocation"``: only after the whole orchestrator invocation completes (lower I/O; a crash
  loses the in-flight run). A large Graph on a remote store can opt down to this.

Orchestrators are latest-only — no immutable history and no ``snapshot_trigger``. Mirrors the
TypeScript SDK's ``MultiAgentSaveLatestStrategy``.
"""

_MULTI_AGENT_SAVE_LATEST_STRATEGIES = get_args(MultiAgentSaveLatestStrategy)

# Top-level storage namespace for all session data. Byte-identical to the TypeScript SDK,
# which namespaces its unified storage under "session" (singular) before the session id, so
# the on-disk key layout is shared across SDKs. The manager applies this namespace once (unless
# the caller passed an already-namespaced view) and builds keys relative to it, so a caller who
# pre-namespaces under "session" does not get a doubled "session/session/..." prefix.
_SESSIONS_NAMESPACE = "session"

_SNAPSHOT_LATEST = "snapshot_latest.json"
_IMMUTABLE_HISTORY = "immutable_history"
_SNAPSHOT_REGEX = re.compile(r"snapshot_([\w-]+)\.json\Z")

# Cap concurrent deletes so a session with many immutable checkpoints does not spawn thousands
# of simultaneous blocking storage calls (e.g. S3's per-object delete via asyncio.to_thread).
_DELETE_CONCURRENCY = 100

# -- Key layout, relative to the "session" storage namespace applied in __init__ --
#
#   <session_id>/scopes/agent/<agent_id>/snapshots/
#     snapshot_latest.json
#     immutable_history/snapshot_<id>.json
#
# The namespaced storage view prepends "session/", so the full on-disk key is
# session/<session_id>/... — byte-identical to the TypeScript SDK. These are module-level so the
# migration utility builds the same keys the manager reads.


def _resolve_storage(storage: Storage) -> Storage:
    """Namespace raw storage under ``"session"``; pass an already-namespaced view through.

    Mirrors the TypeScript SDK: a view the caller already scoped (marked with ``_NAMESPACED``)
    is used as-is so its prefix is not doubled, otherwise raw storage is wrapped under the
    ``"session"`` namespace. Manager keys are built relative to the result.
    """
    if getattr(storage, "_namespaced", None) is _NAMESPACED:
        return storage
    return _NamespacedStorage(storage, _SESSIONS_NAMESPACE)


def _validate_snapshot_id(snapshot_id: str) -> None:
    """Validate that a string is an SDK-vended snapshot id (a UUIDv7).

    Snapshot ids are opaque handles callers get from ``list_snapshot_ids`` and never construct.
    The fixed shape also guards the immutable-history key against traversal.

    Args:
        snapshot_id: The string to validate.

    Raises:
        ValueError: If the string is not a valid snapshot id.
    """
    if not is_uuid7(snapshot_id):
        raise ValueError(f"'{snapshot_id}' is not a valid snapshot id")


def _session_prefix(session_id: str) -> str:
    """Return the namespace-relative key prefix covering an entire session."""
    session_id = validate_identifier(session_id, Identifier.SESSION)
    return f"{session_id}/"


def _snapshots_prefix(session_id: str, agent_id: str) -> str:
    """Return the namespace-relative key prefix for an agent's snapshots directory."""
    agent_id = validate_identifier(agent_id, Identifier.AGENT)
    return f"{_session_prefix(session_id)}scopes/agent/{agent_id}/snapshots/"


def _snapshot_key(session_id: str, agent_id: str, *, snapshot_id: str | None) -> str:
    """Return the storage key for a snapshot; ``None`` targets ``snapshot_latest``."""
    prefix = _snapshots_prefix(session_id, agent_id)
    if snapshot_id is None:
        return f"{prefix}{_SNAPSHOT_LATEST}"
    _validate_snapshot_id(snapshot_id)
    return f"{prefix}{_IMMUTABLE_HISTORY}/snapshot_{snapshot_id}.json"


def _multi_agent_latest_key(session_id: str, orchestrator_id: str) -> str:
    """Return the ``snapshot_latest`` key for an orchestrator.

    Orchestrators are latest-only (no immutable history), byte-identical to the TypeScript SDK's
    ``multiAgent`` scope: ``session/<session_id>/scopes/multiAgent/<orchestrator_id>/snapshots/``.
    """
    orchestrator_id = validate_identifier(orchestrator_id, Identifier.AGENT)
    return f"{_session_prefix(session_id)}scopes/multiAgent/{orchestrator_id}/snapshots/{_SNAPSHOT_LATEST}"


def _serialize_snapshot(snapshot: Snapshot) -> bytes:
    """Serialize a snapshot to JSON bytes, base64-encoding any bytes content."""
    return json.dumps(encode_bytes_values(snapshot.to_dict()), ensure_ascii=False).encode("utf-8")


def _deserialize_snapshot(data: bytes) -> Snapshot:
    """Deserialize JSON bytes into a snapshot, decoding any base64 bytes content.

    Raises:
        SnapshotException: If the bytes are not a valid, current-schema snapshot (malformed
            JSON, wrong encoding, wrong shape, or an unsupported schema/scope).
    """
    try:
        decoded = decode_bytes_values(json.loads(data))
    except (ValueError, UnicodeDecodeError) as error:
        raise SnapshotException(f"Failed to deserialize snapshot: {error}") from error
    if not isinstance(decoded, dict):
        raise SnapshotException(f"Snapshot is not an object: got {type(decoded).__name__}")
    try:
        return Snapshot.from_dict(decoded)
    except (KeyError, TypeError, AttributeError) as error:
        raise SnapshotException(f"Failed to deserialize snapshot: {error}") from error


@runtime_checkable
class SnapshotTrigger(Protocol):
    """Decides whether to write an immutable checkpoint after an invocation."""

    def __call__(self, *, agent_data: "Agent", **kwargs: Any) -> bool:
        """Return True to append an immutable snapshot for the given agent.

        Args:
            agent_data: The agent that just completed an invocation.
            **kwargs: Additional keyword arguments for future extensibility.

        Returns:
            True to create an immutable checkpoint, False otherwise.
        """
        ...


class SnapshotSessionManager(SessionManager):
    """Persists agent snapshots to a :class:`~strands.storage.storage.Storage` across invocations.

    On agent initialization the latest snapshot is restored automatically. On each
    qualifying lifecycle event the agent is re-captured and ``snapshot_latest`` is
    overwritten. When ``snapshot_trigger`` returns True after an invocation, an
    additional immutable snapshot is appended for time-travel restore.

    Single agents get immutable time-travel snapshots via ``snapshot_trigger``. Graph and Swarm
    orchestrators are persisted latest-only: state is captured after each node (or each invocation,
    per ``multi_agent_save_latest_on``) and restored lazily on their first invocation. Attaching
    this manager to a BidiAgent raises ``NotImplementedError``.

    Example:
        ```python
        from strands import Agent
        from strands.session import SnapshotSessionManager
        from strands.storage import LocalFileStorage

        session = SnapshotSessionManager("my-session", storage=LocalFileStorage())
        agent = Agent(session_manager=session)
        ```
    """

    def __init__(
        self,
        session_id: str = "default-session",
        *,
        storage: Storage | None = None,
        save_latest_on: SaveLatestStrategy = "invocation",
        multi_agent_save_latest_on: MultiAgentSaveLatestStrategy = "node",
        snapshot_trigger: SnapshotTrigger | None = None,
        **kwargs: Any,
    ) -> None:
        """Initialize the snapshot session manager.

        Args:
            session_id: Unique session identifier. Must not contain path separators.
            storage: Unified storage backend that persists snapshot blobs. When None,
                resolves from the agent-level ``storage`` during initialization; if no
                agent-level storage is available, falls back to
                :class:`~strands.storage.local_file_storage.LocalFileStorage`.
            save_latest_on: When to overwrite ``snapshot_latest``. See :data:`SaveLatestStrategy`.
            multi_agent_save_latest_on: For Graph/Swarm orchestrators, when to overwrite the
                orchestrator's ``snapshot_latest``. See :data:`MultiAgentSaveLatestStrategy`.
            snapshot_trigger: Optional callback invoked after each invocation; when it
                returns True an immutable snapshot is appended for checkpointing. An immutable
                snapshot can also be forced at any point via :meth:`save_snapshot`.
            **kwargs: Additional keyword arguments for future extensibility.

        Raises:
            ValueError: If ``session_id`` is empty, is a relative-path segment (``.`` or ``..``),
                normalizes to empty, or contains a path separator; or if ``save_latest_on`` is
                not a recognized strategy.
        """
        self.session_id = validate_identifier(session_id, Identifier.SESSION)
        # validate_identifier permits "."/".."/whitespace, which either collapse the session
        # prefix (silently writing to a shared/wrong key on which delete_session then no-ops)
        # or explode deep in the storage layer. Reject anything that isn't a usable id here.
        if not self.session_id.strip() or self.session_id in (".", ".."):
            raise ValueError(f"session_id is not a valid session identifier: {session_id!r}")
        if save_latest_on not in _SAVE_LATEST_STRATEGIES:
            # Silently accepting an unknown value would register no save hooks — the session
            # would persist nothing with no error.
            raise ValueError(f"save_latest_on must be one of {_SAVE_LATEST_STRATEGIES}, got {save_latest_on!r}")
        if multi_agent_save_latest_on not in _MULTI_AGENT_SAVE_LATEST_STRATEGIES:
            raise ValueError(
                f"multi_agent_save_latest_on must be one of {_MULTI_AGENT_SAVE_LATEST_STRATEGIES}, "
                f"got {multi_agent_save_latest_on!r}"
            )
        self._storage: Storage | None = _resolve_storage(storage) if storage is not None else None
        self._save_latest_on: SaveLatestStrategy = save_latest_on
        self._multi_agent_save_latest_on: MultiAgentSaveLatestStrategy = multi_agent_save_latest_on
        self._snapshot_trigger = snapshot_trigger
        # Orchestrator ids restored this process, so restore runs once per orchestrator (lazily,
        # on its first invocation) rather than on every invocation.
        self._multi_agent_restored_ids: set[str] = set()

    @property
    def _resolved_storage(self) -> Storage:
        """Return the resolved storage, raising if not yet initialized."""
        if self._storage is None:
            raise RuntimeError(
                "SnapshotSessionManager requires a storage backend. "
                "Provide storage in the constructor or set storage on the Agent."
            )
        return self._storage

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """Register lifecycle callbacks for snapshot persistence.

        Overrides the base wiring: the message-log callbacks are replaced with
        snapshot save/restore handlers.
        """
        # Restore must be synchronous — AgentInitializedEvent forbids async callbacks.
        registry.add_callback(AgentInitializedEvent, lambda event: self.initialize(event.agent))

        # The save paths run under invoke_callbacks_async, so register them as native
        # async handlers and avoid the sync bridge.
        if self._save_latest_on == "message":
            registry.add_callback(MessageAddedEvent, self._on_message_added)
        registry.add_callback(AfterInvocationEvent, self._on_after_invocation)

        # An orchestrator has no AgentInitializedEvent to lazily resolve storage from, so its hooks
        # are wired at its own init event. A BidiAgent is still unsupported and rejected there.
        registry.add_callback(MultiAgentInitializedEvent, self._init_multi_agent)
        registry.add_callback(BidiAgentInitializedEvent, self._reject_bidi_agent)

    def _init_multi_agent(self, event: MultiAgentInitializedEvent) -> None:
        """Wire orchestrator snapshot persistence at init.

        Registers a lazy restore before the first invocation and save handlers after work
        completes. No state is captured here — a freshly built orchestrator has none. Storage
        must come from the constructor, since an orchestrator has no agent to resolve it from.
        """
        orchestrator = event.source
        if self._storage is None:
            raise RuntimeError(
                "SnapshotSessionManager requires a storage backend for multi-agent orchestrators. "
                "Provide storage in the constructor."
            )
        orchestrator.add_hook(self._on_before_multi_agent_invocation, BeforeMultiAgentInvocationEvent)
        if self._multi_agent_save_latest_on == "node":
            orchestrator.add_hook(self._on_after_node_call, AfterNodeCallEvent)
        orchestrator.add_hook(self._on_after_multi_agent_invocation, AfterMultiAgentInvocationEvent)

    async def _on_before_multi_agent_invocation(self, event: BeforeMultiAgentInvocationEvent) -> None:
        """Restore orchestrator state once, on its first invocation."""
        orchestrator = event.source
        if orchestrator.id in self._multi_agent_restored_ids:
            return
        await self._restore_multi_agent(orchestrator)
        self._multi_agent_restored_ids.add(orchestrator.id)

    async def _on_after_node_call(self, event: AfterNodeCallEvent) -> None:
        """Save latest orchestrator snapshot after each node completes."""
        await self._save_multi_agent_latest(event.source)

    async def _on_after_multi_agent_invocation(self, event: AfterMultiAgentInvocationEvent) -> None:
        """Save latest orchestrator snapshot after the invocation completes."""
        await self._save_multi_agent_latest(event.source)

    async def _restore_multi_agent(self, orchestrator: "MultiAgentBase") -> bool:
        """Load an orchestrator's latest snapshot into it. Returns False if none exists."""
        from ..multiagent.snapshot import load_snapshot

        key = _multi_agent_latest_key(self.session_id, orchestrator.id)
        data = await self._resolved_storage.read(key)
        if data is None:
            return False
        load_snapshot(orchestrator, _deserialize_snapshot(data))
        return True

    async def _save_multi_agent_latest(self, orchestrator: "MultiAgentBase") -> None:
        """Capture the orchestrator and overwrite its ``snapshot_latest``."""
        from ..multiagent.snapshot import take_snapshot

        data = _serialize_snapshot(take_snapshot(orchestrator))
        await self._resolved_storage.write(_multi_agent_latest_key(self.session_id, orchestrator.id), data)

    def _reject_bidi_agent(self, event: BidiAgentInitializedEvent) -> None:
        """Raise on BidiAgent init; bidirectional-streaming snapshot persistence is not supported yet."""
        raise NotImplementedError(
            f"{type(self).__name__} does not support BidiAgent persistence. "
            "Use a message-log session manager (FileSessionManager, S3SessionManager) for "
            "bidirectional-streaming agents."
        )

    # -- ABC methods (invoked synchronously by the Agent; bridge to async storage) --

    def initialize(self, agent: "Agent", **kwargs: Any) -> None:
        """Restore the agent from its latest snapshot, if one exists.

        Storage is resolved on the first call and cached; a single manager instance should not be
        shared across agents with differing storage backends.

        Args:
            agent: Agent to restore.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        if self._storage is None:
            self._storage = _resolve_storage(agent.storage if agent.storage is not None else LocalFileStorage())
        run_async(lambda: self._initialize_async(agent))

    def sync_agent(self, agent: "Agent", **kwargs: Any) -> None:
        """Capture the agent and overwrite ``snapshot_latest``.

        Args:
            agent: Agent to persist.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        run_async(lambda: self._save_latest(agent))

    def redact_latest_message(self, redact_message: Message, agent: "Agent", **kwargs: Any) -> None:
        """Persist immediately after a guardrail redaction, under every strategy.

        The Agent has already applied the redaction to ``agent.messages[-1]`` before
        calling this, so re-capturing the agent flushes pre-redaction content out of
        the persisted latest snapshot. This flush happens regardless of ``save_latest_on``
        (including ``"trigger"``) because the Agent invokes this method directly, not through
        a hook the manager could decline to register — so pre-redaction content never sits at
        rest. This diverges from the TypeScript SDK, which gates redaction persistence behind
        an ``AfterModelCall`` hook it skips under ``"trigger"`` and therefore does not flush there.

        Args:
            redact_message: The redacted replacement message (already applied by the Agent).
            agent: Agent whose latest message was redacted.
            **kwargs: Additional keyword arguments for future extensibility.
        """
        run_async(lambda: self._save_latest(agent))

    def append_message(self, message: Message, agent: "Agent", **kwargs: Any) -> None:
        """No-op — snapshots capture the whole agent.

        Per-message persistence under the ``"message"`` strategy is handled by the
        ``MessageAddedEvent`` hook, not by this method.

        Args:
            message: The message that was appended (unused).
            agent: The agent the message was appended to (unused).
            **kwargs: Additional keyword arguments for future extensibility.
        """

    # -- Public time-travel API --

    async def list_snapshot_ids(
        self, agent: "Agent", *, limit: int | None = None, start_after: str | None = None
    ) -> list[str]:
        """List immutable snapshot ids for an agent, oldest first.

        Args:
            agent: Agent whose snapshots to list.
            limit: Optional cap on the number of ids returned.
            start_after: Exclusive cursor; a snapshot id from a prior page.

        Returns:
            Immutable snapshot ids in chronological order.

        Raises:
            ValueError: If ``start_after`` is not a valid snapshot id.
        """
        if limit is not None and limit <= 0:
            return []
        if start_after is not None:
            _validate_snapshot_id(start_after)

        history_prefix = f"{_snapshots_prefix(self.session_id, agent.agent_id)}{_IMMUTABLE_HISTORY}/"
        keys = await self._resolved_storage.list(history_prefix)
        ids = sorted(
            snapshot_id
            for key in keys
            if (match := _SNAPSHOT_REGEX.search(key)) and is_uuid7(snapshot_id := match.group(1))
        )
        if start_after is not None:
            ids = [snapshot_id for snapshot_id in ids if snapshot_id > start_after]
        if limit is not None:
            ids = ids[:limit]
        return ids

    async def restore_snapshot(self, agent: "Agent", *, snapshot_id: str | None = None) -> bool:
        """Restore an agent from a stored snapshot.

        Args:
            agent: Agent to restore into.
            snapshot_id: The immutable snapshot id to restore (time travel). Omit to restore
                ``snapshot_latest``, the same snapshot restore-on-init loads.

        Returns:
            True if the snapshot existed and was restored, False otherwise.

        Raises:
            ValueError: If ``snapshot_id`` is given and is not a valid snapshot id.
        """
        return await self._restore(agent, snapshot_id=snapshot_id)

    async def save_snapshot(self, agent: "Agent", *, is_latest: bool) -> str | None:
        """Save a snapshot of the agent's current state on demand.

        Use ``is_latest=False`` to force an immutable checkpoint at an arbitrary point (independent
        of ``snapshot_trigger``), so it can later be restored with :meth:`restore_snapshot`; use
        ``is_latest=True`` to overwrite ``snapshot_latest``.

        Args:
            agent: Agent whose state to capture.
            is_latest: When True, overwrite ``snapshot_latest`` (a single mutable snapshot). When
                False, append a new immutable snapshot under a fresh, time-ordered id.

        Returns:
            The new immutable snapshot id, ready to pass to :meth:`restore_snapshot`, or ``None``
            when ``is_latest=True`` (``snapshot_latest`` is not addressed by id).
        """
        data = _serialize_snapshot(self._capture(agent))
        snapshot_id = None if is_latest else _new_snapshot_id()
        key = _snapshot_key(self.session_id, agent.agent_id, snapshot_id=snapshot_id)
        await self._resolved_storage.write(key, data)
        return snapshot_id

    async def delete_session(self) -> None:
        """Delete all snapshots for this session."""
        storage = self._resolved_storage
        keys = await storage.list(_session_prefix(self.session_id))
        semaphore = asyncio.Semaphore(_DELETE_CONCURRENCY)

        async def _delete(key: str) -> None:
            async with semaphore:
                await storage.delete(key)

        await asyncio.gather(*(_delete(key) for key in keys))

    # -- Async internals --

    async def _initialize_async(self, agent: "Agent") -> None:
        """Restore latest snapshot on init, warning on overwrite and handling stateful models."""
        had_messages = len(agent.messages) > 0
        restored = await self._restore(agent)

        if restored and had_messages:
            logger.warning(
                "agent_id=<%s>, session_id=<%s> | agent had existing messages that were overwritten by session restore",
                agent.agent_id,
                self.session_id,
            )

        # Stateful models manage history server-side, so restored messages would drift
        # from the server's view. Keep the restored model_state and drop the messages.
        if restored and agent.model.stateful and len(agent.messages) > 0:
            logger.warning(
                "agent_id=<%s>, message_count=<%s> | discarding restored messages for stateful model",
                agent.agent_id,
                len(agent.messages),
            )
            agent.messages = []

    async def _restore(self, agent: "Agent", *, snapshot_id: str | None = None) -> bool:
        """Load a snapshot into the agent. Returns False if none exists."""
        key = _snapshot_key(self.session_id, agent.agent_id, snapshot_id=snapshot_id)
        data = await self._resolved_storage.read(key)
        if data is None:
            return False
        agent.load_snapshot(_deserialize_snapshot(data))
        return True

    async def _save_latest(self, agent: "Agent") -> None:
        """Capture the agent and overwrite ``snapshot_latest``."""
        await self.save_snapshot(agent, is_latest=True)

    async def _save_immutable_and_latest(self, agent: "Agent") -> None:
        """Capture once and write the immutable snapshot, then ``snapshot_latest``.

        Ordered, not concurrent: writing the immutable checkpoint first means a partial failure
        can leave an orphaned immutable snapshot (harmless — the next list simply includes it)
        but never a ``snapshot_latest`` pointing at history that was never written.
        """
        data = _serialize_snapshot(self._capture(agent))
        await self._resolved_storage.write(
            _snapshot_key(self.session_id, agent.agent_id, snapshot_id=_new_snapshot_id()), data
        )
        await self._resolved_storage.write(_snapshot_key(self.session_id, agent.agent_id, snapshot_id=None), data)

    async def _on_message_added(self, event: MessageAddedEvent) -> None:
        """Save latest after each message under the ``"message"`` strategy."""
        await self._save_latest(event.agent)

    async def _on_after_invocation(self, event: AfterInvocationEvent) -> None:
        """Save latest on invocation and fire the immutable-checkpoint trigger.

        When the trigger fires, the immutable+latest write subsumes the invocation save, so the
        agent is captured only once even under ``save_latest_on="invocation"``.

        ``"message"`` also saves here, not just per message: the Agent runs
        ``conversation_manager.apply_management`` (trimming/summarizing) after the last
        ``MessageAddedEvent`` but before this event, so the per-message saves would otherwise
        persist pre-management messages and a stale ``removed_message_count``.
        """
        triggered = False
        trigger_failed = False
        if self._snapshot_trigger is not None:
            try:
                triggered = self._snapshot_trigger(agent_data=event.agent)
            except Exception:
                # A caller's trigger raising must not discard the completed turn's latest save
                trigger_failed = True
                logger.exception(
                    "agent_id=<%s>, session_id=<%s> | snapshot_trigger raised; skipping immutable checkpoint",
                    event.agent.agent_id,
                    self.session_id,
                )
        if triggered:
            await self._save_immutable_and_latest(event.agent)
        elif trigger_failed or self._save_latest_on in ("invocation", "message"):
            await self._save_latest(event.agent)

    def _capture(self, agent: "Agent") -> Snapshot:
        """Capture a full session snapshot including the system prompt.

        The shared ``"session"`` preset omits ``system_prompt`` (opt-in for callers like
        the goal plugin); session persistence includes it so a rehydrated agent behaves
        identically to the original, matching the TypeScript SDK's session preset.
        """
        return agent.take_snapshot(preset="session", include=["system_prompt"])
