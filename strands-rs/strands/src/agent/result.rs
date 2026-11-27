//! The result of an agent invocation (`AgentResult`).

use std::fmt;

use serde::de::DeserializeOwned;
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::invocation_context::InvocationContext;
use super::invocation_state::InvocationState;
use crate::error::{Result, StructuredOutputError};
use crate::interrupt::Interrupt;
use crate::telemetry::{AgentMetrics, AgentTrace};
use crate::types::{ContentBlock, JsonValue, Message, StopReason};

/// The error text when [`AgentResult::structured_output`] is read from a result without one.
const NO_STRUCTURED_OUTPUT: &str = "The agent result has no structured output.";

/// The result of an agent invocation (`AgentResult`).
///
/// Serializes to `type`, `stopReason`, `lastMessage` and, when present, `structuredOutput`.
/// Traces, metrics, the invocation context and the invocation state stay out of the JSON so a
/// result can be forwarded over the wire without bloat.
///
/// `Display` writes the interrupts as JSON when there are any, else the structured output as JSON,
/// else the text of the last message.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct AgentResult {
    inner: Box<Inner>,
}

/// The fields, boxed so stream events that carry a result stay small.
#[derive(Debug, Clone)]
struct Inner {
    stop_reason: StopReason,
    last_message: Message,
    traces: Option<Vec<AgentTrace>>,
    structured_output: Option<JsonValue>,
    metrics: Option<AgentMetrics>,
    invocation_context: Option<InvocationContext>,
    invocation_state: InvocationState,
    interrupts: Vec<Interrupt>,
}

impl AgentResult {
    /// Creates a result with a stop reason and the last message, and empty invocation state.
    pub fn new(stop_reason: StopReason, last_message: Message) -> Self {
        Self {
            inner: Box::new(Inner {
                stop_reason,
                last_message,
                traces: None,
                structured_output: None,
                metrics: None,
                invocation_context: None,
                invocation_state: InvocationState::new(),
                interrupts: Vec::new(),
            }),
        }
    }

    /// Sets the traces.
    #[must_use]
    pub fn with_traces(mut self, traces: Vec<AgentTrace>) -> Self {
        self.inner.traces = Some(traces);
        self
    }

    /// Sets the validated structured output.
    #[must_use]
    pub fn with_structured_output(mut self, structured_output: JsonValue) -> Self {
        self.inner.structured_output = Some(structured_output);
        self
    }

    /// Sets the metrics.
    #[must_use]
    pub fn with_metrics(mut self, metrics: AgentMetrics) -> Self {
        self.inner.metrics = Some(metrics);
        self
    }

    /// Sets the invocation context.
    #[must_use]
    pub fn with_invocation_context(mut self, invocation_context: InvocationContext) -> Self {
        self.inner.invocation_context = Some(invocation_context);
        self
    }

    /// Sets the invocation state.
    #[must_use]
    pub fn with_invocation_state(mut self, invocation_state: InvocationState) -> Self {
        self.inner.invocation_state = invocation_state;
        self
    }

    /// Sets the interrupts that stopped the agent.
    #[must_use]
    pub fn with_interrupts(mut self, interrupts: Vec<Interrupt>) -> Self {
        self.inner.interrupts = interrupts;
        self
    }

    /// Why the invocation stopped.
    #[must_use]
    pub fn stop_reason(&self) -> StopReason {
        self.inner.stop_reason.clone()
    }

    /// The last message added to the conversation.
    #[must_use]
    pub fn last_message(&self) -> &Message {
        &self.inner.last_message
    }

    /// Local execution traces collected during the invocation.
    #[must_use]
    pub fn traces(&self) -> Option<&[AgentTrace]> {
        self.inner.traces.as_deref()
    }

    /// The validated structured output as raw JSON, when a schema was given.
    #[must_use]
    pub fn structured_output_value(&self) -> Option<&JsonValue> {
        self.inner.structured_output.as_ref()
    }

    /// The structured output deserialized into `T`.
    ///
    /// # Errors
    ///
    /// [`Error::StructuredOutput`](crate::Error::StructuredOutput) when the result has no structured output, or a decoding error
    /// when it does not fit `T`.
    pub fn structured_output<T: DeserializeOwned>(&self) -> Result<T> {
        let Some(value) = &self.inner.structured_output else {
            return Err(StructuredOutputError::new(NO_STRUCTURED_OUTPUT).into());
        };
        Ok(T::deserialize(value)?)
    }

    /// Aggregated loop metrics of the agent.
    #[must_use]
    pub fn metrics(&self) -> Option<&AgentMetrics> {
        self.inner.metrics.as_ref()
    }

    /// The request this call ran in. Its usage covers the whole request; pass it to a later call to
    /// continue on the same limits and usage.
    #[must_use]
    pub fn invocation_context(&self) -> Option<&InvocationContext> {
        self.inner.invocation_context.as_ref()
    }

    /// The invocation state passed through hooks and tools.
    #[must_use]
    pub fn invocation_state(&self) -> &InvocationState {
        &self.inner.invocation_state
    }

    /// The unanswered interrupts when the stop reason is [`StopReason::Interrupt`].
    #[must_use]
    pub fn interrupts(&self) -> &[Interrupt] {
        &self.inner.interrupts
    }

    /// The whole prompt the model processed on the last call.
    #[must_use]
    pub fn context_size(&self) -> Option<u64> {
        self.inner
            .metrics
            .as_ref()
            .and_then(|metrics| metrics.latest_context_size)
    }

    /// Projected context size of the next model call.
    #[must_use]
    pub fn projected_context_size(&self) -> Option<u64> {
        self.inner
            .metrics
            .as_ref()
            .and_then(|metrics| metrics.projected_context_size)
    }

    fn text_parts(&self) -> Vec<String> {
        let mut parts = Vec::new();
        for block in &self.inner.last_message.content {
            match block {
                ContentBlock::Text(text) => parts.push(text.text.clone()),
                ContentBlock::Reasoning(reasoning) => {
                    if let Some(text) = reasoning.text.as_deref().filter(|text| !text.is_empty()) {
                        parts.push(format!("💭 Reasoning:\n   {}", text.replace('\n', "\n   ")));
                    }
                }
                ContentBlock::Citations(citations) => {
                    parts.extend(citations.content.iter().map(|content| content.text.clone()));
                }
                other => tracing::debug!("block=<{}> | skipping content block type", block_type(other)),
            }
        }
        parts
    }
}

fn block_type(block: &ContentBlock) -> &'static str {
    match block {
        ContentBlock::ToolUse(_) => "toolUseBlock",
        ContentBlock::ToolResult(_) => "toolResultBlock",
        ContentBlock::CachePoint(_) => "cachePointBlock",
        ContentBlock::GuardContent(_) => "guardContentBlock",
        ContentBlock::Audio(_) => "audioBlock",
        ContentBlock::Image(_) => "imageBlock",
        ContentBlock::Video(_) => "videoBlock",
        ContentBlock::Document(_) => "documentBlock",
        ContentBlock::Injected(_) => "injectedBlock",
        ContentBlock::Summary(_) => "summaryBlock",
        _ => "unknownBlock",
    }
}

impl fmt::Display for AgentResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if !self.inner.interrupts.is_empty() {
            let json = serde_json::to_string(&self.inner.interrupts).map_err(|_| fmt::Error)?;
            return f.write_str(&json);
        }
        if let Some(structured_output) = &self.inner.structured_output {
            return write!(f, "{structured_output}");
        }
        f.write_str(&self.text_parts().join("\n"))
    }
}

impl Serialize for AgentResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let len = if self.inner.structured_output.is_some() { 4 } else { 3 };
        let mut map = serializer.serialize_map(Some(len))?;
        map.serialize_entry("type", "agentResult")?;
        map.serialize_entry("stopReason", &self.inner.stop_reason)?;
        map.serialize_entry("lastMessage", &self.inner.last_message)?;
        if let Some(structured_output) = &self.inner.structured_output {
            map.serialize_entry("structuredOutput", structured_output)?;
        }
        map.end()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentResultData {
    #[serde(rename = "type")]
    _type: AgentResultTag,
    stop_reason: StopReason,
    last_message: Message,
    #[serde(default)]
    structured_output: Option<JsonValue>,
}

#[derive(Deserialize)]
enum AgentResultTag {
    #[serde(rename = "agentResult")]
    AgentResult,
}

impl<'de> Deserialize<'de> for AgentResult {
    /// Reads the serialized shape. The fields it leaves out (traces, metrics, invocation context and
    /// state) start empty.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let data = AgentResultData::deserialize(deserializer)?;
        let result = Self::new(data.stop_reason, data.last_message);
        Ok(match data.structured_output {
            Some(structured_output) => result.with_structured_output(structured_output),
            None => result,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::types::{
        CachePointBlock, Citation, CitationGeneratedContent, CitationLocation, CitationSourceContent, CitationsBlock,
        DocumentCharLocation, ReasoningBlock, Role, ToolResultBlock, ToolResultContent, ToolUseBlock,
    };

    fn assistant(content: Vec<ContentBlock>) -> Message {
        Message::new(Role::Assistant, content)
    }

    fn result(stop_reason: StopReason, content: Vec<ContentBlock>) -> AgentResult {
        AgentResult::new(stop_reason, assistant(content)).with_metrics(AgentMetrics::new())
    }

    fn text(text: &str) -> ContentBlock {
        ContentBlock::text(text)
    }

    #[test]
    fn returns_empty_string() {
        assert_eq!(result(StopReason::EndTurn, vec![]).to_string(), "");
    }

    #[test]
    fn returns_the_text_content() {
        assert_eq!(
            result(StopReason::EndTurn, vec![text("Hello, world!")]).to_string(),
            "Hello, world!"
        );
    }

    #[test]
    fn returns_all_text_joined_with_newlines() {
        let result = result(
            StopReason::EndTurn,
            vec![text("First line"), text("Second line"), text("Third line")],
        );
        assert_eq!(result.to_string(), "First line\nSecond line\nThird line");
    }

    #[test]
    fn returns_the_reasoning_text_with_prefix() {
        let block = ReasoningBlock::new().with_text("Let me think about this...");
        assert_eq!(
            result(StopReason::EndTurn, vec![block.into()]).to_string(),
            "💭 Reasoning:\n   Let me think about this..."
        );
    }

    #[test]
    fn returns_empty_string_reasoning_block_is_skipped() {
        let block = ReasoningBlock::new().with_signature("abc123");
        assert_eq!(result(StopReason::EndTurn, vec![block.into()]).to_string(), "");
    }

    #[test]
    fn returns_all_text_joined_with_newlines_for_mixed_text_and_reasoning() {
        let result = result(
            StopReason::EndTurn,
            vec![
                text("Here is my response."),
                ReasoningBlock::new().with_text("I reasoned carefully.").into(),
                text("Additional context."),
            ],
        );
        assert_eq!(
            result.to_string(),
            "Here is my response.\n💭 Reasoning:\n   I reasoned carefully.\nAdditional context."
        );
    }

    #[test]
    fn indents_multi_line_reasoning() {
        let block = ReasoningBlock::new().with_text("one\ntwo");
        assert_eq!(
            result(StopReason::EndTurn, vec![block.into()]).to_string(),
            "💭 Reasoning:\n   one\n   two"
        );
    }

    #[test]
    fn returns_empty_string_for_only_non_text_blocks() {
        let result = result(
            StopReason::ToolUse,
            vec![
                ToolUseBlock::new("calc", "id-1", json!({"a": 1, "b": 2})).into(),
                ToolResultBlock::success("id-1", vec![ToolResultContent::text("3")]).into(),
                CachePointBlock::new().into(),
            ],
        );
        assert_eq!(result.to_string(), "");
    }

    #[test]
    fn returns_only_text_from_text_block_and_reasoning_block() {
        let result = result(
            StopReason::ToolUse,
            vec![
                text("Before tool"),
                ToolUseBlock::new("calc", "id-1", json!({"a": 1, "b": 2})).into(),
                ReasoningBlock::new().with_text("Thinking...").into(),
                CachePointBlock::new().into(),
                text("After tool"),
            ],
        );
        assert_eq!(
            result.to_string(),
            "Before tool\n💭 Reasoning:\n   Thinking...\nAfter tool"
        );
    }

    #[test]
    fn returns_json_stringified_interrupts_taking_priority_over_text_content() {
        let interrupt = Interrupt::new("i-1", "confirm").with_reason("ok?");
        let result = result(StopReason::Interrupt, vec![text("ignored")]).with_interrupts(vec![interrupt.clone()]);
        assert_eq!(result.to_string(), serde_json::to_string(&[interrupt]).unwrap());
        assert_eq!(
            result.to_string(),
            r#"[{"id":"i-1","name":"confirm","reason":"ok?","source":"hook"}]"#
        );
    }

    #[test]
    fn falls_through_when_interrupts_array_is_empty() {
        let result = result(StopReason::EndTurn, vec![text("Hello")]).with_interrupts(vec![]);
        assert_eq!(result.to_string(), "Hello");
    }

    #[test]
    fn returns_json_stringified_structured_output_taking_priority_over_text_content() {
        let result = result(StopReason::EndTurn, vec![text("ignored")])
            .with_structured_output(json!({"answer": 42, "note": "hello"}));
        assert_eq!(result.to_string(), r#"{"answer":42,"note":"hello"}"#);
    }

    #[test]
    fn returns_interrupts_taking_priority_over_structured_output() {
        let interrupt = Interrupt::new("i-1", "confirm");
        let result = result(StopReason::Interrupt, vec![text("ignored")])
            .with_interrupts(vec![interrupt])
            .with_structured_output(json!({"answer": 42}));
        assert_eq!(result.to_string(), r#"[{"id":"i-1","name":"confirm","source":"hook"}]"#);
    }

    #[test]
    fn concatenates_generated_content_text_from_citations() {
        let citation = Citation::new(
            CitationLocation::DocumentChar(DocumentCharLocation::new(0, 0, 5)),
            "doc",
            vec![CitationSourceContent::new("source text")],
            "Doc",
        );
        let citations = CitationsBlock::new(vec![citation], vec![CitationGeneratedContent::new("cited fragment")]);
        let result = result(StopReason::EndTurn, vec![text("Here is a citation:"), citations.into()]);
        assert_eq!(result.to_string(), "Here is a citation:\ncited fragment");
    }

    #[test]
    fn works_with_string_conversion() {
        assert_eq!(result(StopReason::EndTurn, vec![text("Hello")]).to_string(), "Hello");
    }

    #[test]
    fn works_with_template_literals() {
        let result = result(StopReason::EndTurn, vec![text("World")]);
        assert_eq!(format!("Response: {result}"), "Response: World");
    }

    #[test]
    fn returns_latest_context_size_from_metrics() {
        let result = AgentResult::new(StopReason::EndTurn, assistant(vec![text("Hello")]))
            .with_metrics(AgentMetrics::new().with_latest_context_size(500));
        assert_eq!(result.context_size(), Some(500));
    }

    #[test]
    fn returns_undefined_when_metrics_has_no_latest_context_size() {
        assert_eq!(result(StopReason::EndTurn, vec![text("Hello")]).context_size(), None);
    }

    #[test]
    fn returns_undefined_when_no_metrics_are_available() {
        let result = AgentResult::new(StopReason::EndTurn, assistant(vec![text("Hello")]));
        assert_eq!(result.context_size(), None);
        assert_eq!(result.projected_context_size(), None);
    }

    #[test]
    fn returns_projected_context_size_from_metrics() {
        let result = AgentResult::new(StopReason::EndTurn, assistant(vec![text("Hello")]))
            .with_metrics(AgentMetrics::new().with_projected_context_size(750));
        assert_eq!(result.projected_context_size(), Some(750));
    }

    #[test]
    fn returns_undefined_when_metrics_has_no_projected_context_size() {
        assert_eq!(
            result(StopReason::EndTurn, vec![text("Hello")]).projected_context_size(),
            None
        );
    }

    fn with_traces(content: &str) -> (AgentResult, Message) {
        let message = assistant(vec![text(content)]).with_tracking_id("m-1");
        let result = AgentResult::new(StopReason::EndTurn, message.clone())
            .with_traces(vec![AgentTrace::new("Cycle 1", 0)])
            .with_metrics(AgentMetrics::new());
        (result, message)
    }

    #[test]
    fn excludes_traces_and_metrics_from_serialization() {
        let (result, message) = with_traces("Hello");
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"type": "agentResult", "stopReason": "endTurn", "lastMessage": message})
        );
    }

    #[test]
    fn includes_structured_output_when_present() {
        let result = AgentResult::new(StopReason::EndTurn, assistant(vec![text("Response")]))
            .with_structured_output(json!({"field": "value"}));
        assert_eq!(
            serde_json::to_value(&result).unwrap()["structuredOutput"],
            json!({"field": "value"})
        );
    }

    #[test]
    fn excludes_structured_output_when_not_present() {
        let result = AgentResult::new(StopReason::EndTurn, assistant(vec![text("Response")]));
        assert!(serde_json::to_value(&result).unwrap().get("structuredOutput").is_none());
    }

    #[test]
    fn is_automatically_used_by_json_stringify() {
        let (result, _) = with_traces("Hello");
        let parsed: JsonValue = serde_json::from_str(&serde_json::to_string(&result).unwrap()).unwrap();
        assert_eq!(parsed["type"], "agentResult");
        assert_eq!(parsed["lastMessage"]["role"], "assistant");
        assert_eq!(parsed.as_object().unwrap().len(), 3);
    }

    #[test]
    fn preserves_traces_and_metrics_as_accessible_properties() {
        let (result, message) = with_traces("Hello");
        assert_eq!(result.traces().map(<[AgentTrace]>::len), Some(1));
        assert_eq!(result.metrics(), Some(&AgentMetrics::new()));
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({"type": "agentResult", "stopReason": "endTurn", "lastMessage": message})
        );
    }

    #[test]
    fn prevents_bloated_api_responses_when_forwarding_result_directly() {
        let (result, _) = with_traces("Response text");
        let response: JsonValue = serde_json::to_value(&result).unwrap();
        assert!(response.get("traces").is_none());
        assert!(response.get("metrics").is_none());
    }

    #[test]
    fn deserializes_the_to_json_shape() {
        let wire = r#"{"type":"agentResult","stopReason":"endTurn","lastMessage":{"role":"assistant","content":[{"text":"hi"}],"trackingId":"m-1"},"structuredOutput":{"a":1}}"#;
        let result: AgentResult = serde_json::from_str(wire).unwrap();
        assert_eq!(serde_json::to_string(&result).unwrap(), wire);
        assert_eq!(result.structured_output::<JsonValue>().unwrap(), json!({"a": 1}));
        assert!(serde_json::from_str::<AgentResult>(&wire.replace("agentResult", "other")).is_err());
    }

    #[test]
    fn structured_output_is_typed_and_errors_when_absent() {
        #[derive(Deserialize, Debug, PartialEq)]
        struct Answer {
            answer: u32,
        }
        let result =
            AgentResult::new(StopReason::EndTurn, assistant(vec![])).with_structured_output(json!({"answer": 42}));
        assert_eq!(result.structured_output::<Answer>().unwrap(), Answer { answer: 42 });
        let error = AgentResult::new(StopReason::EndTurn, assistant(vec![]))
            .structured_output::<Answer>()
            .unwrap_err();
        assert_eq!(error.to_string(), NO_STRUCTURED_OUTPUT);
    }
}
