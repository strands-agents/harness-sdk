"""Tests for model metadata lookup tables."""

from strands.models._defaults import get_context_window_limit, resolve_config_metadata


class TestGetContextWindowLimit:
    """Tests for get_context_window_limit."""

    def test_known_anthropic_direct_api(self):
        assert get_context_window_limit("claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("claude-opus-4-6") == 1_000_000
        assert get_context_window_limit("claude-opus-4-5") == 200_000
        assert get_context_window_limit("claude-haiku-4-5") == 200_000

    def test_known_bedrock_anthropic(self):
        assert get_context_window_limit("anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("anthropic.claude-haiku-4-5-20251001-v1:0") == 200_000

    def test_known_anthropic_current_generation(self):
        # Guards against the 1M-context 5.5 / 5.1 models resolving to None (#4692),
        # which silently disables proactive compression and reports a wrong utilization.
        assert get_context_window_limit("claude-sonnet-5-5") == 1_000_000
        assert get_context_window_limit("claude-opus-5-5") == 1_000_000
        assert get_context_window_limit("claude-fable-5-1") == 1_000_000
        assert get_context_window_limit("anthropic.claude-sonnet-5-5") == 1_000_000
        assert get_context_window_limit("anthropic.claude-opus-5-5") == 1_000_000
        assert get_context_window_limit("anthropic.claude-fable-5-1") == 1_000_000
        assert get_context_window_limit("global.anthropic.claude-opus-5-5") == 1_000_000
        assert get_context_window_limit("us.anthropic.claude-fable-5-1") == 1_000_000
        # Claude Haiku 5.5 has the same 1M window (#4996).
        assert get_context_window_limit("claude-haiku-5-5") == 1_000_000
        assert get_context_window_limit("anthropic.claude-haiku-5-5") == 1_000_000
        assert get_context_window_limit("eu.anthropic.claude-haiku-5-5") == 1_000_000
        assert get_context_window_limit("global.anthropic.claude-haiku-5-5") == 1_000_000

    def test_known_bedrock_nova(self):
        assert get_context_window_limit("amazon.nova-pro-v1:0") == 300_000
        assert get_context_window_limit("amazon.nova-micro-v1:0") == 128_000

    def test_known_bedrock_zai(self):
        # GLM-5.3 resolves to its 1M window, not the 200K default (#5300).
        assert get_context_window_limit("zai.glm-4.7") == 203_000
        assert get_context_window_limit("zai.glm-4.7-flash") == 203_000
        assert get_context_window_limit("zai.glm-5") == 200_000
        assert get_context_window_limit("zai.glm-5.3") == 1_000_000
        assert get_context_window_limit("us.zai.glm-5.3") == 1_000_000
        assert get_context_window_limit("global.zai.glm-5.3") == 1_000_000

    def test_known_bedrock_openai_gpt_oss(self):
        assert get_context_window_limit("openai.gpt-oss-120b") == 128_000
        assert get_context_window_limit("openai.gpt-oss-120b-1:0") == 128_000
        assert get_context_window_limit("openai.gpt-oss-20b") == 128_000
        assert get_context_window_limit("openai.gpt-oss-20b-1:0") == 128_000
        assert get_context_window_limit("openai.gpt-oss-safeguard-120b") == 128_000
        assert get_context_window_limit("openai.gpt-oss-safeguard-20b") == 128_000
        assert get_context_window_limit("us.openai.gpt-oss-120b-1:0") == 128_000
        assert get_context_window_limit("global.openai.gpt-oss-120b") == 128_000

    def test_known_bedrock_openai_gpt(self):
        # Bedrock GPT ids need their own rows: gpt-6.1-sol's Bedrock card is 1M, not the 1.05M of its siblings.
        assert get_context_window_limit("openai.gpt-6-astra") == 1_050_000
        assert get_context_window_limit("openai.gpt-6.1-sol") == 1_000_000
        assert get_context_window_limit("openai.gpt-6-sol") == 1_050_000
        assert get_context_window_limit("openai.gpt-6-luna") == 1_050_000
        assert get_context_window_limit("openai.gpt-5.6-sol") == 1_050_000
        assert get_context_window_limit("openai.gpt-5.6-terra") == 1_050_000
        assert get_context_window_limit("openai.gpt-5.6-luna") == 1_050_000
        assert get_context_window_limit("openai.gpt-5.5") == 1_050_000
        assert get_context_window_limit("openai.gpt-5.4") == 1_050_000
        assert get_context_window_limit("us.openai.gpt-5.5") == 1_050_000
        assert get_context_window_limit("global.openai.gpt-6.1-sol") == 1_000_000
        assert get_context_window_limit("in.openai.gpt-5.6-luna") == 1_050_000

    def test_known_bedrock_mistral(self):
        # The Bedrock ids need their own rows: the prefix strip turns
        # mistral.mistral-large-3-675b-instruct into a key that is not the direct-API mistral-large-3 row.
        assert get_context_window_limit("mistral.mistral-large-3-675b-instruct") == 256_000
        assert get_context_window_limit("mistral.ministral-3-14b-instruct") == 128_000
        assert get_context_window_limit("mistral.ministral-3-8b-instruct") == 128_000
        assert get_context_window_limit("mistral.ministral-3-3b-instruct") == 128_000
        assert get_context_window_limit("mistral.magistral-small-2509") == 128_000
        assert get_context_window_limit("mistral.pixtral-large-2502-v1:0") == 128_000
        assert get_context_window_limit("mistral.mistral-small-2402-v1:0") == 32_000
        assert get_context_window_limit("mistral.mistral-large-2402-v1:0") == 32_000
        assert get_context_window_limit("us.mistral.mistral-large-3-675b-instruct") == 256_000
        assert get_context_window_limit("global.mistral.mistral-large-3-675b-instruct") == 256_000

    def test_known_bedrock_gemma(self):
        assert get_context_window_limit("google.gemma-4-31b") == 256_000
        assert get_context_window_limit("google.gemma-4-26b-a4b") == 256_000
        assert get_context_window_limit("google.gemma-4-e2b") == 128_000
        assert get_context_window_limit("us.google.gemma-4-31b") == 256_000

    def test_known_bedrock_xai(self):
        assert get_context_window_limit("xai.grok-4.7") == 524_288
        assert get_context_window_limit("xai.grok-4.6") == 500_000
        assert get_context_window_limit("xai.grok-4.3") == 1_000_000
        assert get_context_window_limit("us.xai.grok-4.7") == 524_288
        assert get_context_window_limit("global.xai.grok-4.7") == 524_288

    def test_known_openai(self):
        assert get_context_window_limit("chat-latest") == 272_000
        assert get_context_window_limit("gpt-6-astra") == 1_050_000
        assert get_context_window_limit("gpt-6.1-sol") == 1_050_000
        assert get_context_window_limit("gpt-6-sol") == 1_050_000
        assert get_context_window_limit("gpt-6-luna") == 1_050_000
        assert get_context_window_limit("gpt-5.4") == 1_050_000
        assert get_context_window_limit("gpt-4o") == 128_000
        assert get_context_window_limit("o3") == 200_000
        assert get_context_window_limit("o4-mini") == 200_000
        assert get_context_window_limit("gpt-oss-120b") == 131_072
        assert get_context_window_limit("gpt-oss-20b") == 131_072

    def test_known_gemini(self):
        assert get_context_window_limit("gemini-4-argon") == 1_048_576
        assert get_context_window_limit("gemini-3.8-flash") == 1_048_576
        assert get_context_window_limit("gemini-3.7-flash") == 1_048_576
        assert get_context_window_limit("gemini-2.5-flash") == 1_048_576
        assert get_context_window_limit("gemini-2.5-pro") == 1_048_576

    def test_known_mistral(self):
        assert get_context_window_limit("codestral-2508") == 256_000
        assert get_context_window_limit("codestral-latest") == 256_000
        assert get_context_window_limit("mistral-large-4-0") == 1_048_576
        assert get_context_window_limit("mistral-large-4") == 1_048_576
        assert get_context_window_limit("mistral-medium-3-5") == 262_144
        assert get_context_window_limit("mistral-medium-3") == 262_144
        assert get_context_window_limit("mistral-medium-latest") == 262_144
        assert get_context_window_limit("ministral-14b-2512") == 262_144
        assert get_context_window_limit("ministral-14b-latest") == 262_144
        assert get_context_window_limit("ministral-8b-2512") == 262_144
        assert get_context_window_limit("ministral-8b-latest") == 262_144
        assert get_context_window_limit("ministral-3b-2512") == 131_072
        assert get_context_window_limit("ministral-3b-latest") == 131_072
        assert get_context_window_limit("mistral-small-2603") == 262_144
        assert get_context_window_limit("mistral-small-latest") == 262_144

    def test_strips_bedrock_cross_region_prefix(self):
        assert get_context_window_limit("us.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("global.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("eu.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("ap.anthropic.claude-sonnet-4-6") == 1_000_000

    def test_strips_nested_bedrock_prefixes(self):
        # Guards against nested Bedrock prefixes failing model metadata lookup (#4220)
        assert get_context_window_limit("us.openai.gpt-5.6") == 1_050_000
        assert get_context_window_limit("global.openai.gpt-5.6") == 1_050_000
        assert (
            get_context_window_limit("arn:aws:bedrock:eu-west-2:123456789012:inference-profile/global.openai.gpt-5.6")
            == 1_050_000
        )

    def test_strips_any_prefix_as_fallback(self):
        # Any prefix before the first dot is stripped if direct lookup fails
        assert get_context_window_limit("custom.anthropic.claude-sonnet-4-6") == 1_000_000

    def test_unknown_model_returns_none(self):
        assert get_context_window_limit("unknown-model-xyz") is None
        assert get_context_window_limit("foo.unknown-model-xyz") is None


class TestResolveConfigMetadata:
    """Tests for resolve_config_metadata."""

    def test_resolves_context_window_limit(self):
        config: dict = {"model_id": "claude-sonnet-4-6"}
        result = resolve_config_metadata(config, "claude-sonnet-4-6")
        assert result["context_window_limit"] == 1_000_000

    def test_preserves_explicit_context_window_limit(self):
        config: dict = {"model_id": "claude-sonnet-4-6", "context_window_limit": 100_000}
        result = resolve_config_metadata(config, "claude-sonnet-4-6")
        assert result["context_window_limit"] == 100_000

    def test_returns_original_config_when_explicit(self):
        config: dict = {"model_id": "claude-sonnet-4-6", "context_window_limit": 100_000}
        result = resolve_config_metadata(config, "claude-sonnet-4-6")
        assert result is config

    def test_returns_original_config_when_unknown_model(self):
        config: dict = {"model_id": "unknown-model"}
        result = resolve_config_metadata(config, "unknown-model")
        assert result is config
        assert "context_window_limit" not in result

    def test_returns_new_dict_when_resolved(self):
        config: dict = {"model_id": "claude-sonnet-4-6"}
        result = resolve_config_metadata(config, "claude-sonnet-4-6")
        assert result is not config
        assert "context_window_limit" not in config
