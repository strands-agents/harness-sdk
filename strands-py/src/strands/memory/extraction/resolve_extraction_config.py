"""Resolves a store's ``extraction`` setting into a concrete config.

The single place the ``bool | ExtractionConfig`` shorthand is interpreted and
per-store defaults are applied, so the :class:`~strands.memory.memory_manager.MemoryManager`
and :class:`~strands.memory.extraction.coordinator.ExtractionCoordinator` never
re-apply defaults or normalize shapes themselves.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..types import MemoryStore, _has_method
from .model_extractor import ModelExtractor
from .triggers import IntervalTrigger
from .types import (
    DEFAULT_MEMORY_MESSAGE_FILTER,
    ExtractionConfig,
    ExtractionTrigger,
    Extractor,
    MemoryMessageFilter,
)

# Default cadence when an ``ExtractionConfig`` omits its ``trigger``: extract every N turns.
_DEFAULT_EXTRACTION_TRIGGER_TURNS = 5


@dataclass
class _ResolvedExtractionConfig:
    """An :class:`ExtractionConfig` with every field resolved to a concrete value.

    Produced by :func:`_resolve_extraction_config` so the ``MemoryManager`` and
    ``ExtractionCoordinator`` never have to re-apply defaults or normalize shapes.

    Attributes:
        triggers: Normalized to a list (a single trigger is wrapped). Never empty
            for a resolved config (an explicit empty list is left empty for the
            manager to reject).
        extractor: The extractor that distills facts client-side and stores them
            via the store's ``add`` method, or ``None`` to use the store's
            ``add_messages`` method (server-side extraction).
        filter: The content-block filter applied before extraction.
    """

    triggers: list[ExtractionTrigger]
    extractor: Extractor | None
    filter: MemoryMessageFilter


def _resolve_extraction_config(
    extraction: bool | ExtractionConfig | None,
    store: MemoryStore,
) -> _ResolvedExtractionConfig | None:
    """Resolve a store's ``extraction`` setting into a :class:`_ResolvedExtractionConfig`.

    The single place the ``bool | ExtractionConfig`` shorthand is interpreted:
    ``False``/``None`` is off (returns ``None``), ``True`` enables all defaults, an
    :class:`ExtractionConfig` defaults its unset fields. The defaults are:

    - **triggers**: every :data:`_DEFAULT_EXTRACTION_TRIGGER_TURNS` turns. An
      explicit empty list is left empty for the ``MemoryManager`` to reject.
    - **extractor**: chosen from the methods the store implements. A store that
      implements only ``add`` cannot extract server-side, so it defaults to a
      :class:`~strands.memory.extraction.model_extractor.ModelExtractor` that
      distills facts client-side (via model calls) and stores each one through
      ``add``. A store that implements ``add_messages`` supports server-side
      extraction, so it defaults to no extractor: the manager hands raw messages
      to ``add_messages`` and the backend extracts them itself, with no model call.
    - **filter**: :data:`DEFAULT_MEMORY_MESSAGE_FILTER`.

    Args:
        extraction: The store's ``extraction`` setting.
        store: The store, inspected for the write methods it implements to pick the
            default extractor.

    Returns:
        The resolved config, or ``None`` when extraction is disabled.
    """
    if extraction is None or extraction is False:
        return None
    config = ExtractionConfig() if extraction is True else extraction

    config_trigger = config.get("trigger")
    triggers: list[ExtractionTrigger]
    if config_trigger is None:
        triggers = [IntervalTrigger(turns=_DEFAULT_EXTRACTION_TRIGGER_TURNS)]
    elif isinstance(config_trigger, list):
        triggers = config_trigger
    else:
        triggers = [config_trigger]

    extractor = config.get("extractor")
    if extractor is None:
        # Pick the default extractor from the store's write methods:
        # - implements only ``add``: it cannot extract server-side, so default to a
        #   ModelExtractor that distills facts client-side and stores each via ``add``.
        # - implements ``add_messages`` (whether or not it also implements ``add``): extract
        #   server-side. Leave the extractor None so raw messages go straight to
        #   ``add_messages`` with no model call.
        if _has_method(store, "add") and not _has_method(store, "add_messages"):
            extractor = ModelExtractor()

    return _ResolvedExtractionConfig(
        triggers=triggers,
        extractor=extractor,
        filter=config.get("filter") or DEFAULT_MEMORY_MESSAGE_FILTER,
    )
