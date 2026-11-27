"""Core types for the Strands memory module."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from typing_extensions import Required, TypedDict

from ..injection import InjectionConfig
from ..types.content import Message, Messages
from ..types.tools import AgentTool

if TYPE_CHECKING:
    # Lazy import to avoid a circular import with the extraction subpackage;
    # ``ExtractionConfig`` is only referenced in annotations.
    from .extraction.types import ExtractionConfig

# JSON-compatible metadata mapping (scores, ids, timestamps, etc.).
Metadata = dict[str, Any]


@dataclass
class MemoryEntry:
    """A single memory entry retrieved from or stored to a memory store.

    Attributes:
        store_name: Name of the store this entry came from, set by
            ``MemoryManager.search``. Stores need not set this themselves.
    """

    content: str
    store_name: str | None = None
    metadata: Metadata | None = None


class SearchOptions(TypedDict, total=False):
    """Options passed to :meth:`MemoryStore.search`.

    Store implementations may extend this with backend-specific fields; note that
    ``MemoryManager.search`` forwards only these base fields across its stores.
    """

    max_search_results: int


@dataclass
class AddMessagesContext:
    """Context the manager supplies to :meth:`MemoryStore.add_messages`.

    An extension point: fields are added here without changing the
    :meth:`MemoryStore.add_messages` signature.

    Attributes:
        sequence_numbers: Per-message identities aligned one-to-one with
            ``messages`` (``sequence_numbers[i]`` identifies ``messages[i]``). A
            retried batch reuses the same numbers, so a store can build an
            idempotency key that survives retries -- unlike a content hash, which
            collides when two messages share text (e.g. "ok"). Numbers increase
            with order but may have gaps (a message filtered to empty is dropped
            while its siblings keep their own numbers), and reset to 0 each agent
            run, so a durable dedup token must combine one with a run-unique id.
            ``None`` when the manager has no per-message numbers to supply.
    """

    sequence_numbers: list[int] | None = None


class MemorySearchOptions(SearchOptions, total=False):
    """Options for ``MemoryManager.search``.

    Attributes:
        stores: Filter to specific stores by name. Omit to search all. A
            programmatic search with an empty list searches no stores, whereas
            the ``search_memory`` tool treats an empty list as "search all
            in-scope stores".
    """

    stores: list[str]


class MemoryAddOptions(TypedDict, total=False):
    """Options for ``MemoryManager.add``.

    Attributes:
        stores: Filter to specific writable stores by name. Omit to write to all.
            A programmatic add with an empty list matches no store (raises),
            whereas the ``add_memory`` tool treats an empty list as "write to all
            in-scope stores".
    """

    metadata: Metadata
    stores: list[str]


class MemoryToolConfig(TypedDict, total=False):
    """Configuration for customizing a memory tool's name or description."""

    name: str
    description: str


class MemoryAddToolConfig(MemoryToolConfig, total=False):
    """Configuration for the ``add_memory`` tool.

    Attributes:
        stores: The writable stores the tool may write to, as store names or
            :class:`MemoryStore` instances. Omit to allow all writable stores.
        wait_for_writes: When ``True`` (default), wait for writes and return
            ``{"stored": ...}`` (or surface a failure to the model). When
            ``False``, fire-and-forget: return ``{"accepted": ...}`` once writes
            are dispatched; per-store failures are logged.
    """

    stores: list[str | MemoryStore]
    wait_for_writes: bool


@dataclass
class InjectionQueryContext:
    """Context passed to :attr:`MemoryInjectionConfig.query`.

    Attributes:
        messages: The current conversation, as data.
    """

    messages: Messages


@dataclass
class InjectionFormatContext:
    """Context passed to :attr:`MemoryInjectionConfig.format`.

    Attributes:
        entries: The retrieved memory entries to render.
    """

    entries: list[MemoryEntry]


class InjectionQueryCallback(Protocol):
    """Derives the injection search query from the current conversation.

    Implemented by a plain function as well — the ``**kwargs`` tail lets the calling convention
    grow new keyword arguments without breaking existing callbacks.
    """

    def __call__(self, context: InjectionQueryContext, **kwargs: Any) -> str | None:
        """Return the search query, or ``None``/``""`` to skip injection this call."""
        ...


class InjectionFormatCallback(Protocol):
    """Renders retrieved memory entries into the injected text.

    Implemented by a plain function as well — the ``**kwargs`` tail lets the calling convention
    grow new keyword arguments without breaking existing callbacks.
    """

    def __call__(self, context: InjectionFormatContext, **kwargs: Any) -> str:
        """Return the text to inject for the given entries."""
        ...


# The bare ``Callable`` arms keep the happy path (``lambda context: ...``) ergonomic; the
# ``*Callback`` Protocol arms are the forward-compatible shape for callers that opt into future
# keyword arguments.
InjectionQuery = Callable[[InjectionQueryContext], "str | None"] | InjectionQueryCallback
InjectionFormat = Callable[[InjectionFormatContext], str] | InjectionFormatCallback


class MemoryInjectionConfig(InjectionConfig, total=False):
    """Configuration for memory context injection.

    Extends the generic :class:`~strands.injection.InjectionConfig` (which carries ``trigger``)
    with the memory-owned knobs: how many entries to retrieve, how to derive the query, and how
    to render the results.

    Attributes:
        max_entries: Maximum number of entries to retrieve and inject per model call. A store
            ranks by semantic similarity, which is not the same as contextual usefulness, so the
            default injects a small candidate set rather than betting on the top hit. Raising it
            improves recall at the cost of a larger prepend (context bloat); lower it for a
            tighter injection. With multiple stores, results are concatenated in
            store-registration order with no cross-store ranking, so this cap can favor entries
            from earlier-registered stores. Defaults to 5.
        query: Derives the search query from the current conversation. Return ``None`` or an
            empty string to skip injection for this call. A callback that raises fails open
            (injection is skipped). Defaults to an adaptive query: the latest user message's
            text on a user turn, otherwise the most recent assistant message's text (the
            previous step on an autonomous turn).
        format: Renders retrieved entries into the injected text. A callback that raises fails
            open (injection is skipped). Defaults to a ``<memory>`` XML block with one
            ``<entry>`` per result, carrying a ``source`` attribute naming the originating store
            (when known) so the model can attribute and weigh each memory. The default escapes
            entry content and source, so a custom ``format`` that emits markup is responsible
            for its own escaping.
    """

    max_entries: int
    query: InjectionQuery
    format: InjectionFormat


class MemoryManagerConfig(TypedDict, total=False):
    """Configuration for the ``MemoryManager``, mirroring the constructor kwargs.

    Attributes:
        stores: One or more memory stores to manage.
        search_tool_config: Search tool configuration. Defaults to ``True``.
        add_tool_config: Add tool configuration. Defaults to ``False`` (opt-in);
            ``True`` allows all writable stores, or pass a
            :class:`MemoryAddToolConfig` to restrict it.
        injection: Memory context injection. Defaults to ``True``. ``True`` uses the default
            injection settings; pass a :class:`MemoryInjectionConfig` to customize retrieval,
            timing, and formatting; ``False`` disables it.
    """

    stores: Required[list[MemoryStore]]
    search_tool_config: MemoryToolConfig | bool
    add_tool_config: MemoryAddToolConfig | bool
    injection: MemoryInjectionConfig | bool


class MemoryStoreConfig(TypedDict, total=False):
    """Declarative identity and behavior fields a store is configured with.

    Attributes:
        name: Unique identifier for this store, used to target it in tools.
        description: Human-readable description; included in tool descriptions.
        max_search_results: Default maximum results per search, used when a caller
            does not pass a per-call value.
        writable: Whether this store accepts writes. A writable store requires at least one write
            sink (:meth:`MemoryStore.add` or :meth:`MemoryStore.add_messages`).
        extraction: Automatic-extraction configuration for this writable store, as
            a ``bool | config`` shorthand. ``True`` enables it with defaults; an
            :class:`ExtractionConfig` defaults any unset field; ``False``/omitted
            is off. The defaults run every 5 turns, and the extraction method
            depends on the store's write methods: a store implementing only ``add``
            uses a :class:`~strands.memory.extraction.model_extractor.ModelExtractor`
            for client-side extraction (a model call to distill facts, stored via
            ``add``), while a store implementing ``add_messages`` uses server-side
            extraction (the backend extracts the raw messages, no model call).
    """

    name: Required[str]
    description: str
    max_search_results: int
    writable: bool
    extraction: ExtractionConfig | bool


def _default_not_implemented(store: object, method: str) -> Any:
    """Raise for a write sink invoked on a store that does not implement it.

    The manager never routes to an unimplemented sink (``_has_method`` filters
    them out); this guards direct calls on the inherited default.
    """
    raise NotImplementedError(f"{type(store).__name__} does not implement {method}.")


class MemoryStore(Protocol):
    """Runtime contract for a memory store backend.

    A store exposes the :class:`MemoryStoreConfig` fields as attributes and implements :meth:`search`,
    plus optionally :meth:`add`, :meth:`add_messages`, and :meth:`get_tools`. The fields are
    re-declared here because a ``Protocol`` cannot extend a ``TypedDict``.

    Attributes:
        name: Unique identifier for this store, used to target it in tools.
        description: Human-readable description; included in tool descriptions.
        max_search_results: Default maximum results per search.
        writable: Whether this store accepts writes.
        extraction: Resolved automatic-extraction configuration, or ``None``/``False`` when off.
    """

    name: str
    description: str | None
    max_search_results: int | None
    writable: bool
    extraction: ExtractionConfig | bool | None

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        """Search the store for entries matching the query, ordered by relevance."""
        ...

    # --- Optional methods: detect presence via ``_has_method`` / ``_has_write_sink``.
    # Each carries a concrete default body so that explicit subclasses are
    # instantiable under static type checkers; ``_has_method`` treats an
    # inherited default as "not implemented", so runtime detection is unchanged.
    # The write sinks raise through ``_default_not_implemented`` because a bare
    # ``raise NotImplementedError`` body is itself treated as a stub by mypy.

    async def add(self, content: str, metadata: Metadata | None = None) -> Any:
        """Add a single piece of content to the store.

        Extraction writes are at-least-once, so implementations used with
        extraction should tolerate duplicate writes. The resolved value is
        store-specific and not consumed by the manager.
        """
        return _default_not_implemented(self, "add")

    async def add_messages(self, messages: list[Message], context: AddMessagesContext | None = None) -> Any:
        """Ingest a batch of conversation messages, preserving role structure.

        The sink for extraction without a client-side extractor: the manager
        hands the filtered batch straight here. The resolved value is
        store-specific.
        """
        return _default_not_implemented(self, "add_messages")

    async def initialize(self) -> None:
        """Perform async setup that must succeed before the agent runs.

        Called by the ``MemoryManager`` during ``init_agent``. Stores that require remote resources
        (e.g. resolving a knowledge base type) implement this; the default is a no-op.
        """
        return None

    def get_tools(self) -> list[AgentTool]:
        """Return store-specific tools to register alongside the manager's tools."""
        return []


def _has_method(store: object, name: str) -> bool:
    """Return whether ``store`` actually implements the named method.

    Inspects the store's type so a class that merely inherits the
    :class:`MemoryStore` Protocol's stub counts as "not implemented".
    """
    method = getattr(type(store), name, None)
    if method is None:
        return False
    # A subclass can inherit the Protocol's stub; treat that as "not implemented".
    if method is getattr(MemoryStore, name, None):
        return False
    return callable(method)


def _has_write_sink(store: MemoryStore) -> bool:
    """Return whether ``store`` provides at least one write sink (``add`` or ``add_messages``)."""
    return _has_method(store, "add") or _has_method(store, "add_messages")
