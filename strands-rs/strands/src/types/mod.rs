//! Core data types: messages, content blocks, media, citations, tools, stop reasons, snapshots and
//! interrupt responses.

mod agent_metadata;
mod citations;
mod interrupt;
pub(crate) mod json;
pub(crate) mod media;
mod messages;
#[cfg(test)]
pub(crate) use messages::test_ids;
mod snapshot;
mod stop_reason;
mod toggle;
mod tools;

pub use agent_metadata::AgentMetadata;
pub use citations::{
    Citation, CitationGeneratedContent, CitationLocation, CitationSourceContent, CitationsBlock, DocumentCharLocation,
    DocumentChunkLocation, DocumentPageLocation, SearchResultLocation, WebLocation,
};
pub use interrupt::{InterruptParams, InterruptResponse, InterruptResponseContent};
pub use json::{JsonObject, JsonSchema, JsonValue};
pub use media::{
    AudioBlock, AudioFormat, AudioSource, DocumentBlock, DocumentCitations, DocumentContentBlock, DocumentFormat,
    DocumentSource, ImageBlock, ImageFormat, ImageSource, S3Location, VideoBlock, VideoFormat, VideoSource,
};
pub use messages::{
    CachePointBlock, CacheType, ContentBlock, GuardContentBlock, GuardContentImage, GuardContentText, GuardImageFormat,
    GuardImageSource, GuardQualifier, InjectedBlock, JsonBlock, Message, MessageMetadata, OffloadMethod, Offloaded,
    ReasoningBlock, Role, SummaryBlock, SystemContentBlock, SystemPrompt, TextBlock, ToolResultBlock,
    ToolResultContent, ToolResultError, ToolUseBlock, UnknownBlock,
};
pub use snapshot::{SNAPSHOT_SCHEMA_VERSION, Scope, Snapshot};
pub use stop_reason::{StopReason, UnknownStopReason};
pub use toggle::Toggle;
pub(crate) use toggle::toggle_from_config;
pub use tools::{ToolChoice, ToolResultStatus, ToolSpec, ToolUse};
