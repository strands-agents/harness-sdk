import json
import pathlib

import pytest
from strands.models._model_info import lookup_model as sdk_lookup_model

from strands_harness import models
from strands_harness.models import EFFORT_LEVELS, _lookup_model

_SHARED = pathlib.Path(__file__).parents[2] / "shared" / "model-info.json"
_COPY = pathlib.Path(__file__).parents[1] / "src" / "strands_harness" / "model_info.json"


def test_packaged_copy_matches_the_shared_data():
    assert _COPY.read_text(encoding="utf-8") == _SHARED.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "model_id",
    [
        "claude-opus-5-5",
        "global.anthropic.claude-opus-5-5",
        "us.anthropic.claude-opus-5-5-20260401-v1:0",
        "arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5",
    ],
)
def test_every_spelling_of_a_model_resolves_to_its_entry(model_id):
    assert _lookup_model(model_id) == {
        "limits": {"contextWindow": 1_000_000, "maxOutputTokens": 128_000},
        "capabilities": _lookup_model("claude-opus-5-5")["capabilities"],
    }
    assert _lookup_model(model_id)["capabilities"]["defaultEffort"] == "medium"


def test_an_unknown_model_has_an_empty_entry():
    assert _lookup_model("unknown-model") == {}


def test_every_default_effort_is_an_effort_level():
    models = json.loads(_SHARED.read_text(encoding="utf-8"))["models"]
    for model_id, entry in models.items():
        level = entry.get("capabilities", {}).get("defaultEffort")
        assert level is None or level in EFFORT_LEVELS[2:], model_id


@pytest.mark.parametrize(
    "model_id",
    [
        "claude-opus-5-5",
        "us.anthropic.claude-opus-5-5-20260401-v1:0",
        "arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        "claude-haiku-4-5@20251001",
        "anthropic.claude-3-5-haiku-20241022-v2:0",
        "openai.gpt-6.1-sol",
        "global.openai.gpt-6-astra",
        "amazon.nova-pro-v1:0",
        "gemini-3.5-flash",
        "unknown-model",
        "toString",
    ],
)
def test_the_id_matching_rule_matches_the_sdk(model_id):
    sdk = sdk_lookup_model(model_id)
    ours = _lookup_model(model_id)
    assert bool(ours) == (sdk is not None)
    if sdk is not None:
        assert ours.get("limits", {}).get("maxOutputTokens") == sdk.limits.max_output_tokens
        assert ours.get("limits", {}).get("contextWindow") == sdk.limits.context_window


def _provider_levels(model_id: str) -> tuple[str, ...]:
    if "." in model_id.split("-")[0]:
        return models._bedrock_levels(model_id)
    if model_id.startswith("claude-"):
        return models._model_levels("anthropic", model_id, models._ANTHROPIC_LEVELS)
    if model_id.startswith("gemini-"):
        return models._model_levels("google", model_id, models._GOOGLE_LEVELS)
    return models._model_levels("openai", model_id, models._OPENAI_LEVELS)


def test_every_default_effort_is_a_level_the_serving_provider_accepts():
    data = json.loads(_SHARED.read_text(encoding="utf-8"))["models"]
    for model_id, entry in data.items():
        level = entry.get("capabilities", {}).get("defaultEffort")
        if level is not None:
            assert level in _provider_levels(model_id), model_id
