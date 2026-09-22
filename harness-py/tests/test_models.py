import pytest
from strands.models import BedrockModel, CacheConfig, Model, ModelRouter

from strands_harness.models import (
    _claude_extended_thinking,
    _supports_media,
    resolve_model,
    supports_thinking,
    supports_web_search,
)

DEFAULT = "bedrock/global.anthropic.claude-opus-4-8"


def resolve(model, effort="auto", web_search=False, caching=False, caching_explicit=False):
    return resolve_model(
        model, DEFAULT, effort, web_search=web_search, caching=caching, caching_explicit=caching_explicit
    )


def test_none_resolves_to_default_with_thinking():
    model = resolve(None)
    assert isinstance(model, BedrockModel)
    assert model.config["model_id"] == "global.anthropic.claude-opus-4-8"
    assert model.config["additional_request_fields"] == {
        "thinking": {"type": "adaptive", "display": "summarized"},
        "output_config": {"effort": "high"},
    }


def test_bare_string_is_bedrock_model_id():
    model = resolve("my.custom.model-id")
    assert isinstance(model, BedrockModel)
    assert model.config["model_id"] == "my.custom.model-id"


def test_model_instance_passes_through_untouched():
    instance = BedrockModel(model_id="anything")
    assert resolve(instance) is instance


def test_model_router_passes_through_untouched():
    router = ModelRouter([BedrockModel(model_id="fast"), BedrockModel(model_id="deep")])
    assert resolve(router) is router


def test_bedrock_uses_model_id_directly():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8")
    assert model.config["model_id"] == "global.anthropic.claude-opus-4-8"


def test_bedrock_name_passes_through():
    model = resolve("bedrock/some.other.model")
    assert model.config["model_id"] == "some.other.model"


def test_bedrock_enables_prompt_caching_when_requested():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", caching=True)
    assert model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_bedrock_caching_enabled_with_effort_off():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", effort="off", caching=True)
    assert model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_bedrock_no_caching_when_off():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", caching=False)
    assert "cache_config" not in model.config
    assert "cache_tools" not in model.config


@pytest.mark.parametrize("prefix", ["", "us."])
def test_claude_3_haiku_disables_automatic_caching(prefix):
    spec = f"bedrock/{prefix}anthropic.claude-3-haiku-20240307-v1:0"
    model = resolve(spec, caching=True)
    assert "cache_config" not in model.config
    with pytest.raises(ValueError, match="does not support prompt caching"):
        resolve(spec, caching=True, caching_explicit=True)


def test_anthropic_direct_enables_prompt_caching_when_requested():
    model = resolve("anthropic/claude-opus-4-8", caching=True)
    assert model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_anthropic_direct_no_caching_when_off():
    model = resolve("anthropic/claude-opus-4-8", caching=False)
    assert "cache_config" not in model.config
    assert "cache_tools" not in model.config


def test_explicit_caching_on_supported_provider_builds():
    model = resolve("openai/gpt-5.6-sol", caching=True, caching_explicit=True)
    assert model is not None


def test_explicit_caching_on_model_instance_warns_and_builds(caplog):
    import logging

    instance = BedrockModel(model_id="anything")
    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        model = resolve(instance, caching=True, caching_explicit=True)
    assert model is instance
    assert any("pre-built Model instance" in r.message for r in caplog.records)


def test_default_caching_on_model_instance_warns_and_builds(caplog):
    import logging

    instance = BedrockModel(model_id="anything")
    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        model = resolve(instance, caching=True, caching_explicit=False)
    assert model is instance
    assert any("pre-built Model instance" in r.message for r in caplog.records)


def test_caching_supported_provider_does_not_warn(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        resolve("openai/gpt-5.6-sol", caching=True, caching_explicit=True)
    assert not any("prompt caching not supported" in r.message for r in caplog.records)


def test_explicit_caching_on_litellm_builds():
    model = resolve("litellm/gpt-4o", caching=True, caching_explicit=True)
    assert model is not None
    assert "cache_config" not in model.config


def test_litellm_caching_does_not_warn(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        resolve("litellm/gpt-4o", caching=True, caching_explicit=False)
    assert not any("prompt caching not supported" in r.message for r in caplog.records)


def test_effort_off_leaves_provider_defaults():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", effort="off")
    assert model.config.get("additional_request_fields") is None


@pytest.mark.parametrize("effort", [None, True, "turbo"])
def test_unknown_effort_rejected_even_for_model_instances(effort):
    with pytest.raises(ValueError, match="Unknown effort"):
        resolve(BedrockModel(model_id="anything"), effort=effort)


def test_explicit_effort_on_model_instance_warns_and_builds(caplog):
    import logging

    instance = BedrockModel(model_id="anything")
    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        model = resolve(instance, effort="low")
    assert model is instance
    assert any("effort='low' not applied" in r.message for r in caplog.records)


def test_effort_explicit_level():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", effort="low")
    assert model.config["additional_request_fields"]["output_config"]["effort"] == "low"


def test_bedrock_accepts_provider_specific_level():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8", effort="max")
    assert model.config["additional_request_fields"]["output_config"]["effort"] == "max"


def test_openai_on_bedrock_maps_effort_to_reasoning_effort():
    model = resolve("bedrock/us.openai.gpt-5.6-luna", effort="max")
    assert model.config["additional_request_fields"] == {"reasoning": {"effort": "max"}}


@pytest.mark.parametrize("model_id", ["openai.gpt-6-astra", "global.openai.gpt-6-astra", "us.openai.gpt-6-astra"])
def test_astra_on_bedrock_resolves_effort(model_id):
    for effort, level in [("auto", "high"), ("low", "low"), ("max", "max"), ("off", "none")]:
        model = resolve(f"bedrock/{model_id}", effort=effort)
        assert model.config["additional_request_fields"] == {"reasoning": {"effort": level}}
    with pytest.raises(ValueError, match="not supported"):
        resolve(f"bedrock/{model_id}", effort="minimal")


def test_gpt_oss_on_bedrock_uses_its_reasoning_field_and_levels():
    model = resolve("bedrock/openai.gpt-oss-120b-1:0", effort="medium")
    assert model.config["additional_request_fields"] == {"reasoning_effort": "medium"}
    # No ``none`` level: off drops the reasoning block instead.
    assert "additional_request_fields" not in resolve("bedrock/openai.gpt-oss-120b-1:0", effort="off").config
    with pytest.raises(ValueError, match="not supported by Bedrock model openai.gpt-oss-120b-1:0"):
        resolve("bedrock/openai.gpt-oss-120b-1:0", effort="max")


def test_qwen_on_bedrock_uses_its_reasoning_field_and_levels():
    model = resolve("bedrock/qwen.qwen3-32b-v1:0", effort="minimal")
    assert model.config["additional_request_fields"] == {"reasoning_effort": "minimal"}
    assert resolve("bedrock/qwen.qwen3-32b-v1:0", effort="off").config["additional_request_fields"] == {
        "reasoning_effort": "none"
    }
    regional = resolve("bedrock/us.qwen.qwen3-32b-v1:0", effort="high")
    assert regional.config["additional_request_fields"] == {"reasoning_effort": "high"}
    with pytest.raises(ValueError, match="Unknown effort 'bogus'"):
        resolve("bedrock/qwen.qwen3-32b-v1:0", effort="bogus")


def test_xai_grok_on_bedrock_uses_its_reasoning_field_and_levels():
    model = resolve("bedrock/us.xai.grok-4.6", effort="xhigh")
    assert model.config["additional_request_fields"] == {"reasoning_effort": "xhigh"}
    automatic = resolve("bedrock/us.xai.grok-4.6", effort="auto")
    assert automatic.config["additional_request_fields"] == {"reasoning_effort": "high"}
    with pytest.raises(ValueError, match="not supported by Bedrock model us.xai.grok-4.6"):
        resolve("bedrock/us.xai.grok-4.6", effort="max")


def test_unknown_bedrock_family_does_not_get_claude_thinking_fields():
    model = resolve("bedrock/amazon.nova-pro-v1:0")
    assert "additional_request_fields" not in model.config


def test_unknown_bedrock_family_rejects_explicit_effort():
    with pytest.raises(ValueError, match="not supported by Bedrock model.*Pass 'auto' or 'off'"):
        resolve("bedrock/amazon.nova-pro-v1:0", effort="high")
    assert "additional_request_fields" not in resolve("bedrock/amazon.nova-pro-v1:0", effort="off").config


def test_level_rejected_when_provider_does_not_support_it():
    with pytest.raises(ValueError, match="not supported by this provider"):
        resolve("google/gemini-3.5-flash", effort="xhigh")
    with pytest.raises(ValueError, match="not supported by this provider"):
        resolve("openai/gpt-5.6-sol", effort="max")


def test_bogus_level_rejected():
    with pytest.raises(ValueError, match="Unknown effort 'turbo'. Choose one of: auto, off, minimal"):
        resolve("bedrock/global.anthropic.claude-opus-4-8", effort="turbo")


def test_unsupported_level_names_the_supported_set():
    with pytest.raises(ValueError, match="Supported levels: low, medium, high, xhigh, max \\(or 'auto', 'off'\\)"):
        resolve("bedrock/global.anthropic.claude-opus-4-8", effort="minimal")


def test_unknown_provider_raises():
    with pytest.raises(ValueError, match="Unknown model provider"):
        resolve("mistral/whatever")


def test_gemini_prefix_is_not_a_provider():
    with pytest.raises(ValueError, match="Unknown model provider"):
        resolve("gemini/gemini-3.5-flash")


def test_google_auto_maps_to_high_thinking_level():
    model = resolve("google/gemini-3.5-flash")
    assert isinstance(model, Model)
    assert model.config["params"]["thinking_config"]["thinking_level"] == "high"


def test_google_uses_model_id_directly():
    model = resolve("google/gemini-3.5-flash", effort="off")
    assert model.config["model_id"] == "gemini-3.5-flash"
    # Gemini has no ``none`` level: off drops the thinking config.
    assert "params" not in model.config


def test_openai_maps_to_reasoning_effort():
    model = resolve("openai/gpt-5.6-sol")
    assert isinstance(model, Model)
    assert model.config["params"]["reasoning"]["effort"] == "high"


def test_anthropic_maps_to_thinking_and_max_tokens():
    model = resolve("anthropic/claude-opus-4-8")
    assert model.config["model_id"] == "claude-opus-4-8"
    assert model.config["max_tokens"] == 128_000
    assert model.config["params"]["thinking"] == {"type": "adaptive", "display": "summarized"}


def test_anthropic_haiku_gets_its_own_tier_max_tokens():
    model = resolve("anthropic/claude-haiku-4-5-20251001")
    assert model.config["max_tokens"] == 64_000


def test_anthropic_unrecognized_tier_falls_back_to_flat_max_tokens():
    model = resolve("anthropic/claude-mythos-1")
    assert model.config["max_tokens"] == 32_000


def test_bedrock_claude_gets_tier_max_tokens():
    model = resolve("bedrock/global.anthropic.claude-opus-4-8")
    assert model.config["max_tokens"] == 128_000


def test_bedrock_claude_haiku_gets_its_own_tier_max_tokens():
    model = resolve("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0")
    assert model.config["max_tokens"] == 64_000


def test_bedrock_non_claude_model_has_no_forced_max_tokens():
    model = resolve("bedrock/amazon.nova-pro-v1:0")
    assert "max_tokens" not in model.config


def test_bedrock_legacy_claude_3_id_has_no_forced_max_tokens():
    model = resolve("bedrock/anthropic.claude-3-haiku-20240307-v1:0")
    assert "max_tokens" not in model.config


def test_bedrock_mantle_builds_via_openai_responses_model():
    from strands.models.openai_responses import OpenAIResponsesModel

    model = resolve("bedrock-mantle/openai.gpt-oss-120b")
    assert isinstance(model, OpenAIResponsesModel)
    assert model.config["model_id"] == "openai.gpt-oss-120b"
    assert model.config["params"]["reasoning"]["effort"] == "high"


def test_bedrock_mantle_caching_does_not_warn(caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="strands_harness.models"):
        resolve("bedrock-mantle/openai.gpt-oss-120b", caching=True, caching_explicit=False)
    assert not any("prompt caching not supported" in r.message for r in caplog.records)


def test_bedrock_mantle_rejects_an_unsupported_thinking_level():
    with pytest.raises(ValueError, match="not supported by this provider"):
        resolve("bedrock-mantle/openai.gpt-oss-120b", effort="max")


@pytest.mark.parametrize(
    "model_id", ["openai.gpt-5.6-luna", "openai.gpt-6-astra", "openai.gpt-oss-120b", "qwen.qwen3-32b-v1:0"]
)
def test_bedrock_mantle_never_adds_native_web_search_tools(model_id):
    model = resolve(f"bedrock-mantle/{model_id}", effort="off", web_search=True)
    assert model.config["params"] == {"reasoning": {"effort": "none"}}


def test_bedrock_mantle_no_web_search_has_no_tools():
    model = resolve("bedrock-mantle/openai.gpt-5.6-luna", web_search=False)
    assert "tools" not in model.config["params"]


def test_supports_web_search_by_provider():
    assert supports_web_search("openai/gpt-5.6-sol") is True
    assert supports_web_search("google/gemini-3.5-flash") is True
    assert supports_web_search("bedrock-mantle/openai.gpt-5.6-luna") is False
    assert supports_web_search("bedrock-mantle/openai.gpt-6-astra") is False
    assert supports_web_search("bedrock-mantle/openai.gpt-oss-120b") is False
    assert supports_web_search("bedrock-mantle/qwen.qwen3-32b-v1:0") is False
    assert supports_web_search("bedrock/global.anthropic.claude-opus-4-8") is False
    assert supports_web_search("anthropic/claude-opus-4-8") is True


def test_supports_web_search_none_uses_default_provider():
    assert supports_web_search(None) is False


def test_supports_web_search_model_instance_is_false():
    assert supports_web_search(BedrockModel(model_id="anything")) is False


def test_openai_web_search_adds_tool_alongside_reasoning():
    model = resolve("openai/gpt-5.6-sol", web_search=True)
    assert model.config["params"]["reasoning"]["effort"] == "high"
    assert model.config["params"]["tools"] == [{"type": "web_search"}]


def test_openai_web_search_with_effort_off():
    model = resolve("openai/gpt-5.6-sol", effort="off", web_search=True)
    assert model.config["params"]["tools"] == [{"type": "web_search"}]
    assert model.config["params"]["reasoning"] == {"effort": "none"}


def test_openai_no_web_search_has_no_tools():
    model = resolve("openai/gpt-5.6-sol", web_search=False)
    assert "tools" not in model.config["params"]


def test_google_web_search_adds_google_search_tool():
    from google.genai import types as genai_types

    model = resolve("google/gemini-3.5-flash", web_search=True)
    tools = model.config["gemini_tools"]
    assert tools == [genai_types.Tool(google_search=genai_types.GoogleSearch())]


def test_google_no_web_search_has_no_gemini_tools():
    model = resolve("google/gemini-3.5-flash", web_search=False)
    assert "gemini_tools" not in model.config


def test_anthropic_web_search_adds_direct_server_tool():
    model = resolve("anthropic/claude-opus-4-8", web_search=True)
    assert model.config["anthropic_tools"] == [
        {"type": "web_search_20260318", "name": "web_search", "allowed_callers": ["direct"]}
    ]
    assert "anthropic_tools" not in resolve("anthropic/claude-opus-4-8").config


HAIKU_ON_BEDROCK = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"

ADAPTIVE = {
    "thinking": {"type": "adaptive", "display": "summarized"},
    "output_config": {"effort": "high"},
}

EXTENDED = {"thinking": {"type": "enabled", "budget_tokens": 16_384}}

EXTENDED_CLAUDE = [
    "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-haiku-4-5-20251001-v1:0",
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "global.anthropic.claude-opus-4-5-20251101-v1:0",
]

NO_THINKING_CLAUDE = [
    "us.anthropic.claude-opus-4-1-20250805-v1:0",
    "global.anthropic.claude-sonnet-4-20250514-v1:0",
    "anthropic.claude-opus-4-20250514-v1:0",
    "us.anthropic.claude-3-haiku-20240307-v1:0",
    "us.anthropic.claude-3-sonnet-20240229-v1:0",
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3.5-sonnet-20241022-v2:0",
    "anthropic.claude-3-7-sonnet-20250219-v1:0",
]
ADAPTIVE_CLAUDE = [
    "global.anthropic.claude-opus-4-6-v1",
    "global.anthropic.claude-sonnet-4-6",
    "global.anthropic.claude-opus-4-7",
    "global.anthropic.claude-opus-4-8",
    "global.anthropic.claude-opus-5",
    "global.anthropic.claude-sonnet-5",
    "global.anthropic.claude-fable-5",
    "global.anthropic.claude-fable-5-1",
    "anthropic.claude-mythos-preview",
    "anthropic.claude-mythos-5-1",
]


@pytest.mark.parametrize("model_id", NO_THINKING_CLAUDE)
def test_claude_below_the_thinking_floor_gets_no_block(model_id):
    assert "additional_request_fields" not in resolve(f"bedrock/{model_id}").config


@pytest.mark.parametrize("model_id", EXTENDED_CLAUDE)
def test_claude_on_the_4_5_tier_gets_an_extended_block(model_id):
    assert resolve(f"bedrock/{model_id}").config["additional_request_fields"] == EXTENDED


@pytest.mark.parametrize("model_id", ADAPTIVE_CLAUDE)
def test_claude_with_adaptive_thinking_gets_the_block(model_id):
    assert resolve(f"bedrock/{model_id}").config["additional_request_fields"] == ADAPTIVE


def test_claude_below_the_thinking_floor_rejects_an_explicit_level_locally():
    with pytest.raises(ValueError, match="not supported by Bedrock model"):
        resolve("bedrock/us.anthropic.claude-3-haiku-20240307-v1:0", effort="high")


def test_claude_without_adaptive_thinking_keeps_max_tokens_and_caching():
    model = resolve(HAIKU_ON_BEDROCK, caching=True)
    assert model.config["max_tokens"] == 64000
    assert model.config["cache_config"] == CacheConfig(strategy="auto", tools_ttl=True)


def test_anthropic_direct_haiku_sends_extended_thinking_params(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert resolve("anthropic/claude-haiku-4-5-20251001").config["params"] == EXTENDED


def test_anthropic_direct_below_the_floor_sends_no_thinking_params(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert "params" not in resolve("anthropic/claude-3-haiku-20240307").config


def test_an_unrecognized_claude_family_defaults_to_adaptive():
    model = resolve("bedrock/global.anthropic.claude-quasar-6")
    assert model.config["additional_request_fields"]["thinking"] == {
        "type": "adaptive",
        "display": "summarized",
    }


def test_a_non_claude_bedrock_model_sends_no_thinking_block():
    assert "additional_request_fields" not in resolve("bedrock/amazon.nova-pro-v1:0").config


@pytest.mark.parametrize(
    ("model_id", "expected"),
    [
        ("claude-opus-4.8", ADAPTIVE),
        ("claude-sonnet-4.6", ADAPTIVE),
        ("claude-opus-4.5", EXTENDED),
        ("claude-haiku-4.5", EXTENDED),
        ("claude-opus-4.1", None),
    ],
)
def test_a_dot_separated_version_parses_like_a_dashed_one(model_id, expected):
    config = resolve(f"bedrock/global.anthropic.{model_id}").config
    assert config.get("additional_request_fields") == expected


@pytest.mark.parametrize("model_id", ["claude-opus-latest", "claude-sonnet-latest", "claude-opus-100"])
def test_an_id_with_no_parsable_version_fails_open_to_adaptive(model_id):
    assert resolve(f"bedrock/global.anthropic.{model_id}").config["additional_request_fields"] == ADAPTIVE


@pytest.mark.parametrize(
    ("level", "budget"),
    [("low", 2_048), ("medium", 8_192), ("high", 16_384), ("xhigh", 32_768), ("max", 49_152)],
)
def test_each_level_maps_to_a_budget_the_api_accepts(level, budget):
    config = resolve(HAIKU_ON_BEDROCK, effort=level).config
    assert config["additional_request_fields"] == {"thinking": {"type": "enabled", "budget_tokens": budget}}
    assert budget < config["max_tokens"]


@pytest.mark.parametrize(
    ("model_id", "max_tokens"),
    [
        ("claude-sonnet-4-5-20250929-v1:0", 64_000),
        ("claude-sonnet-4.5", 64_000),
        ("claude-sonnet-4-6", 128_000),
        ("claude-sonnet-4.6", 128_000),
        ("claude-sonnet-5", 128_000),
        ("claude-opus-4-5-20251101-v1:0", 64_000),
        ("claude-opus-4.5", 64_000),
        ("claude-opus-4-8", 128_000),
        ("claude-opus-5", 128_000),
    ],
)
def test_a_split_family_carries_its_version_max_tokens_ceiling(model_id, max_tokens):
    assert resolve(f"bedrock/global.anthropic.{model_id}").config["max_tokens"] == max_tokens


@pytest.mark.parametrize("model_id", ["claude-haiku-latest", "claude-haiku"])
def test_a_versionless_haiku_falls_open_to_extended_not_adaptive(model_id):
    config = resolve(f"bedrock/global.anthropic.{model_id}").config
    assert config["additional_request_fields"] == EXTENDED


def test_the_budget_is_clamped_below_a_small_max_tokens():
    assert _claude_extended_thinking("max", 4_096) == {"thinking": {"type": "enabled", "budget_tokens": 4_095}}
    assert _claude_extended_thinking("low", 64_000) == {"thinking": {"type": "enabled", "budget_tokens": 2_048}}


def test_a_bare_family_name_clamps_against_the_anthropic_direct_fallback(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    config = resolve("anthropic/claude-haiku", effort="max").config
    assert config["max_tokens"] == 32_000
    assert config["params"] == {"thinking": {"type": "enabled", "budget_tokens": 31_999}}


def test_supports_thinking_answers_for_consumers():
    assert supports_thinking("bedrock/global.anthropic.claude-opus-4-8") is True
    assert supports_thinking("bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0") is True
    assert supports_thinking("anthropic/claude-haiku-4-5-20251001") is True
    assert supports_thinking("bedrock/us.anthropic.claude-3-haiku-20240307-v1:0") is False
    assert supports_thinking("anthropic/claude-3-haiku-20240307") is False
    assert supports_thinking("ollama/llama3") is False
    assert supports_thinking(None) is True


@pytest.mark.parametrize(
    "model_id",
    [
        "amazon.nova-pro-v1:0",
        "us.amazon.nova-pro-v1:0",
        "meta.llama3-3-70b-instruct-v1:0",
        "deepseek.r1-v1:0",
        "mistral.mistral-large-2407-v1:0",
    ],
)
def test_a_bedrock_family_without_thinking_reports_none(model_id):
    assert supports_thinking(f"bedrock/{model_id}") is False
    with pytest.raises(ValueError, match="not supported by Bedrock model"):
        resolve(f"bedrock/{model_id}", effort="high")


@pytest.mark.parametrize("prefix", ["", "global.", "apac.", "us.", "eu.", "au.", "jp."])
def test_every_cross_region_prefix_resolves_the_claude_family(prefix):
    model_id = f"bedrock/{prefix}anthropic.claude-opus-4-8"
    assert supports_thinking(model_id) is True
    assert resolve(model_id, effort="max").config["additional_request_fields"]["output_config"] == {"effort": "max"}


def test_an_unsupported_level_on_anthropic_direct_names_the_model_not_the_provider():
    with pytest.raises(ValueError, match="model claude-3-haiku-20240307"):
        resolve("anthropic/claude-3-haiku-20240307", effort="max")


def test_supports_media_is_false_for_openai_on_bedrock_converse():
    assert _supports_media("bedrock/us.openai.gpt-6-astra") is False
    assert _supports_media("bedrock/openai.gpt-5.6-sol") is False
    assert _supports_media("bedrock/global.anthropic.claude-opus-4-8") is True
    assert _supports_media("anthropic/claude-haiku-4-5-20251001") is True
    assert _supports_media("bedrock-mantle/openai.gpt-6-astra") is True
    assert _supports_media(None) is True


def test_bedrock_web_fetch_summarizer_keeps_the_inference_profile_prefix():
    from strands_harness.models import _bedrock_web_fetch_model

    assert _bedrock_web_fetch_model("us.openai.gpt-6-astra") == "us.openai.gpt-5.6-luna"
    assert _bedrock_web_fetch_model("global.openai.gpt-5.6-sol") == "global.openai.gpt-5.6-luna"
    assert _bedrock_web_fetch_model("openai.gpt-5.6-sol") == "openai.gpt-5.6-luna"
    assert _bedrock_web_fetch_model("us.anthropic.claude-opus-4-8") == (
        "global.anthropic.claude-haiku-4-5-20251001-v1:0"
    )
    assert _bedrock_web_fetch_model("meta.llama3") is None


def test_supports_media_reads_a_bedrock_instance_model_id():
    from strands.models import BedrockModel

    assert _supports_media(BedrockModel(model_id="global.anthropic.claude-opus-4-8")) is True
    assert _supports_media(BedrockModel(model_id="us.openai.gpt-6-astra")) is False


def test_supports_media_requires_every_router_candidate_to_support_it():
    from strands.models import BedrockModel, ModelRouter

    capable = ModelRouter([BedrockModel(model_id="global.anthropic.claude-opus-4-8")])
    assert _supports_media(capable) is True

    mixed = ModelRouter(
        [
            BedrockModel(model_id="global.anthropic.claude-opus-4-8"),
            BedrockModel(model_id="us.openai.gpt-6-astra"),
        ]
    )
    assert _supports_media(mixed) is False
