//! Messages and content blocks.
//!
//! Content blocks use the Bedrock Converse JSON shape: one key per block (`{"toolUse": {...}}`),
//! except text, which is a bare `{"text": "..."}`, and [`UnknownBlock`], which keeps the raw data.

use std::error::Error as StdError;
use std::fmt;
use std::sync::Arc;

use serde::de::Error as _;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::citations::CitationsBlock;
use super::json::{JsonObject, JsonValue};
use super::media::{AudioBlock, DocumentBlock, ImageBlock, VideoBlock, base64_bytes};
use super::tools::ToolResultStatus;
use crate::models::streaming::{Metrics, Usage};

/// The role of a message sender (`Role`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Role {
    /// Human input and tool results.
    User,
    /// Model responses.
    Assistant,
}

/// Metadata attached to a message (`MessageMetadata`). Persisted with the message, never sent to
/// model providers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MessageMetadata {
    /// Token usage of the model response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Performance metrics of the model response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,
    /// Arbitrary user or framework metadata, such as compression provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<JsonObject>,
}

impl MessageMetadata {
    /// Creates empty metadata.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the token usage.
    #[must_use]
    pub fn with_usage(mut self, usage: Usage) -> Self {
        self.usage = Some(usage);
        self
    }

    /// Sets the metrics.
    #[must_use]
    pub fn with_metrics(mut self, metrics: Metrics) -> Self {
        self.metrics = Some(metrics);
        self
    }

    /// Sets the custom metadata.
    #[must_use]
    pub fn with_custom(mut self, custom: JsonObject) -> Self {
        self.custom = Some(custom);
        self
    }
}

/// Generates a durable tracking id for a message: a UUID v4.
#[must_use]
pub(crate) fn generate_tracking_id() -> String {
    #[cfg(test)]
    if let Some(id) = test_ids::next() {
        return id;
    }
    uuid::Uuid::new_v4().to_string()
}

/// A crate-internal override of the tracking id generator, for tests that compare against
/// fixtures written with a counting UUID generator.
#[cfg(test)]
pub(crate) mod test_ids {
    use std::cell::Cell;

    thread_local! {
        static COUNTER: Cell<Option<u64>> = const { Cell::new(None) };
    }

    pub(super) fn next() -> Option<String> {
        COUNTER.with(|counter| {
            let value = counter.get()? + 1;
            counter.set(Some(value));
            Some(format!("00000000-0000-4000-8000-{value:012x}"))
        })
    }

    /// Makes tracking ids on this thread count up from `start + 1` until the guard drops.
    pub(crate) fn count_from(start: u64) -> Guard {
        COUNTER.with(|counter| counter.set(Some(start)));
        Guard
    }

    pub(crate) struct Guard;

    impl Drop for Guard {
        fn drop(&mut self) {
            COUNTER.with(|counter| counter.set(None));
        }
    }
}

/// A message in a conversation (`Message`).
///
/// Every message has a `tracking_id`. One supplied by the caller or by saved data is kept;
/// otherwise, or when it is empty, a fresh UUID is minted.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Message {
    /// The role of the sender.
    pub role: Role,
    /// The content blocks.
    pub content: Vec<ContentBlock>,
    tracking_id: String,
    /// Metadata, not sent to model providers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<MessageMetadata>,
}

impl Message {
    /// Creates a message with a fresh tracking id.
    pub fn new(role: Role, content: Vec<ContentBlock>) -> Self {
        Self {
            role,
            content,
            tracking_id: generate_tracking_id(),
            metadata: None,
        }
    }

    /// Creates a user message with one text block.
    pub fn user(text: impl Into<String>) -> Self {
        Self::new(Role::User, vec![ContentBlock::text(text)])
    }

    /// Creates an assistant message with one text block.
    pub fn assistant(text: impl Into<String>) -> Self {
        Self::new(Role::Assistant, vec![ContentBlock::text(text)])
    }

    /// Durable id that survives session save and restore; stripped before model calls. Read-only:
    /// set it at construction with [`Message::with_tracking_id`].
    #[must_use]
    pub fn tracking_id(&self) -> &str {
        &self.tracking_id
    }

    /// Sets the tracking id. An empty id is replaced with a fresh one.
    #[must_use]
    pub fn with_tracking_id(mut self, tracking_id: impl Into<String>) -> Self {
        self.tracking_id = tracking_id_or_new(Some(tracking_id.into()));
        self
    }

    /// Sets the metadata.
    #[must_use]
    pub fn with_metadata(mut self, metadata: MessageMetadata) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Replaces the content, keeping the role, tracking id and metadata (`with({ content })`).
    #[must_use]
    pub fn with_content(mut self, content: Vec<ContentBlock>) -> Self {
        self.content = content;
        self
    }

    /// Parses caller-supplied message data (`Message.fromMessageData`).
    ///
    /// Unlike deserialization, which keeps unknown block types as [`UnknownBlock`] so data a newer
    /// SDK saved still loads, this rejects them with `Unknown ContentBlockData type` (or
    /// `Unknown ToolResultContentData type` inside a tool result).
    ///
    /// # Errors
    ///
    /// Returns an error when the data is not a message or holds an unknown block type.
    pub fn from_message_data(data: JsonValue) -> crate::Result<Self> {
        Ok(MessageData::deserialize(data)?.into_message(OnUnknown::Reject)?)
    }

    /// The concatenated text of the message's text blocks.
    #[must_use]
    pub fn text(&self) -> String {
        self.content.iter().filter_map(ContentBlock::as_text).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageData {
    role: Role,
    content: Vec<JsonValue>,
    #[serde(default)]
    tracking_id: Option<String>,
    #[serde(default)]
    metadata: Option<MessageMetadata>,
}

impl MessageData {
    fn into_message(self, on_unknown: OnUnknown) -> Result<Message, serde_json::Error> {
        let content = self
            .content
            .into_iter()
            .map(|block| parse_content_block(block, on_unknown))
            .collect::<Result<_, _>>()?;
        Ok(Message {
            role: self.role,
            content,
            tracking_id: tracking_id_or_new(self.tracking_id),
            metadata: self.metadata,
        })
    }
}

impl<'de> Deserialize<'de> for Message {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        MessageData::deserialize(deserializer)?
            .into_message(OnUnknown::Keep)
            .map_err(D::Error::custom)
    }
}

fn tracking_id_or_new(tracking_id: Option<String>) -> String {
    tracking_id
        .filter(|id| !id.is_empty())
        .unwrap_or_else(generate_tracking_id)
}

/// A block of content within a message (`ContentBlock`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ContentBlock {
    /// Plain text, `{"text": "..."}`.
    Text(TextBlock),
    /// A tool use request, `{"toolUse": {...}}`.
    ToolUse(ToolUseBlock),
    /// A tool result, `{"toolResult": {...}}`.
    ToolResult(ToolResultBlock),
    /// Model reasoning, `{"reasoning": {...}}`.
    Reasoning(ReasoningBlock),
    /// A prompt cache point, `{"cachePoint": {...}}`.
    CachePoint(CachePointBlock),
    /// Content for guardrail evaluation, `{"guardContent": {...}}`.
    GuardContent(GuardContentBlock),
    /// Audio, `{"audio": {...}}`.
    Audio(AudioBlock),
    /// An image, `{"image": {...}}`.
    Image(ImageBlock),
    /// A video, `{"video": {...}}`.
    Video(VideoBlock),
    /// A document, `{"document": {...}}`.
    Document(DocumentBlock),
    /// Citations, `{"citations": {...}}`.
    Citations(CitationsBlock),
    /// Text the app adds to a user turn, `{"injected": {...}}`.
    Injected(InjectedBlock),
    /// A summary of earlier history, `{"summary": {...}}`.
    Summary(SummaryBlock),
    /// A block of a type this version does not recognize, kept unchanged.
    Unknown(UnknownBlock),
}

impl ContentBlock {
    /// Creates a text block.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(TextBlock::new(text))
    }

    /// Parses caller-supplied block data, rejecting unknown block types.
    ///
    /// # Errors
    ///
    /// Returns `Unknown ContentBlockData type` for an unrecognized block, or a decoding error.
    pub fn from_data(data: JsonValue) -> crate::Result<Self> {
        Ok(parse_content_block(data, OnUnknown::Reject)?)
    }

    /// The text of a text block.
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(block) => Some(&block.text),
            _ => None,
        }
    }
}

impl From<TextBlock> for ContentBlock {
    fn from(block: TextBlock) -> Self {
        Self::Text(block)
    }
}

impl From<&str> for ContentBlock {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl From<String> for ContentBlock {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

macro_rules! content_block_from {
    ($($variant:ident($block:ty)),* $(,)?) => {
        $(impl From<$block> for ContentBlock {
            fn from(block: $block) -> Self {
                Self::$variant(block)
            }
        })*
    };
}

content_block_from!(
    ToolUse(ToolUseBlock),
    ToolResult(ToolResultBlock),
    Reasoning(ReasoningBlock),
    CachePoint(CachePointBlock),
    GuardContent(GuardContentBlock),
    Audio(AudioBlock),
    Image(ImageBlock),
    Video(VideoBlock),
    Document(DocumentBlock),
    Citations(CitationsBlock),
    Injected(InjectedBlock),
    Summary(SummaryBlock),
    Unknown(UnknownBlock),
);

fn serialize_wrapped<S: Serializer, T: Serialize + ?Sized>(
    serializer: S,
    key: &str,
    value: &T,
) -> Result<S::Ok, S::Error> {
    let mut map = serializer.serialize_map(Some(1))?;
    map.serialize_entry(key, value)?;
    map.end()
}

impl Serialize for ContentBlock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(block) => block.serialize(serializer),
            Self::ToolUse(block) => serialize_wrapped(serializer, "toolUse", block),
            Self::ToolResult(block) => serialize_wrapped(serializer, "toolResult", block),
            Self::Reasoning(block) => serialize_wrapped(serializer, "reasoning", block),
            Self::CachePoint(block) => serialize_wrapped(serializer, "cachePoint", block),
            Self::GuardContent(block) => serialize_wrapped(serializer, "guardContent", block),
            Self::Audio(block) => serialize_wrapped(serializer, "audio", block),
            Self::Image(block) => serialize_wrapped(serializer, "image", block),
            Self::Video(block) => serialize_wrapped(serializer, "video", block),
            Self::Document(block) => serialize_wrapped(serializer, "document", block),
            Self::Citations(block) => serialize_wrapped(serializer, "citations", block),
            Self::Injected(block) => serialize_wrapped(serializer, "injected", block),
            Self::Summary(block) => serialize_wrapped(serializer, "summary", block),
            Self::Unknown(block) => block.data.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        parse_content_block(JsonValue::deserialize(deserializer)?, OnUnknown::Keep).map_err(D::Error::custom)
    }
}

/// What parsing does with a block this version cannot read: caller input is rejected, and saved
/// data keeps it as an [`UnknownBlock`] so data a newer SDK wrote still loads and round-trips.
///
/// A block is unreadable when its type key is unknown, or when its key is known but its body does
/// not decode, for example a media format this version does not list.
#[derive(Debug, Clone, Copy)]
enum OnUnknown {
    Keep,
    Reject,
}

impl OnUnknown {
    fn unrecognized(self, data: JsonObject, kind: &str) -> Result<UnknownBlock, serde_json::Error> {
        match self {
            Self::Reject => Err(serde_json::Error::custom(format!("Unknown {kind} type"))),
            Self::Keep => Ok(keep_unknown(data)),
        }
    }

    fn undecodable(self, data: JsonObject, error: serde_json::Error) -> Result<UnknownBlock, serde_json::Error> {
        match self {
            Self::Reject => Err(error),
            Self::Keep => Ok(keep_unknown(data)),
        }
    }
}

fn keep_unknown(data: JsonObject) -> UnknownBlock {
    let keys = data.keys().map(String::as_str).collect::<Vec<_>>().join(",");
    tracing::warn!(
        "block_keys=<{keys}> | unrecognized content block type | keeping it in history and leaving it out of model requests | if a newer sdk version saved it, upgrade to use it"
    );
    UnknownBlock::new(data)
}

type BlockParser = fn(&JsonValue, OnUnknown) -> Result<ContentBlock, serde_json::Error>;

const CONTENT_BLOCK_PARSERS: [(&str, BlockParser); 12] = [
    ("toolUse", |value, _| {
        ToolUseBlock::deserialize(value).map(ContentBlock::ToolUse)
    }),
    ("toolResult", |value, on_unknown| {
        parse_tool_result(value, on_unknown).map(ContentBlock::ToolResult)
    }),
    ("reasoning", |value, _| {
        ReasoningBlock::deserialize(value).map(ContentBlock::Reasoning)
    }),
    ("cachePoint", |value, _| {
        CachePointBlock::deserialize(value).map(ContentBlock::CachePoint)
    }),
    ("guardContent", |value, _| {
        GuardContentBlock::deserialize(value).map(ContentBlock::GuardContent)
    }),
    ("audio", |value, _| {
        AudioBlock::deserialize(value).map(ContentBlock::Audio)
    }),
    ("image", |value, _| {
        ImageBlock::deserialize(value).map(ContentBlock::Image)
    }),
    ("video", |value, _| {
        VideoBlock::deserialize(value).map(ContentBlock::Video)
    }),
    ("document", |value, _| {
        DocumentBlock::deserialize(value).map(ContentBlock::Document)
    }),
    ("citations", |value, _| {
        CitationsBlock::deserialize(value).map(ContentBlock::Citations)
    }),
    ("injected", |value, _| {
        InjectedBlock::deserialize(value).map(ContentBlock::Injected)
    }),
    ("summary", |value, _| {
        SummaryBlock::deserialize(value).map(ContentBlock::Summary)
    }),
];

/// A text block from its data, with the placeholder provenance under `offloaded` when stored data
/// records one (`OffloadedBlock.fromJSON`).
fn parse_text_block(map: &JsonObject) -> Option<Result<TextBlock, serde_json::Error>> {
    let text = map.get("text")?;
    Some((|| {
        let mut block = TextBlock::new(String::deserialize(text)?);
        block.offloaded = map.get("offloaded").map(Offloaded::deserialize).transpose()?;
        Ok(block)
    })())
}

fn parse_content_block(data: JsonValue, on_unknown: OnUnknown) -> Result<ContentBlock, serde_json::Error> {
    let JsonValue::Object(map) = data else {
        return Err(serde_json::Error::custom("content block must be a JSON object"));
    };
    let parsed = parse_text_block(&map)
        .map(|parsed| parsed.map(ContentBlock::Text))
        .or_else(|| {
            CONTENT_BLOCK_PARSERS
                .iter()
                .find_map(|(key, parse)| map.get(*key).map(|value| parse(value, on_unknown)))
        });
    let Some(parsed) = parsed else {
        return on_unknown
            .unrecognized(map, "ContentBlockData")
            .map(ContentBlock::Unknown);
    };
    parsed.or_else(|error| on_unknown.undecodable(map, error).map(ContentBlock::Unknown))
}

/// Plain text content (`TextBlock`).
///
/// A block whose [`offloaded`](Self::offloaded) is set is the placeholder a context-manager
/// strategy left where it offloaded content (`OffloadedBlock`). It is text to every reader and
/// every model provider; only code that cares about the provenance reads `offloaded`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TextBlock {
    /// The text.
    pub text: String,
    /// What the placeholder stands for, when this block replaced offloaded content. Serialized
    /// under one `offloaded` key, whose presence alone marks stored data as a placeholder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offloaded: Option<Offloaded>,
}

impl TextBlock {
    /// Creates a text block.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            offloaded: None,
        }
    }

    /// Creates the placeholder an offload strategy leaves where it replaced content
    /// (`new OffloadedBlock`).
    pub fn offloaded(text: impl Into<String>, offloaded: Offloaded) -> Self {
        Self {
            text: text.into(),
            offloaded: Some(offloaded),
        }
    }

    /// Whether this block is an offload placeholder.
    #[must_use]
    pub fn is_offloaded(&self) -> bool {
        self.offloaded.is_some()
    }
}

/// The offload method that replaced content with a placeholder (`OffloadMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum OffloadMethod {
    /// Removed (`'drop'`).
    Drop,
    /// Shortened to a preview (`'truncate'`).
    Truncate,
    /// Replaced with a summary (`'summarize'`).
    Summarize,
}

impl OffloadMethod {
    /// The method's name, such as `drop`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drop => "drop",
            Self::Truncate => "truncate",
            Self::Summarize => "summarize",
        }
    }
}

impl fmt::Display for OffloadMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What an offload placeholder stands for (the provenance of an `OffloadedBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Offloaded {
    /// The offload method that left the placeholder.
    pub method: OffloadMethod,
    /// The stash reference the original is retrievable under; `None` when it was not stashed
    /// (`ref`).
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// The size of the content the placeholder stands for, in tokens, including any placeholder it
    /// replaced; `None` when the token count could not measure it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
}

impl Offloaded {
    /// The provenance of a placeholder left by `method`, with no reference or size.
    #[must_use]
    pub fn new(method: OffloadMethod) -> Self {
        Self {
            method,
            reference: None,
            tokens: None,
        }
    }

    /// Sets the stash reference.
    #[must_use]
    pub fn with_reference(mut self, reference: impl Into<String>) -> Self {
        self.reference = Some(reference.into());
        self
    }

    /// Sets the size in tokens.
    #[must_use]
    pub fn with_tokens(mut self, tokens: u64) -> Self {
        self.tokens = Some(tokens);
        self
    }
}

impl From<&str> for TextBlock {
    fn from(text: &str) -> Self {
        Self::new(text)
    }
}

impl From<String> for TextBlock {
    fn from(text: String) -> Self {
        Self::new(text)
    }
}

/// A tool use request from the model (`ToolUseBlock`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolUseBlock {
    /// The name of the tool to execute.
    pub name: String,
    /// Identifier for this tool use.
    pub tool_use_id: String,
    /// The tool input.
    pub input: JsonValue,
    /// Reasoning signature from thinking models, sent back unchanged for multi-turn tool use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_signature: Option<String>,
}

impl ToolUseBlock {
    /// Creates a tool use block.
    pub fn new(name: impl Into<String>, tool_use_id: impl Into<String>, input: JsonValue) -> Self {
        Self {
            name: name.into(),
            tool_use_id: tool_use_id.into(),
            input,
            reasoning_signature: None,
        }
    }

    /// Sets the reasoning signature.
    #[must_use]
    pub fn with_reasoning_signature(mut self, signature: impl Into<String>) -> Self {
        self.reasoning_signature = Some(signature.into());
        self
    }
}

/// Structured JSON content, used in tool results (`JsonBlock`), `{"json": ...}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct JsonBlock {
    /// The JSON data.
    pub json: JsonValue,
}

impl JsonBlock {
    /// Creates a JSON block.
    pub fn new(json: JsonValue) -> Self {
        Self { json }
    }
}

/// A tool whose input schema a tool result loads (`ToolReferenceBlock`), `{"toolReference": {"name": ...}}`.
///
/// `load_tools` returns one for each tool it loads, and any tool can return them too, such as a
/// custom loader that searches a tool catalog. It reaches the model as a reference only when the
/// model defers tools natively (`ModelCapabilities::deferred_tool_loading` is
/// [`DeferredToolLoading::Native`](crate::models::DeferredToolLoading::Native)), the request
/// defers this tool, and the tool result holds only such references; the provider then sends a
/// reference its API expands into the tool's definition. Otherwise the model gets the parameters
/// of the request's tool with this name as text, so a tool that changed is shown as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolReferenceBlock {
    /// Name of the tool the result loads.
    pub name: String,
}

impl ToolReferenceBlock {
    /// Creates a reference to the tool named `name`.
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

/// Content within a tool result (`ToolResultContent`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ToolResultContent {
    /// Plain text, `{"text": "..."}`.
    Text(TextBlock),
    /// Structured JSON, `{"json": ...}`.
    Json(JsonBlock),
    /// An image, `{"image": {...}}`.
    Image(ImageBlock),
    /// A video, `{"video": {...}}`.
    Video(VideoBlock),
    /// A document, `{"document": {...}}`.
    Document(DocumentBlock),
    /// A tool whose input schema the result loads, `{"toolReference": {"name": ...}}`.
    ToolReference(ToolReferenceBlock),
    /// Content of a type this version does not recognize, kept unchanged.
    Unknown(UnknownBlock),
}

impl ToolResultContent {
    /// Creates text content.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(TextBlock::new(text))
    }

    /// Creates JSON content.
    pub fn json(json: JsonValue) -> Self {
        Self::Json(JsonBlock::new(json))
    }

    /// Parses caller-supplied content, rejecting unknown types.
    ///
    /// # Errors
    ///
    /// Returns `Unknown ToolResultContentData type` for an unrecognized entry, or a decoding error.
    pub fn from_data(data: JsonValue) -> crate::Result<Self> {
        Ok(parse_tool_result_content(data, OnUnknown::Reject)?)
    }
}

impl From<TextBlock> for ToolResultContent {
    fn from(block: TextBlock) -> Self {
        Self::Text(block)
    }
}

impl From<JsonBlock> for ToolResultContent {
    fn from(block: JsonBlock) -> Self {
        Self::Json(block)
    }
}

impl From<&str> for ToolResultContent {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl From<String> for ToolResultContent {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

impl From<ImageBlock> for ToolResultContent {
    fn from(block: ImageBlock) -> Self {
        Self::Image(block)
    }
}

impl From<VideoBlock> for ToolResultContent {
    fn from(block: VideoBlock) -> Self {
        Self::Video(block)
    }
}

impl From<ToolReferenceBlock> for ToolResultContent {
    fn from(block: ToolReferenceBlock) -> Self {
        Self::ToolReference(block)
    }
}

impl From<DocumentBlock> for ToolResultContent {
    fn from(block: DocumentBlock) -> Self {
        Self::Document(block)
    }
}

impl Serialize for ToolResultContent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(block) => block.serialize(serializer),
            Self::Json(block) => block.serialize(serializer),
            Self::Image(block) => serialize_wrapped(serializer, "image", block),
            Self::Video(block) => serialize_wrapped(serializer, "video", block),
            Self::Document(block) => serialize_wrapped(serializer, "document", block),
            Self::ToolReference(block) => serialize_wrapped(serializer, "toolReference", block),
            Self::Unknown(block) => block.data.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for ToolResultContent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        parse_tool_result_content(JsonValue::deserialize(deserializer)?, OnUnknown::Keep).map_err(D::Error::custom)
    }
}

type ContentParser = fn(&JsonValue) -> Result<ToolResultContent, serde_json::Error>;

const TOOL_RESULT_CONTENT_PARSERS: [(&str, ContentParser); 5] = [
    ("json", |value| Ok(ToolResultContent::json(value.clone()))),
    ("image", |value| {
        ImageBlock::deserialize(value).map(ToolResultContent::Image)
    }),
    ("video", |value| {
        VideoBlock::deserialize(value).map(ToolResultContent::Video)
    }),
    ("document", |value| {
        DocumentBlock::deserialize(value).map(ToolResultContent::Document)
    }),
    ("toolReference", |value| {
        ToolReferenceBlock::deserialize(value).map(ToolResultContent::ToolReference)
    }),
];

fn parse_tool_result_content(data: JsonValue, on_unknown: OnUnknown) -> Result<ToolResultContent, serde_json::Error> {
    let JsonValue::Object(map) = data else {
        return Err(serde_json::Error::custom("tool result content must be a JSON object"));
    };
    let parsed = parse_text_block(&map)
        .map(|parsed| parsed.map(ToolResultContent::Text))
        .or_else(|| {
            TOOL_RESULT_CONTENT_PARSERS
                .iter()
                .find_map(|(key, parse)| map.get(*key).map(parse))
        });
    let Some(parsed) = parsed else {
        return on_unknown
            .unrecognized(map, "ToolResultContentData")
            .map(ToolResultContent::Unknown);
    };
    parsed.or_else(|error| on_unknown.undecodable(map, error).map(ToolResultContent::Unknown))
}

/// The error behind an error tool result. Shared, so results stay cheap to clone.
pub type ToolResultError = Arc<dyn StdError + Send + Sync + 'static>;

/// The result of a tool execution (`ToolResultBlock`).
///
/// `error` is available to hooks and the agent loop but is never serialized. Equality compares
/// `tool_use_id`, `status` and `content` and ignores `error`, so a restored result equals the
/// original.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolResultBlock {
    /// The id of the tool use this result answers.
    pub tool_use_id: String,
    /// Status of the tool execution.
    pub status: ToolResultStatus,
    /// The content the tool returned.
    pub content: Vec<ToolResultContent>,
    /// The original error when `status` is [`ToolResultStatus::Error`].
    #[serde(skip)]
    pub error: Option<ToolResultError>,
}

impl ToolResultBlock {
    /// Creates a tool result.
    pub fn new(tool_use_id: impl Into<String>, status: ToolResultStatus, content: Vec<ToolResultContent>) -> Self {
        Self {
            tool_use_id: tool_use_id.into(),
            status,
            content,
            error: None,
        }
    }

    /// Creates a successful tool result.
    pub fn success(tool_use_id: impl Into<String>, content: Vec<ToolResultContent>) -> Self {
        Self::new(tool_use_id, ToolResultStatus::Success, content)
    }

    /// Creates a failed tool result.
    pub fn error(tool_use_id: impl Into<String>, content: Vec<ToolResultContent>) -> Self {
        Self::new(tool_use_id, ToolResultStatus::Error, content)
    }

    /// Attaches the error that caused the result.
    #[must_use]
    pub fn with_error(mut self, error: impl Into<Box<dyn StdError + Send + Sync + 'static>>) -> Self {
        self.error = Some(Arc::from(error.into()));
        self
    }

    /// Replaces the content, keeping the tool use id, status and error (`with({ content })`).
    #[must_use]
    pub fn with_content(mut self, content: Vec<ToolResultContent>) -> Self {
        self.content = content;
        self
    }
}

impl PartialEq for ToolResultBlock {
    fn eq(&self, other: &Self) -> bool {
        self.tool_use_id == other.tool_use_id && self.status == other.status && self.content == other.content
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultBlockData {
    tool_use_id: String,
    status: ToolResultStatus,
    content: Vec<JsonValue>,
}

fn parse_tool_result(data: &JsonValue, on_unknown: OnUnknown) -> Result<ToolResultBlock, serde_json::Error> {
    let data = ToolResultBlockData::deserialize(data)?;
    let content = data
        .content
        .into_iter()
        .map(|entry| parse_tool_result_content(entry, on_unknown))
        .collect::<Result<_, _>>()?;
    Ok(ToolResultBlock::new(data.tool_use_id, data.status, content))
}

impl<'de> Deserialize<'de> for ToolResultBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        parse_tool_result(&JsonValue::deserialize(deserializer)?, OnUnknown::Keep).map_err(D::Error::custom)
    }
}

/// Model reasoning content (`ReasoningBlock`). `redacted_content` is base64 on the wire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReasoningBlock {
    /// The reasoning text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A cryptographic signature for verification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Redacted reasoning bytes.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "base64_bytes::option")]
    pub redacted_content: Option<Vec<u8>>,
}

impl ReasoningBlock {
    /// Creates an empty reasoning block.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the reasoning text.
    #[must_use]
    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// Sets the signature.
    #[must_use]
    pub fn with_signature(mut self, signature: impl Into<String>) -> Self {
        self.signature = Some(signature.into());
        self
    }

    /// Sets the redacted content.
    #[must_use]
    pub fn with_redacted_content(mut self, redacted_content: Vec<u8>) -> Self {
        self.redacted_content = Some(redacted_content);
        self
    }
}

/// The cache type of a cache point. Only `default` is supported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum CacheType {
    /// The provider's default cache.
    #[default]
    Default,
}

/// Marks where prompt caching should occur (`CachePointBlock`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CachePointBlock {
    /// The cache type.
    pub cache_type: CacheType,
    /// Cache entry TTL; the accepted values are provider-specific (Bedrock takes `5m` and `1h`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<String>,
}

impl CachePointBlock {
    /// Creates a default cache point.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the TTL.
    #[must_use]
    pub fn with_ttl(mut self, ttl: impl Into<String>) -> Self {
        self.ttl = Some(ttl.into());
        self
    }
}

/// How guardrails evaluate guard content (`GuardQualifier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum GuardQualifier {
    /// Content to check for grounding.
    GroundingSource,
    /// A user query to evaluate.
    Query,
    /// General content for guardrail evaluation.
    GuardContent,
}

/// Image format for guard content (`GuardImageFormat`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum GuardImageFormat {
    /// PNG.
    Png,
    /// JPEG.
    Jpeg,
}

/// Text evaluated by guardrails (`GuardContentText`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct GuardContentText {
    /// How this content is evaluated.
    pub qualifiers: Vec<GuardQualifier>,
    /// The text.
    pub text: String,
}

impl GuardContentText {
    /// Creates guard text.
    pub fn new(qualifiers: Vec<GuardQualifier>, text: impl Into<String>) -> Self {
        Self {
            qualifiers,
            text: text.into(),
        }
    }
}

/// Image bytes for guard content (`GuardImageSource`), base64 on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct GuardImageSource {
    /// The raw image bytes.
    #[serde(with = "base64_bytes")]
    pub bytes: Vec<u8>,
}

impl GuardImageSource {
    /// Creates an image source from bytes.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }
}

/// An image evaluated by guardrails (`GuardContentImage`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct GuardContentImage {
    /// The image format.
    pub format: GuardImageFormat,
    /// The image source.
    pub source: GuardImageSource,
}

impl GuardContentImage {
    /// Creates a guard image from bytes.
    pub fn new(format: GuardImageFormat, bytes: Vec<u8>) -> Self {
        Self {
            format,
            source: GuardImageSource::new(bytes),
        }
    }
}

/// Content for guardrail evaluation (`GuardContentBlock`): either text or an image.
///
/// Wire shape: `{"text": {...}}` or `{"image": {...}}`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GuardContentBlock {
    /// Text with evaluation qualifiers.
    Text(GuardContentText),
    /// An image.
    Image(GuardContentImage),
}

impl GuardContentBlock {
    /// The text content, if this is a text block.
    #[must_use]
    pub fn text(&self) -> Option<&GuardContentText> {
        match self {
            Self::Text(text) => Some(text),
            Self::Image(_) => None,
        }
    }

    /// The image content, if this is an image block.
    #[must_use]
    pub fn image(&self) -> Option<&GuardContentImage> {
        match self {
            Self::Image(image) => Some(image),
            Self::Text(_) => None,
        }
    }
}

impl From<GuardContentText> for GuardContentBlock {
    fn from(text: GuardContentText) -> Self {
        Self::Text(text)
    }
}

impl From<GuardContentImage> for GuardContentBlock {
    fn from(image: GuardContentImage) -> Self {
        Self::Image(image)
    }
}

impl Serialize for GuardContentBlock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(text) => serialize_wrapped(serializer, "text", text),
            Self::Image(image) => serialize_wrapped(serializer, "image", image),
        }
    }
}

#[derive(Deserialize)]
struct GuardContentBlockData {
    #[serde(default)]
    text: Option<GuardContentText>,
    #[serde(default)]
    image: Option<GuardContentImage>,
}

impl<'de> Deserialize<'de> for GuardContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let data = GuardContentBlockData::deserialize(deserializer)?;
        match (data.text, data.image) {
            (Some(text), None) => Ok(Self::Text(text)),
            (None, Some(image)) => Ok(Self::Image(image)),
            (None, None) => Err(D::Error::custom(
                "GuardContentBlock must have either text or image content",
            )),
            (Some(_), Some(_)) => Err(D::Error::custom(
                "GuardContentBlock cannot have both text and image content",
            )),
        }
    }
}

/// Text the app adds to a user turn, kept apart from the user's own words (`InjectedBlock`).
///
/// Wire shape: `{"injected": {"text": "...", "source": "..."}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct InjectedBlock {
    /// The text added to the user turn.
    pub text: String,
    /// The component that added it, such as a `ContextInjector`'s name.
    pub source: String,
}

impl InjectedBlock {
    /// Creates an injected block.
    pub fn new(text: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            source: source.into(),
        }
    }
}

/// A summary of earlier conversation history (`SummaryBlock`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct SummaryBlock {
    /// The provider that wrote the summary server-side, for example `anthropic`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// The signature the provider returned with the summary, sent back unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// The summary text.
    pub text: String,
}

impl SummaryBlock {
    /// Creates a summary block.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            provider: None,
            signature: None,
            text: text.into(),
        }
    }

    /// Sets the provider that wrote the summary.
    #[must_use]
    pub fn with_provider(mut self, provider: impl Into<String>) -> Self {
        self.provider = Some(provider.into());
        self
    }

    /// Sets the provider signature.
    #[must_use]
    pub fn with_signature(mut self, signature: impl Into<String>) -> Self {
        self.signature = Some(signature.into());
        self
    }
}

/// A content block of a type this version does not recognize (`UnknownBlock`).
///
/// Holds the raw data so it serializes back unchanged. Model providers skip it.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct UnknownBlock {
    /// The raw block data.
    pub data: JsonObject,
}

impl UnknownBlock {
    /// Wraps raw block data.
    pub fn new(data: JsonObject) -> Self {
        Self { data }
    }
}

/// A block of a system prompt (`SystemContentBlock`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SystemContentBlock {
    /// Plain text, `{"text": "..."}`.
    Text(TextBlock),
    /// A cache point, `{"cachePoint": {...}}`.
    CachePoint(CachePointBlock),
    /// Guard content, `{"guardContent": {...}}`.
    GuardContent(GuardContentBlock),
}

impl SystemContentBlock {
    /// Creates a text block.
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(TextBlock::new(text))
    }
}

impl From<TextBlock> for SystemContentBlock {
    fn from(block: TextBlock) -> Self {
        Self::Text(block)
    }
}

impl From<CachePointBlock> for SystemContentBlock {
    fn from(block: CachePointBlock) -> Self {
        Self::CachePoint(block)
    }
}

impl From<GuardContentBlock> for SystemContentBlock {
    fn from(block: GuardContentBlock) -> Self {
        Self::GuardContent(block)
    }
}

impl From<&str> for SystemContentBlock {
    fn from(text: &str) -> Self {
        Self::text(text)
    }
}

impl From<String> for SystemContentBlock {
    fn from(text: String) -> Self {
        Self::text(text)
    }
}

impl Serialize for SystemContentBlock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(block) => block.serialize(serializer),
            Self::CachePoint(block) => serialize_wrapped(serializer, "cachePoint", block),
            Self::GuardContent(block) => serialize_wrapped(serializer, "guardContent", block),
        }
    }
}

impl<'de> Deserialize<'de> for SystemContentBlock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut map = JsonObject::deserialize(deserializer)?;
        if let Some(value) = map.remove("cachePoint") {
            return CachePointBlock::deserialize(value)
                .map(Self::CachePoint)
                .map_err(D::Error::custom);
        }
        if let Some(value) = map.remove("guardContent") {
            return GuardContentBlock::deserialize(value)
                .map(Self::GuardContent)
                .map_err(D::Error::custom);
        }
        let Some(value) = map.remove("text") else {
            return Err(D::Error::custom("Unknown SystemContentBlockData type"));
        };
        String::deserialize(value)
            .map(|text| Self::Text(TextBlock::new(text)))
            .map_err(D::Error::custom)
    }
}

/// The system prompt (`SystemPrompt`): a string, or blocks for caching and guardrails.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SystemPrompt {
    /// A plain string.
    Text(String),
    /// Content blocks.
    Blocks(Vec<SystemContentBlock>),
}

impl From<&str> for SystemPrompt {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for SystemPrompt {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<Vec<SystemContentBlock>> for SystemPrompt {
    fn from(blocks: Vec<SystemContentBlock>) -> Self {
        Self::Blocks(blocks)
    }
}

impl Serialize for SystemPrompt {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Text(text) => serializer.serialize_str(text),
            Self::Blocks(blocks) => blocks.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for SystemPrompt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match JsonValue::deserialize(deserializer)? {
            JsonValue::String(text) => Ok(Self::Text(text)),
            blocks @ JsonValue::Array(_) => Vec::deserialize(blocks).map(Self::Blocks).map_err(D::Error::custom),
            _ => Err(D::Error::custom("system prompt must be a string or an array of blocks")),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::types::VideoSource;
    use crate::types::{AudioFormat, AudioSource, Citation, CitationGeneratedContent, DocumentCharLocation};
    use crate::types::{CitationSourceContent, DocumentFormat, DocumentSource, ImageFormat, ImageSource, VideoFormat};

    fn round_trip_block(block: &ContentBlock) {
        let json = serde_json::to_value(block).unwrap();
        assert_eq!(&serde_json::from_value::<ContentBlock>(json).unwrap(), block);
    }

    fn usage(input: u64, output: u64) -> Usage {
        Usage::new(input, output, input + output)
    }

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Captured {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn capture_warnings<T>(f: impl FnOnce() -> T) -> (T, String) {
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .without_time()
            .with_level(false)
            .with_target(false)
            .finish();
        let result = tracing::subscriber::with_default(subscriber, f);
        let output = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
        (result, output)
    }

    #[test]
    fn creates_message_with_role_and_content() {
        let message = Message::new(Role::User, vec![TextBlock::new("test").into()]);
        assert_eq!(message.role, Role::User);
        assert_eq!(message.content, vec![ContentBlock::text("test")]);
        assert!(!message.tracking_id.is_empty());
    }

    #[test]
    fn creates_message_without_metadata() {
        assert_eq!(Message::user("test").metadata, None);
    }

    #[test]
    fn creates_message_with_metadata() {
        let metadata = MessageMetadata::new()
            .with_usage(usage(10, 5))
            .with_metrics(Metrics::new(100));
        let message = Message::assistant("hello").with_metadata(metadata.clone());
        assert_eq!(message.metadata, Some(metadata));
    }

    #[test]
    fn creates_message_with_custom_metadata() {
        let custom = json!({"source": "summarization", "originalTurns": [5, 6, 7]});
        let metadata = MessageMetadata::new().with_custom(custom.as_object().unwrap().clone());
        let message = Message::assistant("summary").with_metadata(metadata);
        assert_eq!(
            serde_json::to_value(&message.metadata).unwrap(),
            json!({"custom": {"source": "summarization", "originalTurns": [5, 6, 7]}})
        );
    }

    #[test]
    fn to_json_includes_metadata_when_present() {
        let metadata = MessageMetadata::new()
            .with_usage(usage(42, 10))
            .with_metrics(Metrics::new(200));
        let json = serde_json::to_value(Message::assistant("test").with_metadata(metadata)).unwrap();
        assert_eq!(
            json["metadata"],
            json!({"usage": {"inputTokens": 42, "outputTokens": 10, "totalTokens": 52}, "metrics": {"latencyMs": 200}})
        );
    }

    #[test]
    fn to_json_omits_metadata_when_not_present() {
        let json = serde_json::to_value(Message::user("test")).unwrap();
        assert!(json.get("metadata").is_none());
    }

    #[test]
    fn from_message_data_preserves_metadata() {
        let message = Message::from_message_data(json!({
            "role": "assistant",
            "content": [{"text": "hello"}],
            "metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}, "metrics": {"latencyMs": 100}}
        }))
        .unwrap();
        let metadata = MessageMetadata::new()
            .with_usage(usage(10, 5))
            .with_metrics(Metrics::new(100));
        assert_eq!(message.metadata, Some(metadata));
    }

    #[test]
    fn from_message_data_works_without_metadata() {
        let message = Message::from_message_data(json!({"role": "user", "content": [{"text": "hello"}]})).unwrap();
        assert_eq!(message.metadata, None);
    }

    #[test]
    fn round_trips_metadata_through_to_json_from_json() {
        let metadata = MessageMetadata::new()
            .with_usage(usage(42, 10))
            .with_metrics(Metrics::new(200))
            .with_custom(json!({"source": "test"}).as_object().unwrap().clone());
        let original = Message::assistant("test").with_metadata(metadata.clone());
        let restored: Message = serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
        assert_eq!(restored.metadata, Some(metadata));
    }

    #[test]
    fn round_trips_metadata_through_json_stringify_parse() {
        let original = Message::assistant("test").with_metadata(MessageMetadata::new().with_usage(usage(1, 1)));
        let restored: Message = serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        assert_eq!(restored, original);
    }

    #[test]
    fn constructor_mints_a_uuid_tracking_id_by_default() {
        let id = uuid::Uuid::parse_str(&Message::user("test").tracking_id).unwrap();
        assert_eq!(id.get_version_num(), 4);
    }

    #[test]
    fn two_messages_get_distinct_tracking_ids() {
        assert_ne!(Message::user("test").tracking_id, Message::user("test").tracking_id);
    }

    #[test]
    fn constructor_preserves_an_explicit_id() {
        assert_eq!(Message::user("test").with_tracking_id("abc123").tracking_id, "abc123");
    }

    #[test]
    fn constructor_mints_when_given_an_empty_string_id() {
        assert!(!Message::user("test").with_tracking_id("").tracking_id.is_empty());
        let restored: Message =
            serde_json::from_value(json!({"role": "user", "content": [], "trackingId": ""})).unwrap();
        assert!(!restored.tracking_id.is_empty());
    }

    #[test]
    fn generate_tracking_id_produces_unique_strings() {
        let ids: std::collections::HashSet<_> = (0..1000).map(|_| generate_tracking_id()).collect();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn to_json_includes_the_tracking_id() {
        let json = serde_json::to_value(Message::assistant("test").with_tracking_id("abc123")).unwrap();
        assert_eq!(json["trackingId"], "abc123");
    }

    #[test]
    fn from_message_data_preserves_id() {
        let data = json!({"role": "assistant", "content": [{"text": "hello"}], "trackingId": "abc123"});
        assert_eq!(Message::from_message_data(data).unwrap().tracking_id, "abc123");
    }

    #[test]
    fn from_message_data_backfills_a_tracking_id_when_serialized_data_omits_it() {
        let data = json!({"role": "assistant", "content": [{"text": "hello"}]});
        assert!(!Message::from_message_data(data).unwrap().tracking_id.is_empty());
    }

    #[test]
    fn round_trips_id_through_to_json_from_json() {
        let original = Message::assistant("test").with_tracking_id("durable-1");
        let restored: Message = serde_json::from_value(serde_json::to_value(&original).unwrap()).unwrap();
        assert_eq!(restored.tracking_id, "durable-1");
    }

    #[test]
    fn clone_preserves_id() {
        let original = Message::assistant("test").with_tracking_id("durable-1");
        let copy = original.clone();
        assert_eq!(copy.tracking_id, "durable-1");
        assert_eq!(copy, original);
    }

    #[test]
    fn creates_text_block_with_text() {
        assert_eq!(TextBlock::new("hello").text, "hello");
        assert_eq!(TextBlock::from("hello"), TextBlock::new("hello"));
    }

    #[test]
    fn creates_tool_use_block() {
        let block = ToolUseBlock::new("test-tool", "123", json!({"param": "value"}));
        assert_eq!(
            serde_json::to_value(ContentBlock::ToolUse(block)).unwrap(),
            json!({"toolUse": {"name": "test-tool", "toolUseId": "123", "input": {"param": "value"}}})
        );
    }

    #[test]
    fn creates_tool_result_block() {
        let block = ToolResultBlock::success("123", vec![ToolResultContent::text("result")]);
        assert_eq!(block.status, ToolResultStatus::Success);
        assert_eq!(block.content, vec![ToolResultContent::text("result")]);
    }

    #[test]
    fn creates_reasoning_block_with_text() {
        let block = ReasoningBlock::new().with_text("thinking...");
        assert_eq!(block.text.as_deref(), Some("thinking..."));
        assert_eq!((block.signature, block.redacted_content), (None, None));
    }

    #[test]
    fn creates_cache_point_block() {
        assert_eq!(CachePointBlock::new().cache_type, CacheType::Default);
    }

    #[test]
    fn creates_cache_point_block_with_ttl() {
        assert_eq!(CachePointBlock::new().with_ttl("1h").ttl.as_deref(), Some("1h"));
    }

    #[test]
    fn serializes_ttl_in_to_json() {
        assert_eq!(
            serde_json::to_value(ContentBlock::CachePoint(CachePointBlock::new().with_ttl("5m"))).unwrap(),
            json!({"cachePoint": {"cacheType": "default", "ttl": "5m"}})
        );
    }

    #[test]
    fn omits_ttl_in_to_json_when_not_set() {
        assert_eq!(
            serde_json::to_value(ContentBlock::CachePoint(CachePointBlock::new())).unwrap(),
            json!({"cachePoint": {"cacheType": "default"}})
        );
    }

    #[test]
    fn roundtrips_ttl_via_from_json() {
        let block: ContentBlock =
            serde_json::from_value(json!({"cachePoint": {"cacheType": "default", "ttl": "1h"}})).unwrap();
        assert_eq!(block, ContentBlock::CachePoint(CachePointBlock::new().with_ttl("1h")));
    }

    #[test]
    fn roundtrips_through_to_json_and_content_block_from_data() {
        let block = ContentBlock::Summary(
            SummaryBlock::new("summary")
                .with_provider("anthropic")
                .with_signature("sig"),
        );
        let json = serde_json::to_value(&block).unwrap();
        assert_eq!(
            json,
            json!({"summary": {"provider": "anthropic", "signature": "sig", "text": "summary"}})
        );
        assert_eq!(ContentBlock::from_data(json).unwrap(), block);
    }

    #[test]
    fn omits_unset_provider_and_signature_in_to_json() {
        assert_eq!(
            serde_json::to_value(ContentBlock::Summary(SummaryBlock::new("summary"))).unwrap(),
            json!({"summary": {"text": "summary"}})
        );
    }

    #[test]
    fn drops_a_null_signature_written_by_the_python_sdk() {
        let block = ContentBlock::from_data(
            json!({"summary": {"provider": "anthropic", "signature": null, "text": "summary"}}),
        )
        .unwrap();
        let ContentBlock::Summary(summary) = &block else {
            panic!("expected a summary block");
        };
        assert_eq!(summary.signature, None);
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"summary": {"provider": "anthropic", "text": "summary"}})
        );
    }

    #[test]
    fn creates_json_block() {
        assert_eq!(JsonBlock::new(json!({"key": "value"})).json, json!({"key": "value"}));
    }

    #[test]
    fn creates_injected_block_with_text() {
        let block = InjectedBlock::new("reminder", "test");
        assert_eq!((block.text.as_str(), block.source.as_str()), ("reminder", "test"));
    }

    #[test]
    fn creates_unknown_block_holding_the_raw_data() {
        let data = json!({"futureBlock": {"value": 1}}).as_object().unwrap().clone();
        assert_eq!(UnknownBlock::new(data.clone()).data, data);
    }

    #[test]
    fn converts_text_block_data_to_text_block() {
        let message = Message::from_message_data(json!({"role": "user", "content": [{"text": "hello"}]})).unwrap();
        assert_eq!(message.content, vec![ContentBlock::text("hello")]);
    }

    #[test]
    fn converts_tool_use_block_data_to_tool_use_block() {
        let message = Message::from_message_data(json!({
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tool-123", "name": "test-tool", "input": {"key": "value"}}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![ToolUseBlock::new("test-tool", "tool-123", json!({"key": "value"})).into()]
        );
    }

    #[test]
    fn converts_tool_result_block_data_to_tool_result_block_with_text_content() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tool-123", "status": "success", "content": [{"text": "Result text"}]}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![ToolResultBlock::success("tool-123", vec![ToolResultContent::text("Result text")]).into()]
        );
    }

    #[test]
    fn converts_tool_result_block_data_to_tool_result_block_with_json_content() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tool-123", "status": "success", "content": [{"json": {"result": "data"}}]}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![ToolResultBlock::success("tool-123", vec![ToolResultContent::json(json!({"result": "data"}))]).into()]
        );
    }

    #[test]
    fn converts_reasoning_block_data_to_reasoning_block() {
        let message = Message::from_message_data(
            json!({"role": "assistant", "content": [{"reasoning": {"text": "Let me think"}}]}),
        )
        .unwrap();
        assert_eq!(
            message.content,
            vec![ReasoningBlock::new().with_text("Let me think").into()]
        );
    }

    #[test]
    fn converts_cache_point_block_data_to_cache_point_block() {
        let message =
            Message::from_message_data(json!({"role": "user", "content": [{"cachePoint": {"cacheType": "default"}}]}))
                .unwrap();
        assert_eq!(message.content, vec![CachePointBlock::new().into()]);
    }

    #[test]
    fn converts_guard_content_block_data_to_guard_content_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"guardContent": {"text": {"text": "guard this content", "qualifiers": ["guard_content"]}}}]
        }))
        .unwrap();
        let expected = GuardContentBlock::Text(GuardContentText::new(
            vec![GuardQualifier::GuardContent],
            "guard this content",
        ));
        assert_eq!(message.content, vec![expected.into()]);
    }

    #[test]
    fn converts_injected_block_data_to_injected_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"injected": {"text": "reminder", "source": "test"}}]
        }))
        .unwrap();
        assert_eq!(message.content, vec![InjectedBlock::new("reminder", "test").into()]);
    }

    #[test]
    fn keeps_an_injected_block_passed_inside_message_data_an_injected_block() {
        let block = ContentBlock::Injected(InjectedBlock::new("reminder", "test"));
        let data = json!({"role": "user", "content": [serde_json::to_value(&block).unwrap()]});
        assert_eq!(Message::from_message_data(data).unwrap().content, vec![block]);
    }

    #[test]
    fn converts_audio_block_data_to_audio_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"audio": {"format": "mp3", "source": {"bytes": [1, 2, 3]}}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(vec![1, 2, 3])).into()]
        );
    }

    #[test]
    fn converts_image_block_data_to_image_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"image": {"format": "png", "source": {"bytes": "AQID"}}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3])).into()]
        );
    }

    #[test]
    fn converts_video_block_data_to_video_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"video": {"format": "mp4", "source": {"bytes": "AQID"}}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![1, 2, 3])).into()]
        );
    }

    #[test]
    fn converts_document_block_data_to_document_block() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [{"document": {"name": "test.pdf", "format": "pdf", "source": {"bytes": "AQID"}}}]
        }))
        .unwrap();
        assert_eq!(
            message.content,
            vec![DocumentBlock::new("test.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(vec![1, 2, 3])).into()]
        );
    }

    #[test]
    fn converts_citations_content_block_data_to_citations_block() {
        let message = Message::from_message_data(json!({
            "role": "assistant",
            "content": [{"citations": {
                "citations": [{
                    "location": {"type": "documentChar", "documentIndex": 0, "start": 0, "end": 10},
                    "source": "doc-0",
                    "sourceContent": [{"text": "source"}],
                    "title": "Test Doc"
                }],
                "content": [{"text": "generated"}]
            }}]
        }))
        .unwrap();
        let expected = CitationsBlock::new(
            vec![Citation::new(
                DocumentCharLocation::new(0, 0, 10),
                "doc-0",
                vec![CitationSourceContent::new("source")],
                "Test Doc",
            )],
            vec![CitationGeneratedContent::new("generated")],
        );
        assert_eq!(message.content, vec![expected.into()]);
    }

    #[test]
    fn converts_multiple_content_blocks() {
        let message = Message::from_message_data(json!({
            "role": "user",
            "content": [
                {"text": "First block"},
                {"toolUse": {"toolUseId": "tool-1", "name": "test-tool", "input": {}}},
                {"text": "Second block"}
            ]
        }))
        .unwrap();
        assert_eq!(message.content.len(), 3);
        assert_eq!(message.text(), "First blockSecond block");
    }

    #[test]
    fn throws_error_for_unknown_content_block_type() {
        let error =
            Message::from_message_data(json!({"role": "user", "content": [{"unknownType": {"data": "value"}}]}))
                .unwrap_err();
        assert_eq!(error.to_string(), "Unknown ContentBlockData type");
    }

    #[test]
    fn content_block_from_saved_data_keeps_it_as_an_unknown_block_and_warns() {
        let (block, logs) =
            capture_warnings(|| serde_json::from_value::<ContentBlock>(json!({"futureBlock": {"value": 1}})));
        assert_eq!(
            block.unwrap(),
            ContentBlock::Unknown(UnknownBlock::new(
                json!({"futureBlock": {"value": 1}}).as_object().unwrap().clone()
            ))
        );
        assert_eq!(
            logs.trim(),
            "block_keys=<futureBlock> | unrecognized content block type | keeping it in history and leaving it out of model requests | if a newer sdk version saved it, upgrade to use it"
        );
    }

    #[test]
    fn content_block_from_saved_data_keeps_unknown_content_inside_a_tool_result_and_serializes_it_back_unchanged() {
        let saved = json!({"toolResult": {
            "toolUseId": "tool-1",
            "status": "success",
            "content": [{"text": "loaded"}, {"futureBlock": {"name": "shell"}}]
        }});
        let block: ContentBlock = serde_json::from_value(saved.clone()).unwrap();
        let unknown = UnknownBlock::new(json!({"futureBlock": {"name": "shell"}}).as_object().unwrap().clone());
        assert_eq!(
            block,
            ToolResultBlock::success(
                "tool-1",
                vec![ToolResultContent::text("loaded"), ToolResultContent::Unknown(unknown)]
            )
            .into()
        );
        assert_eq!(serde_json::to_value(&block).unwrap(), saved);
    }

    #[test]
    fn tool_reference_block_roundtrips_inside_a_tool_result_through_to_json_and_message_from_json() {
        let message = Message::new(
            Role::User,
            vec![ToolResultBlock::success("tool-1", vec![ToolReferenceBlock::new("shell").into()]).into()],
        );
        let data = serde_json::to_value(&message).unwrap();
        assert_eq!(
            data["content"][0],
            json!({"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"toolReference": {"name": "shell"}}]}})
        );
        let restored: Message = serde_json::from_value(data).unwrap();
        assert_eq!(restored, message);
    }

    #[test]
    fn tool_reference_block_is_converted_by_tool_result_content_from_data() {
        assert_eq!(
            ToolResultContent::from_data(json!({"toolReference": {"name": "shell"}})).unwrap(),
            ToolResultContent::ToolReference(ToolReferenceBlock::new("shell"))
        );
    }

    #[test]
    fn content_block_from_data_still_throws_on_unknown_content_inside_a_tool_result() {
        let data =
            json!({"toolResult": {"toolUseId": "tool-1", "status": "success", "content": [{"futureBlock": {}}]}});
        assert_eq!(
            ContentBlock::from_data(data).unwrap_err().to_string(),
            "Unknown ToolResultContentData type"
        );
    }

    #[test]
    fn tool_result_block_from_json_keeps_unknown_content() {
        let block: ToolResultBlock = serde_json::from_value(
            json!({"toolUseId": "tool-1", "status": "success", "content": [{"futureBlock": {}}]}),
        )
        .unwrap();
        assert_eq!(
            block.content,
            vec![ToolResultContent::Unknown(UnknownBlock::new(
                json!({"futureBlock": {}}).as_object().unwrap().clone()
            ))]
        );
    }

    #[test]
    fn content_block_from_saved_data_converts_known_types_as_usual_without_a_warning() {
        let (block, logs) = capture_warnings(|| serde_json::from_value::<ContentBlock>(json!({"text": "Hello"})));
        assert_eq!(block.unwrap(), ContentBlock::text("Hello"));
        assert_eq!(logs, "");
    }

    #[test]
    fn message_from_json_restores_the_message_and_serializes_it_back_unchanged() {
        let saved = json!({
            "role": "assistant",
            "content": [{"text": "Hello"}, {"futureBlock": {"nested": {"a": 1}, "items": [1, "two", null]}}],
            "trackingId": "durable-1"
        });
        let message: Message = serde_json::from_value(saved.clone()).unwrap();
        assert!(matches!(message.content[1], ContentBlock::Unknown(_)));
        assert_eq!(serde_json::to_value(&message).unwrap(), saved);
        assert_eq!(
            serde_json::to_string(&message).unwrap(),
            serde_json::to_string(&saved).unwrap()
        );
    }

    #[test]
    fn message_clone_keeps_the_unknown_block_without_warning_again() {
        let message: Message = serde_json::from_value(json!({
            "role": "assistant",
            "content": [{"futureBlock": {"a": 1}}],
            "trackingId": "durable-1"
        }))
        .unwrap();
        let (copy, logs) = capture_warnings(|| message.clone());
        assert_eq!(copy, message);
        assert_eq!(logs, "");
    }

    #[test]
    fn system_prompt_returns_the_string_unchanged() {
        let prompt: SystemPrompt = serde_json::from_value(json!("You are a helpful assistant")).unwrap();
        assert_eq!(prompt, SystemPrompt::from("You are a helpful assistant"));
        assert_eq!(
            serde_json::to_value(&prompt).unwrap(),
            json!("You are a helpful assistant")
        );
    }

    #[test]
    fn system_prompt_converts_all_block_types_correctly() {
        let data = json!([
            {"text": "System prompt"},
            {"cachePoint": {"cacheType": "default"}},
            {"guardContent": {"text": {"text": "guard", "qualifiers": ["guard_content"]}}}
        ]);
        let prompt: SystemPrompt = serde_json::from_value(data.clone()).unwrap();
        assert_eq!(
            prompt,
            SystemPrompt::Blocks(vec![
                SystemContentBlock::Text(TextBlock::new("System prompt")),
                SystemContentBlock::CachePoint(CachePointBlock::new()),
                SystemContentBlock::GuardContent(GuardContentBlock::Text(GuardContentText::new(
                    vec![GuardQualifier::GuardContent],
                    "guard"
                ))),
            ])
        );
        assert_eq!(serde_json::to_value(&prompt).unwrap(), data);
    }

    #[test]
    fn system_prompt_returns_empty_array() {
        let prompt: SystemPrompt = serde_json::from_value(json!([])).unwrap();
        assert_eq!(prompt, SystemPrompt::Blocks(Vec::new()));
        assert_eq!(serde_json::to_value(&prompt).unwrap(), json!([]));
    }

    #[test]
    fn system_prompt_throws_error_for_unknown_block_type() {
        let error = serde_json::from_value::<SystemPrompt>(json!([{"unknown": "x"}])).unwrap_err();
        assert_eq!(error.to_string(), "Unknown SystemContentBlockData type");
    }

    #[test]
    fn round_trips_every_block_type() {
        let blocks: Vec<ContentBlock> = vec![
            ContentBlock::text("Hello world"),
            ToolUseBlock::new("test-tool", "123", json!({"param": "value"})).into(),
            ToolUseBlock::new("test-tool", "123", json!({"param": "value"}))
                .with_reasoning_signature("sig123")
                .into(),
            ToolResultBlock::success("123", vec![ToolResultContent::text("Result text")]).into(),
            ToolResultBlock::success("456", vec![ToolResultContent::json(json!({"result": "data"}))]).into(),
            ToolResultBlock::error("789", vec![ToolResultContent::text("Error message")]).into(),
            ReasoningBlock::new().with_text("Thinking...").into(),
            ReasoningBlock::new()
                .with_text("Thinking...")
                .with_signature("sig123")
                .into(),
            ReasoningBlock::new().with_redacted_content(vec![1, 2, 3]).into(),
            CachePointBlock::new().into(),
            InjectedBlock::new("reminder", "test").into(),
            GuardContentBlock::Text(GuardContentText::new(vec![GuardQualifier::GuardContent], "Guard this")).into(),
            GuardContentBlock::Image(GuardContentImage::new(GuardImageFormat::Png, vec![1, 2, 3])).into(),
            AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(vec![1, 2, 3])).into(),
            UnknownBlock::new(
                json!({"futureBlock": {"nested": {"a": 1}}})
                    .as_object()
                    .unwrap()
                    .clone(),
            )
            .into(),
            ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3])).into(),
            CitationsBlock::new(
                vec![Citation::new(
                    DocumentCharLocation::new(0, 0, 10),
                    "doc-0",
                    vec![CitationSourceContent::new("source")],
                    "Test",
                )],
                vec![CitationGeneratedContent::new("generated")],
            )
            .into(),
        ];
        for block in &blocks {
            round_trip_block(block);
        }
        let messages = [
            Message::user("Hello"),
            Message::new(
                Role::Assistant,
                vec![
                    ContentBlock::text("Here is the result"),
                    ToolUseBlock::new("test-tool", "123", json!({"key": "value"})).into(),
                ],
            ),
            Message::new(
                Role::User,
                vec![
                    ContentBlock::text("Check this image"),
                    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3])).into(),
                ],
            ),
        ];
        for message in &messages {
            let restored: Message = serde_json::from_value(serde_json::to_value(message).unwrap()).unwrap();
            assert_eq!(&restored, message);
        }
    }

    #[test]
    fn message_works_with_json_stringify() {
        let original = Message::user("Test");
        let restored: Message = serde_json::from_str(&serde_json::to_string(&original).unwrap()).unwrap();
        assert_eq!(restored, original);
    }

    #[test]
    fn reasoning_block_from_json_accepts_base64_string_for_redacted_content() {
        let block: ContentBlock =
            serde_json::from_value(json!({"reasoning": {"redactedContent": "AQIDBAU="}})).unwrap();
        assert_eq!(
            block,
            ReasoningBlock::new().with_redacted_content(vec![1, 2, 3, 4, 5]).into()
        );
    }

    #[test]
    fn guard_content_block_from_json_accepts_base64_string_for_image_bytes() {
        let block: GuardContentBlock =
            serde_json::from_value(json!({"image": {"format": "png", "source": {"bytes": "ChQe"}}})).unwrap();
        assert_eq!(block.image().unwrap().source.bytes, vec![10, 20, 30]);
    }

    #[test]
    fn guard_content_block_requires_exactly_one_of_text_or_image() {
        let neither = serde_json::from_value::<GuardContentBlock>(json!({})).unwrap_err();
        assert_eq!(
            neither.to_string(),
            "GuardContentBlock must have either text or image content"
        );
        let both = serde_json::from_value::<GuardContentBlock>(json!({
            "text": {"qualifiers": [], "text": "t"},
            "image": {"format": "png", "source": {"bytes": ""}}
        }))
        .unwrap_err();
        assert_eq!(
            both.to_string(),
            "GuardContentBlock cannot have both text and image content"
        );
    }

    #[test]
    fn text_block_returns_unwrapped_format() {
        assert_eq!(
            serde_json::to_value(ContentBlock::text("Test")).unwrap(),
            json!({"text": "Test"})
        );
    }

    #[test]
    fn json_block_returns_unwrapped_format() {
        assert_eq!(
            serde_json::to_value(ToolResultContent::json(json!({"test": true}))).unwrap(),
            json!({"json": {"test": true}})
        );
    }

    #[test]
    fn injected_block_returns_wrapped_format() {
        assert_eq!(
            serde_json::to_value(ContentBlock::Injected(InjectedBlock::new("reminder", "test"))).unwrap(),
            json!({"injected": {"text": "reminder", "source": "test"}})
        );
    }

    #[test]
    fn tool_use_block_omits_undefined_reasoning_signature() {
        let json = serde_json::to_value(ToolUseBlock::new("test-tool", "123", json!({}))).unwrap();
        assert!(json.get("reasoningSignature").is_none());
    }

    #[test]
    fn tool_result_block_does_not_serialize_error_field() {
        let block = ToolResultBlock::error("123", vec![ToolResultContent::text("Error")])
            .with_error(io::Error::other("Test error"));
        let json = serde_json::to_value(&block).unwrap();
        assert!(json.get("error").is_none());
        assert_eq!(block.error.unwrap().to_string(), "Test error");
    }

    #[test]
    fn reasoning_block_encodes_redacted_content_as_base64() {
        let json = serde_json::to_value(ReasoningBlock::new().with_redacted_content(vec![1, 2, 3])).unwrap();
        assert_eq!(json, json!({"redactedContent": "AQID"}));
    }

    #[test]
    fn reasoning_block_omits_undefined_fields() {
        assert_eq!(
            serde_json::to_value(ReasoningBlock::new().with_text("Test")).unwrap(),
            json!({"text": "Test"})
        );
    }

    #[test]
    fn guard_content_block_encodes_image_bytes_as_base64() {
        let block = GuardContentBlock::Image(GuardContentImage::new(GuardImageFormat::Jpeg, vec![1, 2, 3]));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"image": {"format": "jpeg", "source": {"bytes": "AQID"}}})
        );
    }

    #[test]
    fn saved_blocks_that_fail_to_decode_load_as_unknown_and_round_trip() {
        let saved = json!({
            "role": "user",
            "content": [
                {"image": {"format": "heic", "source": {"bytes": "AQID"}}},
                {"toolResult": {"toolUseId": "t-1", "status": "success", "content": [
                    {"text": "ok"},
                    {"video": {"format": "avi", "source": {"bytes": "AQID"}}}
                ]}}
            ],
            "trackingId": "m-1"
        });
        let (message, logs) = capture_warnings(|| serde_json::from_value::<Message>(saved.clone()).unwrap());
        assert!(matches!(message.content[0], ContentBlock::Unknown(_)));
        let ContentBlock::ToolResult(result) = &message.content[1] else {
            panic!("expected a tool result");
        };
        assert!(matches!(result.content[1], ToolResultContent::Unknown(_)));
        assert_eq!(serde_json::to_value(&message).unwrap(), saved);
        assert!(logs.contains("block_keys=<image> | unrecognized content block type"));
        assert!(logs.contains("block_keys=<video> | unrecognized content block type"));
    }

    #[test]
    fn from_data_rejects_a_known_block_that_fails_to_decode() {
        let error =
            ContentBlock::from_data(json!({"image": {"format": "heic", "source": {"bytes": "AQID"}}})).unwrap_err();
        assert!(error.to_string().contains("heic"));
    }

    #[test]
    fn conversions_build_every_block_kind() {
        assert_eq!(ToolResultContent::from("a"), ToolResultContent::text("a"));
        assert_eq!(ToolResultContent::from(String::from("a")), ToolResultContent::text("a"));
        let image = ImageBlock::new(ImageFormat::Png, ImageSource::Url("https://example.com/a.png".into()));
        assert_eq!(ToolResultContent::from(image.clone()), ToolResultContent::Image(image));
        let text = GuardContentText::new(vec![GuardQualifier::Query], "q");
        assert_eq!(GuardContentBlock::from(text.clone()), GuardContentBlock::Text(text));
        assert_eq!(SystemContentBlock::from("p"), SystemContentBlock::text("p"));
        assert_eq!(
            SystemContentBlock::from(CachePointBlock::new()),
            SystemContentBlock::CachePoint(CachePointBlock::new())
        );
    }

    #[test]
    fn message_text_concatenates_text_blocks() {
        let message = Message::new(
            Role::Assistant,
            vec!["a".into(), ToolUseBlock::new("t", "1", json!({})).into(), "b".into()],
        );
        assert_eq!(message.text(), "ab");
    }

    fn dropped(reference: Option<&str>, tokens: Option<u64>) -> TextBlock {
        let mut offloaded = Offloaded::new(OffloadMethod::Drop);
        offloaded.reference = reference.map(str::to_owned);
        offloaded.tokens = tokens;
        TextBlock::offloaded("[Dropped] [ref: tu-1]", offloaded)
    }

    #[test]
    fn an_offloaded_block_is_a_text_block_that_serializes_what_it_stands_in_for_beside_the_text() {
        let block = ContentBlock::Text(dropped(Some("tu-1"), None));
        assert_eq!(block.as_text(), Some("[Dropped] [ref: tu-1]"));
        let data = serde_json::to_value(&block).unwrap();
        assert_eq!(
            data,
            json!({"text": "[Dropped] [ref: tu-1]", "offloaded": {"method": "drop", "ref": "tu-1"}})
        );
        assert_eq!(ContentBlock::from_data(data).unwrap(), block);
    }

    #[test]
    fn an_offloaded_block_omits_a_ref_and_token_count_it_was_not_given() {
        let block = TextBlock::offloaded("[Dropped]", Offloaded::new(OffloadMethod::Drop));
        assert_eq!(
            serde_json::to_value(&block).unwrap(),
            json!({"text": "[Dropped]", "offloaded": {"method": "drop"}})
        );
    }

    #[test]
    fn a_plain_text_block_carries_and_serializes_no_offloaded_field() {
        let block = TextBlock::new("hello");
        assert_eq!(serde_json::to_value(&block).unwrap(), json!({"text": "hello"}));
        assert!(!block.is_offloaded());
        let parsed = ContentBlock::from_data(json!({"text": "hello"})).unwrap();
        assert_eq!(parsed, ContentBlock::Text(block));
    }

    #[test]
    fn an_offloaded_block_round_trips_through_message_data_at_top_level_and_inside_a_tool_result() {
        let truncated = TextBlock::offloaded(
            "row-1 [ref: tu-1]",
            Offloaded::new(OffloadMethod::Truncate).with_reference("tu-1"),
        );
        let message = Message::new(
            Role::User,
            vec![
                ContentBlock::Text(TextBlock::offloaded(
                    "[Dropped] [ref: msg-1_0]",
                    Offloaded::new(OffloadMethod::Drop).with_reference("msg-1_0"),
                )),
                ContentBlock::ToolResult(ToolResultBlock::success(
                    "tu-1",
                    vec![ToolResultContent::Text(truncated)],
                )),
            ],
        )
        .with_tracking_id("msg-1");
        let data = serde_json::to_value(&message).unwrap();
        assert_eq!(
            data["content"],
            json!([
                {"text": "[Dropped] [ref: msg-1_0]", "offloaded": {"method": "drop", "ref": "msg-1_0"}},
                {"toolResult": {"toolUseId": "tu-1", "status": "success", "content": [
                    {"text": "row-1 [ref: tu-1]", "offloaded": {"method": "truncate", "ref": "tu-1"}}
                ]}}
            ])
        );
        assert_eq!(Message::from_message_data(data.clone()).unwrap(), message);
        assert_eq!(serde_json::from_value::<Message>(data).unwrap(), message);
    }

    #[test]
    fn with_content_replaces_content_keeping_role_tracking_id_and_metadata() {
        let mut custom = JsonObject::new();
        custom.insert("pinned".to_owned(), JsonValue::Bool(true));
        let metadata = MessageMetadata::new().with_custom(custom);
        let message = Message::user("a")
            .with_tracking_id("m1")
            .with_metadata(metadata.clone());
        let copy = message.clone().with_content(vec![ContentBlock::text("b")]);
        assert_eq!(copy, Message::user("b").with_tracking_id("m1").with_metadata(metadata));
        assert_eq!(message.content, [ContentBlock::text("a")]);
    }

    #[test]
    fn tool_result_with_content_replaces_content_keeping_tool_use_id_status_and_error() {
        let block =
            ToolResultBlock::error("t", vec![ToolResultContent::text("a")]).with_error(std::io::Error::other("boom"));
        let copy = block.with_content(vec![ToolResultContent::text("b")]);
        assert_eq!(copy, ToolResultBlock::error("t", vec![ToolResultContent::text("b")]));
        assert!(copy.error.is_some());
    }
}
