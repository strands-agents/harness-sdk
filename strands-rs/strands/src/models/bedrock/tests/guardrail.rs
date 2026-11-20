//! Guardrail configuration tests (request formatting, blocked detection, redaction events,
//! non-streaming mode, guarding the latest user message) and thinking with forced tool choice.

use serde_json::json;

use super::*;
use crate::models::bedrock::{
    BedrockGuardrailConfig, BedrockGuardrailRedactionConfig, BedrockGuardrailStreamProcessingMode,
    BedrockGuardrailTrace,
};
use crate::types::{
    CachePointBlock, GuardContentText, GuardQualifier, ImageBlock, ImageFormat, ImageSource, ReasoningBlock,
    S3Location, ToolResultBlock, ToolResultContent, ToolUseBlock,
};

fn guardrail() -> BedrockGuardrailConfig {
    BedrockGuardrailConfig {
        guardrail_identifier: "my-guardrail-id".into(),
        guardrail_version: "1".into(),
        ..BedrockGuardrailConfig::default()
    }
}

fn guarded(config: BedrockGuardrailConfig) -> BedrockModelConfig {
    BedrockModelConfig {
        guardrail_config: Some(config),
        ..BedrockModelConfig::default()
    }
}

fn redacting(redaction: BedrockGuardrailRedactionConfig) -> BedrockModelConfig {
    guarded(BedrockGuardrailConfig {
        redaction: Some(redaction),
        ..guardrail()
    })
}

async fn sent_guardrail(config: BedrockGuardrailConfig) -> JsonValue {
    let (model, transport) = provider(guarded(config));
    run(&model, request(hello(), Options::default())).await;
    transport.last()["guardrailConfig"].clone()
}

#[test]
fn accepts_guardrail_config_in_options() {
    let (model, _) = provider(guarded(guardrail()));
    assert_eq!(model.config().guardrail_config, Some(guardrail()));
}

#[test]
fn accepts_guardrail_config_with_all_options() {
    let config = BedrockGuardrailConfig {
        trace: Some(BedrockGuardrailTrace::EnabledFull),
        stream_processing_mode: Some(BedrockGuardrailStreamProcessingMode::Sync),
        redaction: Some(BedrockGuardrailRedactionConfig {
            input: Some(true),
            input_message: Some("[Custom input redacted.]".into()),
            output: Some(true),
            output_message: Some("[Custom output redacted.]".into()),
        }),
        ..guardrail()
    };
    let (model, _) = provider(guarded(config.clone()));
    assert_eq!(model.config().guardrail_config, Some(config));
}

#[tokio::test]
async fn includes_guardrail_config_in_request_with_default_trace() {
    assert_eq!(
        sent_guardrail(guardrail()).await,
        json!({"guardrailIdentifier": "my-guardrail-id", "guardrailVersion": "1", "trace": "enabled"})
    );
}

#[tokio::test]
async fn includes_guardrail_config_in_request_with_custom_trace() {
    let config = BedrockGuardrailConfig {
        trace: Some(BedrockGuardrailTrace::Disabled),
        ..guardrail()
    };
    assert_eq!(
        sent_guardrail(config).await,
        json!({"guardrailIdentifier": "my-guardrail-id", "guardrailVersion": "1", "trace": "disabled"})
    );
}

#[tokio::test]
async fn includes_stream_processing_mode_when_specified() {
    let config = BedrockGuardrailConfig {
        stream_processing_mode: Some(BedrockGuardrailStreamProcessingMode::Sync),
        ..guardrail()
    };
    assert_eq!(
        sent_guardrail(config).await,
        json!({"guardrailIdentifier": "my-guardrail-id", "guardrailVersion": "1", "trace": "enabled", "streamProcessingMode": "sync"})
    );
}

#[tokio::test]
async fn does_not_include_guardrail_config_when_not_configured() {
    let (model, transport) = provider(BedrockModelConfig::default());
    run(&model, request(hello(), Options::default())).await;
    assert!(transport.last().get("guardrailConfig").is_none());
}

fn blocked_chunks(stop_reason: &str, trace: Option<JsonValue>) -> Vec<JsonValue> {
    let mut metadata = json!({"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}});
    if let Some(trace) = trace {
        metadata["trace"] = trace;
    }
    vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {}}),
        json!({"contentBlockDelta": {"delta": {"text": "Hello"}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": stop_reason}}),
        json!({"metadata": metadata}),
    ]
}

fn topic_trace(action: &str, detected: bool) -> JsonValue {
    json!({"guardrail": {"inputAssessment": {"1234": {"topicPolicy": {"topics": [{"name": "Harmful", "action": action, "detected": detected}]}}}}})
}

async fn redactions(config: BedrockModelConfig, chunks: Vec<JsonValue>) -> Vec<JsonValue> {
    let (model, transport) = provider(config);
    transport.push_chunks(chunks);
    events_json(&model, request(hello(), Options::default()))
        .await
        .into_iter()
        .filter(|event| event["type"] == "modelRedactionEvent")
        .collect()
}

fn input_redaction(message: &str) -> JsonValue {
    json!({"type": "modelRedactionEvent", "inputRedaction": {"replaceContent": message}})
}

fn output_redaction(message: &str) -> JsonValue {
    json!({"type": "modelRedactionEvent", "outputRedaction": {"replaceContent": message}})
}

#[tokio::test]
async fn detects_blocked_guardrail_in_input_assessment() {
    let events = redactions(
        guarded(guardrail()),
        blocked_chunks("guardrail_intervened", Some(topic_trace("BLOCKED", true))),
    )
    .await;
    assert_eq!(events, [input_redaction("[User input redacted.]")]);
}

#[tokio::test]
async fn detects_blocked_guardrail_in_output_assessments() {
    let trace = json!({"guardrail": {"outputAssessments": {"1234": {"contentPolicy": {"filters": [{"type": "VIOLENCE", "action": "BLOCKED", "detected": true}]}}}}});
    let events = redactions(
        guarded(guardrail()),
        blocked_chunks("guardrail_intervened", Some(trace)),
    )
    .await;
    assert!(!events.is_empty());
}

#[tokio::test]
async fn does_not_emit_redaction_events_when_guardrail_not_blocked() {
    let events = redactions(
        guarded(guardrail()),
        blocked_chunks("end_turn", Some(topic_trace("NONE", false))),
    )
    .await;
    assert!(events.is_empty());
}

#[tokio::test]
async fn does_not_emit_redaction_events_without_guardrail_config() {
    let events = redactions(
        BedrockModelConfig::default(),
        blocked_chunks("guardrail_intervened", Some(topic_trace("BLOCKED", true))),
    )
    .await;
    assert!(events.is_empty());
}

#[tokio::test]
async fn emits_redaction_events_when_guardrail_intervened_is_reported_without_a_trace() {
    let events = redactions(guarded(guardrail()), blocked_chunks("guardrail_intervened", None)).await;
    assert_eq!(events, [input_redaction("[User input redacted.]")]);
}

#[tokio::test]
async fn emits_redaction_events_when_guardrail_intervened_but_no_metadata_event_arrives() {
    let mut chunks = blocked_chunks("guardrail_intervened", None);
    chunks.pop();
    let events = redactions(guarded(guardrail()), chunks).await;
    assert_eq!(events, [input_redaction("[User input redacted.]")]);
}

#[tokio::test]
async fn emits_redaction_events_exactly_once_across_multiple_metadata_events() {
    let mut chunks = blocked_chunks("guardrail_intervened", None);
    chunks.push(chunks[5].clone());
    let events = redactions(guarded(guardrail()), chunks).await;
    assert_eq!(events, [input_redaction("[User input redacted.]")]);
}

fn anonymized_trace() -> JsonValue {
    json!({"guardrail": {"outputAssessments": {"8oi5sp73w4ca": [{"sensitiveInformationPolicy": {"regexes": [
        {"action": "ANONYMIZED", "detected": true, "match": "Hello", "name": "BLOCKING_HELLO", "regex": "Hello"}
    ]}}]}}})
}

#[tokio::test]
async fn does_not_emit_redaction_events_when_the_trace_only_reports_anonymized_masking() {
    let events = redactions(
        guarded(guardrail()),
        blocked_chunks("guardrail_intervened", Some(anonymized_trace())),
    )
    .await;
    assert!(events.is_empty());
}

#[tokio::test]
async fn does_not_emit_redaction_events_for_masking_in_non_streaming_path() {
    let config = BedrockModelConfig {
        stream: Some(false),
        ..guarded(guardrail())
    };
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "{BLOCKING_HELLO}! 👋"}]}},
        "stopReason": "guardrail_intervened",
        "usage": {"inputTokens": 13, "outputTokens": 17, "totalTokens": 30},
        "trace": anonymized_trace()
    });
    assert!(redactions(config, vec![output]).await.is_empty());
}

fn minimal_blocked() -> Vec<JsonValue> {
    vec![
        json!({"messageStop": {"stopReason": "guardrail_intervened"}}),
        json!({"metadata": {
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            "trace": {"guardrail": {"inputAssessment": {"1": {"topicPolicy": {"topics": [{"action": "BLOCKED", "detected": true}]}}}}}
        }}),
    ]
}

#[tokio::test]
async fn emits_input_redaction_with_default_message() {
    let events = redactions(guarded(guardrail()), minimal_blocked()).await;
    assert!(events.contains(&input_redaction("[User input redacted.]")));
}

#[tokio::test]
async fn emits_input_redaction_with_custom_message() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        input_message: Some("[Custom input message]".into()),
        ..BedrockGuardrailRedactionConfig::default()
    });
    assert!(
        redactions(config, minimal_blocked())
            .await
            .contains(&input_redaction("[Custom input message]"))
    );
}

#[tokio::test]
async fn does_not_emit_input_redaction_when_redact_input_is_false() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        input: Some(false),
        ..BedrockGuardrailRedactionConfig::default()
    });
    let events = redactions(config, minimal_blocked()).await;
    assert!(events.iter().all(|event| event.get("inputRedaction").is_none()));
}

#[tokio::test]
async fn emits_output_redaction_when_redact_output_is_true() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        output: Some(true),
        ..BedrockGuardrailRedactionConfig::default()
    });
    assert!(
        redactions(config, minimal_blocked())
            .await
            .contains(&output_redaction("[Assistant output redacted.]"))
    );
}

#[tokio::test]
async fn emits_output_redaction_with_custom_message() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        output: Some(true),
        output_message: Some("[Custom output message]".into()),
        ..BedrockGuardrailRedactionConfig::default()
    });
    assert!(
        redactions(config, minimal_blocked())
            .await
            .contains(&output_redaction("[Custom output message]"))
    );
}

#[tokio::test]
async fn emits_both_input_and_output_redaction_when_both_are_enabled() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        input: Some(true),
        output: Some(true),
        ..BedrockGuardrailRedactionConfig::default()
    });
    let events = redactions(config, minimal_blocked()).await;
    assert_eq!(
        events,
        [
            input_redaction("[User input redacted.]"),
            output_redaction("[Assistant output redacted.]")
        ]
    );
}

#[tokio::test]
async fn includes_redacted_content_from_model_output_when_available() {
    let config = redacting(BedrockGuardrailRedactionConfig {
        output: Some(true),
        output_message: Some("[Blocked]".into()),
        ..BedrockGuardrailRedactionConfig::default()
    });
    let chunks = vec![
        json!({"contentBlockDelta": {"delta": {"text": "This content was blocked"}}}),
        json!({"messageStop": {"stopReason": "guardrail_intervened"}}),
        json!({"metadata": {
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            "trace": {"guardrail": {
                "modelOutput": ["This content ", "was blocked"],
                "outputAssessments": {"0": [{"topicPolicy": {"topics": [{"action": "BLOCKED", "detected": true}]}}]}
            }}
        }}),
    ];
    assert!(redactions(config, chunks).await.contains(&json!({
        "type": "modelRedactionEvent",
        "outputRedaction": {"redactedContent": "This content was blocked", "replaceContent": "[Blocked]"}
    })));
}

#[tokio::test]
async fn emits_redaction_events_in_non_streaming_mode_when_guardrail_blocks() {
    let config = BedrockModelConfig {
        stream: Some(false),
        ..guarded(guardrail())
    };
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}},
        "stopReason": "guardrail_intervened",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "trace": {"guardrail": {"inputAssessment": {"1": {"topicPolicy": {"topics": [{"action": "BLOCKED", "detected": true}]}}}}}
    });
    let (model, transport) = provider(config);
    transport.push_chunks(vec![output]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    let redaction_index = events
        .iter()
        .position(|event| event["type"] == "modelRedactionEvent")
        .unwrap();
    let metadata_index = events
        .iter()
        .position(|event| event["type"] == "modelMetadataEvent")
        .unwrap();
    assert_eq!(events[redaction_index], input_redaction("[User input redacted.]"));
    assert!(redaction_index < metadata_index);
}

#[tokio::test]
async fn emits_redaction_events_when_guardrail_intervened_is_reported_without_a_trace_in_non_streaming_mode() {
    let config = BedrockModelConfig {
        stream: Some(false),
        ..guarded(guardrail())
    };
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}},
        "stopReason": "guardrail_intervened",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
    });
    assert_eq!(
        redactions(config, vec![output]).await,
        [input_redaction("[User input redacted.]")]
    );
}

fn latest(enabled: Option<bool>) -> BedrockModelConfig {
    guarded(BedrockGuardrailConfig {
        guard_latest_user_message: enabled,
        ..guardrail()
    })
}

async fn guarded_messages(enabled: Option<bool>, messages: Vec<Message>) -> JsonValue {
    let (model, transport) = provider(latest(enabled));
    run(&model, request(messages, Options::default())).await;
    transport.last()["messages"].clone()
}

fn guard_text_json(text: &str) -> JsonValue {
    json!({"guardContent": {"text": {"text": text}}})
}

fn image(format: ImageFormat, source: ImageSource) -> ContentBlock {
    ContentBlock::Image(ImageBlock::new(format, source))
}

#[test]
fn accepts_guard_latest_user_message_in_guardrail_config() {
    let (model, _) = provider(latest(Some(true)));
    assert_eq!(
        model
            .config()
            .guardrail_config
            .and_then(|config| config.guard_latest_user_message),
        Some(true)
    );
}

#[tokio::test]
async fn wraps_latest_user_message_text_content_in_guard_content_when_enabled() {
    assert_eq!(
        guarded_messages(Some(true), vec![Message::user("Hello world")]).await,
        json!([{"role": "user", "content": [guard_text_json("Hello world")]}])
    );
}

#[tokio::test]
async fn wraps_latest_user_message_image_content_in_guard_content_when_enabled() {
    let messages = vec![user(vec![image(
        ImageFormat::Jpeg,
        ImageSource::Bytes(vec![1, 2, 3, 4]),
    )])];
    assert_eq!(
        guarded_messages(Some(true), messages).await,
        json!([{"role": "user", "content": [{"guardContent": {"image": {"format": "jpeg", "source": {"bytes": "AQIDBA=="}}}}]}])
    );
}

#[tokio::test]
async fn does_not_wrap_tool_result_messages_even_though_role_is_user() {
    let messages = vec![
        Message::user("What is 2+2?"),
        assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
            "calculator",
            "tool-123",
            json!({"expression": "2+2"}),
        ))]),
        user(vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-123",
            vec![ToolResultContent::text("4")],
        ))]),
    ];
    let formatted = guarded_messages(Some(true), messages).await;
    assert_eq!(
        formatted[0],
        json!({"role": "user", "content": [guard_text_json("What is 2+2?")]})
    );
    assert_eq!(
        formatted[1],
        json!({"role": "assistant", "content": [{"toolUse": {"toolUseId": "tool-123", "name": "calculator", "input": {"expression": "2+2"}}}]})
    );
    assert_eq!(formatted[2]["content"][0]["toolResult"]["toolUseId"], "tool-123");
}

#[tokio::test]
async fn does_not_wrap_messages_when_guard_latest_user_message_is_false() {
    assert_eq!(
        guarded_messages(Some(false), vec![Message::user("Hello world")]).await,
        json!([{"role": "user", "content": [{"text": "Hello world"}]}])
    );
}

#[tokio::test]
async fn does_not_wrap_messages_when_guard_latest_user_message_is_undefined() {
    assert_eq!(
        guarded_messages(None, vec![Message::user("Hello world")]).await,
        json!([{"role": "user", "content": [{"text": "Hello world"}]}])
    );
}

#[tokio::test]
async fn does_not_wrap_assistant_messages() {
    let messages = vec![Message::user("Hello"), Message::assistant("Hi there!")];
    assert_eq!(
        guarded_messages(Some(true), messages).await,
        json!([
            {"role": "user", "content": [guard_text_json("Hello")]},
            {"role": "assistant", "content": [{"text": "Hi there!"}]}
        ])
    );
}

#[tokio::test]
async fn wraps_only_the_last_user_text_image_message_in_multi_turn_conversation() {
    let messages = vec![
        Message::user("First message"),
        Message::assistant("First response"),
        Message::user("Second message"),
    ];
    assert_eq!(
        guarded_messages(Some(true), messages).await,
        json!([
            {"role": "user", "content": [{"text": "First message"}]},
            {"role": "assistant", "content": [{"text": "First response"}]},
            {"role": "user", "content": [guard_text_json("Second message")]}
        ])
    );
}

#[tokio::test]
async fn handles_no_user_messages_with_text_image_content_gracefully() {
    assert_eq!(
        guarded_messages(Some(true), vec![Message::assistant("Hello!")]).await,
        json!([{"role": "assistant", "content": [{"text": "Hello!"}]}])
    );
}

#[tokio::test]
async fn preserves_explicit_guard_content_block_in_messages_without_double_wrapping() {
    let messages = vec![user(vec![ContentBlock::GuardContent(
        GuardContentText::new(vec![GuardQualifier::GroundingSource], "Already guarded content").into(),
    )])];
    assert_eq!(
        guarded_messages(Some(true), messages).await,
        json!([{"role": "user", "content": [
            {"guardContent": {"text": {"text": "Already guarded content", "qualifiers": ["grounding_source"]}}}
        ]}])
    );
}

#[tokio::test]
async fn wraps_all_text_and_image_blocks_in_the_latest_user_message() {
    let messages = vec![user(vec![
        ContentBlock::text("Check this text"),
        image(ImageFormat::Png, ImageSource::Bytes(vec![5, 6, 7, 8])),
        ContentBlock::text("And this text too"),
    ])];
    assert_eq!(
        guarded_messages(Some(true), messages).await,
        json!([{"role": "user", "content": [
            guard_text_json("Check this text"),
            {"guardContent": {"image": {"format": "png", "source": {"bytes": "BQYHCA=="}}}},
            guard_text_json("And this text too")
        ]}])
    );
}

async fn unwrapped_image(format: ImageFormat, source: ImageSource, warning: &str) -> JsonValue {
    let (logs, guard) = crate::test_support::record_logs();
    let formatted = guarded_messages(Some(true), vec![user(vec![image(format, source)])]).await;
    drop(guard);
    assert!(logs.text().contains(warning), "{}", logs.text());
    formatted[0]["content"][0].clone()
}

#[tokio::test]
async fn skips_wrapping_images_with_unsupported_formats_gif() {
    let block = unwrapped_image(
        ImageFormat::Gif,
        ImageSource::Bytes(vec![1, 2, 3, 4]),
        "image_format=<gif> | format not supported by bedrock guardrails | skipping guardContent wrap",
    )
    .await;
    assert_eq!(
        block,
        json!({"image": {"format": "gif", "source": {"bytes": "AQIDBA=="}}})
    );
}

#[tokio::test]
async fn skips_wrapping_images_with_unsupported_formats_webp() {
    let block = unwrapped_image(
        ImageFormat::Webp,
        ImageSource::Bytes(vec![1, 2, 3, 4]),
        "image_format=<webp> | format not supported by bedrock guardrails | skipping guardContent wrap",
    )
    .await;
    assert_eq!(
        block,
        json!({"image": {"format": "webp", "source": {"bytes": "AQIDBA=="}}})
    );
}

#[tokio::test]
async fn skips_wrapping_images_with_s3_source() {
    let block = unwrapped_image(
        ImageFormat::Png,
        ImageSource::Location(S3Location::new("s3://bucket/image.png")),
        "source_type=<non-bytes> | image source must be bytes for bedrock guardrails | skipping guardContent wrap",
    )
    .await;
    assert_eq!(
        block,
        json!({"image": {"format": "png", "source": {"s3Location": {"uri": "s3://bucket/image.png"}}}})
    );
}

#[tokio::test]
async fn skips_wrapping_images_with_url_source() {
    let block = unwrapped_image(
        ImageFormat::Jpeg,
        ImageSource::Url("https://example.com/image.jpg".into()),
        "source_type=<imageSourceUrl> | not supported by bedrock | skipping",
    )
    .await;
    assert_eq!(block, json!({"image": {"format": "jpeg"}}));
}

#[tokio::test]
async fn wraps_supported_image_formats_png_and_jpeg_with_bytes_source() {
    let messages = vec![user(vec![
        image(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3, 4])),
        image(ImageFormat::Jpeg, ImageSource::Bytes(vec![1, 2, 3, 4])),
    ])];
    assert_eq!(
        guarded_messages(Some(true), messages).await[0]["content"],
        json!([
            {"guardContent": {"image": {"format": "png", "source": {"bytes": "AQIDBA=="}}}},
            {"guardContent": {"image": {"format": "jpeg", "source": {"bytes": "AQIDBA=="}}}}
        ])
    );
}

#[tokio::test]
async fn does_not_wrap_reasoning_or_cache_point_blocks() {
    let messages = vec![user(vec![
        ContentBlock::text("User message"),
        ContentBlock::Reasoning(ReasoningBlock::new().with_text("thinking...").with_signature("sig")),
        ContentBlock::CachePoint(CachePointBlock::new()),
    ])];
    assert_eq!(
        guarded_messages(Some(true), messages).await[0]["content"],
        json!([
            guard_text_json("User message"),
            {"reasoningContent": {"reasoningText": {"text": "thinking...", "signature": "sig"}}},
            {"cachePoint": {"type": "default"}}
        ])
    );
}

fn thinking_provider(fields: JsonValue) -> (BedrockModel, Arc<MockTransport>) {
    provider(BedrockModelConfig {
        additional_request_fields: Some(fields),
        ..with_model_id("anthropic.claude-sonnet-4-6")
    })
}

fn thinking_fields() -> JsonValue {
    json!({"thinking": {"type": "enabled", "budget_tokens": 5000}, "some_other_field": "value"})
}

async fn sent_fields(fields: JsonValue, tool_choice: Option<ToolChoice>) -> JsonValue {
    let (model, transport) = thinking_provider(fields);
    let options = Options {
        tool_specs: vec![ToolSpec::new("test_tool", "test")],
        tool_choice,
        ..Options::default()
    };
    run(&model, request(hello(), options)).await;
    transport
        .last()
        .get("additionalModelRequestFields")
        .cloned()
        .unwrap_or(JsonValue::Null)
}

#[tokio::test]
async fn strips_thinking_from_additional_request_fields_when_tool_choice_is_name() {
    for tool_choice in [ToolChoice::Any, ToolChoice::tool("test_tool")] {
        assert_eq!(
            sent_fields(thinking_fields(), Some(tool_choice)).await,
            json!({"some_other_field": "value"})
        );
    }
}

#[tokio::test]
async fn preserves_thinking_when_tool_choice_is_auto() {
    assert_eq!(
        sent_fields(thinking_fields(), Some(ToolChoice::Auto)).await,
        thinking_fields()
    );
}

#[tokio::test]
async fn preserves_thinking_when_no_tool_choice_is_provided() {
    assert_eq!(sent_fields(thinking_fields(), None).await, thinking_fields());
}

#[tokio::test]
async fn omits_additional_model_request_fields_when_thinking_is_the_only_field_and_tool_choice_forces_tool_use() {
    let fields = json!({"thinking": {"type": "enabled", "budget_tokens": 5000}});
    assert_eq!(sent_fields(fields, Some(ToolChoice::Any)).await, JsonValue::Null);
}
