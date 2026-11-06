"""The OpenAI-compatible APIs on Amazon Bedrock: ``BedrockModel.ChatCompletions`` and ``BedrockModel.Responses``."""

import os
from typing import Any

from typing_extensions import Unpack, override

from ._openai_bedrock import BedrockMantleConfig, _resolve_base_url
from .bedrock import BedrockEndpoint, _check_bedrock_options, _resolve_bedrock_region
from .openai import OpenAIModel
from .openai_responses import OpenAIResponsesModel

_ENDPOINTS = ("bedrock-runtime", "bedrock-mantle")
_PARENT_OPTIONS = {"client", "bedrock_mantle_config"}


def _bedrock_options(
    owner: str,
    model_config: dict[str, Any],
    endpoint: str,
    region_name: str | None,
    api_key: str | None,
    client_args: dict[str, Any] | None,
) -> tuple[BedrockMantleConfig, str | None]:
    """Validate the options and return the parent's ``bedrock_mantle_config`` and the API key, if any.

    Raises:
        ValueError: If the endpoint is unknown, the model is an imported model, or a parent or owned option is set.
    """
    if endpoint not in _ENDPOINTS:
        raise ValueError(f"endpoint=<{endpoint}> | unknown Bedrock endpoint, use one of {sorted(_ENDPOINTS)}")
    if conflicting := {"api_key", "base_url"} & set(client_args or {}):
        raise ValueError(f"client_args=<{sorted(conflicting)}> | set by {owner}, remove them")
    _check_bedrock_options(owner, model_config, _PARENT_OPTIONS)
    config = BedrockMantleConfig(endpoint=endpoint, region=_resolve_bedrock_region(region_name))  # type: ignore[typeddict-item]
    return config, api_key or os.environ.get("AWS_BEARER_TOKEN_BEDROCK") or None


def _with_api_key(
    client_args: dict[str, Any], config: BedrockMantleConfig, api_key: str, model_id: str
) -> dict[str, Any]:
    """Client arguments that send a Bedrock API key; the mantle base path depends on the current model."""
    return {**client_args, "api_key": api_key, "base_url": _resolve_base_url(config, config["region"], model_id)}


class BedrockChatCompletionsModel(OpenAIModel):
    """OpenAI Chat Completions on Amazon Bedrock.

    Use it as ``BedrockModel.ChatCompletions``. Without an API key, each request gets a fresh bearer token minted from
    the default AWS credential chain. Model settings are those of :class:`~strands.models.openai.OpenAIModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
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
            api_key: Amazon Bedrock API key. Defaults to ``AWS_BEARER_TOKEN_BEDROCK``; without either, a bearer token
                is minted from AWS credentials for each request, which needs the ``bedrock:CallWithBearerToken``
                permission.
            client_args: Arguments for the OpenAI client, such as ``timeout`` or ``max_retries``. ``base_url`` and
                ``api_key`` are set by this provider.
            **model_config: Configuration options for the OpenAI model.

        Raises:
            ValueError: If the endpoint is unknown, the model is an imported model, or a parent or owned option is set.
        """
        config, self._api_key = _bedrock_options(
            "BedrockModel.ChatCompletions", dict(model_config), endpoint, region_name, api_key, client_args
        )
        self._bedrock_config = config
        super().__init__(
            client_args=client_args, bedrock_mantle_config=None if self._api_key else config, **model_config
        )

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        if not self._api_key:
            return super()._resolve_client_args()
        return _with_api_key(
            self.client_args, self._bedrock_config, self._api_key, str(self.config.get("model_id", ""))
        )


class BedrockResponsesModel(OpenAIResponsesModel):
    """OpenAI Responses on Amazon Bedrock.

    Use it as ``BedrockModel.Responses``. Without an API key, each request gets a fresh bearer token minted from the
    default AWS credential chain. Model settings are those of
    :class:`~strands.models.openai_responses.OpenAIResponsesModel`.
    """

    def __init__(
        self,
        *,
        endpoint: BedrockEndpoint = "bedrock-runtime",
        region_name: str | None = None,
        api_key: str | None = None,
        client_args: dict[str, Any] | None = None,
        **model_config: Unpack[OpenAIResponsesModel.OpenAIResponsesConfig],
    ) -> None:
        """Initialize the provider.

        Args:
            endpoint: Bedrock endpoint that serves the requests, ``"bedrock-runtime"`` or ``"bedrock-mantle"``.
                Not every model serves the Responses API on both; gpt-oss, for example, does only on bedrock-mantle.
            region_name: AWS region. Defaults to the session's region, then ``AWS_REGION``, then us-west-2.
            api_key: Amazon Bedrock API key. Defaults to ``AWS_BEARER_TOKEN_BEDROCK``; without either, a bearer token
                is minted from AWS credentials for each request, which needs the ``bedrock:CallWithBearerToken``
                permission.
            client_args: Arguments for the OpenAI client, such as ``timeout`` or ``max_retries``. ``base_url`` and
                ``api_key`` are set by this provider.
            **model_config: Configuration options for the OpenAI Responses model.

        Raises:
            ValueError: If the endpoint is unknown, the model is an imported model, or a parent or owned option is set.
        """
        config, self._api_key = _bedrock_options(
            "BedrockModel.Responses", dict(model_config), endpoint, region_name, api_key, client_args
        )
        self._bedrock_config = config
        super().__init__(
            client_args=client_args, bedrock_mantle_config=None if self._api_key else config, **model_config
        )

    @override
    def _resolve_client_args(self) -> dict[str, Any]:
        if not self._api_key:
            return super()._resolve_client_args()
        return _with_api_key(
            self.client_args, self._bedrock_config, self._api_key, str(self.config.get("model_id", ""))
        )
