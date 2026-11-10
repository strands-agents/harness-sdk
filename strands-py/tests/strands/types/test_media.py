"""Tests for media type definitions."""

import pytest

from strands.types.media import (
    AudioBlock,
    DocumentSource,
    ImageBlock,
    ImageSource,
    S3Location,
    VideoSource,
)


@pytest.mark.parametrize(
    ("block", "exp_content"),
    [
        (
            AudioBlock(format="pcm", source={"bytes": b"\x00\xff"}),
            {"audio": {"format": "pcm", "source": {"bytes": b"\x00\xff"}}},
        ),
        (
            ImageBlock(format="jpeg", source={"bytes": b"\xff\xd8"}),
            {"image": {"format": "jpeg", "source": {"bytes": b"\xff\xd8"}}},
        ),
    ],
)
def test_block_to_dict(block, exp_content):
    tru_content = block.to_dict()
    assert tru_content == exp_content


class TestS3Location:
    """Tests for S3Location TypedDict."""

    def test_s3_location_with_uri_only(self):
        """Test S3Location with only uri field."""
        s3_loc: S3Location = {"uri": "s3://my-bucket/path/to/file.pdf"}

        assert s3_loc["uri"] == "s3://my-bucket/path/to/file.pdf"
        assert "bucketOwner" not in s3_loc

    def test_s3_location_with_bucket_owner(self):
        """Test S3Location with both uri and bucketOwner fields."""
        s3_loc: S3Location = {
            "uri": "s3://my-bucket/path/to/file.pdf",
            "bucketOwner": "123456789012",
        }

        assert s3_loc["uri"] == "s3://my-bucket/path/to/file.pdf"
        assert s3_loc["bucketOwner"] == "123456789012"


class TestDocumentSource:
    """Tests for DocumentSource TypedDict."""

    def test_document_source_with_bytes(self):
        """Test DocumentSource with bytes content."""
        doc_source: DocumentSource = {"bytes": b"document content"}

        assert doc_source["bytes"] == b"document content"
        assert "s3Location" not in doc_source

    def test_document_source_with_s3_location(self):
        """Test DocumentSource with s3Location."""
        doc_source: DocumentSource = {
            "s3Location": {
                "uri": "s3://my-bucket/docs/report.pdf",
                "bucketOwner": "123456789012",
            }
        }

        assert "bytes" not in doc_source
        assert doc_source["s3Location"]["uri"] == "s3://my-bucket/docs/report.pdf"
        assert doc_source["s3Location"]["bucketOwner"] == "123456789012"


class TestImageSource:
    """Tests for ImageSource TypedDict."""

    def test_image_source_with_bytes(self):
        """Test ImageSource with bytes content."""
        img_source: ImageSource = {"bytes": b"image content"}

        assert img_source["bytes"] == b"image content"
        assert "s3Location" not in img_source

    def test_image_source_with_s3_location(self):
        """Test ImageSource with s3Location."""
        img_source: ImageSource = {
            "s3Location": {
                "uri": "s3://my-bucket/images/photo.png",
            }
        }

        assert "bytes" not in img_source
        assert img_source["s3Location"]["uri"] == "s3://my-bucket/images/photo.png"


class TestVideoSource:
    """Tests for VideoSource TypedDict."""

    def test_video_source_with_bytes(self):
        """Test VideoSource with bytes content."""
        vid_source: VideoSource = {"bytes": b"video content"}

        assert vid_source["bytes"] == b"video content"
        assert "s3Location" not in vid_source

    def test_video_source_with_s3_location(self):
        """Test VideoSource with s3Location."""
        vid_source: VideoSource = {
            "s3Location": {
                "uri": "s3://my-bucket/videos/clip.mp4",
                "bucketOwner": "987654321098",
            }
        }

        assert "bytes" not in vid_source
        assert vid_source["s3Location"]["uri"] == "s3://my-bucket/videos/clip.mp4"
        assert vid_source["s3Location"]["bucketOwner"] == "987654321098"
