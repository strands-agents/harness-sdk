"""Event loop-related type definitions for the SDK."""

from typing import Literal

from typing_extensions import Required, TypedDict


class Usage(TypedDict, total=False):
    """Token usage information for model interactions.

    Attributes:
        inputTokens: Number of tokens sent in the request to the model.
        outputTokens: Number of tokens that the model generated for the request.
        totalTokens: Total number of tokens (input + output).
        cacheReadInputTokens: Number of tokens read from cache (optional).
        cacheWriteInputTokens: Number of tokens written to cache (optional).
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
    "limit_total_tokens",
    "limit_turns",
    "max_tokens",
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
- "limit_total_tokens": Agent loop stopped because the ``limits["total_tokens"]`` cap was reached
- "limit_turns": Agent loop stopped because the ``limits["turns"]`` cap was reached
- "max_tokens": The model provider's per-call output cap was reached
- "stop_sequence": Stop sequence encountered
- "tool_use": Model requested to use a tool
"""


_LIMIT_STOP_REASONS: frozenset[StopReason] = frozenset({"limit_turns", "limit_total_tokens", "limit_output_tokens"})
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
