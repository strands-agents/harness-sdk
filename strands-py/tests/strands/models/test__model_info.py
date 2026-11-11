"""Tests for the ModelInfo record and the shared model info data."""

import json
import pathlib
import re
import unittest.mock
from typing import get_args

import pytest

import strands.models
from strands.models._model_info import (
    _CAPABILITY_FIELDS,
    _LIMIT_FIELDS,
    _PROMPT_CACHING_VALUES,
    DEFAULT_CONTEXT_WINDOW_LIMIT,
    ModelCapabilities,
    ModelInfo,
    ModelLimits,
    PromptCaching,
    ReasoningCapability,
    _load_data,
    _section,
    get_context_window_limit,
    lookup_model,
    lookup_model_info,
)

BASE = ModelInfo(
    capabilities=ModelCapabilities(stateful=False, prompt_caching="cache_points"),
    limits=ModelLimits(context_window=200_000),
)

_SHARED_DATA = pathlib.Path(__file__).parents[3] / ".." / "shared" / "model-info.json"
_PACKAGE_COPY = pathlib.Path(__file__).parents[3] / "src" / "strands" / "models" / "model_info.json"

_MODEL_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.:@-]*$")
_LIMIT_KEYS = ("contextWindow", "maxOutputTokens")
_BOOLEAN_CAPABILITY_KEYS = (
    "stateful",
    "forcedToolChoice",
    "nativeStructuredOutput",
    "serverSideSummary",
    "temporaryMessages",
)
# The vendors' own level names; a default outside this set is a typo, not a new level.
_EFFORT_VALUES = ("minimal", "low", "medium", "high", "xhigh", "max")


def test_model_info_merge_returns_the_base_when_nothing_else_is_given():
    assert ModelInfo.merge(BASE) == BASE


def test_model_info_merge_inherits_fields_a_later_record_leaves_out_or_sets_to_none():
    tru_merged = ModelInfo.merge(
        BASE,
        ModelInfo(limits=ModelLimits(context_window=1_000_000)),
        ModelInfo(capabilities=ModelCapabilities(stateful=None)),
    )

    assert tru_merged.capabilities == BASE.capabilities
    assert tru_merged.limits.context_window == 1_000_000


def test_model_info_merge_lets_a_later_record_win_over_an_earlier_one():
    tru_merged = ModelInfo.merge(
        BASE,
        ModelInfo(limits=ModelLimits(context_window=1)),
        None,
        ModelInfo(
            capabilities=ModelCapabilities(prompt_caching="unsupported"),
            limits=ModelLimits(context_window=2),
        ),
    )

    assert tru_merged.capabilities == ModelCapabilities(stateful=False, prompt_caching="unsupported")
    assert tru_merged.limits.context_window == 2


def test_model_info_merge_returns_empty_sections_when_nothing_is_known():
    tru_merged = ModelInfo.merge(ModelInfo(), None, ModelInfo(limits=ModelLimits(context_window=None)))

    assert tru_merged == ModelInfo()
    assert tru_merged.capabilities == ModelCapabilities()
    assert tru_merged.capabilities.reasoning == ReasoningCapability()
    assert tru_merged.limits == ModelLimits()


def test_model_info_merge_merges_the_nested_reasoning_record_field_by_field():
    base = ModelInfo(
        capabilities=ModelCapabilities(stateful=False, reasoning=ReasoningCapability(default_effort="high"))
    )

    tru_inherited = ModelInfo.merge(
        base,
        ModelInfo(capabilities=ModelCapabilities(prompt_caching="auto")),
        ModelInfo(capabilities=ModelCapabilities(reasoning=ReasoningCapability(default_effort=None))),
    )
    tru_overridden = ModelInfo.merge(
        base, ModelInfo(capabilities=ModelCapabilities(reasoning=ReasoningCapability(default_effort="medium")))
    )

    assert tru_inherited.capabilities == ModelCapabilities(
        stateful=False, prompt_caching="auto", reasoning=ReasoningCapability(default_effort="high")
    )
    assert tru_overridden.capabilities == ModelCapabilities(
        stateful=False, reasoning=ReasoningCapability(default_effort="medium")
    )


def test_model_info_merge_rejects_a_plain_dict_with_the_expected_type_named():
    """A dict loaded from YAML/JSON fails at the merge, not later with an AttributeError."""
    with pytest.raises(TypeError, match="ModelInfo, not dict"):
        ModelInfo.merge(ModelInfo(), {"limits": {"context_window": 10}})  # type: ignore[arg-type]


def test_model_info_merge_returns_a_frozen_record():
    tru_merged = ModelInfo.merge(BASE)

    for frozen in (tru_merged, tru_merged.capabilities, tru_merged.limits):
        with pytest.raises(AttributeError):
            frozen.nope = True


def test_lookup_model_resolves_every_spelling_of_a_model_to_its_one_entry():
    exp_entry = lookup_model("claude-opus-5-5")

    assert exp_entry.limits.context_window == 1_000_000
    assert lookup_model("anthropic.claude-opus-5-5") is exp_entry
    assert lookup_model("us.anthropic.claude-opus-5-5") is exp_entry
    assert lookup_model("arn:aws:bedrock:us-west-2:123:inference-profile/global.anthropic.claude-opus-5-5") is exp_entry


def test_lookup_model_resolves_a_dated_snapshot_to_the_undated_model():
    assert lookup_model("anthropic.claude-opus-5-5-20260401-v1:0") is lookup_model("claude-opus-5-5")
    assert lookup_model("claude-haiku-4-5@20251001") is lookup_model("claude-haiku-4-5")
    assert lookup_model("claude-3-5-haiku-20241022").limits.context_window == 200_000


def test_lookup_model_does_not_read_inherited_object_keys():
    assert lookup_model("keys") is None
    assert lookup_model("x.items") is None


def test_lookup_model_ignores_a_trailing_bedrock_version_suffix():
    assert lookup_model("anthropic.claude-3-5-haiku-20241022-v1:0") is lookup_model("claude-3-5-haiku-20241022")
    assert lookup_model("us.anthropic.claude-3-5-sonnet-20241022-v2:0").limits.context_window == 200_000


def test_lookup_model_returns_none_for_unknown_ids():
    assert lookup_model("unknown-model") is None
    assert lookup_model("") is None


def test_lookup_model_info_returns_the_entry_facts_and_nothing_for_unknown_ids():
    assert lookup_model_info("eu.anthropic.claude-sonnet-4-6") == ModelInfo(
        capabilities=ModelCapabilities(
            prompt_caching="cache_points", reasoning=ReasoningCapability(default_effort="high")
        ),
        limits=ModelLimits(context_window=1_000_000, max_output_tokens=128_000),
    )
    for model_id, effort in (
        ("anthropic.claude-opus-5-5", "medium"),
        ("global.anthropic.claude-fable-5-2", "high"),
        ("claude-mythos-5-2", "high"),
    ):
        assert lookup_model_info(model_id) == ModelInfo(
            capabilities=ModelCapabilities(
                prompt_caching="cache_points",
                forced_tool_choice=False,
                native_structured_output=True,
                server_side_summary=True,
                reasoning=ReasoningCapability(default_effort=effort),
            ),
            limits=ModelLimits(context_window=1_000_000, max_output_tokens=128_000),
        )
    assert lookup_model_info("amazon.nova-pro-v1:0") == ModelInfo(
        capabilities=ModelCapabilities(forced_tool_choice=True, native_structured_output=False),
        limits=ModelLimits(context_window=300_000),
    )
    assert lookup_model_info("claude-future-9") == ModelInfo()
    assert lookup_model_info("") == ModelInfo()


def test_get_context_window_limit_returns_the_window_from_the_shared_data():
    assert get_context_window_limit("mistral-large-latest") == 262_144
    assert get_context_window_limit("o3") == 200_000


def test_default_context_window_limit_comes_from_the_data():
    assert DEFAULT_CONTEXT_WINDOW_LIMIT == 200_000


def test_lookup_model_info_and_reasoning_capability_are_public():
    assert strands.models.lookup_model_info is lookup_model_info
    assert strands.models.ReasoningCapability is ReasoningCapability
    assert {"lookup_model_info", "ReasoningCapability"} <= set(strands.models.__all__)


def test_loader_reads_the_nested_reasoning_record_and_ignores_facts_it_has_no_field_for():
    entry = {"capabilities": {"stateful": False, "reasoning": {"defaultEffort": "medium", "effortLevels": ["low"]}}}

    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities(
        stateful=False, reasoning=ReasoningCapability(default_effort="medium")
    )


@pytest.mark.parametrize("reasoning", [{"defaultEffort": 3}, {"defaultEffort": None}, "medium", True, {}])
def test_loader_treats_a_reasoning_record_it_cannot_read_as_unknown(reasoning):
    entry = {"capabilities": {"stateful": False, "reasoning": reasoning}}

    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities(stateful=False)


def test_loader_ignores_facts_this_version_has_no_field_for():
    """The data file is shared with the TypeScript SDK, so a fact added there first must not break the import."""
    entry = {
        "capabilities": {"promptCaching": "cachePoints", "serverTools": ["web_search"]},
        "limits": {"contextWindow": 1_000, "maxThinkingTokens": 4_096},
    }

    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities(
        prompt_caching="cache_points"
    )
    assert _section(entry, "limits", _LIMIT_FIELDS, ModelLimits) == ModelLimits(context_window=1_000)


def test_loader_returns_an_empty_section_when_its_only_facts_are_unknown_to_this_version():
    entry = {"capabilities": {"serverTools": ["web_search"]}}

    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities()


@pytest.mark.parametrize("value", ["explicit", {"default": "cachePoints"}, None])
def test_loader_treats_a_prompt_caching_value_this_version_does_not_know_as_unknown(value):
    entry = {"capabilities": {"promptCaching": value, "stateful": False}}

    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities(stateful=False)


@pytest.mark.parametrize("entry", [{}, {"capabilities": None}, {"capabilities": "cachePoints"}])
def test_loader_returns_an_empty_section_when_the_section_is_missing_or_not_an_object(entry):
    assert _section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities) == ModelCapabilities()


def test_prompt_caching_value_map_covers_exactly_the_prompt_caching_type():
    assert set(_PROMPT_CACHING_VALUES.values()) == set(get_args(PromptCaching))


def test_load_data_says_how_to_restore_the_package_copy_when_it_is_missing():
    """The copy is only written on install, so an environment installed without it needs the fix named."""
    with unittest.mock.patch("strands.models._model_info.resources") as mock_resources:
        mock_resources.files.return_value.joinpath.return_value.read_text.side_effect = FileNotFoundError(
            2, "No such file or directory"
        )

        with pytest.raises(FileNotFoundError) as err:
            _load_data()

    message = str(err.value)
    assert "shared/model-info.json" in message
    assert "hatch_build.py" in message
    assert "pip install -e ." in message
    assert isinstance(err.value.__cause__, FileNotFoundError)


def test_load_data_names_the_copy_when_it_is_malformed():
    """A truncated or hand-edited copy fails import with the cause named, not a bare JSON error."""
    with unittest.mock.patch("strands.models._model_info.resources") as mock_resources:
        mock_resources.files.return_value.joinpath.return_value.read_text.return_value = '{"models": {}}'

        with pytest.raises(ValueError) as err:
            _load_data()

    assert "shared/model-info.json" in str(err.value)
    assert isinstance(err.value.__cause__, KeyError)


def test_package_copy_matches_the_shared_data():
    """The build hook copies ``shared/model-info.json``; run ``hatch build`` to refresh the copy."""
    assert _PACKAGE_COPY.read_text(encoding="utf-8") == _SHARED_DATA.read_text(encoding="utf-8")


def test_shared_data_has_only_the_fields_model_info_defines_with_the_right_types_in_every_entry():
    data = json.loads(_SHARED_DATA.read_text(encoding="utf-8"))

    assert sorted(data.keys()) == ["$comment", "defaults", "models"]
    assert data["defaults"] == {"limits": {"contextWindow": DEFAULT_CONTEXT_WINDOW_LIMIT}}

    for model_id, entry in data["models"].items():
        assert _MODEL_ID_PATTERN.match(model_id), model_id
        assert set(entry) <= {"limits", "capabilities"}, model_id
        for key, value in entry.get("limits", {}).items():
            assert key in _LIMIT_KEYS, f"{model_id}.limits.{key}"
            assert isinstance(value, int) and value > 0, f"{model_id}.limits.{key}"
        for key, value in entry.get("capabilities", {}).items():
            if key == "promptCaching":
                assert value in _PROMPT_CACHING_VALUES, f"{model_id}.{key}"
            elif key == "reasoning":
                assert set(value) == {"defaultEffort"}, f"{model_id}.capabilities.reasoning"
                assert value["defaultEffort"] in _EFFORT_VALUES, f"{model_id}.capabilities.reasoning.defaultEffort"
            else:
                assert key in _BOOLEAN_CAPABILITY_KEYS, f"{model_id}.capabilities.{key}"
                assert isinstance(value, bool), f"{model_id}.{key}"
