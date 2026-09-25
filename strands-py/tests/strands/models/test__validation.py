"""Tests for model validation helper functions."""

import pytest

from strands.models._validation import _has_location_source, validate_region


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

    def test_audio_with_location_source(self):
        """Test detection of location source in audio content."""
        content = {"audio": {"source": {"location": {"type": "s3", "uri": "s3://bucket/key"}}}}
        assert _has_location_source(content)

    def test_audio_with_bytes_source(self):
        """Test that bytes source is not detected as location."""
        content = {"audio": {"source": {"bytes": b"data"}}}
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

    def test_audio_without_source(self):
        """Test that audio without source is not detected as location."""
        content = {"audio": {"format": "wav"}}
        assert not _has_location_source(content)
