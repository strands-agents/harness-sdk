"""Event loop-related type definitions for the SDK."""

from typing import Literal

from typing_extensions import Required, TypedDict


class Usage(TypedDict, total=False):
    """Token usage information for model interactions.

    Providers differ on whether ``inputTokens`` includes cached tokens. Some count cache reads and
    writes inside ``inputTokens``; others count them only in ``cacheReadInputTokens`` and
    ``cacheWriteInputTokens``. ``totalTokens`` always includes cached tokens, so for a single model call:
    if ``inputTokens + outputTokens == totalTokens``, ``inputTokens`` already includes the cache fields;
    otherwise, total input is ``inputTokens + cacheReadInputTokens + cacheWriteInputTokens``. Adding the
    cache fields to an ``inputTokens`` that already includes them counts cached tokens twice.

    Custom model providers should include cached tokens in ``inputTokens`` (matching the OpenTelemetry
    GenAI conventions), so that ``totalTokens == inputTokens + outputTokens``.

    Attributes:
        inputTokens: Number of input tokens, as the model provider counts them. May or may not include
            cached tokens, depending on the provider.
        outputTokens: Number of tokens that the model generated for the request.
        totalTokens: Total number of tokens processed, including any cached input tokens.
        cacheReadInputTokens: Number of input tokens read from cache (optional).
        cacheWriteInputTokens: Number of input tokens written to cache (optional).
    """

    inputTokens: Required[int]
    outputTokens: Required[int]
    totalTokens: Required[int]
    cacheReadInputTokens: int
    cacheWriteInputTokens: int


class Metrics(TypedDict, total=False):
    """Performance metrics for model interactions.

    Attributes:
        latencyMs (int): Latency of the model request in milliseconds.
        timeToFirstByteMs (int): Latency from sending model request to first
            content chunk (contentBlockDelta or contentBlockStart) from the model in milliseconds.
    """

    latencyMs: Required[int]
    timeToFirstByteMs: int


StopReason = Literal[
    "cancelled",
    "checkpoint",
    "content_filtered",
    "end_turn",
    "guardrail_intervened",
    "interrupt",
    "limit_output_tokens",
    "limit_structured_output_attempts",
    "limit_total_tokens",
    "limit_turns",
    "max_tokens",
    "model_context_window_exceeded",
    "refusal",
    "stop_sequence",
    "tool_use",
]
"""Reason for the model ending its response generation.

- "cancelled": Agent execution was cancelled via agent.cancel()
- "checkpoint": Agent paused for durable checkpoint persistence
- "content_filtered": Content was filtered due to policy violation
- "end_turn": Normal completion of the response
- "guardrail_intervened": Guardrail system intervened
- "interrupt": Agent was interrupted for human input
- "limit_output_tokens": Agent loop stopped because the ``limits["output_tokens"]`` cap was reached
- "limit_structured_output_attempts": Agent loop stopped because the ``limits["structured_output_attempts"]`` cap
  was reached
- "limit_total_tokens": Agent loop stopped because the ``limits["total_tokens"]`` cap was reached
- "limit_turns": Agent loop stopped because the ``limits["turns"]`` cap was reached
- "max_tokens": The model provider's per-call output cap was reached
- "model_context_window_exceeded": Input exceeded the model's context window
- "refusal": A streaming classifier intervened to handle a potential policy violation
- "stop_sequence": Stop sequence encountered
- "tool_use": Model requested to use a tool
"""


_LIMIT_STOP_REASONS: frozenset[StopReason] = frozenset(
    {"limit_turns", "limit_total_tokens", "limit_output_tokens", "limit_structured_output_attempts"}
)
"""Stop reasons for a call that stopped because a limit (``limits``) was reached."""


def _limit_stop_message(agent_name: str, stop_reason: StopReason) -> str:
    """Explain that a nested call stopped because a limit (its own or the request's) was reached.

    Args:
        agent_name: Name of the agent that stopped.
        stop_reason: The limit stop reason it returned.

    Returns:
        The message to surface in place of the agent's answer.
    """
    return (
        f"Agent '{agent_name}' stopped early ({stop_reason}): "
        "a limit on this call was reached, so its answer is incomplete"
    )
