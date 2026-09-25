"""Internal helpers for routing OpenAI-compatible clients to Amazon Bedrock.

Converts a ``bedrock_mantle_config`` dict into the ``base_url`` and ``api_key`` that the
OpenAI Python SDK consumes. Tokens are minted on demand via
``aws_bedrock_token_generator.provide_token`` so long-running agents survive the
bearer token's maximum lifetime.

The config's ``endpoint`` key selects which of Bedrock's two OpenAI-compatible endpoint
families serves the request; see :class:`BedrockMantleConfig`.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Literal, TypedDict

import boto3
from botocore.credentials import CredentialProvider

from ._validation import validate_region

_MANTLE_BASE_URL_TEMPLATE = "https://bedrock-mantle.{region}.api.aws{path}"
# On bedrock-runtime every OpenAI-compatible API is served from /openai/v1, so the base
# path is fixed rather than per-model as it is on bedrock-mantle.
_RUNTIME_BASE_URL_TEMPLATE = "https://bedrock-runtime.{region}.amazonaws.com/openai/v1"
_MANTLE_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html"
_RUNTIME_REGIONS_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints-region-availability.html"
_ENDPOINTS_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html"
_DEFAULT_ENDPOINT: Literal["bedrock-mantle", "bedrock-runtime"] = "bedrock-mantle"


# Mantle model lines served from /openai/v1; every other Mantle model uses /v1, and the
# wrong base path fails with HTTP 400. The base path is a per-model property that no
# Mantle API reports, so these prefixes were verified against the ``us-east-1`` catalog on
# 2026-08-05. Scope each prefix to a single model line, never a vendor: one vendor's lines
# can split across base paths (``google.gemma-4-*`` is on /openai/v1, ``google.gemma-3-*``
# is on /v1). An unmatched new line falls through to /v1; the ``test_mantle_routing``
# integ test fails naming any id that routes wrong.
_OPENAI_PATH_MODEL_PREFIXES: tuple[str, ...] = ("openai.gpt-5.", "openai.gpt-6-", "xai.grok-4.", "google.gemma-4-")


def _resolve_mantle_base_path(model_id: str) -> str:
    """Resolve the Mantle base path for ``model_id``.

    Models matching :data:`_OPENAI_PATH_MODEL_PREFIXES` are served from ``/openai/v1``;
    other Mantle-routed models (e.g. ``openai.gpt-oss-*``, ``google.gemma-3-*``) use ``/v1``.
    """
    if model_id.startswith(_OPENAI_PATH_MODEL_PREFIXES):
        return "/openai/v1"
    return "/v1"


class BedrockMantleConfig(TypedDict, total=False):
    """Config for routing an OpenAI-compatible client through Amazon Bedrock.

    Attributes:
        endpoint: Which Bedrock endpoint family serves the request: ``"bedrock-mantle"``
            (the default) or ``"bedrock-runtime"``. Only ``bedrock-runtime`` accepts
            cross-Region inference profile ids (``us.openai.*``, ``global.openai.*``). See
            https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html for the
            full comparison.
        region: AWS region hosting the Bedrock endpoint. If omitted, resolved
            from ``boto_session`` (if provided) or the standard boto3 chain
            (``AWS_REGION`` / ``AWS_DEFAULT_REGION`` / active profile / EC2 metadata).
            A :class:`ValueError` is raised if none resolve.
        boto_session: Optional :class:`boto3.Session` used to resolve the region when
            ``region`` is not provided. Useful for picking up a non-default profile
            without exporting env vars.
        credentials_provider: Optional botocore :class:`~botocore.credentials.CredentialProvider`
            forwarded to ``provide_token``. Omit to let the token generator use the
            standard AWS credential chain.
        expiry: Optional ``timedelta`` for the bearer token's lifetime, forwarded to
            ``provide_token``. Defaults to the generator's built-in lifetime when
            omitted.
    """

    endpoint: Literal["bedrock-mantle", "bedrock-runtime"]
    region: str
    boto_session: boto3.Session
    credentials_provider: CredentialProvider
    expiry: timedelta


def _resolve_base_url(config: BedrockMantleConfig, region: str, model_id: str) -> str:
    """Resolve the OpenAI client's ``base_url`` for the configured endpoint family.

    Raises:
        ValueError: If ``endpoint`` is neither ``"bedrock-mantle"`` nor ``"bedrock-runtime"``.
    """
    endpoint = config.get("endpoint", _DEFAULT_ENDPOINT)
    if endpoint == "bedrock-runtime":
        return _RUNTIME_BASE_URL_TEMPLATE.format(region=region)
    if endpoint != "bedrock-mantle":
        raise ValueError(
            f"Unknown Bedrock endpoint '{endpoint}' in bedrock_mantle_config. "
            f"Use 'bedrock-mantle' or 'bedrock-runtime'. See {_ENDPOINTS_DOCS_URL} for the difference."
        )
    return _MANTLE_BASE_URL_TEMPLATE.format(region=region, path=_resolve_mantle_base_path(model_id))


def _resolve_region(config: BedrockMantleConfig) -> str:
    """Resolve the AWS region, preferring explicit config then falling back to boto3.

    The resolved region is validated before it is returned, since it is interpolated
    into the Bedrock endpoint URL by the caller.

    Raises:
        ValueError: If no region can be resolved from the config, an attached session,
            or the standard boto3 credential chain, or if the resolved region is not a
            well-formed AWS region identifier.
    """
    region = config.get("region")
    if region:
        return validate_region(region)

    session = config.get("boto_session")
    if session is not None and session.region_name:
        return validate_region(str(session.region_name))

    # ``boto3.Session()`` with no args reads ``AWS_REGION`` / ``AWS_DEFAULT_REGION``,
    # the active profile, and falls back to EC2 instance metadata — the same chain
    # :class:`BedrockModel` uses.
    default_region = boto3.Session().region_name
    if default_region:
        return validate_region(str(default_region))

    # The two endpoint families are available in different Regions, so point at the list
    # for the one actually being used.
    regions_docs_url = (
        _RUNTIME_REGIONS_DOCS_URL
        if config.get("endpoint", _DEFAULT_ENDPOINT) == "bedrock-runtime"
        else _MANTLE_DOCS_URL
    )
    raise ValueError(
        "Could not resolve an AWS region for Amazon Bedrock. Pass 'region' in "
        "bedrock_mantle_config, attach a boto_session with a configured region, or set "
        f"AWS_REGION in the environment. See {regions_docs_url} for supported regions."
    )


def resolve_bedrock_client_args(
    config: BedrockMantleConfig, client_args: dict[str, Any] | None = None, model_id: str = ""
) -> dict[str, Any]:
    """Resolve a ``BedrockMantleConfig`` (plus optional ``client_args``) into OpenAI client kwargs.

    Mints a fresh bearer token on every call. Callers are expected to validate that
    ``client_args`` does not contain ``base_url`` or ``api_key`` before calling this
    function (typically at ``__init__`` time for fail-fast behavior).

    The ``endpoint`` key selects the endpoint family; on ``bedrock-mantle`` the ``model_id``
    additionally selects the base path via :func:`_resolve_mantle_base_path`.

    Raises:
        ValueError: If no region can be resolved, or ``endpoint`` is not a known value.
        ImportError: If ``aws-bedrock-token-generator`` is not installed.
        RuntimeError: If token minting fails (e.g. missing AWS credentials).
    """
    region = _resolve_region(config)
    # Resolved before the token is minted so invalid input never costs a token round trip.
    base_url = _resolve_base_url(config, region, model_id)

    # ``aws-bedrock-token-generator`` is included in the ``openai`` extras group but not in
    # ``litellm`` or ``sagemaker`` (which also depend on the ``openai`` package). The lazy
    # import keeps those extras from hitting an ImportError at module load.
    try:
        from aws_bedrock_token_generator import provide_token
    except ImportError as e:
        raise ImportError(
            "bedrock_mantle_config requires the 'aws-bedrock-token-generator' package. "
            "Install it with: pip install strands-agents[openai]"
        ) from e

    # Only forward kwargs the user set; provide_token rejects expiry=None.
    token_kwargs: dict[str, Any] = {"region": region}
    if "credentials_provider" in config:
        token_kwargs["aws_credentials_provider"] = config["credentials_provider"]
    if "expiry" in config:
        token_kwargs["expiry"] = config["expiry"]

    try:
        token = provide_token(**token_kwargs)
    except Exception as e:
        raise RuntimeError(
            f"Failed to mint an Amazon Bedrock bearer token for region '{region}'. "
            "Verify your AWS credentials and network connectivity."
        ) from e

    resolved: dict[str, Any] = dict(client_args or {})
    resolved["base_url"] = base_url
    resolved["api_key"] = token
    return resolved
