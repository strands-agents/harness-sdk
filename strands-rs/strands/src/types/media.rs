//! Media and document content blocks and their formats.
//!
//! Binary data is a `Vec<u8>` in memory and a standard base64 string on the wire.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::messages::TextBlock;

/// Serde helpers for bytes stored as base64 strings.
///
/// Encoding is standard padded base64. Decoding is lenient: it accepts missing padding, the URL-safe
/// alphabet and embedded whitespace. It also accepts the byte forms other Strands SDKs may write: a
/// JSON array of byte values and an index-keyed object (`{"0":1,"1":2}`).
pub(crate) mod base64_bytes {
    use std::fmt;

    use base64::Engine as _;
    use base64::alphabet::STANDARD as STANDARD_ALPHABET;
    use base64::engine::general_purpose::STANDARD;
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    use serde::de::{self, MapAccess, SeqAccess, Visitor};
    use serde::{Deserializer, Serializer};

    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &STANDARD_ALPHABET,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );

    pub(crate) fn encode(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    pub(crate) fn decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
        let normalized: String = text
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .map(|c| match c {
                '-' => '+',
                '_' => '/',
                other => other,
            })
            .collect();
        LENIENT.decode(normalized.trim_end_matches('='))
    }

    pub(crate) fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&encode(bytes))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        deserializer.deserialize_any(BytesVisitor)
    }

    struct BytesVisitor;

    impl<'de> Visitor<'de> for BytesVisitor {
        type Value = Vec<u8>;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a base64 string, an array of bytes or an index-keyed object of bytes")
        }

        fn visit_str<E: de::Error>(self, text: &str) -> Result<Vec<u8>, E> {
            decode(text).map_err(|error| E::custom(format!("invalid base64 bytes: {error}")))
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<u8>, A::Error> {
            let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0));
            while let Some(byte) = seq.next_element::<u8>()? {
                bytes.push(byte);
            }
            Ok(bytes)
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Vec<u8>, A::Error> {
            let mut indexed = Vec::with_capacity(map.size_hint().unwrap_or(0));
            while let Some((key, byte)) = map.next_entry::<String, u8>()? {
                let index = key
                    .parse::<usize>()
                    .map_err(|_| de::Error::custom(format!("byte object key `{key}` is not an index")))?;
                indexed.push((index, byte));
            }
            indexed.sort_unstable_by_key(|(index, _)| *index);
            let contiguous = indexed
                .iter()
                .enumerate()
                .all(|(position, (index, _))| position == *index);
            if !contiguous {
                return Err(de::Error::custom("byte object keys must be the indices 0..n"));
            }
            Ok(indexed.into_iter().map(|(_, byte)| byte).collect())
        }
    }

    pub(crate) mod option {
        use serde::{Deserialize, Deserializer, Serializer};

        #[derive(Deserialize)]
        struct Wrapped(#[serde(with = "super")] Vec<u8>);

        #[allow(clippy::ref_option, reason = "serde `with` passes `&Option<T>`")]
        pub(crate) fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, serializer: S) -> Result<S::Ok, S::Error> {
            match bytes {
                Some(bytes) => super::serialize(bytes, serializer),
                None => serializer.serialize_none(),
            }
        }

        pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<u8>>, D::Error> {
            Ok(Option::<Wrapped>::deserialize(deserializer)?.map(|wrapped| wrapped.0))
        }
    }
}

/// Audio format (`AudioFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum AudioFormat {
    /// `mp3`
    Mp3,
    /// `opus`
    Opus,
    /// `wav`
    Wav,
    /// `aac`
    Aac,
    /// `flac`
    Flac,
    /// `mp4`
    Mp4,
    /// `ogg`
    Ogg,
    /// `mkv`
    Mkv,
    /// `mka`
    Mka,
    /// `x-aac`
    #[serde(rename = "x-aac")]
    XAac,
    /// `m4a`
    M4a,
    /// `mpeg`
    Mpeg,
    /// `mpga`
    Mpga,
    /// `pcm`
    Pcm,
    /// `webm`
    Webm,
}

/// Image format (`ImageFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum ImageFormat {
    /// `png`
    Png,
    /// `jpg`
    Jpg,
    /// `jpeg`
    Jpeg,
    /// `gif`
    Gif,
    /// `webp`
    Webp,
}

/// Video format (`VideoFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum VideoFormat {
    /// `mkv`
    Mkv,
    /// `mov`
    Mov,
    /// `mp4`
    Mp4,
    /// `webm`
    Webm,
    /// `flv`
    Flv,
    /// `mpeg`
    Mpeg,
    /// `mpg`
    Mpg,
    /// `wmv`
    Wmv,
    /// `3gp`
    #[serde(rename = "3gp")]
    ThreeGp,
}

/// Document format (`DocumentFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum DocumentFormat {
    /// `pdf`
    Pdf,
    /// `csv`
    Csv,
    /// `doc`
    Doc,
    /// `docx`
    Docx,
    /// `xls`
    Xls,
    /// `xlsx`
    Xlsx,
    /// `html`
    Html,
    /// `txt`
    Txt,
    /// `md`
    Md,
    /// `json`
    Json,
    /// `xml`
    Xml,
}

/// An S3 object location for media and document sources (`S3Location`).
///
/// Serializes with `"type": "s3"` first.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct S3Location {
    /// S3 URI, `s3://bucket-name/key-name`.
    pub uri: String,
    /// AWS account ID of the bucket owner, required when the bucket belongs to another account.
    pub bucket_owner: Option<String>,
}

impl S3Location {
    /// Creates a location from an S3 URI.
    pub fn new(uri: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            bucket_owner: None,
        }
    }

    /// Sets the bucket owner's account ID.
    #[must_use]
    pub fn with_bucket_owner(mut self, bucket_owner: impl Into<String>) -> Self {
        self.bucket_owner = Some(bucket_owner.into());
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct S3LocationWire<'a> {
    r#type: &'static str,
    uri: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    bucket_owner: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct S3LocationData {
    uri: String,
    #[serde(default)]
    bucket_owner: Option<String>,
}

impl Serialize for S3Location {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        S3LocationWire {
            r#type: "s3",
            uri: &self.uri,
            bucket_owner: self.bucket_owner.as_deref(),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for S3Location {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let data = S3LocationData::deserialize(deserializer)?;
        Ok(Self {
            uri: data.uri,
            bucket_owner: data.bucket_owner,
        })
    }
}

/// Source of an audio block (`AudioSource`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum AudioSource {
    /// Raw bytes, base64 on the wire.
    Bytes(#[serde(with = "base64_bytes")] Vec<u8>),
    /// An S3 location.
    Location(S3Location),
}

/// Source of an image block (`ImageSource`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum ImageSource {
    /// Raw bytes, base64 on the wire.
    Bytes(#[serde(with = "base64_bytes")] Vec<u8>),
    /// An S3 location.
    Location(S3Location),
    /// An `https://` URL.
    Url(String),
}

/// Source of a video block (`VideoSource`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum VideoSource {
    /// Raw bytes, base64 on the wire.
    Bytes(#[serde(with = "base64_bytes")] Vec<u8>),
    /// An S3 location.
    Location(S3Location),
}

/// A block nested inside a document's structured content (`DocumentContentBlock`).
pub type DocumentContentBlock = TextBlock;

/// Source of a document block (`DocumentSource`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum DocumentSource {
    /// Raw bytes, base64 on the wire.
    Bytes(#[serde(with = "base64_bytes")] Vec<u8>),
    /// Plain text.
    Text(String),
    /// Structured content made of text blocks.
    Content(Vec<DocumentContentBlock>),
    /// An S3 location.
    Location(S3Location),
}

/// Audio content block (`AudioBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AudioBlock {
    /// Audio format.
    pub format: AudioFormat,
    /// Audio source.
    pub source: AudioSource,
}

impl AudioBlock {
    /// Creates an audio block.
    pub fn new(format: AudioFormat, source: AudioSource) -> Self {
        Self { format, source }
    }
}

/// Image content block (`ImageBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ImageBlock {
    /// Image format.
    pub format: ImageFormat,
    /// Image source.
    pub source: ImageSource,
}

impl ImageBlock {
    /// Creates an image block.
    pub fn new(format: ImageFormat, source: ImageSource) -> Self {
        Self { format, source }
    }
}

/// Video content block (`VideoBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct VideoBlock {
    /// Video format.
    pub format: VideoFormat,
    /// Video source.
    pub source: VideoSource,
}

impl VideoBlock {
    /// Creates a video block.
    pub fn new(format: VideoFormat, source: VideoSource) -> Self {
        Self { format, source }
    }
}

/// Citation configuration of a document block.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct DocumentCitations {
    /// Whether the model may cite this document.
    pub enabled: bool,
}

impl DocumentCitations {
    /// Creates the configuration.
    pub fn new(enabled: bool) -> Self {
        Self { enabled }
    }
}

/// Document content block (`DocumentBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct DocumentBlock {
    /// Document name.
    pub name: String,
    /// Document format.
    pub format: DocumentFormat,
    /// Document source.
    pub source: DocumentSource,
    /// Citation configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<DocumentCitations>,
    /// Context information for the document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
}

impl DocumentBlock {
    /// Creates a document block.
    pub fn new(name: impl Into<String>, format: DocumentFormat, source: DocumentSource) -> Self {
        Self {
            name: name.into(),
            format,
            source,
            citations: None,
            context: None,
        }
    }

    /// Sets the citation configuration.
    #[must_use]
    pub fn with_citations(mut self, citations: DocumentCitations) -> Self {
        self.citations = Some(citations);
        self
    }

    /// Sets the document context.
    #[must_use]
    pub fn with_context(mut self, context: impl Into<String>) -> Self {
        self.context = Some(context.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn bytes() -> Vec<u8> {
        vec![1, 2, 3]
    }

    fn round_trip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(value: &T) {
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(&serde_json::from_value::<T>(json).unwrap(), value);
    }

    #[test]
    fn creates_instance_with_uri_only() {
        let location = S3Location::new("s3://test-bucket/file.jpg");
        assert_eq!(location.uri, "s3://test-bucket/file.jpg");
        assert_eq!(location.bucket_owner, None);
    }

    #[test]
    fn creates_instance_with_uri_and_bucket_owner() {
        let location = S3Location::new("s3://test-bucket/file.jpg").with_bucket_owner("123456789012");
        assert_eq!(location.bucket_owner.as_deref(), Some("123456789012"));
    }

    #[test]
    fn audio_block_creates_instance_with_bytes_source() {
        let block = AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(bytes()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "mp3", "source": {"bytes": "AQID"}})
        );
    }

    #[test]
    fn audio_block_creates_instance_with_s3_location_source() {
        let block = AudioBlock::new(
            AudioFormat::Wav,
            AudioSource::Location(S3Location::new("s3://b/a.wav").with_bucket_owner("123456789012")),
        );
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "wav", "source": {"location": {"type": "s3", "uri": "s3://b/a.wav", "bucketOwner": "123456789012"}}})
        );
    }

    #[test]
    fn audio_block_throws_error_for_invalid_source() {
        assert!(serde_json::from_value::<AudioBlock>(json!({"format": "mp3", "source": {}})).is_err());
    }

    #[test]
    fn image_block_creates_instance_with_bytes_source() {
        let block = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "png", "source": {"bytes": "AQID"}})
        );
    }

    #[test]
    fn image_block_creates_instance_with_s3_location_source() {
        let block = ImageBlock::new(
            ImageFormat::Jpeg,
            ImageSource::Location(S3Location::new("s3://b/i.jpg")),
        );
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "jpeg", "source": {"location": {"type": "s3", "uri": "s3://b/i.jpg"}}})
        );
    }

    #[test]
    fn image_block_creates_instance_with_url_source() {
        let block = ImageBlock::new(ImageFormat::Webp, ImageSource::Url("https://example.com/i.webp".into()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "webp", "source": {"url": "https://example.com/i.webp"}})
        );
    }

    #[test]
    fn image_block_throws_error_for_invalid_source() {
        assert!(serde_json::from_value::<ImageBlock>(json!({"format": "png", "source": {}})).is_err());
    }

    #[test]
    fn video_block_creates_instance_with_bytes_source() {
        let block = VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(bytes()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "mp4", "source": {"bytes": "AQID"}})
        );
    }

    #[test]
    fn video_block_creates_instance_with_s3_location_source() {
        let block = VideoBlock::new(VideoFormat::ThreeGp, VideoSource::Location(S3Location::new("s3://b/v")));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"format": "3gp", "source": {"location": {"type": "s3", "uri": "s3://b/v"}}})
        );
    }

    #[test]
    fn video_block_throws_error_for_invalid_source() {
        assert!(serde_json::from_value::<VideoBlock>(json!({"format": "mp4", "source": {}})).is_err());
    }

    #[test]
    fn document_block_creates_instance_with_bytes_source() {
        let block = DocumentBlock::new("doc", DocumentFormat::Pdf, DocumentSource::Bytes(bytes()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "doc", "format": "pdf", "source": {"bytes": "AQID"}})
        );
    }

    #[test]
    fn document_block_creates_instance_with_text_source() {
        let block = DocumentBlock::new("doc", DocumentFormat::Txt, DocumentSource::Text("Hello".into()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "doc", "format": "txt", "source": {"text": "Hello"}})
        );
    }

    #[test]
    fn document_block_creates_instance_with_content_source() {
        let source = DocumentSource::Content(vec![TextBlock::new("one"), TextBlock::new("two")]);
        let block = DocumentBlock::new("doc", DocumentFormat::Html, source);
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "doc", "format": "html", "source": {"content": [{"text": "one"}, {"text": "two"}]}})
        );
    }

    #[test]
    fn document_block_creates_instance_with_s3_location_source() {
        let block = DocumentBlock::new(
            "doc",
            DocumentFormat::Docx,
            DocumentSource::Location(S3Location::new("s3://b/d.docx")),
        );
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "doc", "format": "docx", "source": {"location": {"type": "s3", "uri": "s3://b/d.docx"}}})
        );
    }

    #[test]
    fn creates_instance_with_bytes_and_filename() {
        let block = DocumentBlock::new("upload.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(bytes()));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "upload.pdf", "format": "pdf", "source": {"bytes": "AQID"}})
        );
    }

    #[test]
    fn creates_instance_with_text_and_filename() {
        let block = DocumentBlock::new(
            "note.txt",
            DocumentFormat::Txt,
            DocumentSource::Text("Hello world".into()),
        );
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"name": "note.txt", "format": "txt", "source": {"text": "Hello world"}})
        );
    }

    #[test]
    fn creates_instance_with_citations_and_context() {
        let block = DocumentBlock::new("research.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(bytes()))
            .with_citations(DocumentCitations::new(true))
            .with_context("Research paper about AI");
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({
                "name": "research.pdf",
                "format": "pdf",
                "source": {"bytes": "AQID"},
                "citations": {"enabled": true},
                "context": "Research paper about AI"
            })
        );
    }

    #[test]
    fn document_block_throws_error_for_invalid_source() {
        assert!(serde_json::from_value::<DocumentBlock>(json!({"name": "d", "format": "pdf", "source": {}})).is_err());
    }

    #[test]
    fn round_trips_empty_array() {
        round_trip(&ImageSource::Bytes(Vec::new()));
        assert_eq!(base64_bytes::encode(&[]), "");
    }

    #[test]
    fn round_trips_single_byte() {
        round_trip(&ImageSource::Bytes(vec![255]));
    }

    #[test]
    fn round_trips_multi_byte_array() {
        round_trip(&ImageSource::Bytes(vec![0, 1, 127, 128, 255]));
    }

    #[test]
    fn round_trips_large_array() {
        let large: Vec<u8> = (0..100_000u32).map(|i| (i % 256) as u8).collect();
        round_trip(&ImageSource::Bytes(large));
    }

    #[test]
    fn audio_block_from_json_accepts_base64_string_for_bytes() {
        let block: AudioBlock = serde_json::from_value(json!({"format": "mp3", "source": {"bytes": "AQID"}})).unwrap();
        assert_eq!(block.source, AudioSource::Bytes(bytes()));
    }

    #[test]
    fn audio_block_from_json_accepts_uint8_array_for_bytes() {
        let block: AudioBlock =
            serde_json::from_value(json!({"format": "mp3", "source": {"bytes": [1, 2, 3]}})).unwrap();
        assert_eq!(block.source, AudioSource::Bytes(bytes()));
    }

    #[test]
    fn image_block_from_json_accepts_base64_string_for_bytes() {
        let block: ImageBlock = serde_json::from_value(json!({"format": "png", "source": {"bytes": "AQID"}})).unwrap();
        assert_eq!(block.source, ImageSource::Bytes(bytes()));
    }

    #[test]
    fn image_block_from_json_accepts_uint8_array_for_bytes() {
        let block: ImageBlock =
            serde_json::from_value(json!({"format": "png", "source": {"bytes": [1, 2, 3]}})).unwrap();
        assert_eq!(block.source, ImageSource::Bytes(bytes()));
    }

    #[test]
    fn video_block_from_json_accepts_base64_string_for_bytes() {
        let block: VideoBlock = serde_json::from_value(json!({"format": "mp4", "source": {"bytes": "AQID"}})).unwrap();
        assert_eq!(block.source, VideoSource::Bytes(bytes()));
    }

    #[test]
    fn video_block_from_json_accepts_uint8_array_for_bytes() {
        let block: VideoBlock =
            serde_json::from_value(json!({"format": "mp4", "source": {"bytes": [1, 2, 3]}})).unwrap();
        assert_eq!(block.source, VideoSource::Bytes(bytes()));
    }

    #[test]
    fn document_block_from_json_accepts_base64_string_for_bytes() {
        let block: DocumentBlock =
            serde_json::from_value(json!({"name": "d", "format": "pdf", "source": {"bytes": "AQID"}})).unwrap();
        assert_eq!(block.source, DocumentSource::Bytes(bytes()));
    }

    #[test]
    fn document_block_from_json_accepts_uint8_array_for_bytes() {
        let block: DocumentBlock =
            serde_json::from_value(json!({"name": "d", "format": "pdf", "source": {"bytes": [1, 2, 3]}})).unwrap();
        assert_eq!(block.source, DocumentSource::Bytes(bytes()));
    }

    #[test]
    fn s3_location_round_trips_with_uri_only() {
        round_trip(&S3Location::new("s3://bucket/key"));
    }

    #[test]
    fn s3_location_round_trips_with_uri_and_bucket_owner() {
        round_trip(&S3Location::new("s3://bucket/key").with_bucket_owner("123456789012"));
    }

    #[test]
    fn includes_type_in_json_output() {
        assert_eq!(
            serde_json::to_string(&S3Location::new("s3://bucket/key")).unwrap(),
            r#"{"type":"s3","uri":"s3://bucket/key"}"#
        );
    }

    #[test]
    fn audio_block_round_trips_with_bytes_source() {
        round_trip(&AudioBlock::new(AudioFormat::Flac, AudioSource::Bytes(bytes())));
    }

    #[test]
    fn audio_block_round_trips_with_s3_location_source() {
        round_trip(&AudioBlock::new(
            AudioFormat::XAac,
            AudioSource::Location(S3Location::new("s3://b/a")),
        ));
    }

    #[test]
    fn audio_block_encodes_bytes_as_base64_in_json_output() {
        let json = serde_json::to_value(AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(bytes()))).unwrap();
        assert!(json["source"]["bytes"].is_string());
    }

    #[test]
    fn image_block_round_trips_with_bytes_source() {
        round_trip(&ImageBlock::new(ImageFormat::Gif, ImageSource::Bytes(bytes())));
    }

    #[test]
    fn image_block_round_trips_with_url_source() {
        round_trip(&ImageBlock::new(
            ImageFormat::Jpg,
            ImageSource::Url("https://example.com/a.jpg".into()),
        ));
    }

    #[test]
    fn image_block_round_trips_with_s3_location_source() {
        round_trip(&ImageBlock::new(
            ImageFormat::Png,
            ImageSource::Location(S3Location::new("s3://b/i")),
        ));
    }

    #[test]
    fn image_block_encodes_bytes_as_base64_in_json_output() {
        let json = serde_json::to_value(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes()))).unwrap();
        assert_eq!(json["source"]["bytes"], "AQID");
    }

    #[test]
    fn video_block_round_trips_with_bytes_source() {
        round_trip(&VideoBlock::new(VideoFormat::Mov, VideoSource::Bytes(bytes())));
    }

    #[test]
    fn video_block_round_trips_with_s3_location_source() {
        round_trip(&VideoBlock::new(
            VideoFormat::Mkv,
            VideoSource::Location(S3Location::new("s3://b/v")),
        ));
    }

    #[test]
    fn video_block_encodes_bytes_as_base64_in_json_output() {
        let json = serde_json::to_value(VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(bytes()))).unwrap();
        assert_eq!(json["source"]["bytes"], "AQID");
    }

    #[test]
    fn document_block_round_trips_with_bytes_source() {
        round_trip(&DocumentBlock::new(
            "d",
            DocumentFormat::Pdf,
            DocumentSource::Bytes(bytes()),
        ));
    }

    #[test]
    fn document_block_round_trips_with_text_source() {
        round_trip(&DocumentBlock::new(
            "d",
            DocumentFormat::Md,
            DocumentSource::Text("# hi".into()),
        ));
    }

    #[test]
    fn document_block_round_trips_with_content_source() {
        let source = DocumentSource::Content(vec![TextBlock::new("a")]);
        round_trip(&DocumentBlock::new("d", DocumentFormat::Txt, source));
    }

    #[test]
    fn document_block_round_trips_with_s3_location_source() {
        let source = DocumentSource::Location(S3Location::new("s3://b/d"));
        round_trip(&DocumentBlock::new("d", DocumentFormat::Csv, source));
    }

    #[test]
    fn document_block_round_trips_with_citations_and_context() {
        let block = DocumentBlock::new("d", DocumentFormat::Pdf, DocumentSource::Bytes(bytes()))
            .with_citations(DocumentCitations::new(true))
            .with_context("ctx");
        round_trip(&block);
    }

    #[test]
    fn omits_undefined_citations_and_context_from_json() {
        let json = serde_json::to_value(DocumentBlock::new(
            "d",
            DocumentFormat::Pdf,
            DocumentSource::Text("x".into()),
        ))
        .unwrap();
        assert!(json.get("citations").is_none());
        assert!(json.get("context").is_none());
    }

    fn assert_wire<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(cases: &[(T, &str)]) {
        for (format, wire) in cases {
            assert_eq!(serde_json::to_value(format).unwrap(), json!(wire));
            assert_eq!(&serde_json::from_value::<T>(json!(wire)).unwrap(), format);
        }
    }

    #[test]
    fn every_media_format_round_trips_through_its_wire_string() {
        use AudioFormat as A;
        use DocumentFormat as D;
        use ImageFormat as I;
        use VideoFormat as V;
        assert_wire(&[
            (A::Mp3, "mp3"),
            (A::Opus, "opus"),
            (A::Wav, "wav"),
            (A::Aac, "aac"),
            (A::Flac, "flac"),
            (A::Mp4, "mp4"),
            (A::Ogg, "ogg"),
            (A::Mkv, "mkv"),
            (A::Mka, "mka"),
            (A::XAac, "x-aac"),
            (A::M4a, "m4a"),
            (A::Mpeg, "mpeg"),
            (A::Mpga, "mpga"),
            (A::Pcm, "pcm"),
            (A::Webm, "webm"),
        ]);
        assert_wire(&[
            (I::Png, "png"),
            (I::Jpg, "jpg"),
            (I::Jpeg, "jpeg"),
            (I::Gif, "gif"),
            (I::Webp, "webp"),
        ]);
        assert_wire(&[
            (V::Mkv, "mkv"),
            (V::Mov, "mov"),
            (V::Mp4, "mp4"),
            (V::Webm, "webm"),
            (V::Flv, "flv"),
            (V::Mpeg, "mpeg"),
            (V::Mpg, "mpg"),
            (V::Wmv, "wmv"),
            (V::ThreeGp, "3gp"),
        ]);
        assert_wire(&[
            (D::Pdf, "pdf"),
            (D::Csv, "csv"),
            (D::Doc, "doc"),
            (D::Docx, "docx"),
            (D::Xls, "xls"),
            (D::Xlsx, "xlsx"),
            (D::Html, "html"),
            (D::Txt, "txt"),
            (D::Md, "md"),
            (D::Json, "json"),
            (D::Xml, "xml"),
        ]);
    }

    #[test]
    fn base64_decoding_is_as_lenient_as_node_buffer() {
        let cases = [
            ("AQID", vec![1, 2, 3]),
            ("AQI", vec![1, 2]),
            ("AQI=", vec![1, 2]),
            ("-_8", vec![251, 255]),
            ("+/8=", vec![251, 255]),
            ("AQ ID\nBA==", vec![1, 2, 3, 4]),
            ("", Vec::new()),
        ];
        for (text, expected) in cases {
            assert_eq!(base64_bytes::decode(text).unwrap(), expected, "{text:?}");
        }
        assert_eq!(base64_bytes::encode(&[251, 255]), "+/8=");
    }

    #[test]
    fn base64_rejects_characters_outside_both_alphabets() {
        let error = serde_json::from_value::<ImageSource>(json!({"bytes": "A*B"})).unwrap_err();
        assert!(error.to_string().starts_with("invalid base64 bytes"));
    }
}
