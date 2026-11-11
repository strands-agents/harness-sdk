import json
import pathlib

import pytest

from strands_harness.models import EFFORT_LEVELS, lookup_model

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
    assert lookup_model(model_id) == {
        "limits": {"contextWindow": 1_000_000, "maxOutputTokens": 128_000},
        "capabilities": lookup_model("claude-opus-5-5")["capabilities"],
    }
    assert lookup_model(model_id)["capabilities"]["defaultEffort"] == "medium"


def test_an_unknown_model_has_an_empty_entry():
    assert lookup_model("unknown-model") == {}


def test_every_default_effort_is_an_effort_level():
    models = json.loads(_SHARED.read_text(encoding="utf-8"))["models"]
    for model_id, entry in models.items():
        level = entry.get("capabilities", {}).get("defaultEffort")
        assert level is None or level in EFFORT_LEVELS[2:], model_id
