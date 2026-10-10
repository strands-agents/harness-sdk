"""Tests for model validation helper functions."""

import logging

import pytest

from strands.models._validation import _has_location_source, _warn_unsupported_blocks, validate_region

S3_IMAGE = {"image": {"format": "png", "source": {"location": {"type": "s3", "uri": "s3://bucket/key.png"}}}}
CACHE_POINT = {"cachePoint": {"type": "default"}}


class TestValidateRegion:
    """Tests for the validate_region helper function."""

    @pytest.mark.parametrize("region", ["us-east-1", "ap-southeast-1", "us-gov-east-1", "eu-central-1"])
    def test_well_formed_region_is_returned(self, region):
        """A well-formed region is accepted and returned unchanged."""
        assert validate_region(region) == region

    @pytest.mark.parametrize(
        "region",
        [
            "x@attacker.com:443/#",  # URL control characters redirecting the host
            "us-east-1\n",  # trailing newline
            "\nus-east-1",  # leading newline
            "us-east-1/",  # trailing path separator
            "US-EAST-1",  # uppercase
            "useast1",  # missing separators
            "us-east",  # missing numeric suffix
            "us-east-١",  # non-ASCII (Arabic-Indic) digit
            "us-éast-1",  # non-ASCII letter
            "",  # empty
        ],
    )
    def test_malformed_region_is_rejected(self, region):
        """A malformed region is rejected before it can reach an endpoint URL."""
        with pytest.raises(ValueError, match="invalid AWS region"):
            validate_region(region)

    def test_non_string_region_is_rejected(self):
        """A non-string region is rejected rather than raising an opaque error later."""
        with pytest.raises(ValueError, match="invalid AWS region"):
            validate_region(None)  # type: ignore[arg-type]


class TestHasLocationSource:
    """Tests for _has_location_source helper function."""

    def test_image_with_location_source(self):
        """Test detection of location source in image content."""
        content = {"image": {"source": {"location": {"type": "s3", "uri": "s3://bucket/key"}}}}
        assert _has_location_source(content)

    def test_image_with_bytes_source(self):
        """Test that bytes source is not detected as location."""
        content = {"image": {"source": {"bytes": b"data"}}}
        assert not _has_location_source(content)

    def test_document_with_location_source(self):
        """Test detection of location source in document content."""
        content = {"document": {"source": {"location": {"type": "s3", "uri": "s3://bucket/key"}}}}
        assert _has_location_source(content)

    def test_document_with_bytes_source(self):
        """Test that bytes source is not detected as location."""
        content = {"document": {"source": {"bytes": b"data"}}}
        assert not _has_location_source(content)

    def test_video_with_location_source(self):
        """Test detection of location source in video content."""
        content = {"video": {"source": {"location": {"type": "s3", "uri": "s3://bucket/key"}}}}
        assert _has_location_source(content)

    def test_video_with_bytes_source(self):
        """Test that bytes source is not detected as location."""
        content = {"video": {"source": {"bytes": b"data"}}}
        assert not _has_location_source(content)

    def test_text_content(self):
        """Test that text content is not detected as location source."""
        content = {"text": "hello"}
        assert not _has_location_source(content)

    def test_tool_use_content(self):
        """Test that toolUse content is not detected as location source."""
        content = {"toolUse": {"name": "test", "input": {}, "toolUseId": "123"}}
        assert not _has_location_source(content)

    def test_tool_result_content(self):
        """Test that toolResult content is not detected as location source."""
        content = {"toolResult": {"toolUseId": "123", "content": [{"text": "result"}]}}
        assert not _has_location_source(content)

    def test_image_without_source(self):
        """Test that image without source is not detected as location."""
        content = {"image": {"format": "png"}}
        assert not _has_location_source(content)

    def test_document_without_source(self):
        """Test that document without source is not detected as location."""
        content = {"document": {"format": "pdf", "name": "test.pdf"}}
        assert not _has_location_source(content)

    def test_video_without_source(self):
        """Test that video without source is not detected as location."""
        content = {"video": {"format": "mp4"}}
        assert not _has_location_source(content)


class TestWarnUnsupportedBlocks:
    """Tests for the _warn_unsupported_blocks helper function."""

    def test_warns_once_per_block_type_across_history(self, caplog):
        logger = logging.getLogger("test.provider")
        caplog.set_level(logging.WARNING, logger="test.provider")
        messages = [{"role": "user", "content": [{"text": "q"}, S3_IMAGE, CACHE_POINT]}] * 3

        _warn_unsupported_blocks(messages, "TestProvider", logger, cache_point=True)

        tru_messages = [record.getMessage() for record in caplog.records]
        exp_messages = [
            "Location sources are not supported by TestProvider | skipping content block",
            "cachePoint content block is not supported by TestProvider | skipping",
        ]
        assert tru_messages == exp_messages
        assert {record.name for record in caplog.records} == {"test.provider"}

    def test_skips_cache_point_warning_unless_requested(self, caplog):
        caplog.set_level(logging.WARNING, logger="test.provider")
        messages = [{"role": "user", "content": [CACHE_POINT]}]

        _warn_unsupported_blocks(messages, "TestProvider", logging.getLogger("test.provider"))

        assert caplog.records == []

    def test_does_not_warn_for_supported_blocks(self, caplog):
        caplog.set_level(logging.WARNING, logger="test.provider")
        messages = [{"role": "user", "content": [{"text": "q"}, {"image": {"source": {"bytes": b"data"}}}]}]

        _warn_unsupported_blocks(messages, "TestProvider", logging.getLogger("test.provider"), cache_point=True)

        assert caplog.records == []


def _openai_model():
    from strands.models.openai import OpenAIModel

    return OpenAIModel(client_args={"api_key": "unused"}, model_id="m")


def _openai_responses_model():
    from strands.models.openai_responses import OpenAIResponsesModel

    return OpenAIResponsesModel(client_args={"api_key": "unused"}, model_id="m")


def _anthropic_model():
    from strands.models.anthropic import AnthropicModel

    return AnthropicModel(client_args={"api_key": "unused"}, model_id="m", max_tokens=1)


def _gemini_model():
    from strands.models.gemini import GeminiModel

    return GeminiModel(client_args={"api_key": "unused"}, model_id="m")


def _mistral_model():
    from strands.models.mistral import MistralModel

    return MistralModel(api_key="unused", model_id="m")


def _ollama_model():
    from strands.models.ollama import OllamaModel

    return OllamaModel(host="http://localhost:1", model_id="m")


def _llamacpp_model():
    from strands.models.llamacpp import LlamaCppModel

    return LlamaCppModel()


def _llamaapi_model():
    from strands.models.llamaapi import LlamaAPIModel

    return LlamaAPIModel(client_args={"api_key": "unused"}, model_id="m")


def _writer_model():
    from strands.models.writer import WriterModel

    return WriterModel(client_args={"api_key": "unused"}, model_id="m")


@pytest.mark.parametrize(
    ("make_model", "format_messages", "blocks"),
    [
        (_openai_model, lambda model, messages: model.format_request(messages), [S3_IMAGE, CACHE_POINT]),
        (
            _openai_responses_model,
            lambda model, messages: model._format_request_messages(messages),
            [S3_IMAGE, CACHE_POINT],
        ),
        (_anthropic_model, lambda model, messages: model.format_request(messages), [S3_IMAGE]),
        (_gemini_model, lambda model, messages: model._format_request_content(messages), [S3_IMAGE, CACHE_POINT]),
        (_mistral_model, lambda model, messages: model.format_request(messages), [S3_IMAGE, CACHE_POINT]),
        (_ollama_model, lambda model, messages: model.format_request(messages), [S3_IMAGE]),
        (_llamacpp_model, lambda model, messages: model._format_request(messages), [S3_IMAGE]),
        (_llamaapi_model, lambda model, messages: model.format_request(messages), [S3_IMAGE]),
        (_writer_model, lambda model, messages: model.format_request(messages), [S3_IMAGE]),
    ],
)
def test_providers_warn_once_per_request_for_unsupported_blocks(make_model, format_messages, blocks, caplog):
    """Each unsupported block type logs once per request however long the history is (#5020)."""
    model = make_model()
    caplog.set_level(logging.WARNING)
    messages = []
    for turn in range(3):
        messages.append({"role": "user", "content": [{"text": f"question {turn}"}, *blocks]})
        messages.append({"role": "assistant", "content": [{"text": f"answer {turn}"}]})

    format_messages(model, messages)

    tru_count = sum("not supported by" in record.getMessage() for record in caplog.records)
    exp_count = len(blocks)
    assert tru_count == exp_count
