"""The OpenAI-compatible APIs on Amazon Bedrock: ``BedrockModel.ChatCompletions`` and ``BedrockModel.Responses``."""

from typing import Any

import boto3
import openai
from typing_extensions import Unpack, override

from ._bedrock_auth import BedrockSigV4Auth, require_sdk_version
from ._openai_bedrock import BedrockMantleConfig, _resolve_base_url
from .bedrock import BedrockEndpoint, _resolve_bedrock_region
from .openai import OpenAIModel
from .openai_responses import OpenAIResponsesModel

# 2.31.0 is the first release that passes errors raised while signing through instead of retrying them.
require_sdk_version("openai", openai.__version__, (2, 31, 0), "BedrockModel.ChatCompletions and .Responses", "openai")

_ENDPOINTS = ("bedrock-runtime", "bedrock-mantle")

# The OpenAI SDK requires an api_key; with SigV4 the signature replaces the header it produces.
_SIGV4_PLACEHOLDER_KEY = "bedrock-sigv4"


class _BedrockOpenAIClient:
    """Builds the OpenAI client arguments for a Bedrock endpoint, signing with SigV4 unless an API key is given."""

    def __init__(
        self,
        *,
        model_id: str,
        endpoint: BedrockEndpoint,
        region_name: str | None,
        boto_session: boto3.Session | None,
        api_key: str | None,
        client_args: dict[str, Any] | None,
    ) -> None:
        if endpoint not in _ENDPOINTS:
            raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_ENDPOINTS)}")
        if ":imported-model/" in model_id:
            raise ValueError(
                f"model_id=<{model_id}> | imported models are served only through InvokeModel, "
                "which the OpenAI-compatible endpoints don't cover"
            )
        owned = {"api_key", "base_url"} if api_key else {"api_key", "base_url", "http_client"}
        if conflicting := owned & set(client_args or {}):
            raise ValueError(f"client_args=<{sorted(conflicting)}> | set by this provider, remove them")

        self._session, region = _resolve_bedrock_region(region_name, boto_session)
        self._region = region
        self._signed = not api_key
        base_url = _resolve_base_url(BedrockMantleConfig(endpoint=endpoint), region, model_id)
        self.client_args = {**(client_args or {}), "api_key": api_key or _SIGV4_PLACEHOLDER_KEY, "base_url": base_url}

    def per_request(self, client_args: dict[str, Any]) -> dict[str, Any]:
        """Add a signing HTTP client; the parent model closes its OpenAI client, and with it this one, per request."""
        if not self._signed:
            return client_args
        http_client = openai.DefaultAsyncHttpxClient(
            auth=BedrockSigV4Auth(self._session, self._region, openai.OpenAIError)
        )
        return {**client_args, "http_client": http_client}


class BedrockChatCompletionsModel(OpenAIModel):
    """OpenAI Chat Completions on Amazon Bedrock.

    Use it as ``BedrockModel.ChatCompletions``. Model settings are those of :class:`~strands.models.openai.OpenAIModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
        api_key: str | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[OpenAIModel.OpenAIConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            endpoint: Bedrock endpoint that serves the requests, ``"bedrock-runtime"`` or ``"bedrock-mantle"``.
                Model ids differ between the two, for example ``openai.gpt-oss-120b-1:0`` on bedrock-runtime and
                ``openai.gpt-oss-120b`` on bedrock-mantle.
            region_name: AWS region. Defaults to the session's region, then ``AWS_REGION``, then us-west-2.
            boto_session: Session whose credentials sign each request. Mutually exclusive with ``region_name``.
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials.
            client_args: Arguments for the underlying OpenAI client, such as ``timeout`` or ``max_retries``.
                Base URL and authentication are set by this provider, and ``http_client`` only with ``api_key``.
            **model_config: Configuration options for the OpenAI model.

        Raises:
            ValueError: If the endpoint is unknown, both ``region_name`` and ``boto_session`` are given, the model
                is an imported model, or ``client_args`` sets an argument this provider owns.
        """
        self._bedrock = _BedrockOpenAIClient(
            model_id=str(model_config.get("model_id", "")),
            endpoint=endpoint,
            region_name=region_name,
            boto_session=boto_session,
            api_key=api_key,
            client_args=client_args,
        )
        super().__init__(client_args=self._bedrock.client_args, **model_config)

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        return self._bedrock.per_request(super()._resolve_client_args())


class BedrockResponsesModel(OpenAIResponsesModel):
    """OpenAI Responses on Amazon Bedrock.

    Use it as ``BedrockModel.Responses``. Model settings are those of
    :class:`~strands.models.openai_responses.OpenAIResponsesModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        boto_session: boto3.Session | None = None,
        api_key: str | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[OpenAIResponsesModel.OpenAIResponsesConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            endpoint: Bedrock endpoint that serves the requests, ``"bedrock-runtime"`` or ``"bedrock-mantle"``.
                Not every model serves the Responses API on both; gpt-oss, for example, does only on bedrock-mantle.
            region_name: AWS region. Defaults to the session's region, then ``AWS_REGION``, then us-west-2.
            boto_session: Session whose credentials sign each request. Mutually exclusive with ``region_name``.
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials.
            client_args: Arguments for the underlying OpenAI client, such as ``timeout`` or ``max_retries``.
                Base URL and authentication are set by this provider, and ``http_client`` only with ``api_key``.
            **model_config: Configuration options for the OpenAI Responses model.

        Raises:
            ValueError: If the endpoint is unknown, both ``region_name`` and ``boto_session`` are given, the model
                is an imported model, or ``client_args`` sets an argument this provider owns.
        """
        self._bedrock = _BedrockOpenAIClient(
            model_id=str(model_config.get("model_id", "")),
            endpoint=endpoint,
            region_name=region_name,
            boto_session=boto_session,
            api_key=api_key,
            client_args=client_args,
        )
        super().__init__(client_args=self._bedrock.client_args, **model_config)

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        return self._bedrock.per_request(super()._resolve_client_args())
