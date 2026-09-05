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
        totalCostUsd: Best-effort estimated cost of the interaction in USD (optional). Set only by
            providers that can price a call (currently LiteLLM); absent for providers that do not
            report cost, so consumers must treat a missing key as "cost not tracked".
    """

    inputTokens: Required[int]
    outputTokens: Required[int]
    totalTokens: Required[int]
    cacheReadInputTokens: int
    cacheWriteInputTokens: int
    totalCostUsd: float


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
