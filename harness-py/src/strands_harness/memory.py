"""File-based memory resolution: build a ``MemoryManager`` over a local ``FileMemoryStore``.

Memory is on by default. Facts the agent learns are distilled every few turns into markdown files
under ``memory_dir`` (default ``./.agent/memory``), searched and injected before each turn so a
returning agent recalls them without re-asking. Persistence is plain files, independent of any
session: memory survives across sessions and works with sessions off.

Extraction is background and turn-triggered, so a short run can end with the latest turns unsaved.
The owner of the agent's lifecycle flushes at shutdown (``await agent.memory_manager.flush()``) to
persist what's pending; the harness's CLI does this, and a library consumer should do the same.

A consumer can swap the backend by passing their own ``stores``; the harness still owns the manager, so its
injection/tool policy (injection on, ``search_memory`` on, ``add_memory`` off) applies either way.
"""

from __future__ import annotations

from strands.memory import (
    ExtractionConfig,
    MemoryEntry,
    MemoryInjectionConfig,
    MemoryManager,
    MemoryStore,
    ModelExtractor,
    SearchOptions,
)
from strands.models import Model, ModelRouter
from strands.storage import LocalFileStorage
from strands.vended_memory_stores.file_memory_store import FileMemoryStore

from strands_harness.defaults import DEFAULT_MEMORY_DIR
from strands_harness.models import resolve_web_fetch_model

# Store name, surfaced as the ``source`` attribute on each injected ``<memory>`` entry.
MEMORY_STORE_NAME = "memory"


def resolve_memory(
    *,
    stores: MemoryStore | list[MemoryStore] | None = None,
    model: Model | ModelRouter | str | None = None,
    memory_dir: str = DEFAULT_MEMORY_DIR,
    web_fetch_model: Model | ModelRouter | str | None = None,
    writable: bool = True,
) -> MemoryManager:
    """Build the memory manager: a ``MemoryManager`` wrapping either the consumer's ``stores`` or a
    default ``FileMemoryStore`` writing to ``memory_dir``, with the SDK's tool defaults
    (``search_memory`` on, no ``add_memory`` write tool) and injection on every turn.

    The default store's keys are pre-namespaced to ``memory_dir`` itself, so files land at
    ``memory_dir/<slug>.md`` without the store's own ``memory/<name>/`` scoping doubling the path.
    Extraction runs on the same small, credential-aligned model ``web_fetch`` summarizes with (the
    agent's ``web_fetch_model`` override, or the small model for its provider) rather than the main
    model, so distilling facts every few turns stays cheap.

    Args:
        stores: Consumer-supplied store(s) to manage instead of the default file store. When omitted
            or an empty list, the harness builds a ``FileMemoryStore`` under ``memory_dir``.
            ``model``/``memory_dir``/``web_fetch_model`` are used only to build that default store and
            are ignored when ``stores`` is non-empty.
        model: The agent's ``model`` argument, used to derive the small extraction model for the
            default store.
        memory_dir: Directory the default store's memory files live in.
        web_fetch_model: Explicit summarizer/extraction model override, forwarded to the resolver.
        writable: Whether the manager may write to its stores. ``True`` (default) builds a writable
            default store and passes consumer stores through as-is. ``False`` builds a recall-only
            manager: the default store is created read-only and consumer stores are wrapped in a
            read-only view, so the manager still searches and injects them but never extracts or
            writes. That is the shape for a subagent delegate, which reads the shared memory without
            promoting its throwaway subtask into the store.

    Returns:
        A configured ``MemoryManager`` to pass as ``Agent(memory_manager=...)``.
    """
    if stores is None:
        supplied: list[MemoryStore] = []
    elif isinstance(stores, list):
        supplied = stores
    else:
        supplied = [stores]

    if supplied:
        managed = [store if writable else _to_read_only(store) for store in supplied]
    else:
        managed = [_build_default_store(model, memory_dir, web_fetch_model, writable)]
    # Inject on every model call, not only on a fresh user ask: the harness runs multi-step tool loops, so an
    # autonomous step (or a delegate) consults memory at each turn rather than only when the user speaks.
    return MemoryManager(stores=managed, injection=MemoryInjectionConfig(trigger="everyTurn"))


def _build_default_store(
    model: Model | ModelRouter | str | None,
    memory_dir: str,
    web_fetch_model: Model | ModelRouter | str | None,
    writable: bool,
) -> FileMemoryStore:
    """The default file-backed store, writing markdown directly under ``memory_dir``."""
    storage = LocalFileStorage(memory_dir).namespace("")
    if not writable:
        return FileMemoryStore(name=MEMORY_STORE_NAME, storage=storage, writable=False)
    summarizer = resolve_web_fetch_model(model, web_fetch_model)
    return FileMemoryStore(
        name=MEMORY_STORE_NAME,
        storage=storage,
        writable=True,
        extraction=ExtractionConfig(extractor=ModelExtractor(model=summarizer)),
    )


class _ReadOnlyStore:
    """A recall-only view of a store: the same backend, still searchable, but with every write path
    (``add``/``add_messages``) and its extraction config dropped so the delegate's manager can neither
    extract nor write. ``get_tools`` is omitted too, since a store-native tool is an unbounded surface
    we can't guarantee is read-only; the delegate still recalls through ``search_memory`` and injection.
    """

    def __init__(self, store: MemoryStore) -> None:
        self._store = store
        self.name = store.name
        self.description = getattr(store, "description", None)
        self.max_search_results = getattr(store, "max_search_results", None)
        self.writable = False
        self.extraction = None

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        return await self._store.search(query, options)

    async def initialize(self) -> None:
        initialize = getattr(self._store, "initialize", None)
        if initialize is not None:
            await initialize()


def _to_read_only(store: MemoryStore) -> MemoryStore:
    """Wrap ``store`` in a recall-only view (see :class:`_ReadOnlyStore`)."""
    return _ReadOnlyStore(store)
