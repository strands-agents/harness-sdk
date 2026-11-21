//! Converse response mapping, streamed and not, and the guardrail redaction helpers.
//!
//! Responses arrive as Converse JSON: one single-key object per stream event, or the whole
//! Converse output, with bytes base64-encoded.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::BedrockGuardrailConfig;
use super::transport::BedrockError;
use crate::error::{Error, ModelThrottledError, Result};
use crate::models::streaming::{
    CitationsDelta, Metrics, ModelContentBlockDeltaEvent, ModelContentBlockStartEvent, ModelContentBlockStopEvent,
    ModelMessageStartEvent, ModelMessageStopEvent, ModelMetadataEvent, ModelRedactionEvent, ModelStreamEvent,
    ReasoningContentDelta, RedactInputContent, RedactOutputContent, TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
use crate::types::{
    Citation, CitationGeneratedContent, CitationLocation, CitationSourceContent, DocumentCharLocation,
    DocumentChunkLocation, DocumentPageLocation, JsonObject, JsonValue, Role, SearchResultLocation, StopReason,
    WebLocation,
};

const DEFAULT_REDACT_INPUT_MESSAGE: &str = "[User input redacted.]";
const DEFAULT_REDACT_OUTPUT_MESSAGE: &str = "[Assistant output redacted.]";
const GUARDRAIL_INTERVENED: &str = "guardrail_intervened";

/// Bedrock stop reasons and the SDK values they map to (`STOP_REASON_MAP`).
const STOP_REASON_MAP: [(&str, StopReason); 6] = [
    ("end_turn", StopReason::EndTurn),
    ("tool_use", StopReason::ToolUse),
    ("max_tokens", StopReason::MaxTokens),
    ("stop_sequence", StopReason::StopSequence),
    ("content_filtered", StopReason::ContentFiltered),
    ("guardrail_intervened", StopReason::GuardrailIntervened),
];

/// Stream exception events Bedrock sends inside the event stream, rethrown as they arrive.
const STREAM_EXCEPTIONS: [&str; 4] = [
    "internalServerException",
    "modelStreamErrorException",
    "serviceUnavailableException",
    "validationException",
];

fn undefined(field: &str) -> Error {
    Error::other(format!("Expected {field} to be defined, but got undefined"))
}

fn defined<'a>(value: Option<&'a JsonValue>, field: &str) -> Result<&'a JsonValue> {
    value.filter(|value| !value.is_null()).ok_or_else(|| undefined(field))
}

fn defined_str<'a>(value: Option<&'a JsonValue>, field: &str) -> Result<&'a str> {
    defined(value, field)?.as_str().ok_or_else(|| undefined(field))
}

fn defined_u64(value: Option<&JsonValue>, field: &str) -> Result<u64> {
    defined(value, field)?.as_u64().ok_or_else(|| undefined(field))
}

fn non_empty_str(value: Option<&JsonValue>) -> Option<&str> {
    value.and_then(JsonValue::as_str).filter(|text| !text.is_empty())
}

fn decode_bytes(value: &JsonValue) -> Option<Vec<u8>> {
    value.as_str().and_then(|encoded| STANDARD.decode(encoded).ok())
}

/// Converts a snake_case stop reason to camelCase: each `_` before a lowercase letter is dropped and
/// the letter uppercased.
fn snake_to_camel(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(next) if c == '_' && next.is_ascii_lowercase() => {
                out.push(next.to_ascii_uppercase());
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// Maps a Bedrock stop reason to the SDK's; unknown values are converted
/// to camelCase. A Converse `end_turn` whose content holds a tool use is reported as `tool_use`.
fn transform_stop_reason(raw: &str, converse_output: Option<&JsonObject>) -> StopReason {
    let mapped = STOP_REASON_MAP
        .iter()
        .find(|(key, _)| *key == raw)
        .map(|(_, reason)| reason.clone());
    let mapped = mapped.unwrap_or_else(|| {
        let camel = snake_to_camel(raw);
        tracing::warn!("stop_reason=<{raw}>, fallback=<{camel}> | unknown stop reason, converting to camelCase");
        StopReason::from(camel)
    });
    let has_tool_use = converse_output
        .and_then(|output| output.get("output"))
        .and_then(|output| output.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(JsonValue::as_array)
        .is_some_and(|content| content.iter().any(|block| block.get("toolUse").is_some()));
    if mapped == StopReason::EndTurn && has_tool_use {
        tracing::warn!("stop_reason=<end_turn> | adjusting to tool_use due to tool use in content blocks");
        return StopReason::ToolUse;
    }
    mapped
}

fn map_role(value: Option<&JsonValue>, field: &str) -> Result<Role> {
    match defined_str(value, field)? {
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        role => Err(Error::other(format!("Unexpected role from Bedrock: '{role}'"))),
    }
}

/// Maps a Bedrock token usage to the SDK's.
fn map_usage(usage: &JsonValue) -> Result<Usage> {
    let mut mapped = Usage::new(
        defined_u64(usage.get("inputTokens"), "usage.inputTokens")?,
        defined_u64(usage.get("outputTokens"), "usage.outputTokens")?,
        defined_u64(usage.get("totalTokens"), "usage.totalTokens")?,
    );
    if let Some(tokens) = usage.get("cacheReadInputTokens").and_then(JsonValue::as_u64) {
        mapped = mapped.with_cache_read_input_tokens(tokens);
    }
    if let Some(tokens) = usage.get("cacheWriteInputTokens").and_then(JsonValue::as_u64) {
        mapped = mapped.with_cache_write_input_tokens(tokens);
    }
    Ok(mapped)
}

fn map_metrics(metrics: &JsonValue) -> Result<Metrics> {
    Ok(Metrics::new(defined_u64(
        metrics.get("latencyMs"),
        "metrics.latencyMs",
    )?))
}

fn index(location: &JsonValue, key: &str) -> u64 {
    location.get(key).and_then(JsonValue::as_u64).unwrap_or_default()
}

/// Maps a Bedrock object-key citation location to the SDK's.
fn map_citation_location(location: &JsonValue) -> Option<CitationLocation> {
    let range = |loc: &JsonValue| (index(loc, "documentIndex"), index(loc, "start"), index(loc, "end"));
    if let Some(loc) = location.get("documentChar") {
        let (document, start, end) = range(loc);
        return Some(DocumentCharLocation::new(document, start, end).into());
    }
    if let Some(loc) = location.get("documentPage") {
        let (document, start, end) = range(loc);
        return Some(DocumentPageLocation::new(document, start, end).into());
    }
    if let Some(loc) = location.get("documentChunk") {
        let (document, start, end) = range(loc);
        return Some(DocumentChunkLocation::new(document, start, end).into());
    }
    if let Some(loc) = location.get("searchResultLocation") {
        return Some(
            SearchResultLocation::new(index(loc, "searchResultIndex"), index(loc, "start"), index(loc, "end")).into(),
        );
    }
    if let Some(loc) = location.get("web") {
        let mut web = WebLocation::new(loc.get("url").and_then(JsonValue::as_str).unwrap_or_default());
        if let Some(domain) = non_empty_str(loc.get("domain")) {
            web = web.with_domain(domain);
        }
        return Some(web.into());
    }
    tracing::warn!("citation_location=<{location}> | unknown citation location type");
    None
}

fn texts<T>(value: Option<&JsonValue>, make: impl Fn(String) -> T) -> Vec<T> {
    value
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    make(
                        item.get("text")
                            .and_then(JsonValue::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn map_citation(citation: &JsonValue) -> Option<Citation> {
    let location = map_citation_location(citation.get("location")?)?;
    Some(Citation::new(
        location,
        citation.get("source").and_then(JsonValue::as_str).unwrap_or_default(),
        texts(citation.get("sourceContent"), CitationSourceContent::new),
        citation.get("title").and_then(JsonValue::as_str).unwrap_or_default(),
    ))
}

/// Maps a Bedrock citations content block to a citations delta.
fn map_citations_data(block: &JsonValue) -> CitationsDelta {
    let citations = block
        .get("citations")
        .and_then(JsonValue::as_array)
        .map(|citations| citations.iter().filter_map(map_citation).collect())
        .unwrap_or_default();
    CitationsDelta::new(citations, texts(block.get("content"), CitationGeneratedContent::new))
}

fn reasoning_delta(
    text: Option<&str>,
    signature: Option<&str>,
    redacted: Option<Vec<u8>>,
) -> Option<ReasoningContentDelta> {
    if text.is_none() && signature.is_none() && redacted.is_none() {
        return None;
    }
    let mut delta = ReasoningContentDelta::new();
    if let Some(text) = text {
        delta = delta.with_text(text);
    }
    if let Some(signature) = signature {
        delta = delta.with_signature(signature);
    }
    if let Some(redacted) = redacted {
        delta = delta.with_redacted_content(redacted);
    }
    Some(delta)
}

fn delta_event(delta: impl Into<crate::models::streaming::ContentBlockDelta>) -> ModelStreamEvent {
    ModelContentBlockDeltaEvent::new(delta).into()
}

/// The error a stream exception event raises, carrying the exception's name.
fn stream_exception(key: &str, data: &JsonValue) -> Error {
    let message = data.get("message").and_then(JsonValue::as_str).unwrap_or_default();
    let mut name = key.to_owned();
    if let Some(first) = name.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    BedrockError::service(name, message).into()
}

/// Events of one stream chunk, and the raw stop reason when the chunk is `messageStop`.
struct MappedChunk {
    events: Vec<ModelStreamEvent>,
    stop_reason: Option<String>,
}

/// Maps one ConverseStream chunk to SDK events.
fn map_stream_chunk(chunk: &JsonObject) -> Result<MappedChunk> {
    let (event_type, data) = chunk.iter().next().ok_or_else(|| undefined("eventType"))?;
    let mut events = Vec::new();
    let mut stop_reason = None;
    match event_type.as_str() {
        "messageStart" => {
            events.push(ModelMessageStartEvent::new(map_role(data.get("role"), "messageStart.role")?).into());
        }
        "contentBlockStart" => {
            let mut event = ModelContentBlockStartEvent::new();
            if let Some(tool_use) = data.get("start").and_then(|start| start.get("toolUse")) {
                event = event.with_start(ToolUseStart::new(
                    defined_str(tool_use.get("name"), "toolUse.name")?,
                    defined_str(tool_use.get("toolUseId"), "toolUse.toolUseId")?,
                ));
            }
            events.push(event.into());
        }
        "contentBlockDelta" => {
            map_content_block_delta(defined(data.get("delta"), "contentBlockDelta.delta")?, &mut events);
        }
        "contentBlockStop" => events.push(ModelContentBlockStopEvent::new().into()),
        "messageStop" => {
            let raw = defined_str(data.get("stopReason"), "messageStop.stopReason")?;
            let mut event = ModelMessageStopEvent::new(transform_stop_reason(raw, None));
            if let Some(fields) = data
                .get("additionalModelResponseFields")
                .filter(|fields| !fields.is_null())
            {
                event = event.with_additional_model_response_fields(fields.clone());
            }
            stop_reason = Some(raw.to_owned());
            events.push(event.into());
        }
        "metadata" => events.push(map_metadata(data, None)?.into()),
        "throttlingException" => {
            let message = data
                .get("message")
                .and_then(JsonValue::as_str)
                .unwrap_or("Request was throttled by the model provider");
            tracing::debug!("throttled | error_message=<{message}>");
            let source = stream_exception(event_type, data);
            return Err(ModelThrottledError::new(message).with_source(source).into());
        }
        key if STREAM_EXCEPTIONS.contains(&key) => return Err(stream_exception(key, data)),
        other => tracing::warn!("event_type=<{other}> | unsupported bedrock event type"),
    }
    Ok(MappedChunk { events, stop_reason })
}

fn map_content_block_delta(delta: &JsonValue, events: &mut Vec<ModelStreamEvent>) {
    let Some(delta) = delta.as_object() else {
        return;
    };
    for (key, value) in delta {
        match key.as_str() {
            "text" => events.push(delta_event(TextDelta::new(value.as_str().unwrap_or_default()))),
            "toolUse" => {
                if let Some(input) = non_empty_str(value.get("input")) {
                    events.push(delta_event(ToolUseInputDelta::new(input)));
                }
            }
            "reasoningContent" => {
                let redacted = value.get("redactedContent").and_then(decode_bytes);
                let delta = reasoning_delta(
                    non_empty_str(value.get("text")),
                    non_empty_str(value.get("signature")),
                    redacted,
                );
                events.extend(delta.map(delta_event));
            }
            "citation" => {
                let Some(location) = value.get("location").and_then(map_citation_location) else {
                    continue;
                };
                let citation = Citation::new(
                    location,
                    value.get("source").and_then(JsonValue::as_str).unwrap_or_default(),
                    texts(value.get("sourceContent"), CitationSourceContent::new),
                    value.get("title").and_then(JsonValue::as_str).unwrap_or_default(),
                );
                events.push(delta_event(CitationsDelta::new(vec![citation], Vec::new())));
            }
            other => tracing::warn!("delta_key=<{other}> | skipping unsupported delta key"),
        }
    }
}

fn map_metadata(data: &JsonValue, usage_field: Option<&str>) -> Result<ModelMetadataEvent> {
    let mut event = ModelMetadataEvent::new();
    let usage = match usage_field {
        Some(field) => Some(defined(data.get("usage"), field)?),
        None => data.get("usage").filter(|usage| !usage.is_null()),
    };
    if let Some(usage) = usage {
        event = event.with_usage(map_usage(usage)?);
    }
    if let Some(metrics) = data.get("metrics").filter(|metrics| !metrics.is_null()) {
        event = event.with_metrics(map_metrics(metrics)?);
    }
    if let Some(trace) = data.get("trace").filter(|trace| !trace.is_null()) {
        event = event.with_trace(trace.clone());
    }
    Ok(event)
}

/// Whether a guardrail trace holds a detected and blocked policy.
///
/// Bedrock reports `guardrail_intervened` for both blocking and masking; only blocked content
/// warrants redaction, as masked spans were already substituted server-side.
pub(super) fn has_blocked_guardrail_policy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Array(items) => items.iter().any(has_blocked_guardrail_policy),
        JsonValue::Object(record) => {
            let blocked = record.get("action").and_then(JsonValue::as_str) == Some("BLOCKED")
                && record.get("detected").and_then(JsonValue::as_bool) == Some(true);
            blocked || record.values().any(has_blocked_guardrail_policy)
        }
        _ => false,
    }
}

/// Redaction events for the guardrail configuration: input redaction
/// unless turned off, output redaction only when turned on.
pub(super) fn generate_redaction_events(
    config: &BedrockGuardrailConfig,
    guardrail_data: &JsonValue,
) -> Vec<ModelStreamEvent> {
    let redaction = config.redaction.as_ref();
    let mut events = Vec::new();
    if redaction.and_then(|redaction| redaction.input) != Some(false) {
        tracing::debug!("redacting input due to guardrail");
        let message = redaction
            .and_then(|redaction| redaction.input_message.as_deref())
            .unwrap_or(DEFAULT_REDACT_INPUT_MESSAGE);
        events.push(
            ModelRedactionEvent::new()
                .with_input_redaction(RedactInputContent::new(message))
                .into(),
        );
    }
    if redaction.and_then(|redaction| redaction.output) == Some(true) {
        tracing::debug!("redacting output due to guardrail");
        let message = redaction
            .and_then(|redaction| redaction.output_message.as_deref())
            .unwrap_or(DEFAULT_REDACT_OUTPUT_MESSAGE);
        let mut output = RedactOutputContent::new(message);
        let model_output = guardrail_data
            .get("modelOutput")
            .and_then(JsonValue::as_array)
            .filter(|parts| !parts.is_empty());
        if let Some(parts) = model_output {
            output = output.with_redacted_content(parts.iter().filter_map(JsonValue::as_str).collect::<String>());
        }
        events.push(ModelRedactionEvent::new().with_output_redaction(output).into());
    }
    events
}

/// The ConverseStream mapping state across chunks: the last stop reason and whether guardrail
/// redaction was emitted.
pub(super) struct StreamState<'a> {
    guardrail: Option<&'a BedrockGuardrailConfig>,
    last_stop_reason: Option<String>,
    redaction_emitted: bool,
    saw_guardrail_trace: bool,
}

impl<'a> StreamState<'a> {
    pub(super) fn new(guardrail: Option<&'a BedrockGuardrailConfig>) -> Self {
        Self {
            guardrail,
            last_stop_reason: None,
            redaction_emitted: false,
            saw_guardrail_trace: false,
        }
    }

    /// Maps one chunk. The guardrail trace arrives with the metadata event and decides between
    /// blocking and masking; without a trace the `guardrail_intervened` stop reason decides.
    pub(super) fn apply(&mut self, chunk: &JsonObject) -> Result<Vec<ModelStreamEvent>> {
        let mapped = map_stream_chunk(chunk)?;
        if mapped.stop_reason.is_some() {
            self.last_stop_reason = mapped.stop_reason;
        }
        let mut events = Vec::new();
        let metadata = chunk.get("metadata");
        if let (false, Some(guardrail), Some(metadata)) = (self.redaction_emitted, self.guardrail, metadata) {
            let trace = metadata
                .get("trace")
                .and_then(|trace| trace.get("guardrail"))
                .filter(|trace| !trace.is_null());
            if let Some(trace) = trace {
                self.saw_guardrail_trace = true;
                if has_blocked_guardrail_policy(trace) {
                    self.redaction_emitted = true;
                    events.extend(generate_redaction_events(guardrail, trace));
                }
            } else if self.last_stop_reason.as_deref() == Some(GUARDRAIL_INTERVENED) {
                self.redaction_emitted = true;
                events.extend(generate_redaction_events(guardrail, &json!({})));
            }
        }
        events.extend(mapped.events);
        Ok(events)
    }

    /// The safety net when `guardrail_intervened` arrived but no metadata event did.
    pub(super) fn finish(&self) -> Vec<ModelStreamEvent> {
        let intervened = self.last_stop_reason.as_deref() == Some(GUARDRAIL_INTERVENED);
        match self.guardrail {
            Some(guardrail) if !self.redaction_emitted && !self.saw_guardrail_trace && intervened => {
                generate_redaction_events(guardrail, &json!({}))
            }
            _ => Vec::new(),
        }
    }
}

/// Maps a Converse (non-streaming) output to stream events.
pub(super) fn map_converse_output(
    output: &JsonObject,
    guardrail: Option<&BedrockGuardrailConfig>,
) -> Result<Vec<ModelStreamEvent>> {
    let response = defined(output.get("output"), "event.output")?;
    let message = defined(response.get("message"), "output.message")?;
    let mut events = vec![ModelMessageStartEvent::new(map_role(message.get("role"), "message.role")?).into()];
    let content = defined(message.get("content"), "message.content")?;
    for block in content.as_array().into_iter().flatten() {
        for (key, value) in block.as_object().into_iter().flatten() {
            map_converse_block(key, value, &mut events)?;
        }
    }
    let raw_stop_reason = defined_str(output.get("stopReason"), "event.stopReason")?;
    events.push(ModelMessageStopEvent::new(transform_stop_reason(raw_stop_reason, Some(output))).into());
    let metadata = map_metadata(&JsonValue::Object(output.clone()), Some("output.usage"))?;
    if let Some(guardrail) = guardrail.filter(|_| raw_stop_reason == GUARDRAIL_INTERVENED) {
        let trace = output
            .get("trace")
            .and_then(|trace| trace.get("guardrail"))
            .filter(|trace| !trace.is_null());
        if trace.is_none_or(has_blocked_guardrail_policy) {
            events.extend(generate_redaction_events(guardrail, trace.unwrap_or(&json!({}))));
        }
    }
    events.push(metadata.into());
    Ok(events)
}

fn map_converse_block(key: &str, value: &JsonValue, events: &mut Vec<ModelStreamEvent>) -> Result<()> {
    match key {
        "text" => {
            events.push(ModelContentBlockStartEvent::new().into());
            events.push(delta_event(TextDelta::new(value.as_str().unwrap_or_default())));
            events.push(ModelContentBlockStopEvent::new().into());
        }
        "toolUse" => {
            let start = ToolUseStart::new(
                defined_str(value.get("name"), "toolUse.name")?,
                defined_str(value.get("toolUseId"), "toolUse.toolUseId")?,
            );
            let input = defined(value.get("input"), "toolUse.input")?;
            events.push(ModelContentBlockStartEvent::new().with_start(start).into());
            events.push(delta_event(ToolUseInputDelta::new(input.to_string())));
            events.push(ModelContentBlockStopEvent::new().into());
        }
        "reasoningContent" => {
            events.push(ModelContentBlockStartEvent::new().into());
            let delta = match (value.get("reasoningText"), value.get("redactedContent")) {
                (Some(text), _) => reasoning_delta(
                    Some(defined_str(text.get("text"), "reasoningText.text")?),
                    non_empty_str(text.get("signature")),
                    None,
                ),
                (None, Some(redacted)) => reasoning_delta(None, None, decode_bytes(redacted)),
                (None, None) => None,
            };
            events.extend(delta.map(delta_event));
            events.push(ModelContentBlockStopEvent::new().into());
        }
        "citationsContent" => {
            events.push(ModelContentBlockStartEvent::new().into());
            events.push(delta_event(map_citations_data(value)));
            events.push(ModelContentBlockStopEvent::new().into());
        }
        other => tracing::warn!("block_key=<{other}> | skipping unsupported block key"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_to_camel_matches_the_ts_regex() {
        assert_eq!(
            snake_to_camel("model_context_window_exceeded"),
            "modelContextWindowExceeded"
        );
        assert_eq!(snake_to_camel("new_stop_reason"), "newStopReason");
        assert_eq!(snake_to_camel("a_B_c"), "a_BC");
        assert_eq!(snake_to_camel("trailing_"), "trailing_");
    }
}
