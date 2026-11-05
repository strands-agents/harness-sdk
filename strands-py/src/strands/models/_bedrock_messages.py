"""The Anthropic Messages API served by Amazon Bedrock, exposed as ``BedrockModel.Messages``."""

import logging
from typing import Any

import anthropic
import boto3
from typing_extensions import Unpack, override

from ._bedrock_auth import (
    bedrock_api_key,
    bedrock_http_client,
    check_bedrock_options,
    require_sdk_version,
)
from .anthropic import AnthropicModel
from .bedrock import BedrockEndpoint, _resolve_bedrock_region

# 0.98.0 is the first release with the Bedrock client's skip_auth that also passes signing errors through.
require_sdk_version("anthropic", anthropic.__version__, (0, 98, 0), "BedrockModel.Messages")

logger = logging.getLogger(__name__)

_BASE_URLS: dict[str, str] = {
    "bedrock-runtime": "https://bedrock-runtime.{region}.amazonaws.com/anthropic",
    "bedrock-mantle": "https://bedrock-mantle.{region}.api.aws/anthropic",
}

# Set by this provider; the Bedrock client's own AWS options would bypass the session-based signing.
_OWNED_CLIENT_ARGS = {
    "api_key",
    "aws_access_key",
    "aws_profile",
    "aws_region",
    "aws_secret_key",
    "aws_session_token",
    "base_url",
    "http_client",
    "skip_auth",
}


class BedrockMessagesModel(AnthropicModel):
    """Claude on Amazon Bedrock through the Anthropic Messages API.

    Use it as ``BedrockModel.Messages`` for Anthropic features that the Converse API does not offer. Model settings
    are those of :class:`~strands.models.anthropic.AnthropicModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
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
            boto_session: Session whose credentials sign each request. Mutually exclusive with ``region_name``.
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials. Defaults to
                ``AWS_BEARER_TOKEN_BEDROCK``, which then takes precedence over ``boto_session``, as in botocore.
            client_args: Arguments for the underlying Anthropic client, such as ``timeout`` or ``max_retries``.
                Base URL, authentication, and ``http_client`` are set by this provider.
            **model_config: Configuration options for the Anthropic model.

        Raises:
            ValueError: If both ``region_name`` and ``boto_session`` are given, ``endpoint`` is unknown, the model is
                an imported model, or ``client_args`` or the model options set something this provider owns.
        """
        if endpoint not in _BASE_URLS:
            raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_BASE_URLS)}")
        if conflicting := _OWNED_CLIENT_ARGS & set(client_args or {}):
            raise ValueError(f"client_args=<{sorted(conflicting)}> | set by BedrockModel.Messages, remove them")

        check_bedrock_options("BedrockModel.Messages", model_config.get("model_id"), model_config, {"client"})

        session, region = _resolve_bedrock_region(region_name, boto_session)
        api_key = bedrock_api_key(api_key)
        http_client = bedrock_http_client(
            anthropic.DefaultAsyncHttpxClient,
            endpoint=endpoint,
            region=region,
            session=session,
            api_key=api_key,
            error_type=anthropic.AnthropicError,
            per_loop_limits=anthropic.DEFAULT_CONNECTION_LIMITS,
        )
        super().__init__(
            client_args={
                **(client_args or {}),
                "skip_auth": True,
                "http_client": http_client,
                "base_url": _BASE_URLS[endpoint].format(region=region),
                "aws_region": region,
            },
            **model_config,
        )
        logger.debug("endpoint=<%s>, region=<%s> | bedrock messages client created", endpoint, region)

    @override
    def _create_client(self, client_args: dict[str, Any]) -> anthropic.AsyncAnthropic:
        # The Bedrock client speaks the same Messages API as AsyncAnthropic, which AnthropicModel is typed against.
        return anthropic.AsyncAnthropicBedrockMantle(**client_args)  # type: ignore[return-value]
