"""Configuration types for OpenAI bidirectional model providers."""

from typing import Any, Literal

from typing_extensions import Required, TypedDict

__all__ = ["OpenAILiveAudioConfig", "OpenAILiveResponsesDelegationConfig"]


class OpenAILiveAudioConfig(TypedDict, total=False):
    """Audio configuration for OpenAI Live.

    Audio is always mono signed 16-bit little-endian PCM.

    Attributes:
        sample_rate: Input and output sample rate in Hz. Defaults to 24000.
    """

    sample_rate: Literal[16000, 24000]


class OpenAILiveResponsesDelegationConfig(TypedDict, total=False):
    """Responses delegation configuration for OpenAI Live.

    Attributes:
        type: Delegation mode. Must be ``responses``.
        model_id: Responses model identifier.
        system_prompt: Responses model instructions. Omission uses the agent's system prompt.
        max_output_tokens: Maximum output tokens per response.
        reasoning: Reasoning settings passed through to OpenAI.
        text: Text generation settings passed through to OpenAI.
        service_tier: Processing tier for Responses requests.
    """

    type: Required[Literal["responses"]]
    model_id: Required[str]
    system_prompt: str
    max_output_tokens: int
    reasoning: dict[str, Any]
    text: dict[str, Any]
    service_tier: str
