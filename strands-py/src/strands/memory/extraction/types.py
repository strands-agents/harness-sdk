"""Primitive types for the memory extraction subsystem."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol

from typing_extensions import TypedDict

from ...models.model import Model
from ...types.content import Message

if TYPE_CHECKING:
    # Lazy import to avoid a circular import; only used in annotations.
    from ...agent.agent import Agent

# Metadata mapping for an extracted entry (scores, ids, timestamps, etc.).
Metadata = dict[str, Any]

# Content-block kinds a ``MemoryMessageFilter`` can exclude. Mirrors the keys of
# ``strands.types.content.ContentBlock`` (e.g. ``{"text": ...}`` -> ``"text"``).
MemoryContentBlockType = Literal[
    "text",
    "toolUse",
    "toolResult",
    "image",
    "document",
    "reasoningContent",
    "video",
    "guardContent",
    "citationsContent",
    "cachePoint",
]


@dataclass
class ExtractionResult:
    """A discrete entry produced by an :class:`Extractor`, ready to write via ``add``."""

    content: str
    metadata: Metadata | None = None


@dataclass
class ExtractorContext:
    """Context passed to :meth:`Extractor.extract`.

    The context is per-call input: extractors should read it inside ``extract`` rather
    than store it, which keeps a single extractor instance shareable across agents.

    Attributes:
        default_model: The agent's model, supplied so an extractor can default to
            it.
        agent: The agent the extraction runs on behalf of, supplied so a model-backed
            extractor can fire hooks and attribute token usage. None when no owning
            agent is reachable.
    """

    default_model: Model | None = None
    agent: Agent | None = None


class Extractor(Protocol):
    """Transforms conversation messages into discrete, searchable entries.

    Optional on a store's :class:`ExtractionConfig`: when absent, the manager
    passes messages straight to the store's ``add_messages`` (the no-extractor
    passthrough), which is the right path for backends that extract server-side.
    """

    async def extract(self, messages: list[Message], context: ExtractorContext | None = None) -> list[ExtractionResult]:
        """Extract entries from a batch of messages."""
        ...


@dataclass
class MemoryMessageFilter:
    """Filters content blocks out of messages before extraction.

    Blocks whose kind is in :attr:`exclude` are stripped; a message left with no
    content is dropped. Defaults to excluding tool traffic (``toolUse`` /
    ``toolResult``).
    """

    exclude: list[MemoryContentBlockType]


# Default filter: drop tool-call traffic, keep everything else.
DEFAULT_MEMORY_MESSAGE_FILTER = MemoryMessageFilter(exclude=["toolUse", "toolResult"])


@dataclass
class ExtractionTriggerContext:
    """Context handed to :meth:`ExtractionTrigger.attach`.

    Attributes:
        agent: The agent the trigger attaches its hooks to.
        fire: Save this store's unsaved messages now. Runs in the background and
            returns immediately. To await completion, see ``MemoryManager.flush``.
    """

    agent: Agent
    fire: Callable[[], None]


class ExtractionTrigger(ABC):
    """Controls when a store's :class:`ExtractionConfig` runs.

    A trigger is a self-attaching value object: :meth:`attach` wires the agent
    hooks it needs and calls :attr:`ExtractionTriggerContext.fire` when extraction
    should happen. Subclass for custom triggering logic. A trigger that never
    fires never extracts; for a guaranteed final write, use
    ``MemoryManager.flush``.

    Attributes:
        name: Stable identifier for this trigger kind, used in logging.
    """

    name: str

    @abstractmethod
    def attach(self, context: ExtractionTriggerContext) -> None:
        """Wire this trigger into the agent lifecycle.

        Called once per store during ``MemoryManager`` initialization. Register
        hooks on ``context.agent`` and call ``context.fire()`` when extraction
        should run.
        """
        ...


class ExtractionConfig(TypedDict, total=False):
    """Per-store automatic-extraction configuration.

    Attributes:
        trigger: When to run extraction. A single trigger or a list; multiple
            triggers compose (extraction runs whenever any fires). Omit to default
            to every 5 turns; an explicit empty list is rejected at construction.
        extractor: How to turn messages into entries. When set, the store must
            implement ``add``. When omitted, the default depends on the store's
            write methods: a store implementing only ``add`` defaults to a
            :class:`~strands.memory.extraction.model_extractor.ModelExtractor`
            that distills facts client-side, while a store implementing
            ``add_messages`` uses server-side extraction (the manager hands the
            filtered messages straight to ``add_messages``, no model call).
        filter: Content blocks to strip before extraction. Defaults to
            :data:`DEFAULT_MEMORY_MESSAGE_FILTER` (excludes ``toolUse`` /
            ``toolResult``). Pass ``MemoryMessageFilter(exclude=[])`` to keep tool
            blocks.
    """

    trigger: ExtractionTrigger | list[ExtractionTrigger]
    extractor: Extractor
    filter: MemoryMessageFilter
