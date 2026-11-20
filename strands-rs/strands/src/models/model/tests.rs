use std::error::Error as _;

use futures::StreamExt;
use serde_json::json;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::models::streaming::{
    CitationsDelta, Metrics, ModelContentBlockDeltaEvent, ModelContentBlockStopEvent, ModelMessageStartEvent,
    ModelMessageStopEvent, RedactInputContent, RedactOutputContent, TextDelta, ToolUseInputDelta, ToolUseStart, Usage,
};
use crate::models::summarize::{DEFAULT_SUMMARIZE_INSTRUCTIONS, SUMMARIZE_GUARD};
use crate::models::{PromptCaching, SummarizeResult};
use crate::test_support::record_logs;
use crate::testing::{MockModel, MockTurn};
use crate::types::{
    CachePointBlock, CitationLocation, CitationSourceContent, DocumentChunkLocation, GuardContentText, GuardQualifier,
    InjectedBlock, SummaryBlock, ToolResultBlock, WebLocation,
};

type E = ModelStreamEvent;

fn message_start() -> E {
    ModelMessageStartEvent::new(Role::Assistant).into()
}

fn block_start() -> E {
    ModelContentBlockStartEvent::new().into()
}

fn tool_start(tool_use_id: &str, name: &str) -> E {
    ModelContentBlockStartEvent::new()
        .with_start(ToolUseStart::new(name, tool_use_id))
        .into()
}

fn text(text: &str) -> E {
    ModelContentBlockDeltaEvent::new(TextDelta::new(text)).into()
}

fn tool_input(input: &str) -> E {
    ModelContentBlockDeltaEvent::new(ToolUseInputDelta::new(input)).into()
}

fn reasoning(delta: ReasoningContentDelta) -> E {
    ModelContentBlockDeltaEvent::new(delta).into()
}

fn citations(citations: Vec<Citation>, content: Vec<CitationGeneratedContent>) -> E {
    ModelContentBlockDeltaEvent::new(CitationsDelta::new(citations, content)).into()
}

fn block_stop() -> E {
    ModelContentBlockStopEvent::new().into()
}

fn message_stop(stop_reason: StopReason) -> E {
    ModelMessageStopEvent::new(stop_reason).into()
}

fn usage(input: u64, output: u64) -> Usage {
    Usage::new(input, output, input + output)
}

fn metadata(usage: Usage) -> E {
    ModelMetadataEvent::new().with_usage(usage).into()
}

fn provider(events: Vec<E>) -> MockModel {
    let model = MockModel::new();
    model.add_turn(MockTurn::events(events));
    model
}

fn hi() -> Vec<Message> {
    vec![Message::user("Hi")]
}

struct Collected {
    items: Vec<AggregatedEvent>,
    result: Result<StreamAggregatedResult>,
}

impl Collected {
    fn ok(self) -> StreamAggregatedResult {
        self.result.unwrap()
    }

    fn blocks(&self) -> Vec<ContentBlock> {
        self.items
            .iter()
            .filter_map(|item| match item {
                AggregatedEvent::ContentBlock(block) => Some(block.clone()),
                _ => None,
            })
            .collect()
    }

    fn events_json(&self) -> Vec<JsonValue> {
        self.items
            .iter()
            .map(|item| match item {
                AggregatedEvent::ModelStreamEvent(event) => serde_json::to_value(event).unwrap(),
                AggregatedEvent::ContentBlock(block) => json!({"block": serde_json::to_value(block).unwrap()}),
                AggregatedEvent::Done(_) => unreachable!(),
            })
            .collect()
    }
}

async fn collect(model: &dyn Model, messages: Vec<Message>) -> Collected {
    let mut stream = model.stream_aggregated(ModelRequest::builder().messages(messages).build());
    let mut items = Vec::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(AggregatedEvent::Done(result)) => {
                return Collected {
                    items,
                    result: Ok(result),
                };
            }
            Ok(item) => items.push(item),
            Err(error) => {
                return Collected {
                    items,
                    result: Err(error),
                };
            }
        }
    }
    panic!("stream ended without a result");
}

fn message_json(message: &Message) -> JsonValue {
    json!({
        "role": message.role,
        "content": message.content,
        "metadata": message.metadata,
    })
}

#[tokio::test]
async fn yields_original_events_plus_aggregated_content_block_and_returns_final_message() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 5)),
    ]);
    let collected = collect(&model, hi()).await;
    assert_eq!(
        collected.events_json(),
        [
            json!({"type": "modelMessageStartEvent", "role": "assistant"}),
            json!({"type": "modelContentBlockStartEvent"}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
            json!({"type": "modelContentBlockStopEvent"}),
            json!({"block": {"text": "Hello"}}),
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}),
        ]
    );
    let result = collected.ok();
    assert_eq!(
        message_json(&result.message),
        json!({
            "role": "assistant",
            "content": [{"text": "Hello"}],
            "metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}},
        })
    );
    assert_eq!(result.stop_reason, StopReason::EndTurn);
    assert_eq!(
        result.metadata,
        Some(ModelMetadataEvent::new().with_usage(usage(10, 5)))
    );
    assert_eq!(result.redaction, None);
}

#[tokio::test]
async fn throws_max_token_error_when_stop_reason_is_max_token_error() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::MaxTokens),
        metadata(usage(10, 5)),
    ]);
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Model reached maximum token limit. This is an unrecoverable state that requires intervention."
    );
    let Error::MaxTokens(error) = error else {
        panic!("expected MaxTokensError");
    };
    assert_eq!(error.partial_message.text(), "Hello");
    assert_eq!(
        error
            .partial_message
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.usage),
        Some(usage(10, 5))
    );
}

#[tokio::test]
async fn completes_a_message_with_streamed_text_and_tool_use_as_the_assistant() {
    let model = provider(vec![
        block_start(),
        text("Checking"),
        block_stop(),
        tool_start("tool1", "get_weather"),
        tool_input(r#"{"location": "Paris"}"#),
        block_stop(),
        message_stop(StopReason::ToolUse),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        message_json(&result.message),
        json!({
            "role": "assistant",
            "content": [
                {"text": "Checking"},
                {"toolUse": {"name": "get_weather", "toolUseId": "tool1", "input": {"location": "Paris"}}},
            ],
            "metadata": null,
        })
    );
    assert_eq!(result.stop_reason, StopReason::ToolUse);
}

#[tokio::test]
async fn returns_an_empty_assistant_message_when_the_turn_is_empty() {
    let model = provider(vec![message_stop(StopReason::EndTurn), metadata(usage(10, 1))]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        message_json(&result.message),
        json!({
            "role": "assistant",
            "content": [],
            "metadata": {"usage": {"inputTokens": 10, "outputTokens": 1, "totalTokens": 11}},
        })
    );
    assert_eq!(
        result.metadata,
        Some(ModelMetadataEvent::new().with_usage(usage(10, 1)))
    );
}

#[tokio::test]
async fn yields_all_blocks_in_order() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("First"),
        block_stop(),
        block_start(),
        text("Second"),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 10)),
    ]);
    let collected = collect(&model, hi()).await;
    assert_eq!(
        collected.blocks(),
        [ContentBlock::text("First"), ContentBlock::text("Second")]
    );
    let result = collected.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::text("First"), ContentBlock::text("Second")]
    );
    assert_eq!(
        result.metadata,
        Some(ModelMetadataEvent::new().with_usage(usage(10, 10)))
    );
}

#[tokio::test]
async fn yields_complete_tool_use_block() {
    let model = provider(vec![
        message_start(),
        tool_start("tool1", "get_weather"),
        tool_input(r#"{"location""#),
        tool_input(r#": "Paris"}"#),
        block_stop(),
        message_stop(StopReason::ToolUse),
        metadata(usage(10, 8)),
    ]);
    let collected = collect(&model, hi()).await;
    let expected = ContentBlock::ToolUse(ToolUseBlock::new("get_weather", "tool1", json!({"location": "Paris"})));
    assert_eq!(collected.blocks(), std::slice::from_ref(&expected));
    let result = collected.ok();
    assert_eq!(result.message.content, [expected]);
    assert_eq!(result.stop_reason, StopReason::ToolUse);
}

#[tokio::test]
async fn yields_complete_tool_use_block_with_empty_input() {
    let model = provider(vec![
        message_start(),
        tool_start("tool1", "get_time"),
        tool_input(""),
        block_stop(),
        message_stop(StopReason::ToolUse),
        metadata(usage(10, 8)),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::ToolUse(ToolUseBlock::new("get_time", "tool1", json!({})))]
    );
}

#[tokio::test]
async fn keeps_the_reasoning_signature_of_a_tool_use() {
    let start =
        ModelContentBlockStartEvent::new().with_start(ToolUseStart::new("calc", "t1").with_reasoning_signature("sig"));
    let model = provider(vec![
        message_start(),
        start.into(),
        tool_input("{}"),
        block_stop(),
        message_stop(StopReason::ToolUse),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::ToolUse(
            ToolUseBlock::new("calc", "t1", json!({})).with_reasoning_signature("sig")
        )]
    );
}

#[tokio::test]
async fn throws_max_token_error_when_stop_reason_is_max_token_error_and_tool_use_is_partial() {
    let model = provider(vec![
        message_start(),
        tool_start("tool1", "get_weather"),
        tool_input(r#"{"location""#),
        message_stop(StopReason::MaxTokens),
        metadata(usage(10, 8)),
    ]);
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(error.name(), "MaxTokensError");
}

#[tokio::test]
async fn throws_max_tokens_error_when_content_block_stop_arrives_with_truncated_tool_input_json_and_stop_reason_is_max_tokens()
 {
    let model = provider(vec![
        message_start(),
        tool_start("t", "tool"),
        tool_input(r#"{"field": "value""#),
        block_stop(),
        message_stop(StopReason::MaxTokens),
    ]);
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(error.name(), "MaxTokensError");
}

#[tokio::test]
async fn surfaces_syntax_error_as_cause_when_tool_input_json_is_malformed_and_stop_reason_is_not_max_tokens() {
    let model = provider(vec![
        message_start(),
        tool_start("t", "tool"),
        tool_input("{invalid json"),
        block_stop(),
        message_stop(StopReason::ToolUse),
    ]);
    let collected = collect(&model, hi()).await;
    assert!(collected.blocks().is_empty());
    let error = collected.result.unwrap_err();
    assert_eq!(error.name(), "ModelError");
    assert_eq!(error.to_string(), "unable to parse tool input JSON");
    assert!(error.source().unwrap().is::<serde_json::Error>());
}

#[tokio::test]
async fn attaches_syntax_error_as_cause_when_stream_ends_without_a_stop_event_after_malformed_tool_input() {
    let model = provider(vec![
        message_start(),
        tool_start("t", "tool"),
        tool_input("{invalid json"),
        block_stop(),
    ]);
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(error.name(), "ModelError");
    assert_eq!(error.to_string(), "Stream ended without completing a message");
    assert!(error.source().unwrap().is::<serde_json::Error>());
}

#[tokio::test]
async fn does_not_carry_a_malformed_tool_use_into_the_next_block() {
    let model = provider(vec![
        message_start(),
        tool_start("t", "tool"),
        tool_input("{invalid json"),
        block_stop(),
        block_start(),
        text("after"),
        block_stop(),
        message_stop(StopReason::MaxTokens),
    ]);
    let collected = collect(&model, hi()).await;
    assert_eq!(collected.blocks(), [ContentBlock::text("after")]);
    let Err(Error::MaxTokens(error)) = collected.result else {
        panic!("expected MaxTokensError");
    };
    assert_eq!(error.partial_message.content, [ContentBlock::text("after")]);
}

#[tokio::test]
async fn yields_complete_reasoning_block() {
    let model = provider(vec![
        message_start(),
        block_start(),
        reasoning(
            ReasoningContentDelta::new()
                .with_text("Thinking about")
                .with_signature("sig1"),
        ),
        reasoning(ReasoningContentDelta::new().with_text(" the problem")),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 10)),
    ]);
    let expected = ContentBlock::Reasoning(
        ReasoningBlock::new()
            .with_text("Thinking about the problem")
            .with_signature("sig1"),
    );
    let collected = collect(&model, hi()).await;
    assert_eq!(collected.blocks(), std::slice::from_ref(&expected));
    assert_eq!(collected.ok().message.content, [expected]);
}

#[tokio::test]
async fn yields_redacted_content_reasoning_block() {
    let model = provider(vec![
        message_start(),
        block_start(),
        reasoning(ReasoningContentDelta::new().with_redacted_content(Vec::new())),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 5)),
    ]);
    let expected = ContentBlock::Reasoning(ReasoningBlock::new().with_redacted_content(Vec::new()));
    let collected = collect(&model, hi()).await;
    assert_eq!(collected.blocks(), std::slice::from_ref(&expected));
    assert_eq!(collected.ok().message.content, [expected]);
}

#[tokio::test]
async fn omits_signature_if_not_present() {
    let model = provider(vec![
        message_start(),
        block_start(),
        reasoning(ReasoningContentDelta::new().with_text("Thinking")),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        serde_json::to_value(&result.message.content).unwrap(),
        json!([{"reasoning": {"text": "Thinking"}}])
    );
}

#[tokio::test]
async fn reasoning_replaces_the_signature_with_the_latest_one() {
    let model = provider(vec![
        message_start(),
        block_start(),
        reasoning(ReasoningContentDelta::new().with_text("a").with_signature("s1")),
        reasoning(ReasoningContentDelta::new().with_text("b").with_signature("s2")),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::Reasoning(
            ReasoningBlock::new().with_text("ab").with_signature("s2")
        )]
    );
}

#[tokio::test]
async fn yields_all_blocks_in_correct_order() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        tool_start("tool1", "get_weather"),
        tool_input(r#"{"city": "Paris"}"#),
        block_stop(),
        block_start(),
        reasoning(
            ReasoningContentDelta::new()
                .with_text("Reasoning")
                .with_signature("sig1"),
        ),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 15)),
    ]);
    let expected = vec![
        ContentBlock::text("Hello"),
        ContentBlock::ToolUse(ToolUseBlock::new("get_weather", "tool1", json!({"city": "Paris"}))),
        ContentBlock::Reasoning(ReasoningBlock::new().with_text("Reasoning").with_signature("sig1")),
    ];
    let collected = collect(&model, hi()).await;
    assert_eq!(collected.blocks(), expected);
    assert_eq!(collected.ok().message.content, expected);
}

fn web_citation() -> Citation {
    Citation::new(
        CitationLocation::Web(WebLocation::new("https://a.com")),
        "https://a.com",
        Vec::new(),
        "A",
    )
}

#[tokio::test]
async fn falls_back_to_the_accumulated_text_when_the_delta_carries_no_content() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        citations(vec![web_citation()], Vec::new()),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::Citations(CitationsBlock::new(
            vec![web_citation()],
            vec![CitationGeneratedContent::new("Hello")]
        ))]
    );
}

#[tokio::test]
async fn keeps_the_delta_content_when_it_carries_some() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        citations(vec![web_citation()], vec![CitationGeneratedContent::new("cited")]),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(
        result.message.content,
        [ContentBlock::Citations(CitationsBlock::new(
            vec![web_citation()],
            vec![CitationGeneratedContent::new("cited")]
        ))]
    );
}

#[tokio::test]
async fn keeps_text_and_citations_scoped_to_each_completed_block() {
    let citation = Citation::new(
        CitationLocation::DocumentChunk(DocumentChunkLocation::new(0, 0, 1)),
        "",
        vec![CitationSourceContent::new(
            "Project Atlas automates invoice processing.",
        )],
        "doc1",
    );
    let model = provider(vec![
        message_start(),
        text("From the document: "),
        block_stop(),
        citations(vec![citation.clone()], Vec::new()),
        text("Atlas "),
        text("automates invoices."),
        block_stop(),
        text(" That is the summary."),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let expected = vec![
        ContentBlock::text("From the document: "),
        ContentBlock::Citations(CitationsBlock::new(
            vec![citation],
            vec![CitationGeneratedContent::new("Atlas automates invoices.")],
        )),
        ContentBlock::text(" That is the summary."),
    ];
    let collected = collect(&model, vec![Message::user("What is Atlas?")]).await;
    assert_eq!(collected.blocks(), expected);
    assert_eq!(collected.ok().message.content, expected);
}

#[tokio::test]
async fn drops_the_resulting_empty_text_block_from_the_aggregated_message_but_still_yields_it() {
    let model = provider(vec![
        message_start(),
        block_start(),
        reasoning(
            ReasoningContentDelta::new()
                .with_text("Thinking")
                .with_signature("sig1"),
        ),
        block_stop(),
        block_start(),
        block_stop(),
        tool_start("tool1", "get_weather"),
        tool_input(r#"{"city": "Paris"}"#),
        block_stop(),
        message_stop(StopReason::ToolUse),
    ]);
    let collected = collect(&model, hi()).await;
    assert!(collected.blocks().contains(&ContentBlock::text("")));
    assert_eq!(
        collected.ok().message.content,
        [
            ContentBlock::Reasoning(ReasoningBlock::new().with_text("Thinking").with_signature("sig1")),
            ContentBlock::ToolUse(ToolUseBlock::new("get_weather", "tool1", json!({"city": "Paris"}))),
        ]
    );
}

#[tokio::test]
async fn drops_whitespace_only_text_blocks_including_the_byte_order_mark() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text(" \n\t\u{feff}"),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    assert!(collect(&model, hi()).await.ok().message.content.is_empty());
}

#[tokio::test]
async fn yields_all_metadata_events_but_keeps_only_the_last_one_in_return_value() {
    let last = ModelMetadataEvent::new()
        .with_usage(usage(20, 10))
        .with_metrics(Metrics::new(100));
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::EndTurn),
        metadata(usage(10, 5)),
        last.clone().into(),
    ]);
    let collected = collect(&model, hi()).await;
    let metadata_events = collected
        .items
        .iter()
        .filter(|item| matches!(item, AggregatedEvent::ModelStreamEvent(E::Metadata(_))))
        .count();
    assert_eq!(metadata_events, 2);
    let result = collected.ok();
    assert_eq!(
        message_json(&result.message)["metadata"],
        json!({"usage": {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30}, "metrics": {"latencyMs": 100}})
    );
    assert_eq!(result.metadata, Some(last));
}

#[tokio::test]
async fn returns_result_with_undefined_metadata() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(result.metadata, None);
    assert_eq!(result.message.metadata, None);
}

#[tokio::test]
async fn wraps_non_model_error_errors_in_model_error_with_original_as_cause() {
    let model = MockModel::new();
    model.add_turn(MockTurn::error(|| Error::other("API connection failed")));
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(error.name(), "ModelError");
    assert_eq!(error.to_string(), "API connection failed");
    let source = error.source().unwrap().downcast_ref::<Error>().unwrap();
    assert_eq!(source.name(), "Error");
}

#[tokio::test]
async fn passes_model_errors_through_unwrapped() {
    let model = MockModel::new();
    model.add_turn(MockTurn::throttled("slow down"));
    let error = collect(&model, hi()).await.result.unwrap_err();
    assert_eq!(error.name(), "ModelThrottledError");
}

fn redaction_model(redactions: Vec<ModelRedactionEvent>) -> MockModel {
    let mut events = vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::GuardrailIntervened),
        metadata(usage(10, 5)),
    ];
    events.extend(redactions.into_iter().map(E::from));
    provider(events)
}

#[tokio::test]
async fn returns_redaction_user_message_when_input_redaction_is_present() {
    let model = redaction_model(vec![
        ModelRedactionEvent::new().with_input_redaction(RedactInputContent::new("[User input redacted.]")),
    ]);
    let messages = vec![Message::user("Sensitive content")];
    let result = collect(&model, messages.clone()).await.ok();
    assert_eq!(result.redaction, Some(Redaction::new("[User input redacted.]")));
    assert_eq!(messages[0].text(), "Sensitive content");
}

#[tokio::test]
async fn redacts_assistant_message_directly_when_output_redaction_is_present() {
    let model = redaction_model(vec![
        ModelRedactionEvent::new().with_output_redaction(RedactOutputContent::new("[Assistant output redacted.]")),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(result.message.role, Role::Assistant);
    assert_eq!(
        result.message.content,
        [ContentBlock::text("[Assistant output redacted.]")]
    );
    assert_eq!(result.redaction, None);
}

#[tokio::test]
async fn returns_redaction_message_and_redacts_assistant_when_both_are_present() {
    let model = redaction_model(vec![
        ModelRedactionEvent::new().with_input_redaction(RedactInputContent::new("[User input redacted.]")),
        ModelRedactionEvent::new().with_output_redaction(RedactOutputContent::new("[Assistant output redacted.]")),
    ]);
    let result = collect(&model, hi()).await.ok();
    assert_eq!(result.redaction, Some(Redaction::new("[User input redacted.]")));
    assert_eq!(
        result.message.content,
        [ContentBlock::text("[Assistant output redacted.]")]
    );
}

#[tokio::test]
async fn does_not_include_redaction_when_no_redact_events_are_received() {
    let model = provider(vec![
        message_start(),
        block_start(),
        text("Hello"),
        block_stop(),
        message_stop(StopReason::EndTurn),
    ]);
    assert_eq!(collect(&model, hi()).await.ok().redaction, None);
}

#[test]
fn returns_model_id_from_model_config() {
    let model = MockModel::new();
    model
        .update_config(BaseModelConfig::builder().model_id("my-model").build())
        .unwrap();
    assert_eq!(model.model_id().as_deref(), Some("my-model"));
}

/// Replies with `reply` texts and `stop_reason`.
fn recording_model(reply: &[&str], stop_reason: StopReason, usage: Option<Usage>) -> MockModel {
    let mut events = vec![message_start()];
    for text_part in reply {
        events.extend([block_start(), text(text_part), block_stop()]);
    }
    events.extend(usage.map(metadata));
    events.push(message_stop(stop_reason));
    provider(events)
}

fn history() -> Vec<Message> {
    vec![
        Message::user("task"),
        Message::new(
            Role::Assistant,
            vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "lookup",
                "t1",
                json!({"q": "x"}),
            ))],
        ),
        Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "t1",
                vec!["42".into()],
            ))],
        ),
    ]
}

fn turns(messages: &[Message]) -> JsonValue {
    messages
        .iter()
        .map(|message| json!({"role": message.role, "content": message.content}))
        .collect()
}

fn summary(text: &str) -> SummarizeResult {
    SummarizeResult::new(vec![ContentBlock::Summary(SummaryBlock::new(text))]).with_usage(Usage::default())
}

fn instructions(text: &str) -> ContentBlock {
    ContentBlock::text(format!("{SUMMARIZE_GUARD}\n\n{text}"))
}

#[tokio::test]
async fn replays_the_request_with_the_instructions_closing_it() {
    let model = recording_model(&["first", "second"], StopReason::EndTurn, None);
    let tool_specs = vec![ToolSpec::new("lookup", "Look up").with_input_schema(json!({"type": "object"}))];
    let system_prompt = SystemPrompt::Blocks(vec![
        SystemContentBlock::text("live prompt"),
        CachePointBlock::new().into(),
    ]);
    let options = SummarizeOptions::builder()
        .tool_specs(tool_specs.clone())
        .system_prompt(system_prompt.clone())
        .instructions("Summarize briefly.")
        .build();

    let result = model.summarize(history(), options).await.unwrap();

    assert_eq!(result, summary("first\nsecond"));
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    let mut last_turn = history()[2].content.clone();
    last_turn.push(instructions("Summarize briefly."));
    let mut expected = history()[..2].to_vec();
    expected.push(Message::new(Role::User, last_turn));
    assert_eq!(turns(&requests[0].messages), turns(&expected));
    assert_eq!(requests[0].tool_specs, tool_specs);
    assert_eq!(requests[0].system_prompt, Some(system_prompt));
    assert!(requests[0].agent_metadata.is_none() && requests[0].cancel_signal.is_none());
}

#[tokio::test]
async fn sends_the_agent_metadata() {
    let model = recording_model(&["the summary"], StopReason::EndTurn, None);
    let agent_metadata = AgentMetadata::new().with_session_id("session");
    let options = SummarizeOptions::builder()
        .agent_metadata(agent_metadata.clone())
        .build();

    model.summarize(history()[..2].to_vec(), options).await.unwrap();

    let requests = model.requests();
    let mut expected = history()[..2].to_vec();
    expected.push(Message::new(
        Role::User,
        vec![instructions(DEFAULT_SUMMARIZE_INSTRUCTIONS)],
    ));
    assert_eq!(turns(&requests[0].messages), turns(&expected));
    assert_eq!(requests[0].agent_metadata, Some(agent_metadata));
    assert!(requests[0].system_prompt.is_none() && requests[0].tool_specs.is_empty());
}

#[tokio::test]
async fn adds_a_user_turn_after_an_assistant_turn() {
    let model = recording_model(&["the summary"], StopReason::EndTurn, None);
    let options = SummarizeOptions::builder().instructions("Summarize briefly.").build();

    model.summarize(history()[..2].to_vec(), options).await.unwrap();

    let mut expected = history()[..2].to_vec();
    expected.push(Message::new(Role::User, vec![instructions("Summarize briefly.")]));
    assert_eq!(turns(&model.requests()[0].messages), turns(&expected));
}

#[tokio::test]
async fn sends_no_system_prompt_and_the_default_instructions_for_unset_or_empty_instructions() {
    for options in [
        SummarizeOptions::default(),
        SummarizeOptions::builder().instructions("").build(),
    ] {
        let model = recording_model(&["the summary"], StopReason::EndTurn, None);
        model.summarize(vec![Message::user("hi")], options).await.unwrap();
        let request = &model.requests()[0];
        assert!(request.system_prompt.is_none());
        assert_eq!(
            request.messages.last().unwrap().content.last(),
            Some(&instructions(DEFAULT_SUMMARIZE_INSTRUCTIONS))
        );
    }
}

#[tokio::test]
async fn returns_an_empty_summary_for_an_unfinished_reply() {
    for stop_reason in ["toolUse", "guardrailIntervened", "contentFiltered"] {
        let model = recording_model(&["canned"], StopReason::from(stop_reason), Some(usage(10, 1)));
        let (logs, _guard) = record_logs();

        let result = model
            .summarize(vec![Message::user("hi")], SummarizeOptions::default())
            .await
            .unwrap();

        assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(usage(10, 1)));
        let expected = format!("stop_reason=<{stop_reason}> | summary reply did not finish");
        assert!(logs.text().contains(&expected), "{}", logs.text());
        assert!(logs.text().contains("WARN model=<MockModel>"), "{}", logs.text());
    }
}

/// Streams a partial reply, cancels `handle` mid-stream, then either finishes or fails.
struct CancellingModel {
    handle: CancelHandle,
    fail_after_cancel: bool,
}

impl Model for CancellingModel {
    fn stream(&self, _request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        let handle = self.handle.clone();
        let fail = self.fail_after_cancel;
        Box::pin(async_stream::stream! {
            yield Ok(message_start());
            if fail {
                handle.cancel(CancelOptions::default());
                yield Err(Error::other("aborted"));
                return;
            }
            yield Ok(block_start());
            yield Ok(text("partial"));
            handle.cancel(CancelOptions::default());
            yield Ok(block_stop());
            yield Ok(message_stop(StopReason::EndTurn));
        })
    }

    fn get_config(&self) -> BaseModelConfig {
        BaseModelConfig::default()
    }

    fn update_config(&self, _config: BaseModelConfig) -> crate::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn returns_an_empty_summary_when_cancelled_mid_stream() {
    let handle = CancelHandle::new();
    let model = CancellingModel {
        handle: handle.clone(),
        fail_after_cancel: false,
    };
    let options = SummarizeOptions::builder().cancel_signal(handle.signal()).build();
    let result = model.summarize(vec![Message::user("hi")], options).await.unwrap();
    assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(Usage::default()));
}

#[tokio::test]
async fn sends_no_request_when_cancelled_before_the_call() {
    let handle = CancelHandle::new();
    handle.cancel(CancelOptions::default());
    let model = recording_model(&["the summary"], StopReason::EndTurn, None);
    let options = SummarizeOptions::builder().cancel_signal(handle.signal()).build();
    let result = model.summarize(vec![Message::user("hi")], options).await.unwrap();
    assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(Usage::default()));
    assert!(model.requests().is_empty());
}

#[tokio::test]
async fn returns_an_empty_summary_when_the_stream_throws_after_a_cancel() {
    let handle = CancelHandle::new();
    let model = CancellingModel {
        handle: handle.clone(),
        fail_after_cancel: true,
    };
    let options = SummarizeOptions::builder().cancel_signal(handle.signal()).build();
    let result = model.summarize(vec![Message::user("hi")], options).await.unwrap();
    assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(Usage::default()));
}

#[tokio::test]
async fn keeps_a_reply_that_stopped_at_a_limit() {
    for stop_reason in [StopReason::MaxTokens, StopReason::StopSequence] {
        let model = recording_model(&["partial"], stop_reason, None);
        let result = model
            .summarize(vec![Message::user("hi")], SummarizeOptions::default())
            .await
            .unwrap();
        assert_eq!(result, summary("partial"));
    }
}

#[tokio::test]
async fn returns_an_empty_summary_when_the_reply_holds_no_text() {
    let model = recording_model(&["  "], StopReason::EndTurn, Some(usage(10, 1)));
    let result = model
        .summarize(vec![Message::user("hi")], SummarizeOptions::default())
        .await
        .unwrap();
    assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(usage(10, 1)));
}

#[tokio::test]
async fn returns_its_usage() {
    let model = recording_model(&["the summary"], StopReason::EndTurn, Some(usage(10, 5)));
    let result = model
        .summarize(vec![Message::user("hi")], SummarizeOptions::default())
        .await
        .unwrap();
    assert_eq!(
        result,
        SummarizeResult::new(vec![ContentBlock::Summary(SummaryBlock::new("the summary"))]).with_usage(usage(10, 5))
    );
}

#[tokio::test]
async fn forwards_the_cancel_signal() {
    let model = recording_model(&["the summary"], StopReason::EndTurn, None);
    let handle = CancelHandle::new();
    let options = SummarizeOptions::builder().cancel_signal(handle.signal()).build();
    model.summarize(vec![Message::user("hi")], options).await.unwrap();
    let forwarded = model.requests()[0].cancel_signal.clone().unwrap();
    assert!(!forwarded.is_cancelled());
    handle.cancel(CancelOptions::default());
    assert!(forwarded.is_cancelled());
}

#[tokio::test]
async fn propagates_stream_errors() {
    let model = MockModel::new();
    model.add_turn(MockTurn::error(|| Error::other("images unsupported")));
    let error = model
        .summarize(vec![Message::user("hi")], SummarizeOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "images unsupported");
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test]
async fn stores_a_listed_models_client_side_summary_as_a_summary_block_without_a_provider() {
    let model = recording_model(&["a summary"], StopReason::EndTurn, None);
    model
        .update_config(BaseModelConfig::builder().model_id("claude-sonnet-5-5").build())
        .unwrap();
    assert_eq!(model.model_info().capabilities.server_side_summary, Some(true));
    let result = model
        .summarize(vec![Message::user("task")], SummarizeOptions::default())
        .await
        .unwrap();
    assert_eq!(result.content, [ContentBlock::Summary(SummaryBlock::new("a summary"))]);
}

async fn count(messages: Vec<Message>, options: CountTokensOptions) -> u64 {
    MockModel::new().count_tokens(&messages, options).await.unwrap()
}

fn ceil_div(length: usize, divisor: usize) -> u64 {
    length.div_ceil(divisor) as u64
}

#[tokio::test]
async fn counts_summary_text_like_a_text_block() {
    let text = "x".repeat(400);
    let summary = count(
        vec![Message::new(
            Role::Assistant,
            vec![ContentBlock::Summary(SummaryBlock::new(&text))],
        )],
        CountTokensOptions::default(),
    )
    .await;
    assert_eq!(
        summary,
        count(vec![Message::assistant(text)], CountTokensOptions::default()).await
    );
}

#[tokio::test]
async fn estimates_text_block_tokens_using_chars_4_heuristic() {
    assert_eq!(
        count(vec![Message::user("Hello world")], CountTokensOptions::default()).await,
        3
    );
}

#[tokio::test]
async fn estimates_tool_use_block_tokens_name_json_input() {
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::ToolUse(ToolUseBlock::new(
            "get_weather",
            "id1",
            json!({"city": "Seattle"}),
        ))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, 3 + 9);
}

#[tokio::test]
async fn estimates_tool_result_block_tokens_text_items_only() {
    let messages = vec![Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "id1",
            vec!["72°F and sunny".into()],
        ))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, ceil_div(14, 4));
}

#[tokio::test]
async fn estimates_tool_result_json_items_like_json() {
    let messages = vec![Message::new(
        Role::User,
        vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "id1",
            vec![ToolResultContent::json(json!({"a": 1}))],
        ))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, ceil_div(7, 2));
}

#[tokio::test]
async fn estimates_reasoning_block_tokens() {
    let text = "Let me think about this step by step";
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::Reasoning(ReasoningBlock::new().with_text(text))],
    )];
    assert_eq!(
        count(messages, CountTokensOptions::default()).await,
        ceil_div(text.len(), 4)
    );
}

fn guard(text: &str) -> crate::types::GuardContentBlock {
    GuardContentText::new(vec![GuardQualifier::Query], text).into()
}

#[tokio::test]
async fn estimates_guard_content_block_tokens() {
    let messages = vec![Message::new(
        Role::User,
        vec![ContentBlock::GuardContent(guard("Is this safe?"))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, ceil_div(13, 4));
}

#[tokio::test]
async fn estimates_citations_block_tokens() {
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::Citations(CitationsBlock::new(
            Vec::new(),
            vec![CitationGeneratedContent::new("cited text here")],
        ))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, ceil_div(15, 4));
}

#[tokio::test]
async fn estimates_injected_block_tokens() {
    let text = "cwd: /repo, date: today";
    let messages = vec![Message::new(
        Role::User,
        vec![ContentBlock::Injected(InjectedBlock::new(text, "test"))],
    )];
    assert_eq!(
        count(messages, CountTokensOptions::default()).await,
        ceil_div(text.len(), 4)
    );
}

#[tokio::test]
async fn counts_only_the_injected_blocks_of_the_latest_user_message() {
    let messages = vec![
        Message::new(
            Role::User,
            vec![ContentBlock::Injected(InjectedBlock::new("x".repeat(400), "test"))],
        ),
        Message::assistant("ok"),
        Message::new(
            Role::User,
            vec![ContentBlock::Injected(InjectedBlock::new("cwd: /repo", "test"))],
        ),
    ];
    assert_eq!(
        count(messages, CountTokensOptions::default()).await,
        ceil_div(2, 4) + ceil_div(10, 4)
    );
}

#[tokio::test]
async fn estimates_string_system_prompt_tokens() {
    let options = CountTokensOptions::builder()
        .system_prompt("You are a helpful assistant")
        .build();
    assert_eq!(count(hi(), options).await, ceil_div(27, 4) + ceil_div(2, 4));
}

#[tokio::test]
async fn estimates_array_system_prompt_tokens() {
    let options = CountTokensOptions::builder()
        .system_prompt(vec![SystemContentBlock::text("System instructions")])
        .build();
    assert_eq!(count(hi(), options).await, ceil_div(19, 4) + ceil_div(2, 4));
}

#[tokio::test]
async fn estimates_tool_spec_tokens() {
    let spec = ToolSpec::new("get_weather", "Get weather for a city");
    let spec_json = serde_json::to_string(&spec).unwrap();
    assert_eq!(
        spec_json,
        r#"{"name":"get_weather","description":"Get weather for a city"}"#
    );
    let options = CountTokensOptions::builder().tool_specs(vec![spec]).build();
    assert_eq!(
        count(hi(), options).await,
        ceil_div(2, 4) + ceil_div(spec_json.len(), 2)
    );
}

#[tokio::test]
async fn returns_0_for_empty_messages() {
    assert_eq!(count(Vec::new(), CountTokensOptions::default()).await, 0);
}

#[tokio::test]
async fn skips_reasoning_blocks_without_text() {
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::Reasoning(ReasoningBlock::new().with_signature("sig123"))],
    )];
    assert_eq!(count(messages, CountTokensOptions::default()).await, 0);
}

#[tokio::test]
async fn estimates_guard_content_in_array_system_prompt() {
    let options = CountTokensOptions::builder()
        .system_prompt(vec![SystemContentBlock::GuardContent(guard("Guard text here"))])
        .build();
    assert_eq!(count(hi(), options).await, ceil_div(15, 4) + ceil_div(2, 4));
}

#[tokio::test]
async fn accumulates_tokens_across_multiple_messages_with_mixed_content() {
    let messages = vec![
        Message::user("What is the weather?"),
        Message::new(
            Role::Assistant,
            vec![ContentBlock::ToolUse(ToolUseBlock::new(
                "get_weather",
                "id1",
                json!({"city": "Seattle"}),
            ))],
        ),
        Message::new(
            Role::User,
            vec![ContentBlock::ToolResult(ToolResultBlock::success(
                "id1",
                vec!["72F".into()],
            ))],
        ),
    ];
    let options = CountTokensOptions::builder().system_prompt("You are helpful").build();
    let expected = ceil_div(15, 4) + ceil_div(20, 4) + ceil_div(11, 4) + ceil_div(18, 2) + ceil_div(3, 4);
    assert_eq!(count(messages, options).await, expected);
}

#[tokio::test]
async fn counts_whole_number_floats_the_way_js_writes_them() {
    let messages = vec![Message::new(
        Role::Assistant,
        vec![ContentBlock::ToolUse(ToolUseBlock::new(
            "t",
            "id1",
            json!({"a": 1.0, "b": [2.0, 0.5]}),
        ))],
    )];
    let js = r#"{"a":1,"b":[2,0.5]}"#;
    assert_eq!(
        count(messages, CountTokensOptions::default()).await,
        ceil_div(1, 4) + ceil_div(js.len(), 2)
    );
}

#[test]
fn js_whitespace_matches_string_trim() {
    assert!(is_js_whitespace('\u{feff}') && is_js_whitespace('\u{a0}') && is_js_whitespace('\u{2028}'));
    assert!(!is_js_whitespace('\u{85}'));
}

#[tokio::test]
async fn counts_text_length_in_utf16_code_units_like_js() {
    assert_eq!(
        count(vec![Message::user("😀😀")], CountTokensOptions::default()).await,
        1
    );
    assert_eq!(
        count(vec![Message::user("😀😀😀")], CountTokensOptions::default()).await,
        2
    );
}

fn configured(config: BaseModelConfig) -> MockModel {
    let model = MockModel::new();
    model.update_config(config).unwrap();
    model
}

fn info_override(info: ModelInfo) -> BaseModelConfig {
    BaseModelConfig::builder().model_info(info).build()
}

#[test]
fn knows_only_that_temporary_messages_are_off_for_a_provider_with_no_model_id_and_unknown_stateful_reads_as_false() {
    let model = MockModel::new();
    assert_eq!(
        serde_json::to_value(model.model_info()).unwrap(),
        json!({"capabilities": {"temporaryMessages": false}})
    );
    assert!(!model.stateful());
}

#[test]
fn resolves_facts_from_the_shared_model_info_for_any_provider_by_model_id() {
    let model = configured(
        BaseModelConfig::builder()
            .model_id("us.anthropic.claude-sonnet-4-6")
            .build(),
    );
    let info = model.model_info();
    assert_eq!(info.limits.context_window, Some(1_000_000));
    assert_eq!(info.capabilities.prompt_caching, Some(PromptCaching::CachePoints));
}

#[test]
fn leaves_temporary_messages_off_for_a_model_the_shared_data_says_takes_them() {
    let model = configured(BaseModelConfig::builder().model_id("vertex.claude-opus-5-5").build());
    assert_eq!(model.model_info().capabilities.temporary_messages, Some(false));
}

/// A provider that puts its own facts over the shared model info, keeping the user override on top.
struct GatewayModel {
    inner: MockModel,
    facts: ModelInfo,
}

impl Model for GatewayModel {
    fn stream(&self, request: ModelRequest) -> BoxStream<'static, Result<ModelStreamEvent>> {
        self.inner.stream(request)
    }

    fn get_config(&self) -> BaseModelConfig {
        self.inner.get_config()
    }

    fn update_config(&self, config: BaseModelConfig) -> crate::Result<()> {
        self.inner.update_config(config)
    }

    fn model_info(&self) -> ModelInfo {
        let config = self.get_config();
        ModelInfo::merge([
            Some(&base_model_info(&config)),
            Some(&self.facts),
            config.model_info.as_ref(),
        ])
    }
}

fn gateway(facts: ModelCapabilities) -> GatewayModel {
    GatewayModel {
        inner: MockModel::new(),
        facts: ModelInfo {
            capabilities: facts,
            ..ModelInfo::default()
        },
    }
}

#[test]
fn lets_a_provider_put_its_facts_over_the_shared_model_info_with_the_user_override_over_both() {
    let model = gateway(
        ModelCapabilities::builder()
            .prompt_caching(PromptCaching::Unsupported)
            .build(),
    );
    model
        .update_config(
            BaseModelConfig::builder()
                .model_id("claude-sonnet-4-6")
                .context_window_limit(8_000)
                .build(),
        )
        .unwrap();
    assert_eq!(
        model.model_info().capabilities.prompt_caching,
        Some(PromptCaching::Unsupported)
    );
    assert_eq!(model.model_info().limits.context_window, Some(8_000));

    model
        .update_config(info_override(ModelInfo {
            capabilities: ModelCapabilities::builder()
                .prompt_caching(PromptCaching::CachePoints)
                .build(),
            ..ModelInfo::default()
        }))
        .unwrap();
    assert_eq!(
        model.model_info().capabilities.prompt_caching,
        Some(PromptCaching::CachePoints)
    );
}

#[test]
fn lets_the_info_override_set_stateful_and_the_stateful_getter_reads_it() {
    let model = MockModel::new();
    assert!(!model.stateful());
    model
        .update_config(info_override(ModelInfo {
            capabilities: ModelCapabilities::builder().stateful(true).build(),
            ..ModelInfo::default()
        }))
        .unwrap();
    assert_eq!(model.model_info().capabilities.stateful, Some(true));
    assert!(model.stateful());
}

#[test]
fn lets_the_info_override_win_over_context_window_limit() {
    let model = configured(
        BaseModelConfig::builder()
            .context_window_limit(50_000)
            .model_info(ModelInfo {
                limits: ModelLimits::builder().context_window(10_000).build(),
                ..ModelInfo::default()
            })
            .build(),
    );
    assert_eq!(model.model_info().limits.context_window, Some(10_000));
}

#[test]
fn takes_the_context_window_from_the_config() {
    let model = configured(BaseModelConfig::builder().context_window_limit(50_000).build());
    assert_eq!(model.model_info().limits.context_window, Some(50_000));
}

#[test]
fn reads_stateful_from_what_a_provider_puts_in_the_record() {
    let model = gateway(ModelCapabilities::builder().stateful(true).build());
    assert!(model.stateful());
    model
        .update_config(info_override(ModelInfo {
            capabilities: ModelCapabilities::builder().stateful(false).build(),
            ..ModelInfo::default()
        }))
        .unwrap();
    assert!(!model.stateful());
}

#[test]
fn reflects_config_changes_on_the_next_read() {
    let model = MockModel::new();
    assert_eq!(model.model_info().limits.context_window, None);
    model
        .update_config(BaseModelConfig::builder().context_window_limit(4_096).build())
        .unwrap();
    assert_eq!(model.model_info().limits.context_window, Some(4_096));
}

#[test]
fn uses_the_context_window_from_info_including_an_info_override() {
    let model = configured(info_override(ModelInfo {
        limits: ModelLimits::builder().context_window(10_000).build(),
        ..ModelInfo::default()
    }));
    assert!((model.estimate_utilization(5_000) - 0.5).abs() < f64::EPSILON);
}

#[test]
fn returns_ratio_of_input_tokens_to_context_window_limit() {
    let model = configured(BaseModelConfig::builder().context_window_limit(100_000).build());
    assert!((model.estimate_utilization(50_000) - 0.5).abs() < f64::EPSILON);
}

#[test]
fn uses_default_context_window_limit_when_context_window_limit_is_not_set() {
    crate::logging::forget_warning(&default_context_window_warning(200_000));
    let (utilization, logs) = crate::test_support::capture_logs(|| MockModel::new().estimate_utilization(100_000));
    assert!((utilization - 0.5).abs() < f64::EPSILON);
    let warned = "WARN contextWindowLimit is not set on the model, using default of 200000 for utilization estimate";
    assert!(logs.contains(warned), "{logs}");
}

#[test]
fn returns_value_above_1_0_when_tokens_exceed_limit() {
    let model = configured(BaseModelConfig::builder().context_window_limit(1000).build());
    assert!(model.estimate_utilization(1500) > 1.0);
}

#[test]
fn returns_0_for_zero_tokens() {
    let model = configured(BaseModelConfig::builder().context_window_limit(100_000).build());
    assert!(model.estimate_utilization(0).abs() < f64::EPSILON);
}

#[test]
fn update_config_replaces_only_the_fields_it_sets() {
    let mut config = BaseModelConfig::builder()
        .model_id("a")
        .max_tokens(10)
        .temperature(0.5)
        .build();
    config.merge(BaseModelConfig::builder().max_tokens(20).top_p(0.9).build());
    assert_eq!(
        config,
        BaseModelConfig::builder()
            .model_id("a")
            .max_tokens(20)
            .temperature(0.5)
            .top_p(0.9)
            .build()
    );
}

#[test]
fn resolve_config_metadata_fills_the_context_window_from_the_model_info() {
    let filled = resolve_config_metadata(BaseModelConfig::default(), "claude-sonnet-4-6");
    assert_eq!(filled.context_window_limit, Some(1_000_000));
    let explicit = BaseModelConfig::builder().context_window_limit(5).build();
    assert_eq!(
        resolve_config_metadata(explicit, "claude-sonnet-4-6").context_window_limit,
        Some(5)
    );
    let overridden = info_override(ModelInfo {
        limits: ModelLimits::builder().context_window(7).build(),
        ..ModelInfo::default()
    });
    assert_eq!(
        resolve_config_metadata(overridden, "claude-sonnet-4-6").context_window_limit,
        Some(7)
    );
    assert_eq!(
        resolve_config_metadata(BaseModelConfig::default(), "unknown").context_window_limit,
        None
    );
}

#[test]
fn resolve_max_tokens_prefers_the_config_then_the_model_info() {
    let config = BaseModelConfig::builder().max_tokens(5).build();
    assert_eq!(resolve_max_tokens(&config, "claude-sonnet-4-6"), Some(5));
    assert_eq!(
        resolve_max_tokens(&BaseModelConfig::default(), "claude-sonnet-4-6"),
        Some(128_000)
    );
    assert_eq!(resolve_max_tokens(&BaseModelConfig::default(), "unknown"), None);
}

#[test]
fn latest_user_index_finds_the_last_user_message() {
    let messages = vec![
        Message::user("a"),
        Message::assistant("b"),
        Message::user("c"),
        Message::assistant("d"),
    ];
    assert_eq!(latest_user_index(&messages), Some(2));
    assert_eq!(latest_user_index(&[Message::assistant("x")]), None);
}

/// Cache points per section as `cacheConfig` portability compares them: one entry per enabled
/// section, holding its TTL or `None`.
fn cache_sections(config: &CacheConfig) -> (Vec<Option<String>>, Vec<Option<String>>) {
    let ttl = config.ttl.as_deref();
    let section = |setting: Option<&CacheSectionSetting>| {
        let resolved = resolve_cache_section(setting, &[ttl]);
        if resolved.enabled {
            vec![resolved.ttl]
        } else {
            Vec::new()
        }
    };
    (
        section(config.tools_ttl.as_ref()),
        section(config.messages_ttl.as_ref()),
    )
}

#[test]
fn agrees_on_cache_sections_across_providers() {
    let h = || Some("1h".to_owned());
    let cases = [
        (
            "both sections by default",
            CacheConfig::default(),
            (vec![None], vec![None]),
        ),
        (
            "a shared ttl on both sections",
            CacheConfig::builder().ttl("1h").build(),
            (vec![h()], vec![h()]),
        ),
        (
            "tool definitions only",
            CacheConfig::builder().ttl("1h").messages_ttl(false).build(),
            (vec![h()], vec![]),
        ),
        (
            "conversation only",
            CacheConfig::builder().ttl("1h").tools_ttl(false).build(),
            (vec![], vec![h()]),
        ),
        (
            "a per-section ttl override",
            CacheConfig::builder().ttl("1h").messages_ttl("5m").build(),
            (vec![h()], vec![Some("5m".to_owned())]),
        ),
        (
            "an empty ttl treated as unset",
            CacheConfig::builder().ttl("").build(),
            (vec![None], vec![None]),
        ),
        (
            "every section disabled",
            CacheConfig::builder().tools_ttl(false).messages_ttl(false).build(),
            (vec![], vec![]),
        ),
    ];
    for (label, config, expected) in cases {
        assert_eq!(cache_sections(&config), expected, "{label}");
    }
}

#[test]
fn resolve_cache_section_tries_fallbacks_in_order() {
    let enabled = CacheSectionSetting::from(true);
    assert_eq!(
        resolve_cache_section(Some(&enabled), &[None, Some(""), Some("5m"), Some("1h")]),
        ResolvedCacheSection {
            enabled: true,
            ttl: Some("5m".to_owned())
        }
    );
}
