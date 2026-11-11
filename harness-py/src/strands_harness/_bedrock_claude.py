"""``AnthropicModel`` for Claude on Bedrock InvokeModel, through Anthropic's Bedrock client."""

from collections.abc import AsyncGenerator
from typing import Any

import anthropic
from strands.models.anthropic import AnthropicModel
from strands.types.exceptions import ModelThrottledException
from strands.types.streaming import StreamEvent


class BedrockClaudeModel(AnthropicModel):
    """Raises ``ModelThrottledException`` for a throttling error inside an InvokeModel stream.

    Anthropic's client surfaces that error as a plain ``APIStatusError`` (the stream already
    answered HTTP 200), so without this the agent loop would not retry it as it does on Converse.
    """

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncGenerator[StreamEvent, None]:
        try:
            async for event in super().stream(*args, **kwargs):
                yield event
        except anthropic.APIStatusError as error:
            body = error.body if isinstance(error.body, dict) else {}
            if (body.get("error") or {}).get("type") == "throttlingException":
                raise ModelThrottledException(str(error)) from error
            raise
