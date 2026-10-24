"""Recovery for replayed thinking blocks that a history edit invalidated.

Preserved-thinking Claude models bind each thinking block to the content before it. When that content
changes, enforcing accounts reject the request unless it asks the API to drop the stale blocks.
"""

import re
from typing import Any

THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"
_THINKING_BINDING_ERROR = "bound to a different conversation"

# On-demand compaction summarizes older turns server side, so thinking in the turns kept after it stays valid.
COMPACTION_BETA = "compact-2026-09-04"
_PRESERVED_THINKING_MODELS = re.compile(r"claude-(?:opus-5-5|sonnet-5-5|haiku-5-5|fable-5-1)(?!\d)")


def has_preserved_thinking(model_id: str) -> bool:
    """Whether the model binds each thinking block to the content before it."""
    return _PRESERVED_THINKING_MODELS.search(model_id) is not None


def is_thinking_binding_error(error: BaseException) -> bool:
    """Whether the provider rejected a replayed thinking block because history before it changed."""
    return _THINKING_BINDING_ERROR in str(error)


def thinking_with_drop_block(thinking: Any) -> dict[str, Any] | None:
    """Return the thinking config with stale blocks dropped, or None if it cannot or should not change.

    A caller-set ``block_binding`` is left as written.
    """
    if not isinstance(thinking, dict) or "block_binding" in thinking:
        return None
    return {**thinking, "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
