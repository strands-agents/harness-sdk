//! Model stream events, token usage and metrics.
//!
//! Each event serializes with its `type` discriminator first, for example
//! `{"type":"modelMessageStartEvent","role":"assistant"}`.

use serde::{Deserialize, Serialize};

use crate::types::json::present;
use crate::types::media::base64_bytes;
use crate::types::{Citation, CitationGeneratedContent, JsonValue, Role, StopReason};

/// Token usage of a model response (`Usage`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Usage {
    /// Input tokens.
    pub input_tokens: u64,
    /// Output tokens.
    pub output_tokens: u64,
    /// Total tokens.
    pub total_tokens: u64,
    /// Input tokens read from the prompt cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,
    /// Input tokens written to the prompt cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_input_tokens: Option<u64>,
}

impl Usage {
    /// Creates usage without cache counts.
    pub fn new(input_tokens: u64, output_tokens: u64, total_tokens: u64) -> Self {
        Self {
            input_tokens,
            output_tokens,
            total_tokens,
            cache_read_input_tokens: None,
            cache_write_input_tokens: None,
        }
    }

    /// Sets the cache read count.
    #[must_use]
    pub fn with_cache_read_input_tokens(mut self, tokens: u64) -> Self {
        self.cache_read_input_tokens = Some(tokens);
        self
    }

    /// Sets the cache write count.
    #[must_use]
    pub fn with_cache_write_input_tokens(mut self, tokens: u64) -> Self {
        self.cache_write_input_tokens = Some(tokens);
        self
    }

    /// Adds `other` into `self`, saturating at `u64::MAX`. Cache counts are added
    /// only when `other` has them.
    pub fn accumulate(&mut self, other: &Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
        if let Some(read) = other.cache_read_input_tokens {
            self.cache_read_input_tokens = Some(self.cache_read_input_tokens.unwrap_or(0).saturating_add(read));
        }
        if let Some(write) = other.cache_write_input_tokens {
            self.cache_write_input_tokens = Some(self.cache_write_input_tokens.unwrap_or(0).saturating_add(write));
        }
    }

    /// The whole prompt size, cached or not.
    ///
    /// Providers either count cache tokens inside `input_tokens` (input plus output equals the
    /// total) or separately, in which case they are added.
    #[must_use]
    pub fn total_prompt_tokens(&self) -> u64 {
        if self.input_tokens.saturating_add(self.output_tokens) == self.total_tokens {
            return self.input_tokens;
        }
        self.input_tokens
            .saturating_add(self.cache_read_input_tokens.unwrap_or(0))
            .saturating_add(self.cache_write_input_tokens.unwrap_or(0))
    }
}

/// Performance metrics of a model response (`Metrics`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Metrics {
    /// End-to-end latency in milliseconds.
    pub latency_ms: u64,
    /// Time to the first byte in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_to_first_byte_ms: Option<u64>,
}

impl Metrics {
    /// Creates metrics with a latency.
    pub fn new(latency_ms: u64) -> Self {
        Self {
            latency_ms,
            time_to_first_byte_ms: None,
        }
    }

    /// Sets the time to the first byte.
    #[must_use]
    pub fn with_time_to_first_byte_ms(mut self, time_to_first_byte_ms: u64) -> Self {
        self.time_to_first_byte_ms = Some(time_to_first_byte_ms);
        self
    }
}

/// An event in a model's response stream (`ModelStreamEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[non_exhaustive]
pub enum ModelStreamEvent {
    /// The model started a message.
    #[serde(rename = "modelMessageStartEvent")]
    MessageStart(ModelMessageStartEvent),
    /// A content block started.
    #[serde(rename = "modelContentBlockStartEvent")]
    ContentBlockStart(ModelContentBlockStartEvent),
    /// A content block received a delta.
    #[serde(rename = "modelContentBlockDeltaEvent")]
    ContentBlockDelta(ModelContentBlockDeltaEvent),
    /// A content block ended.
    #[serde(rename = "modelContentBlockStopEvent")]
    ContentBlockStop(ModelContentBlockStopEvent),
    /// The message ended.
    #[serde(rename = "modelMessageStopEvent")]
    MessageStop(ModelMessageStopEvent),
    /// Usage, metrics and trace data.
    #[serde(rename = "modelMetadataEvent")]
    Metadata(ModelMetadataEvent),
    /// A guardrail redacted content.
    #[serde(rename = "modelRedactionEvent")]
    Redaction(ModelRedactionEvent),
}

macro_rules! stream_event_from {
    ($($variant:ident($event:ty)),* $(,)?) => {
        $(impl From<$event> for ModelStreamEvent {
            fn from(event: $event) -> Self {
                Self::$variant(event)
            }
        })*
    };
}

stream_event_from!(
    MessageStart(ModelMessageStartEvent),
    ContentBlockStart(ModelContentBlockStartEvent),
    ContentBlockDelta(ModelContentBlockDeltaEvent),
    ContentBlockStop(ModelContentBlockStopEvent),
    MessageStop(ModelMessageStopEvent),
    Metadata(ModelMetadataEvent),
    Redaction(ModelRedactionEvent),
);

/// The model started a message (`ModelMessageStartEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ModelMessageStartEvent {
    /// The role of the message.
    pub role: Role,
}

impl ModelMessageStartEvent {
    /// Creates the event.
    pub fn new(role: Role) -> Self {
        Self { role }
    }
}

/// A content block started (`ModelContentBlockStartEvent`). Text blocks carry no start data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ModelContentBlockStartEvent {
    /// Start data for blocks that have it, such as tool use.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<ContentBlockStart>,
}

impl ModelContentBlockStartEvent {
    /// Creates the event without start data.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the start data.
    #[must_use]
    pub fn with_start(mut self, start: impl Into<ContentBlockStart>) -> Self {
        self.start = Some(start.into());
        self
    }
}

/// Start data of a content block (`ContentBlockStart`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[non_exhaustive]
pub enum ContentBlockStart {
    /// A tool use block started.
    #[serde(rename = "toolUseStart")]
    ToolUse(ToolUseStart),
}

impl From<ToolUseStart> for ContentBlockStart {
    fn from(start: ToolUseStart) -> Self {
        Self::ToolUse(start)
    }
}

/// A tool use block started (`ToolUseStart`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolUseStart {
    /// The tool name.
    pub name: String,
    /// The tool use id.
    pub tool_use_id: String,
    /// Reasoning signature from thinking models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_signature: Option<String>,
}

impl ToolUseStart {
    /// Creates the start data.
    pub fn new(name: impl Into<String>, tool_use_id: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            tool_use_id: tool_use_id.into(),
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

/// A content block received a delta (`ModelContentBlockDeltaEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelContentBlockDeltaEvent {
    /// Index of the block within the message, when the provider reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_block_index: Option<u64>,
    /// The delta.
    pub delta: ContentBlockDelta,
}

impl ModelContentBlockDeltaEvent {
    /// Creates the event.
    pub fn new(delta: impl Into<ContentBlockDelta>) -> Self {
        Self {
            content_block_index: None,
            delta: delta.into(),
        }
    }

    /// Sets the index of the block within the message.
    #[must_use]
    pub fn with_content_block_index(mut self, content_block_index: u64) -> Self {
        self.content_block_index = Some(content_block_index);
        self
    }
}

/// A delta within a content block (`ContentBlockDelta`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[non_exhaustive]
pub enum ContentBlockDelta {
    /// Text.
    #[serde(rename = "textDelta")]
    Text(TextDelta),
    /// A fragment of tool input JSON.
    #[serde(rename = "toolUseInputDelta")]
    ToolUseInput(ToolUseInputDelta),
    /// Reasoning content.
    #[serde(rename = "reasoningContentDelta")]
    ReasoningContent(ReasoningContentDelta),
    /// Citations.
    #[serde(rename = "citationsDelta")]
    Citations(CitationsDelta),
}

macro_rules! delta_from {
    ($($variant:ident($delta:ty)),* $(,)?) => {
        $(impl From<$delta> for ContentBlockDelta {
            fn from(delta: $delta) -> Self {
                Self::$variant(delta)
            }
        })*
    };
}

delta_from!(
    Text(TextDelta),
    ToolUseInput(ToolUseInputDelta),
    ReasoningContent(ReasoningContentDelta),
    Citations(CitationsDelta),
);

/// A text delta (`TextDelta`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TextDelta {
    /// The text fragment.
    pub text: String,
}

impl TextDelta {
    /// Creates the delta.
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

/// A fragment of tool input JSON (`ToolUseInputDelta`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ToolUseInputDelta {
    /// The JSON fragment.
    pub input: String,
}

impl ToolUseInputDelta {
    /// Creates the delta.
    pub fn new(input: impl Into<String>) -> Self {
        Self { input: input.into() }
    }
}

/// A reasoning delta (`ReasoningContentDelta`). `redacted_content` is base64 on the wire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReasoningContentDelta {
    /// A reasoning text fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A reasoning signature fragment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Redacted reasoning bytes.
    #[serde(default, skip_serializing_if = "Option::is_none", with = "base64_bytes::option")]
    pub redacted_content: Option<Vec<u8>>,
}

impl ReasoningContentDelta {
    /// Creates an empty delta.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the text fragment.
    #[must_use]
    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    /// Sets the signature fragment.
    #[must_use]
    pub fn with_signature(mut self, signature: impl Into<String>) -> Self {
        self.signature = Some(signature.into());
        self
    }

    /// Sets the redacted bytes.
    #[must_use]
    pub fn with_redacted_content(mut self, redacted_content: Vec<u8>) -> Self {
        self.redacted_content = Some(redacted_content);
        self
    }
}

/// A citations delta (`CitationsDelta`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CitationsDelta {
    /// The citations.
    pub citations: Vec<Citation>,
    /// The generated content the citations belong to.
    pub content: Vec<CitationGeneratedContent>,
}

impl CitationsDelta {
    /// Creates the delta.
    pub fn new(citations: Vec<Citation>, content: Vec<CitationGeneratedContent>) -> Self {
        Self { citations, content }
    }
}

/// A content block ended (`ModelContentBlockStopEvent`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ModelContentBlockStopEvent {}

impl ModelContentBlockStopEvent {
    /// Creates the event.
    pub fn new() -> Self {
        Self {}
    }
}

/// The message ended (`ModelMessageStopEvent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelMessageStopEvent {
    /// Why the model stopped.
    pub stop_reason: StopReason,
    /// Provider-specific response fields. A present `null` stays `Some(JsonValue::Null)`.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub additional_model_response_fields: Option<JsonValue>,
}

impl ModelMessageStopEvent {
    /// Creates the event.
    pub fn new(stop_reason: StopReason) -> Self {
        Self {
            stop_reason,
            additional_model_response_fields: None,
        }
    }

    /// Sets the provider-specific response fields.
    #[must_use]
    pub fn with_additional_model_response_fields(mut self, fields: JsonValue) -> Self {
        self.additional_model_response_fields = Some(fields);
        self
    }
}

/// Usage, metrics and trace data (`ModelMetadataEvent`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ModelMetadataEvent {
    /// Token usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Performance metrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,
    /// Provider trace data, such as guardrail evaluations. A present `null` stays
    /// `Some(JsonValue::Null)`.
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub trace: Option<JsonValue>,
}

impl ModelMetadataEvent {
    /// Creates an empty event.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the usage.
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

    /// Sets the trace data.
    #[must_use]
    pub fn with_trace(mut self, trace: JsonValue) -> Self {
        self.trace = Some(trace);
        self
    }
}

/// Replacement for redacted input (`RedactInputContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RedactInputContent {
    /// The text that replaces the redacted input.
    pub replace_content: String,
}

impl RedactInputContent {
    /// Creates the redaction.
    pub fn new(replace_content: impl Into<String>) -> Self {
        Self {
            replace_content: replace_content.into(),
        }
    }
}

/// Replacement for redacted output (`RedactOutputContent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RedactOutputContent {
    /// The output that was redacted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted_content: Option<String>,
    /// The text that replaces it.
    pub replace_content: String,
}

impl RedactOutputContent {
    /// Creates the redaction.
    pub fn new(replace_content: impl Into<String>) -> Self {
        Self {
            redacted_content: None,
            replace_content: replace_content.into(),
        }
    }

    /// Sets the redacted output.
    #[must_use]
    pub fn with_redacted_content(mut self, redacted_content: impl Into<String>) -> Self {
        self.redacted_content = Some(redacted_content.into());
        self
    }
}

/// A guardrail redacted content (`ModelRedactionEvent`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelRedactionEvent {
    /// Input redaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_redaction: Option<RedactInputContent>,
    /// Output redaction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_redaction: Option<RedactOutputContent>,
}

impl ModelRedactionEvent {
    /// Creates an empty event.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the input redaction.
    #[must_use]
    pub fn with_input_redaction(mut self, redaction: RedactInputContent) -> Self {
        self.input_redaction = Some(redaction);
        self
    }

    /// Sets the output redaction.
    #[must_use]
    pub fn with_output_redaction(mut self, redaction: RedactOutputContent) -> Self {
        self.output_redaction = Some(redaction);
        self
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parses(value: serde_json::Value) -> bool {
        serde_json::from_value::<ModelStreamEvent>(value).is_ok()
    }

    #[test]
    fn returns_true_for_model_message_start_event() {
        assert!(parses(json!({"type": "modelMessageStartEvent", "role": "assistant"})));
    }

    #[test]
    fn returns_true_for_model_content_block_start_event() {
        assert!(parses(json!({"type": "modelContentBlockStartEvent"})));
    }

    #[test]
    fn returns_true_for_model_content_block_delta_event() {
        assert!(parses(
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "hello"}})
        ));
    }

    #[test]
    fn returns_true_for_model_content_block_stop_event() {
        assert!(parses(json!({"type": "modelContentBlockStopEvent"})));
    }

    #[test]
    fn returns_true_for_model_message_stop_event() {
        assert!(parses(
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"})
        ));
    }

    #[test]
    fn returns_true_for_model_metadata_event() {
        assert!(parses(json!({
            "type": "modelMetadataEvent",
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
        })));
    }

    #[test]
    fn returns_true_for_model_redaction_event() {
        assert!(parses(json!({
            "type": "modelRedactionEvent",
            "inputRedaction": {"replaceContent": "[User input redacted.]"}
        })));
    }

    #[test]
    fn returns_false_for_unknown_event_types() {
        assert!(!parses(json!({"type": "unknownEvent"})));
    }

    #[test]
    fn returns_false_for_content_block_types() {
        assert!(!parses(json!({"type": "textBlock", "text": "hello"})));
    }

    #[test]
    fn counts_cache_tokens_on_disjoint_providers_where_they_add_to_input_tokens() {
        let usage = Usage::new(10, 4, 5862).with_cache_read_input_tokens(5848);
        assert_eq!(usage.total_prompt_tokens(), 5858);
    }

    #[test]
    fn does_not_double_count_cache_tokens_on_subset_providers_where_they_sit_inside_input_tokens() {
        let usage = Usage::new(12936, 10, 12946).with_cache_read_input_tokens(6457);
        assert_eq!(usage.total_prompt_tokens(), 12936);
    }

    #[test]
    fn counts_the_cache_read_from_an_anthropic_direct_payload_whose_total_tokens_includes_the_cache() {
        let usage = Usage::new(10, 4, 5862).with_cache_read_input_tokens(5848);
        assert_eq!(usage.total_prompt_tokens(), 5858);
    }

    #[test]
    fn adds_cache_reads_and_writes_on_disjoint_providers() {
        let usage = Usage::new(10, 5, 100)
            .with_cache_read_input_tokens(60)
            .with_cache_write_input_tokens(25);
        assert_eq!(usage.total_prompt_tokens(), 95);
    }

    #[test]
    fn collapses_to_input_tokens_when_there_are_no_cache_tokens() {
        assert_eq!(Usage::new(100, 50, 150).total_prompt_tokens(), 100);
    }

    #[test]
    fn accumulate_adds_counts_and_only_present_cache_tokens() {
        let mut total = Usage::default();
        total.accumulate(&Usage::new(1, 2, 3));
        assert_eq!(total.cache_read_input_tokens, None);
        total.accumulate(&Usage::new(1, 1, 2).with_cache_read_input_tokens(4));
        assert_eq!(total, Usage::new(2, 3, 5).with_cache_read_input_tokens(4));
    }

    #[test]
    fn accumulate_saturates_instead_of_overflowing() {
        let mut total = Usage::new(u64::MAX, 1, u64::MAX).with_cache_read_input_tokens(u64::MAX);
        total.accumulate(&Usage::new(1, 1, 1).with_cache_read_input_tokens(1));
        assert_eq!(total.input_tokens, u64::MAX);
        assert_eq!(total.cache_read_input_tokens, Some(u64::MAX));
        assert_eq!(total.total_prompt_tokens(), u64::MAX);
    }

    #[test]
    fn present_null_fields_survive_a_round_trip() {
        let stop =
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn", "additionalModelResponseFields": null});
        let metadata = json!({"type": "modelMetadataEvent", "trace": null});
        for wire in [stop, metadata] {
            let event: ModelStreamEvent = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(&event).unwrap(), wire);
        }
    }

    #[test]
    fn reasoning_delta_accepts_ts_index_keyed_redacted_content() {
        let event: ModelStreamEvent = serde_json::from_value(json!({
            "type": "modelContentBlockDeltaEvent",
            "delta": {"type": "reasoningContentDelta", "redactedContent": {"1": 2, "0": 1, "2": 3}}
        }))
        .unwrap();
        let ModelStreamEvent::ContentBlockDelta(delta) = event else {
            panic!("expected a delta event");
        };
        let ContentBlockDelta::ReasoningContent(reasoning) = delta.delta else {
            panic!("expected a reasoning delta");
        };
        assert_eq!(reasoning.redacted_content, Some(vec![1, 2, 3]));
    }

    #[test]
    fn reasoning_delta_rejects_a_byte_object_with_gaps() {
        let error =
            serde_json::from_value::<ReasoningContentDelta>(json!({"redactedContent": {"0": 1, "2": 3}})).unwrap_err();
        assert!(error.to_string().contains("byte object keys must be the indices 0..n"));
    }

    #[test]
    fn delta_event_carries_an_optional_block_index() {
        let event = ModelContentBlockDeltaEvent::new(TextDelta::new("a")).with_content_block_index(2);
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"contentBlockIndex": 2, "delta": {"type": "textDelta", "text": "a"}})
        );
    }

    #[test]
    fn events_serialize_with_the_type_first() {
        let event = ModelStreamEvent::from(ModelContentBlockDeltaEvent::new(TextDelta::new("Hel")));
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"modelContentBlockDeltaEvent","delta":{"type":"textDelta","text":"Hel"}}"#
        );
    }

    #[test]
    fn reasoning_delta_encodes_redacted_content_as_base64() {
        let event = ModelContentBlockDeltaEvent::new(ReasoningContentDelta::new().with_redacted_content(vec![1, 2, 3]));
        assert_eq!(
            serde_json::to_value(ModelStreamEvent::from(event)).unwrap(),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "reasoningContentDelta", "redactedContent": "AQID"}})
        );
    }
}
