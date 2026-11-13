"""Recovery for replayed thinking blocks that a history edit invalidated.

Preserved-thinking Claude models bind each thinking block to the content before it. When that content
changes, enforcing accounts reject the request unless it asks the API to drop the stale blocks.
"""

from typing import Any

THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"
_THINKING_BINDING_ERROR = "bound to a different conversation"


def is_thinking_binding_error(error: BaseException) -> bool:
    """Whether the provider rejected a replayed thinking block because history before it changed."""
    return _THINKING_BINDING_ERROR in str(error)


def thinking_with_drop_block(thinking: Any, tool_forced: bool = False) -> dict[str, Any] | None:
    """Return the thinking config with stale blocks dropped, or None if it cannot or should not change.

    A caller-set ``block_binding`` is left as written. Without a config, adaptive thinking is added, since these models
    think adaptively by default and some reject a config without a type; a forced tool rules thinking out.
    """
    if thinking is None and not tool_forced:
        thinking = {"type": "adaptive"}
    if not isinstance(thinking, dict) or "block_binding" in thinking:
        return None
    return {**thinking, "block_binding": {"prefix_mismatch_behavior": "drop_block"}}
