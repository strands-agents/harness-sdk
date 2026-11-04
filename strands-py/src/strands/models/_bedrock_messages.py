"""The Anthropic Messages API served by Amazon Bedrock, exposed as ``BedrockModel.Messages``."""

import logging
import os
from typing import Any, Literal

import anthropic
import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from typing_extensions import Unpack, override

from ._validation import validate_region
from .anthropic import AnthropicModel
from .bedrock import DEFAULT_BEDROCK_REGION

logger = logging.getLogger(__name__)

BedrockEndpoint = Literal["bedrock-runtime", "bedrock-mantle"]

_BASE_URLS: dict[str, str] = {
    "bedrock-runtime": "https://bedrock-runtime.{region}.amazonaws.com/anthropic",
    "bedrock-mantle": "https://bedrock-mantle.{region}.api.aws/anthropic",
}


class _BedrockAnthropicClient(anthropic.AsyncAnthropic):
    """Anthropic client that authenticates to Bedrock with a Bedrock API key or SigV4.

    Without an API key, each request is signed with the session's current credentials, so refreshable
    credentials (assumed roles, SSO) keep working for the life of the agent.
    """

    def __init__(
        self, *, base_url: str, region: str, boto_session: boto3.Session, api_key: str | None = None
    ) -> None:
        # The placeholder keeps the SDK from reading Anthropic credentials from the environment; auth_headers
        # below decides what is actually sent.
        super().__init__(api_key=api_key or "sigv4", base_url=base_url)
        self._bedrock_api_key = api_key
        self._region = region
        self._boto_session = boto_session

    @property
    @override
    def auth_headers(self) -> dict[str, str]:
        return {"X-Api-Key": self._bedrock_api_key} if self._bedrock_api_key else {}

    @override
    def _validate_headers(self, headers: Any, custom_headers: Any) -> None:
        return None

    @override
    async def _prepare_request(self, request: httpx.Request) -> None:
        if self._bedrock_api_key:
            return

        credentials = self._boto_session.get_credentials()
        if credentials is None:
            raise RuntimeError("Could not resolve AWS credentials for Amazon Bedrock from the boto3 session.")

        headers = {key: value for key, value in request.headers.items() if key.lower() != "connection"}
        signed = AWSRequest(method=request.method, url=str(request.url), headers=headers, data=request.read())
        SigV4Auth(credentials, "bedrock", self._region).add_auth(signed)
        request.headers.update(dict(signed.headers))


class BedrockMessagesModel(AnthropicModel):
    """Claude on Amazon Bedrock through the Anthropic Messages API.

    Use it as ``BedrockModel.Messages`` for Anthropic features that the Converse API does not offer. Model settings
    are those of :class:`~strands.models.anthropic.AnthropicModel`.
    """

    _client_class = _BedrockAnthropicClient

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
        api_key: str | None = None,
        **model_config: Unpack[AnthropicModel.AnthropicConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            endpoint: Bedrock endpoint that serves the requests, ``"bedrock-runtime"`` or ``"bedrock-mantle"``.
                Model ids differ between the two, for example ``global.anthropic.claude-sonnet-4-6`` on
                bedrock-runtime and ``anthropic.claude-sonnet-4-6`` on bedrock-mantle.
            region_name: AWS region. Defaults to the session's region, then ``AWS_REGION``, then us-west-2.
            boto_session: Session whose credentials sign each request. Mutually exclusive with ``region_name``.
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials.
            **model_config: Configuration options for the Anthropic model.

        Raises:
            ValueError: If both ``region_name`` and ``boto_session`` are given, or ``endpoint`` is unknown.
        """
        if region_name and boto_session:
            raise ValueError("Cannot specify both `region_name` and `boto_session`.")
        if endpoint not in _BASE_URLS:
            raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_BASE_URLS)}")

        session = boto_session or boto3.Session()
        region = validate_region(
            region_name or session.region_name or os.environ.get("AWS_REGION") or DEFAULT_BEDROCK_REGION
        )
        client_args = {
            "base_url": _BASE_URLS[endpoint].format(region=region),
            "region": region,
            "boto_session": session,
            "api_key": api_key,
        }
        super().__init__(client_args=client_args, **model_config)
        logger.debug("endpoint=<%s>, region=<%s> | bedrock messages client created", endpoint, region)
