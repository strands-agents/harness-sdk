"""The Anthropic Messages API served by Amazon Bedrock, exposed as ``BedrockModel.Messages``."""

import inspect
import logging
from collections.abc import AsyncGenerator
from typing import Any

import anthropic
from pydantic import BaseModel
from typing_extensions import Unpack, override

from ..types.content import Messages, SystemContentBlock
from ..types.exceptions import ContextWindowOverflowException, ModelThrottledException
from ..types.streaming import StreamEvent
from ..types.tools import ToolChoice, ToolSpec
from .anthropic import AnthropicModel
from .bedrock import BedrockEndpoint, _check_bedrock_options, _resolve_bedrock_region

logger = logging.getLogger(__name__)

_ENDPOINTS = ("bedrock-runtime", "bedrock-mantle")

# Error events in an InvokeModel response stream that mean "try again later".
_THROTTLING_EVENTS = ("throttlingException", "serviceUnavailableException")


class BedrockMessagesModel(AnthropicModel):
    """Claude on Amazon Bedrock through the Anthropic Messages API.

    Use it as ``BedrockModel.Messages`` for Anthropic features that the Converse API does not offer. Requests go
    through the Anthropic SDK's own Bedrock clients, which handle authentication. Model settings are those of
    :class:`~strands.models.anthropic.AnthropicModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        api_key: str | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[AnthropicModel.AnthropicConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            endpoint: Bedrock endpoint that serves the requests, ``"bedrock-runtime"`` or ``"bedrock-mantle"``.
                Model ids differ between the two, for example ``global.anthropic.claude-sonnet-4-6`` on
                bedrock-runtime and ``anthropic.claude-sonnet-4-6`` on bedrock-mantle.
            region_name: AWS region. Defaults to the session's region, then ``AWS_REGION``, then us-west-2.
            api_key: Amazon Bedrock API key. Defaults to ``AWS_BEARER_TOKEN_BEDROCK``. Without either, requests are
                signed with SigV4 using the default AWS credential chain, or the ``aws_profile`` / ``aws_access_key``
                options in ``client_args``.
            client_args: Arguments for the Anthropic SDK's Bedrock client, such as ``aws_profile``, ``timeout``, or
                ``max_retries``. ``base_url`` and ``aws_region`` are set by this provider.
            **model_config: Configuration options for the Anthropic model.

        Raises:
            ValueError: If ``endpoint`` is unknown, the model is an imported model, or ``client_args`` sets
                ``base_url`` or ``aws_region``.
        """
        if endpoint not in _ENDPOINTS:
            raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_ENDPOINTS)}")
        if conflicting := {"base_url", "aws_region"} & set(client_args or {}):
            raise ValueError(f"client_args=<{sorted(conflicting)}> | set by BedrockModel.Messages, remove them")
        _check_bedrock_options("BedrockModel.Messages", model_config, {"client"})

        self._endpoint = endpoint
        region = _resolve_bedrock_region(region_name)
        args = {**(client_args or {}), "aws_region": region, **({"api_key": api_key} if api_key else {})}
        super().__init__(client_args=args, **model_config)
        logger.debug("endpoint=<%s>, region=<%s> | bedrock messages client created", endpoint, region)

    @override
    def _create_client(self, client_args: dict[str, Any]) -> anthropic.AsyncAnthropic:
        # The Bedrock clients speak the same Messages API as AsyncAnthropic, which AnthropicModel is typed against.
        if self._endpoint == "bedrock-mantle":
            if not hasattr(anthropic, "AsyncAnthropicBedrockMantle"):
                raise ImportError(
                    f"anthropic=<{anthropic.__version__}> | the bedrock-mantle endpoint requires anthropic>=0.91.0, "
                    "install it with: pip install -U 'anthropic>=0.91.0'"
                )
            return anthropic.AsyncAnthropicBedrockMantle(**client_args)  # type: ignore[return-value]
        if "api_key" in client_args and "api_key" not in inspect.signature(anthropic.AsyncAnthropicBedrock).parameters:
            raise ImportError(
                f"anthropic=<{anthropic.__version__}> | api_key on bedrock-runtime requires anthropic>=0.88.0, "
                "install it with: pip install -U 'anthropic>=0.88.0'"
            )
        return anthropic.AsyncAnthropicBedrock(**client_args)  # type: ignore[return-value]

    @override
    async def stream(
        self,
        messages: Messages,
        tool_specs: list[ToolSpec] | None = None,
        system_prompt: str | None = None,
        *,
        tool_choice: ToolChoice | None = None,
        system_prompt_content: list[SystemContentBlock] | None = None,
        structured_output_model: type[BaseModel] | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[StreamEvent, None]:
        """Stream like :class:`AnthropicModel`, mapping InvokeModel's mid-stream error events to Strands exceptions.

        The Anthropic SDK raises those events as a plain ``ValueError``.
        """
        try:
            async for event in super().stream(
                messages,
                tool_specs,
                system_prompt,
                tool_choice=tool_choice,
                system_prompt_content=system_prompt_content,
                structured_output_model=structured_output_model,
                **kwargs,
            ):
                yield event
        except ValueError as error:
            message = str(error)
            if any(name in message for name in _THROTTLING_EVENTS):
                raise ModelThrottledException(message) from error
            if any(overflow in message.lower() for overflow in AnthropicModel.OVERFLOW_MESSAGES):
                raise ContextWindowOverflowException(message) from error
            raise
