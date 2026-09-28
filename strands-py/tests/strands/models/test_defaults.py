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

    def test_known_bedrock_nova(self):
        assert get_context_window_limit("amazon.nova-pro-v1:0") == 300_000
        assert get_context_window_limit("amazon.nova-micro-v1:0") == 128_000

    def test_known_openai(self):
        assert get_context_window_limit("gpt-6-astra") == 1_050_000
        assert get_context_window_limit("gpt-5.4") == 1_050_000
        assert get_context_window_limit("gpt-4o") == 128_000
        assert get_context_window_limit("o3") == 200_000
        assert get_context_window_limit("o4-mini") == 200_000

    def test_known_gemini(self):
        assert get_context_window_limit("gemini-2.5-flash") == 1_048_576
        assert get_context_window_limit("gemini-2.5-pro") == 1_048_576

    def test_strips_bedrock_cross_region_prefix(self):
        assert get_context_window_limit("us.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("global.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("eu.anthropic.claude-sonnet-4-6") == 1_000_000
        assert get_context_window_limit("ap.anthropic.claude-sonnet-4-6") == 1_000_000

    def test_strips_nested_bedrock_prefixes(self):
        # Guards against nested Bedrock prefixes failing model metadata lookup (#4220)
        assert get_context_window_limit("us.openai.gpt-5.6-luna") == 1_050_000
        assert get_context_window_limit("global.openai.gpt-5.6-luna") == 1_050_000
        assert (
            get_context_window_limit(
                "arn:aws:bedrock:eu-west-2:123456789012:inference-profile/global.openai.gpt-5.6-luna"
            )
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
