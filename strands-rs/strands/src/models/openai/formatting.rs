//! Formatting helpers both OpenAI adapters share.

use serde::Serialize;

use crate::mime::to_mime_type;
use crate::models::model::is_js_whitespace;
use crate::types::media::base64_bytes;
use crate::types::{ContentBlock, DocumentSource, ImageBlock, ImageSource, JsonObject, JsonValue, ToolResultContent};

/// Logs a warning for each key in `params` that the provider manages and overwrites at request
/// time. Runs at config time so callers notice before a request.
pub(super) fn warn_managed_params(params: Option<&JsonObject>, managed: &[&str]) {
    for key in params.into_iter().flat_map(JsonObject::keys) {
        if managed.contains(&key.as_str()) {
            tracing::warn!(
                "params_key=<{key}> | '{key}' is managed by the provider and will be ignored in params — use the dedicated config property instead"
            );
        }
    }
}

/// The wire name of a serialized enum value, such as an image format.
pub(super) fn wire_name(value: impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// A `data:<mime>;base64,<payload>` URL for bytes in `format`, with `fallback_kind/<format>` as the
/// media type when the format has no known one.
pub(super) fn data_url(format: &str, fallback_kind: &str, bytes: &[u8]) -> String {
    let mime_type = to_mime_type(format).map_or_else(|| format!("{fallback_kind}/{format}"), str::to_owned);
    format!("data:{mime_type};base64,{}", base64_bytes::encode(bytes))
}

/// The URL for an image block: a data URL for bytes, the URL itself for a
/// URL source, `None` for other sources.
pub(super) fn image_data_url(image: &ImageBlock) -> Option<String> {
    match &image.source {
        ImageSource::Bytes(bytes) => Some(data_url(&wire_name(image.format), "image", bytes)),
        ImageSource::Url(url) => Some(url.clone()),
        _ => None,
    }
}

/// The type name of a content block, such as `textBlock`, for log messages.
pub(super) fn block_type(block: &ContentBlock) -> &'static str {
    match block {
        ContentBlock::Text(_) => "textBlock",
        ContentBlock::ToolUse(_) => "toolUseBlock",
        ContentBlock::ToolResult(_) => "toolResultBlock",
        ContentBlock::Reasoning(_) => "reasoningBlock",
        ContentBlock::CachePoint(_) => "cachePointBlock",
        ContentBlock::GuardContent(_) => "guardContentBlock",
        ContentBlock::Audio(_) => "audioBlock",
        ContentBlock::Image(_) => "imageBlock",
        ContentBlock::Video(_) => "videoBlock",
        ContentBlock::Document(_) => "documentBlock",
        ContentBlock::Citations(_) => "citationsBlock",
        ContentBlock::Injected(_) => "injectedBlock",
        ContentBlock::Summary(_) => "summaryBlock",
        ContentBlock::Unknown(_) => "unknownBlock",
    }
}

/// The type name of tool result content, such as `jsonBlock`, for log messages.
pub(super) fn tool_result_content_type(content: &ToolResultContent) -> &'static str {
    match content {
        ToolResultContent::Text(_) => "textBlock",
        ToolResultContent::Json(_) => "jsonBlock",
        ToolResultContent::Image(_) => "imageBlock",
        ToolResultContent::Video(_) => "videoBlock",
        ToolResultContent::Document(_) => "documentBlock",
        ToolResultContent::ToolReference(_) => "toolReferenceBlock",
        ToolResultContent::Unknown(_) => "unknownBlock",
    }
}

/// The type name of a document source, such as `documentSourceBytes`, for log messages.
pub(super) fn document_source_type(source: &DocumentSource) -> &'static str {
    match source {
        DocumentSource::Bytes(_) => "documentSourceBytes",
        DocumentSource::Text(_) => "documentSourceText",
        DocumentSource::Content(_) => "documentSourceContentBlock",
        DocumentSource::Location(_) => "documentSourceS3Location",
    }
}

/// Trims leading and trailing whitespace, including the byte order mark but not U+0085.
pub(super) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Whether a JSON value counts as set: present and not `null`, `false`, zero or an empty string.
pub(super) fn is_truthy(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) => false,
        Some(JsonValue::Bool(value)) => *value,
        Some(JsonValue::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(JsonValue::String(text)) => !text.is_empty(),
        Some(JsonValue::Array(_) | JsonValue::Object(_)) => true,
    }
}

/// A non-empty string field.
pub(super) fn non_empty_str<'a>(value: &'a JsonValue, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .filter(|text| !text.is_empty())
}

/// A token count from a usage object: a non-negative number, else `None`.
pub(super) fn token_count(value: Option<&JsonValue>) -> Option<u64> {
    let value = value?;
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|count| *count >= 0.0).map(|count| count as u64))
}

/// A positive token count, as the cache fields require.
pub(super) fn positive_count(value: Option<&JsonValue>) -> Option<u64> {
    token_count(value).filter(|count| *count > 0)
}

/// A tool input as compact JSON text.
pub(super) fn json_string(value: &JsonValue) -> Option<String> {
    serde_json::to_string(value).ok()
}

/// A JSON object from key and value pairs, in order.
pub(super) fn object<const N: usize>(pairs: [(&str, JsonValue); N]) -> JsonValue {
    JsonValue::Object(pairs.into_iter().map(|(key, value)| (key.to_owned(), value)).collect())
}
