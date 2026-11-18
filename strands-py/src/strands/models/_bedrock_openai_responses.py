"""OpenAI Responses on Amazon Bedrock, exposed as ``BedrockModel.Responses``.

Kept apart from ``_bedrock_openai`` because ``openai_responses`` requires openai>=2.0.0 at import time.
"""

from typing import Any

from typing_extensions import Unpack, override

from ._bedrock_openai import _bedrock_options, _with_api_key
from .bedrock import BedrockEndpoint
from .openai_responses import OpenAIResponsesModel


class BedrockResponsesModel(OpenAIResponsesModel):
    """OpenAI Responses on Amazon Bedrock.

    Use it as ``BedrockModel.Responses``. Without an API key, each request gets a fresh bearer token minted from the
    default AWS credential chain. Model settings are those of
    :class:`~strands.models.openai_responses.OpenAIResponsesModel`.

    Requires the ``openai>=2.0.0`` package, plus ``aws-bedrock-token-generator`` unless you use an API key.
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
            ImportError: If there is no API key and ``aws-bedrock-token-generator`` is not installed.
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
