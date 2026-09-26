"""Bounded, safe text projections of an agent conversation for auxiliary decision calls.

Shared by model-routing classification and System One decision adapters so every auxiliary call bounds and
sanitizes the conversation the same way: only request-bearing user text crosses the boundary, guarded content is
never forwarded, media is labelled rather than sent, and every projection is length-bounded.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..types.content import Message, Messages, SystemPrompt

OMISSION_MARKER = "\n...[content omitted]...\n"
CHARS_PER_TOKEN = 4
"""Approximate characters per token used to turn token budgets into character bounds."""
NO_REQUEST_TEXT = "[No request-bearing user message provided]"
_MEDIA_CONTENT_LABELS = {
    "image": "[Image]",
    "document": "[Document]",
    "video": "[Video]",
}


def truncate_text(text: str, character_limit: int, marker: str = OMISSION_MARKER) -> str:
    """Bound text while preserving its opening and trailing content."""
    if len(text) <= character_limit:
        return text
    if character_limit <= len(marker):
        return text[:character_limit]
    available_characters = character_limit - len(marker)
    head_characters = available_characters // 2
    tail_characters = available_characters - head_characters
    return f"{text[:head_characters]}{marker}{text[-tail_characters:]}"


def _guarded_text(content: object) -> str | None:
    """Return guarded text only to detect a request; callers must not forward it."""
    if not isinstance(content, Mapping):
        return None
    text = content.get("text")
    if not isinstance(text, Mapping):
        return None
    value = text.get("text")
    return value if isinstance(value, str) else None


def request_text(message: Message, character_limit: int, marker: str = OMISSION_MARKER) -> str | None:
    """Render only safe request-bearing fields from one user message, or None when it carries no request."""
    parts: list[str] = []
    for block in message["content"]:
        text = block.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text)

        guarded_text = _guarded_text(block.get("guardContent"))
        if guarded_text is not None and guarded_text.strip():
            parts.append("[Guarded content]")

        parts.extend(label for content_type, label in _MEDIA_CONTENT_LABELS.items() if content_type in block)

    if not parts:
        return None
    return truncate_text("\n".join(parts), character_limit, marker)


def latest_request_text(
    messages: Messages,
    character_limit: int,
    *,
    marker: str = OMISSION_MARKER,
    no_request_text: str = NO_REQUEST_TEXT,
) -> str:
    """Return the latest request-bearing user message as bounded safe text."""
    for message in reversed(messages):
        if message["role"] == "user" and (text := request_text(message, character_limit, marker)) is not None:
            return text
    return truncate_text(no_request_text, character_limit, marker)


def instruction_text(system_prompt: SystemPrompt | None, character_limit: int, marker: str = OMISSION_MARKER) -> str:
    """Extract bounded text from an agent system prompt, omitting non-text blocks such as cache points."""
    if isinstance(system_prompt, str):
        instructions = system_prompt
    elif system_prompt:
        instructions = "\n".join(block["text"] for block in system_prompt if "text" in block)
    else:
        instructions = ""
    return truncate_text(instructions, character_limit, marker)


def project_state(
    messages: Messages,
    system_prompt: SystemPrompt | None,
    *,
    max_tokens: int,
    max_instruction_tokens: int | None = None,
) -> dict[str, str]:
    """Project an agent conversation into bounded decision state.

    Only the latest request-bearing user message and the text of the system prompt cross the boundary; guarded
    content is labelled, never forwarded, and media is labelled rather than sent.

    Args:
        messages: The conversation.
        system_prompt: The agent's system prompt, if any.
        max_tokens: Approximate token budget for the request text.
        max_instruction_tokens: Approximate token budget for the instruction text. Defaults to ``max_tokens``.

    Returns:
        ``{"request": ..., "agent_instructions": ...}``, each bounded to its budget.

    Raises:
        ValueError: If a budget is not a positive integer.
    """
    instruction_tokens = max_tokens if max_instruction_tokens is None else max_instruction_tokens
    for name, value in (("max_tokens", max_tokens), ("max_instruction_tokens", instruction_tokens)):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    return {
        "request": latest_request_text(messages, max_tokens * CHARS_PER_TOKEN),
        "agent_instructions": instruction_text(system_prompt, instruction_tokens * CHARS_PER_TOKEN),
    }
