"""The OpenAI-compatible APIs on Amazon Bedrock: ``BedrockModel.ChatCompletions`` and ``BedrockModel.Responses``."""

from typing import Any

import boto3
import openai
from typing_extensions import Unpack, override

from ._bedrock_auth import (
    bedrock_api_key,
    bedrock_http_client,
    check_bedrock_options,
    require_sdk_version,
)
from ._openai_bedrock import BedrockMantleConfig, _resolve_base_url
from .bedrock import BedrockEndpoint, _resolve_bedrock_region
from .openai import OpenAIModel
from .openai_responses import OpenAIResponsesModel

# 2.31.0 is the first release that passes errors raised while signing through instead of retrying them.
require_sdk_version("openai", openai.__version__, (2, 31, 0), "BedrockModel.ChatCompletions and .Responses", "openai")

_ENDPOINTS = ("bedrock-runtime", "bedrock-mantle")

_PLACEHOLDER_KEY = "bedrock"


class _BedrockOpenAIClient:
    """Builds the OpenAI client arguments for a Bedrock endpoint, signing with SigV4 unless an API key is given."""

    def __init__(
        self,
        *,
        owner: str,
        model_config: dict[str, Any],
        endpoint: BedrockEndpoint,
        region_name: str | None,
        boto_session: boto3.Session | None,
        api_key: str | None,
        client_args: dict[str, Any] | None,
    ) -> None:
        if endpoint not in _ENDPOINTS:
            raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_ENDPOINTS)}")
        model_id = str(model_config.get("model_id", ""))
        check_bedrock_options(owner, model_id, model_config, {"client", "bedrock_mantle_config"})
        if conflicting := {"api_key", "base_url", "http_client"} & set(client_args or {}):
            raise ValueError(f"client_args=<{sorted(conflicting)}> | set by {owner}, remove them")

        session, region = _resolve_bedrock_region(region_name, boto_session)
        self._endpoint = endpoint
        self._region = region
        self._session = session
        self._api_key = bedrock_api_key(api_key)
        client_args = client_args or {}
        self.client_args = {
            **client_args,
            # The OpenAI SDK adds these from OPENAI_ORG_ID / OPENAI_PROJECT_ID; they're meant for OpenAI, not AWS.
            "default_headers": {"OpenAI-Organization": openai.Omit(), "OpenAI-Project": openai.Omit()}
            | dict(client_args.get("default_headers") or {}),
            # The OpenAI SDK requires an api_key; the auth below replaces the header it produces.
            "api_key": _PLACEHOLDER_KEY,
        }

    def per_request(self, client_args: dict[str, Any], model_id: str) -> dict[str, Any]:
        """Add the base URL for the current model and an authenticating HTTP client.

        The mantle base path depends on the model, which ``update_config`` can change. The parent model closes its
        OpenAI client, and with it this HTTP client, after each request.
        """
        http_client = bedrock_http_client(
            openai.DefaultAsyncHttpxClient,
            endpoint=self._endpoint,
            region=self._region,
            session=self._session,
            api_key=self._api_key,
            error_type=openai.OpenAIError,
        )
        base_url = _resolve_base_url(BedrockMantleConfig(endpoint=self._endpoint), self._region, model_id)
        return {**client_args, "base_url": base_url, "http_client": http_client}


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
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials. Defaults to
                ``AWS_BEARER_TOKEN_BEDROCK``, which then takes precedence over ``boto_session``, as in botocore.
            client_args: Arguments for the underlying OpenAI client, such as ``timeout`` or ``max_retries``.
                Base URL, authentication, and ``http_client`` are set by this provider.
            **model_config: Configuration options for the OpenAI model.

        Raises:
            ValueError: If the endpoint is unknown, both ``region_name`` and ``boto_session`` are given, the model
                is an imported model, or ``client_args`` or the model options set something this provider owns.
        """
        self._bedrock = _BedrockOpenAIClient(
            owner="BedrockModel.ChatCompletions",
            model_config=dict(model_config),
            endpoint=endpoint,
            region_name=region_name,
            boto_session=boto_session,
            api_key=api_key,
            client_args=client_args,
        )
        super().__init__(client_args=self._bedrock.client_args, **model_config)

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        return self._bedrock.per_request(super()._resolve_client_args(), str(self.config.get("model_id", "")))


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
            api_key: Amazon Bedrock API key, sent instead of signing requests with AWS credentials. Defaults to
                ``AWS_BEARER_TOKEN_BEDROCK``, which then takes precedence over ``boto_session``, as in botocore.
            client_args: Arguments for the underlying OpenAI client, such as ``timeout`` or ``max_retries``.
                Base URL, authentication, and ``http_client`` are set by this provider.
            **model_config: Configuration options for the OpenAI Responses model.

        Raises:
            ValueError: If the endpoint is unknown, both ``region_name`` and ``boto_session`` are given, the model
                is an imported model, or ``client_args`` or the model options set something this provider owns.
        """
        self._bedrock = _BedrockOpenAIClient(
            owner="BedrockModel.Responses",
            model_config=dict(model_config),
            endpoint=endpoint,
            region_name=region_name,
            boto_session=boto_session,
            api_key=api_key,
            client_args=client_args,
        )
        super().__init__(client_args=self._bedrock.client_args, **model_config)

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        return self._bedrock.per_request(super()._resolve_client_args(), str(self.config.get("model_id", "")))
