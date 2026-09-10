"""Strategy presets — named building blocks that resolve to concrete strategy configurations.

Preset definitions (thresholds, methods, conditions) are internal defaults and may
change between releases as we tune based on real-world usage data. Treat the preset
name as the stable contract, not its expansion. Use raw ``Offload.*`` strategies when
you need a specific, pinned configuration.
"""

from __future__ import annotations

from .strategies.offload import Offload
from .types import ContextStrategy

StrategyPresetName = str
"""Known preset name strings accepted in the strategies array.

Preset names are the stable contract. The strategies they resolve to may change
between releases.

- ``'proactive_summarization'`` — batch summarize oldest messages at 70% utilization
- ``'large_tool_offloading'`` — truncate tool results over 2500 tokens to a 1000-token preview
- ``'overflow_protection'`` — truncate oldest messages when the context window is full
- ``'stale_tool_cleanup'`` — drop tool results older than 5 messages
"""

STRATEGY_PRESET_NAMES: tuple[str, ...] = (
    "proactive_summarization",
    "large_tool_offloading",
    "overflow_protection",
    "stale_tool_cleanup",
)


def resolve_preset(name: str) -> list[ContextStrategy]:
    """Resolve a preset name to its default strategy array.

    Args:
        name: The preset name.

    Returns:
        The strategy array for the given preset.
    """
    if name == "proactive_summarization":
        return [Offload.summarize("*").when(utilization=0.7, preserve_recent=0.7)]
    if name == "large_tool_offloading":
        return [Offload.truncate("tool_results", {"preview_tokens": 1000}).when(threshold=2500)]
    if name == "overflow_protection":
        return [Offload.truncate("*").when(utilization=1.0, preserve_recent=4)]
    if name == "stale_tool_cleanup":
        return [Offload.drop("tool_results").when(preserve_recent=5)]
    raise ValueError(f'Unknown strategy preset: "{name}". Valid presets: {", ".join(STRATEGY_PRESET_NAMES)}')


def resolve_strategies(entries: list[ContextStrategy | str]) -> list[ContextStrategy]:
    """Resolve a mixed list of strategies and preset names into a flat strategy list.

    Args:
        entries: List of raw strategies and/or preset name strings.

    Returns:
        Flattened list of concrete strategies.
    """
    strategies: list[ContextStrategy] = []
    for entry in entries:
        if isinstance(entry, str):
            if entry not in STRATEGY_PRESET_NAMES:
                raise ValueError(
                    f'Unknown strategy preset: "{entry}". Valid presets: {", ".join(STRATEGY_PRESET_NAMES)}'
                )
            strategies.extend(resolve_preset(entry))
        else:
            strategies.append(entry)
    return strategies
