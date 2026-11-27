use serde_json::json;

use super::*;
use crate::Usage;
use crate::agent::{InvocationContext, InvokeLimits};
use crate::telemetry::Tracer;
use crate::testing::{MockModel, MockTurn};

fn user_turn(text: &str) -> Vec<Message> {
    vec![Message::user(text)]
}

fn replying(text: &str) -> MockModel {
    MockModel::new().with_turn(text)
}

fn with_model(model: &MockModel) -> ModelExtractor {
    ModelExtractor::new(ModelExtractorOptions {
        model: Some(Arc::new(model.clone())),
        system_prompt: None,
    })
}

fn contents(entries: &[ExtractionResult]) -> Vec<&str> {
    entries.iter().map(|entry| entry.content.as_str()).collect()
}

fn system_prompt(model: &MockModel) -> String {
    match &model.requests()[0].system_prompt {
        Some(SystemPrompt::Text(text)) => text.clone(),
        other => panic!("not a text system prompt: {other:?}"),
    }
}

#[tokio::test]
async fn parses_a_json_array_of_entries_from_the_model_response() {
    let model = replying(r#"[{"content": "User prefers dark mode"}, {"content": "Lives in Berlin"}]"#);
    let entries = with_model(&model)
        .extract(
            &user_turn("I like dark mode and live in Berlin"),
            ExtractorContext::default(),
        )
        .await
        .unwrap();
    assert_eq!(contents(&entries), ["User prefers dark mode", "Lives in Berlin"]);
}

#[tokio::test]
async fn extracts_a_json_array_even_when_wrapped_in_prose_or_a_code_fence() {
    let model = replying("Here are the facts:\n```json\n[{\"content\": \"fact\"}]\n```\nHope that helps.");
    let entries = with_model(&model)
        .extract(&user_turn("something"), ExtractorContext::default())
        .await
        .unwrap();
    assert_eq!(entries, [ExtractionResult::new("fact")]);
}

#[tokio::test]
async fn preserves_entry_metadata() {
    let model = replying(r#"[{"content": "fact", "metadata": {"topic": "pref"}}]"#);
    let entries = with_model(&model)
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap();
    let metadata = json!({"topic": "pref"}).as_object().cloned().unwrap();
    assert_eq!(entries, [ExtractionResult::new("fact").with_metadata(metadata)]);
}

#[tokio::test]
async fn returns_no_entries_on_malformed_json_without_throwing() {
    let model = replying("not json at all");
    let entries = with_model(&model)
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap();
    assert!(entries.is_empty());
}

#[tokio::test]
async fn drops_entries_without_a_string_content_and_empty_strings() {
    let model = replying(r#"[{"content": "keep"}, {"content": ""}, {"foo": "bar"}, "loose"]"#);
    let entries = with_model(&model)
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap();
    assert_eq!(entries, [ExtractionResult::new("keep")]);
}

#[tokio::test]
async fn returns_empty_for_an_empty_message_batch_without_calling_the_model() {
    let model = MockModel::new();
    let entries = with_model(&model)
        .extract(&[], ExtractorContext::default())
        .await
        .unwrap();
    assert!(entries.is_empty());
    assert!(model.requests().is_empty());
}

#[tokio::test]
async fn appends_the_output_format_to_the_default_system_prompt() {
    let model = replying("[]");
    with_model(&model)
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap();
    let prompt = system_prompt(&model);
    assert!(prompt.starts_with("You extract durable facts"));
    assert!(prompt.contains(r#"Return ONLY a JSON array of objects, each: {"content": string}."#));
}

#[tokio::test]
async fn keeps_the_output_format_when_a_custom_system_prompt_replaces_the_default() {
    let model = replying(r#"[{"content": "Prefers aisle seats"}]"#);
    let extractor = ModelExtractor::new(ModelExtractorOptions {
        model: Some(Arc::new(model.clone())),
        system_prompt: Some("Extract user preferences.".into()),
    });
    let entries = extractor
        .extract(&user_turn("I like aisle seats"), ExtractorContext::default())
        .await
        .unwrap();
    let prompt = system_prompt(&model);
    assert!(prompt.starts_with("Extract user preferences.\n\n"));
    assert!(!prompt.contains("You extract durable facts"));
    assert!(prompt.contains(r#"Return ONLY a JSON array of objects, each: {"content": string}."#));
    assert_eq!(entries, [ExtractionResult::new("Prefers aisle seats")]);
}

#[tokio::test]
async fn falls_back_to_the_default_model_from_context_when_none_configured() {
    let model = replying(r#"[{"content": "fact"}]"#);
    let context = ExtractorContext::default().with_default_model(Arc::new(model));
    let entries = ModelExtractor::default()
        .extract(&user_turn("x"), context)
        .await
        .unwrap();
    assert_eq!(entries, [ExtractionResult::new("fact")]);
}

#[tokio::test]
async fn throws_when_no_model_is_configured_and_no_default_is_provided() {
    let error = ModelExtractor::default()
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no model configured"));
}

#[tokio::test]
async fn extracts_without_a_tracer_in_context_standalone_use() {
    let model = replying(r#"[{"content": "fact"}]"#);
    let entries = with_model(&model)
        .extract(&user_turn("x"), ExtractorContext::default())
        .await
        .unwrap();
    assert_eq!(entries, [ExtractionResult::new("fact")]);
}

fn traced() -> ExtractorContext {
    ExtractorContext::default().with_tracer(Arc::new(Tracer::default()))
}

#[tokio::test]
async fn ends_the_model_invoke_span_with_an_error_when_the_model_throws() {
    #[cfg(feature = "otel")]
    let capture = crate::telemetry::test_support::capture_spans();
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("model down")));
    let error = with_model(&model).extract(&user_turn("x"), traced()).await.unwrap_err();
    assert_eq!(error.to_string(), "model down");
    #[cfg(feature = "otel")]
    assert!(crate::telemetry::test_support::is_error(
        &capture.span("chat"),
        "model down"
    ));
}

#[cfg(feature = "otel")]
#[tokio::test]
async fn wraps_the_model_call_in_a_model_invoke_span_when_a_tracer_is_supplied() {
    use crate::telemetry::test_support::{capture_spans, events};

    let capture = capture_spans();
    let model = replying(r#"[{"content": "fact"}]"#);
    let entries = with_model(&model).extract(&user_turn("x"), traced()).await.unwrap();
    assert_eq!(contents(&entries), ["fact"]);
    let span = capture.span("chat");
    assert_eq!(span.status, opentelemetry::trace::Status::Ok);
    let output_events =
        events(&span, "gen_ai.choice").len() + events(&span, "gen_ai.client.inference.operation.details").len();
    assert!(output_events > 0);
}

#[tokio::test]
async fn adds_the_extraction_usage_to_the_request_total_even_when_the_request_limit_is_used_up() {
    let usage = Usage {
        input_tokens: 4,
        output_tokens: 5,
        total_tokens: 9,
        ..Default::default()
    };
    let model = MockModel::new().with_turn(MockTurn::text(r#"[{"content": "fact"}]"#).with_usage(usage));
    let request = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..Default::default()
    }));
    for _ in 0..5 {
        request.record_turn();
    }
    let context = ExtractorContext::default().with_invocation_context(InvocationContext::auxiliary(Some(&request)));
    let entries = with_model(&model).extract(&user_turn("x"), context).await.unwrap();
    assert_eq!(entries, [ExtractionResult::new("fact")]);
    let total = request.usage();
    assert_eq!(total.turns_taken, 5);
    assert_eq!(
        (
            total.usage.input_tokens,
            total.usage.output_tokens,
            total.usage.total_tokens
        ),
        (4, 5, 9)
    );
}
