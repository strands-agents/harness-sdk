"""Integration tests for S3 location support in media content types."""

import time

import boto3
import pytest

from strands import Agent
from strands.models.bedrock import BedrockModel


@pytest.fixture
def boto_session():
    """Create a boto3 session for testing."""
    return boto3.Session(region_name="us-west-2")


@pytest.fixture
def account_id(boto_session):
    """Get the current AWS account ID."""
    sts_client = boto_session.client("sts")
    return sts_client.get_caller_identity()["Account"]


@pytest.fixture
def s3_client(boto_session):
    """Create an S3 client."""
    return boto_session.client("s3")


@pytest.fixture
def test_bucket(s3_client, account_id):
    """Create a test S3 bucket for the tests.

    Creates a bucket with account-specific name and cleans it up after tests.
    """
    bucket_name = f"strands-integ-tests-resources-{account_id}"

    # Create the bucket if it doesn't exist
    try:
        s3_client.head_bucket(Bucket=bucket_name)
        print(f"Bucket {bucket_name} already exists")
    except s3_client.exceptions.ClientError:
        try:
            s3_client.create_bucket(
                Bucket=bucket_name,
                CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
            )
            print(f"Created test bucket: {bucket_name}")
            # Wait for bucket to be available
            time.sleep(2)
        except s3_client.exceptions.BucketAlreadyOwnedByYou:
            print(f"Bucket {bucket_name} already exists")

    yield bucket_name

    # Note: We don't delete the bucket to allow reuse across test runs
    # Objects will be overwritten on subsequent runs


@pytest.fixture
def s3_document(s3_client, test_bucket, letter_pdf):
    """Upload a test document to S3 and return its URI."""
    document_key = "test-documents/letter.pdf"

    # Upload the document using existing letter_pdf fixture
    s3_client.put_object(
        Bucket=test_bucket,
        Key=document_key,
        Body=letter_pdf,
        ContentType="application/pdf",
    )
    print(f"Uploaded test document to s3://{test_bucket}/{document_key}")

    return f"s3://{test_bucket}/{document_key}"


@pytest.fixture
def s3_image(s3_client, test_bucket, yellow_img):
    """Upload a test image to S3 and return its URI."""
    image_key = "test-images/yellow.png"

    # Upload the image using existing yellow_img fixture
    s3_client.put_object(
        Bucket=test_bucket,
        Key=image_key,
        Body=yellow_img,
        ContentType="image/png",
    )
    print(f"Uploaded test image to s3://{test_bucket}/{image_key}")

    return f"s3://{test_bucket}/{image_key}"


@pytest.fixture
def s3_video(s3_client, test_bucket, blue_video):
    """Upload a test video to S3 and return its URI."""
    video_key = "test-videos/blue.mp4"

    # Upload the video using existing blue_video fixture
    s3_client.put_object(
        Bucket=test_bucket,
        Key=video_key,
        Body=blue_video,
        ContentType="video/mp4",
    )
    print(f"Uploaded test video to s3://{test_bucket}/{video_key}")

    return f"s3://{test_bucket}/{video_key}"


def test_document_s3_location(s3_document, account_id):
    """Test that Bedrock correctly formats a document with S3 location."""
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Please tell me about this document?"},
                {
                    "document": {
                        "format": "pdf",
                        "name": "letter",
                        "source": {"location": {"type": "s3", "uri": s3_document, "bucketOwner": account_id}},
                    },
                },
            ],
        },
    ]

    agent = Agent(model=BedrockModel(model_id="us.amazon.nova-2-lite-v1:0", region_name="us-west-2"))
    result = agent(messages)

    # The actual recognition capabilities of these models is not great, so just asserting that the call actually worked.
    assert len(str(result)) > 0


def test_image_s3_location(s3_image):
    """Test that Bedrock correctly formats an image with S3 location."""
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Please tell me about this image?"},
                {
                    "image": {
                        "format": "png",
                        "source": {"location": {"type": "s3", "uri": s3_image}},
                    },
                },
            ],
        },
    ]

    agent = Agent(model=BedrockModel(model_id="us.amazon.nova-2-lite-v1:0", region_name="us-west-2"))
    result = agent(messages)

    # The actual recognition capabilities of these models is not great, so just asserting that the call actually worked.
    assert len(str(result)) > 0


def test_video_s3_location(s3_video):
    """Test that Bedrock correctly formats a video with S3 location."""
    messages = [
        {
            "role": "user",
            "content": [
                {"text": "Describe the colors is in this video?"},
                {"video": {"format": "mp4", "source": {"location": {"type": "s3", "uri": s3_video}}}},
            ],
        },
    ]

    agent = Agent(model=BedrockModel(model_id="us.amazon.nova-pro-v1:0", region_name="us-west-2"))
    result = agent(messages)

    # The actual recognition capabilities of these models is not great, so just asserting that the call actually worked.
    assert len(str(result)) > 0
