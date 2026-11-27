"""Provenance tags for provider-signed reasoning, so it reaches only models of the vendor that signed it.

A signature or redacted payload is bound to the vendor that issued it, not to the endpoint or the exact model: the
same Claude signature is accepted through Bedrock and the Anthropic API and by other Claude models. Text-only
reasoning carries nothing provider-bound and stays untagged.
"""

from typing import Any, cast

from ..types.content import ReasoningProviderData
from ..types.streaming import StreamEvent

ANTHROPIC = "anthropic"
GOOGLE = "google"


def tag_reasoning_delta(event: StreamEvent, provider: str, model_id: str) -> StreamEvent:
    """``event`` with a provenance tag added when it is a reasoning delta carrying a signature or redacted payload."""
    block_delta: dict[str, Any] = cast(dict[str, Any], event).get("contentBlockDelta", {})
    reasoning: dict[str, Any] = block_delta.get("delta", {}).get("reasoningContent", {})
    if not reasoning.get("signature") and not reasoning.get("redactedContent"):
        return event
    provider_data: ReasoningProviderData = {"provider": provider, "modelId": model_id, "data": {}}
    delta = {**block_delta["delta"], "reasoningContent": {**reasoning, "providerData": provider_data}}
    return cast(StreamEvent, {**event, "contentBlockDelta": {**block_delta, "delta": delta}})
