"""Media-related type definitions for the SDK.

These types are modeled after the Bedrock API.

- Bedrock docs: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_Types_Amazon_Bedrock_Runtime.html
"""

from typing import Literal, TypeAlias

from typing_extensions import Required, TypedDict

from .citations import CitationsConfig

DocumentFormat = Literal["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]
"""Supported document formats."""


class Location(TypedDict, total=False):
    """A location for a document.

    This type is a generic location for a document. Its usage is determined by the underlying model provider.
    """

    type: Required[str]


class S3Location(Location, total=False):
    """A storage location in an Amazon S3 bucket.

    Used by Bedrock to reference media files stored in S3 instead of passing raw bytes.

    - Docs: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_S3Location.html

    Attributes:
        type: s3
        uri: An object URI starting with `s3://`. Required.
        bucketOwner: If the bucket belongs to another AWS account, specify that account's ID. Optional.
    """

    # mypy doesn't like overriding this field since its a subclass, but since its just a literal string, this is fine.

    type: Literal["s3"]  # type: ignore[misc]
    uri: Required[str]
    bucketOwner: str


SourceLocation: TypeAlias = Location | S3Location


AudioFormat = Literal[
    "mp3",
    "opus",
    "wav",
    "aac",
    "flac",
    "mp4",
    "ogg",
    "mkv",
    "mka",
    "x-aac",
    "m4a",
    "mpeg",
    "mpga",
    "pcm",
    "webm",
]
"""Supported audio formats."""


class AudioSource(TypedDict, total=False):
    """Contains the content of an audio block.

    Only one of `bytes` or `location` should be specified.

    Attributes:
        bytes: The binary content of the audio.
        location: Location of the audio.
    """

    bytes: bytes
    location: SourceLocation


class AudioContent(TypedDict):
    """Audio to include in a message.

    Attributes:
        format: The format of the audio.
        source: The source containing the audio content.
    """

    format: AudioFormat
    source: AudioSource


class DocumentSource(TypedDict, total=False):
    """Contains the content of a document.

    Only one of `bytes` or `s3Location` should be specified.

    Attributes:
        bytes: The binary content of the document.
        location: Location of the document.
    """

    bytes: bytes
    location: SourceLocation


class DocumentContent(TypedDict, total=False):
    """A document to include in a message.

    Attributes:
        format: The format of the document (e.g., "pdf", "txt").
        name: The name of the document.
        source: The source containing the document's binary content.
    """

    format: Literal["pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"]
    name: str
    source: DocumentSource
    citations: CitationsConfig | None
    context: str | None


ImageFormat = Literal["png", "jpeg", "gif", "webp"]
"""Supported image formats."""


class ImageSource(TypedDict, total=False):
    """Contains the content of an image.

    Only one of `bytes` or `s3Location` should be specified.

    Attributes:
        bytes: The binary content of the image.
        location: Location of the image.
    """

    bytes: bytes
    location: SourceLocation


class ImageContent(TypedDict):
    """An image to include in a message.

    Attributes:
        format: The format of the image (e.g., "png", "jpeg").
        source: The source containing the image's binary content.
    """

    format: ImageFormat
    source: ImageSource


VideoFormat = Literal["flv", "mkv", "mov", "mpeg", "mpg", "mp4", "three_gp", "webm", "wmv"]
"""Supported video formats."""


class VideoSource(TypedDict, total=False):
    """Contains the content of a video.

    Only one of `bytes` or `s3Location` should be specified.

    Attributes:
        bytes: The binary content of the video.
        location: Location of the video.
    """

    bytes: bytes
    location: SourceLocation


class VideoContent(TypedDict):
    """A video to include in a message.

    Attributes:
        format: The format of the video (e.g., "mp4", "avi").
        source: The source containing the video's binary content.
    """

    format: VideoFormat
    source: VideoSource


AudioFormat = Literal["mp3", "wav", "flac", "ogg", "webm"]
"""Supported audio formats."""


class AudioSource(TypedDict, total=False):
    """Contains the content of an audio file.

    Only one of `bytes` or `s3Location` should be specified.

    Attributes:
        bytes: The binary content of the audio.
        location: Location of the audio.
    """

    bytes: bytes
    location: SourceLocation


class AudioContent(TypedDict):
    """An audio file to include in a message.

    - Docs: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_AudioBlock.html

    Attributes:
        format: The format of the audio (e.g., "mp3", "wav").
        source: The source containing the audio's binary content.
    """

    format: AudioFormat
    source: AudioSource
