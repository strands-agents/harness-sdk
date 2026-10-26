"""Table-wide drift check: every direct-API key in the context-window table matches the provider's reported limit.

Keys the provider no longer serves skip (not fail), so the skip list doubles as a report of stale rows.
Metadata calls only; no model turns. Bedrock-style `vendor.` keys match no prefix below.
"""

import os

import anthropic
import pytest
from google import genai
from google.genai import errors as genai_errors
from mistralai.client import Mistral
from mistralai.client.errors import SDKError as MistralSDKError

from strands.models._defaults import _CONTEXT_WINDOW_LIMITS
from tests_integ.models import providers


def _anthropic(model_id: str) -> int | None:
    client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    try:
        return client.models.retrieve(model_id).max_input_tokens
    except anthropic.NotFoundError:
        return None


def _gemini(model_id: str) -> int | None:
    # Held in a local: an inline `genai.Client(...).models.get(...)` can be collected (and closed) mid-request.
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
    try:
        return client.models.get(model=model_id).input_token_limit
    except genai_errors.ClientError as e:
        if e.code == 404:
            return None
        raise


def _mistral(model_id: str) -> int | None:
    client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))
    try:
        return client.models.retrieve(model_id=model_id).max_context_length
    except MistralSDKError as e:
        if e.status_code == 404:
            return None
        raise


# (table key prefixes, provider, lookup) for each provider whose API reports the input limit.
LOOKUPS = [
    (("claude-",), providers.anthropic, _anthropic),
    (("gemini-",), providers.gemini, _gemini),
    (("mistral-", "ministral-", "codestral-", "magistral-"), providers.mistral, _mistral),
]

DIRECT_API_MODELS = [
    pytest.param(provider, lookup, model_id, table_window, id=model_id, marks=provider.mark)
    for model_id, table_window in _CONTEXT_WINDOW_LIMITS.items()
    for prefixes, provider, lookup in LOOKUPS
    if model_id.startswith(prefixes)
]


@pytest.mark.parametrize(("provider", "lookup", "model_id", "table_window"), DIRECT_API_MODELS)
def test_context_window_matches_provider_api(provider, lookup, model_id, table_window):
    api_window = lookup(model_id)
    if api_window is None:
        pytest.skip(f"{model_id}: not served by {provider.id} API: retired?")

    assert table_window == api_window, (
        f"{model_id}: table says {table_window}, provider API reports {api_window}; update strands/models/_defaults.py"
    )
