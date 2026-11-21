//! Stream tests in streaming and non-streaming mode (structured output enforcement, stale thinking
//! recovery, cancellation, deltas, stop reasons, throttling) and error handling tests.

use serde_json::json;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::models::native_output::{clear_structured_output_support, to_native_output_schema};
use crate::models::{AggregatedEvent, ModelCapabilities, ModelInfo};

fn mode(stream: bool) -> BedrockModelConfig {
    BedrockModelConfig {
        stream: Some(stream),
        ..BedrockModelConfig::default()
    }
}

/// Scripts one reply in the shape the mode reads: stream chunks, or the Converse output.
fn script(transport: &MockTransport, stream: bool, chunks: Vec<JsonValue>, output: JsonValue) {
    if stream {
        transport.push_chunks(chunks);
    } else {
        transport.push_chunks(vec![output]);
    }
}

#[tokio::test]
async fn yields_and_validates_text_events_correctly() {
    for stream in [true, false] {
        let (model, transport) = provider(mode(stream));
        let mut chunks = hello_chunks();
        chunks[5] = json!({"metadata": {
            "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
            "metrics": {"latencyMs": 100}
        }});
        script(&transport, stream, chunks, hello_output());
        let events = events_json(&model, request(hello(), Options::default())).await;
        for expected in [
            json!({"role": "assistant", "type": "modelMessageStartEvent"}),
            json!({"type": "modelContentBlockStartEvent"}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
            json!({"type": "modelContentBlockStopEvent"}),
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            json!({
                "type": "modelMetadataEvent",
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                "metrics": {"latencyMs": 100}
            }),
        ] {
            assert!(
                events.contains(&expected),
                "stream={stream} missing {expected} in {events:?}"
            );
        }
    }
}

#[tokio::test]
async fn yields_and_validates_tool_use_events_correctly() {
    for stream in [true, false] {
        let (model, transport) = provider(mode(stream));
        script(
            &transport,
            stream,
            vec![
                json!({"messageStart": {"role": "assistant"}}),
                json!({"contentBlockStart": {"start": {"toolUse": {"toolUseId": "tool-use-123", "name": "get_weather"}}}}),
                json!({"contentBlockDelta": {"delta": {"toolUse": {"input": "{\"location\":\"San Francisco\"}"}}}}),
                json!({"contentBlockStop": {}}),
                json!({"messageStop": {"stopReason": "tool_use"}}),
                json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 25, "totalTokens": 35}, "metrics": {"latencyMs": 120}}}),
            ],
            json!({
                "output": {"message": {"role": "assistant", "content": [
                    {"toolUse": {"toolUseId": "tool-use-123", "name": "get_weather", "input": {"location": "San Francisco"}}}
                ]}},
                "stopReason": "tool_use",
                "usage": {"inputTokens": 10, "outputTokens": 25, "totalTokens": 35},
                "metrics": {"latencyMs": 120}
            }),
        );
        let events = events_json(&model, request(vec![Message::user("Weather?")], Options::default())).await;
        let start = events
            .iter()
            .find(|event| event["type"] == "modelContentBlockStartEvent")
            .unwrap();
        assert_eq!(
            start,
            &json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "get_weather", "toolUseId": "tool-use-123"}})
        );
        assert!(events.contains(&json!({
            "type": "modelContentBlockDeltaEvent",
            "delta": {"type": "toolUseInputDelta", "input": "{\"location\":\"San Francisco\"}"}
        })));
        assert!(events.contains(&json!({"stopReason": "toolUse", "type": "modelMessageStopEvent"})));
        assert!(events.contains(&json!({
            "type": "modelMetadataEvent",
            "usage": {"inputTokens": 10, "outputTokens": 25, "totalTokens": 35},
            "metrics": {"latencyMs": 120}
        })));
    }
}

#[tokio::test]
async fn yields_and_validates_reasoning_text_events_correctly() {
    for stream in [true, false] {
        let (model, transport) = provider(mode(stream));
        script(
            &transport,
            stream,
            vec![
                json!({"messageStart": {"role": "assistant"}}),
                json!({"contentBlockStart": {}}),
                json!({"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking..."}}}}),
                json!({"contentBlockStop": {}}),
                json!({"messageStop": {"stopReason": "end_turn"}}),
                json!({"metadata": {"usage": {"inputTokens": 15, "outputTokens": 30, "totalTokens": 45}, "metrics": {"latencyMs": 150}}}),
            ],
            json!({
                "output": {"message": {"role": "assistant", "content": [{"reasoningContent": {"reasoningText": {"text": "Thinking..."}}}]}},
                "stopReason": "end_turn",
                "usage": {"inputTokens": 15, "outputTokens": 30, "totalTokens": 45},
                "metrics": {"latencyMs": 150}
            }),
        );
        let events = events_json(&model, request(vec![Message::user("A question.")], Options::default())).await;
        assert!(events.contains(&json!({
            "type": "modelContentBlockDeltaEvent",
            "delta": {"type": "reasoningContentDelta", "text": "Thinking..."}
        })));
        assert!(events.contains(&json!({"stopReason": "endTurn", "type": "modelMessageStopEvent"})));
    }
}

#[tokio::test]
async fn yields_and_validates_redacted_content_events_correctly() {
    for stream in [true, false] {
        let (model, transport) = provider(mode(stream));
        script(
            &transport,
            stream,
            vec![
                json!({"messageStart": {"role": "assistant"}}),
                json!({"contentBlockStart": {}}),
                json!({"contentBlockDelta": {"delta": {"reasoningContent": {"redactedContent": "AQID"}}}}),
                json!({"contentBlockStop": {}}),
                json!({"messageStop": {"stopReason": "end_turn"}}),
                json!({"metadata": {"usage": {"inputTokens": 15, "outputTokens": 5, "totalTokens": 20}, "metrics": {"latencyMs": 110}}}),
            ],
            json!({
                "output": {"message": {"role": "assistant", "content": [{"reasoningContent": {"redactedContent": "AQID"}}]}},
                "stopReason": "end_turn",
                "usage": {"inputTokens": 15, "outputTokens": 5, "totalTokens": 20},
                "metrics": {"latencyMs": 110}
            }),
        );
        let events = events_json(
            &model,
            request(vec![Message::user("A sensitive question.")], Options::default()),
        )
        .await;
        assert!(
            events.contains(&json!({
                "type": "modelContentBlockDeltaEvent",
                "delta": {"type": "reasoningContentDelta", "redactedContent": "AQID"}
            })),
            "{events:?}"
        );
    }
}

#[tokio::test]
async fn yields_and_validates_citation_events_correctly() {
    let citation = json!({
        "location": {"documentChar": {"documentIndex": 0, "start": 10, "end": 50}},
        "sourceContent": [{"text": "source text"}],
        "source": "doc-0",
        "title": "Test Doc"
    });
    for stream in [true, false] {
        let (model, transport) = provider(mode(stream));
        script(
            &transport,
            stream,
            vec![
                json!({"messageStart": {"role": "assistant"}}),
                json!({"contentBlockStart": {}}),
                json!({"contentBlockDelta": {"delta": {"citation": citation}}}),
                json!({"contentBlockStop": {}}),
                json!({"messageStop": {"stopReason": "end_turn"}}),
            ],
            json!({
                "output": {"message": {"role": "assistant", "content": [
                    {"citationsContent": {"citations": [citation], "content": [{"text": "generated text"}]}}
                ]}},
                "stopReason": "end_turn",
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                "metrics": {"latencyMs": 100}
            }),
        );
        let events = events_json(&model, request(vec![Message::user("Cite this.")], Options::default())).await;
        let content = if stream {
            json!([])
        } else {
            json!([{"text": "generated text"}])
        };
        assert!(
            events.contains(&json!({
                "type": "modelContentBlockDeltaEvent",
                "delta": {
                    "type": "citationsDelta",
                    "citations": [{
                        "location": {"type": "documentChar", "documentIndex": 0, "start": 10, "end": 50},
                        "source": "doc-0",
                        "sourceContent": [{"text": "source text"}],
                        "title": "Test Doc"
                    }],
                    "content": content
                }
            })),
            "stream={stream} {events:?}"
        );
    }
}

#[tokio::test]
async fn throws_error_mapping_cases() {
    let cases: [(&str, BedrockError, &str); 4] = [
        (
            "ContextWindowOverflowError for context overflow",
            plain_error("Input is too long for requested model"),
            "ContextWindowOverflowError",
        ),
        (
            "ContextWindowOverflowError for Nova input tokens exceeded (#5739)",
            validation(
                "The model returned the following errors: Input Tokens Exceeded: Number of input tokens exceeds maximum length. Please update the input to try again.",
            ),
            "ContextWindowOverflowError",
        ),
        (
            "ContextWindowOverflowError for OpenAI-style maximum context length (#5739)",
            validation("The model returned the following errors: This model's maximum context length is 32768 tokens."),
            "ContextWindowOverflowError",
        ),
        (
            "ValidationException for invalid input",
            validation("ValidationException"),
            "ModelError",
        ),
    ];
    for stream in [true, false] {
        for (name, error, expected) in &cases {
            let (model, transport) = provider(mode(stream));
            transport.reject(BedrockError::service(error.name.clone(), error.message.clone()));
            let error = run_error(&model, request(hello(), Options::default())).await;
            assert_eq!(error.name(), *expected, "{name}: {error}");
        }
    }
}

#[tokio::test]
async fn keeps_the_bedrock_exception_as_the_source() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.reject(validation("The provided model identifier is invalid."));
    let error = run_error(&model, request(hello(), Options::default())).await;
    assert_eq!(error.to_string(), "The provided model identifier is invalid.");
    let source = std::error::Error::source(&error).unwrap().to_string();
    assert_eq!(source, "ValidationException: The provided model identifier is invalid.");
}

#[tokio::test]
async fn maps_a_throttling_exception_from_send_and_a_network_failure() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.reject(service_error("ThrottlingException", "Too many tokens"));
    let error = run_error(&model, request(hello(), Options::default())).await;
    assert_eq!(
        (error.name(), error.to_string().as_str()),
        ("ModelThrottledError", "Too many tokens")
    );

    transport.reject(BedrockError::network("dispatch failure: connection refused"));
    let error = run_error(&model, request(hello(), Options::default())).await;
    assert_eq!(error.name(), "ModelNetworkError");
}

#[tokio::test]
async fn aggregates_an_empty_assistant_message() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStop": {"stopReason": "end_turn"}}),
        json!({"metadata": {"usage": {"inputTokens": 100, "outputTokens": 1, "totalTokens": 101}}}),
    ]);
    let mut stream = model.stream_aggregated(request(vec![Message::user("Hi")], Options::default()));
    let mut result = None;
    while let Some(item) = stream.next().await {
        if let AggregatedEvent::Done(done) = item.unwrap() {
            result = Some(done);
        }
    }
    let result = result.unwrap();
    assert_eq!(result.message.role, Role::Assistant);
    assert!(result.message.content.is_empty());
    assert_eq!(
        serde_json::to_value(result.message.metadata.unwrap().usage.unwrap()).unwrap(),
        json!({"inputTokens": 100, "outputTokens": 1, "totalTokens": 101})
    );
    assert_eq!(result.stop_reason, crate::types::StopReason::EndTurn);
}

const FORCED_REJECTION: &str =
    "This model doesn't support the toolConfig.toolChoice.tool field. Remove toolConfig.toolChoice.tool and try again.";
const NATIVE_REJECTION: &str = "This model doesn't support the outputConfig field. Remove outputConfig and try again.";
const BINDING_ERROR: &str =
    "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";

fn person_schema() -> JsonValue {
    json!({
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "number"}},
        "required": ["name", "age"],
        "additionalProperties": false
    })
}

fn structured_output_options(schema: JsonValue) -> Options {
    Options {
        tool_specs: vec![ToolSpec::new("strands_structured_output", "Output").with_input_schema(person_schema())],
        tool_choice: Some(ToolChoice::tool("strands_structured_output")),
        structured_output_schema: Some(schema),
        ..Options::default()
    }
}

fn person() -> Vec<Message> {
    vec![Message::user("Generate a person")]
}

/// The structured output mechanism a sent request uses.
fn mechanism_of(request: &JsonValue) -> &'static str {
    if request["toolConfig"]["toolChoice"].get("tool").is_some() {
        return "forced";
    }
    if request["outputConfig"].get("textFormat").is_some() {
        "native"
    } else {
        "auto"
    }
}

fn mechanisms(transport: &MockTransport, command: Command) -> Vec<&'static str> {
    transport.requests(command).iter().map(mechanism_of).collect()
}

/// A model id unique to the test, since learned rejections are process-wide.
fn unique_model(name: &str) -> BedrockModelConfig {
    with_model_id(&format!("test.structured-{name}"))
}

fn rejections(transport: &MockTransport, messages: &[&str]) {
    for message in messages {
        transport.reject(validation(message));
    }
    transport.set_default(Vec::new());
}

#[tokio::test]
async fn falls_back_to_the_next_mechanism_after_name_and_remembers_it() {
    let cases: [(&str, &[&str], &[&str]); 3] = [
        ("no-rejection", &[], &["forced"]),
        ("forced-rejection", &[FORCED_REJECTION], &["forced", "native"]),
        (
            "forced-and-native",
            &[FORCED_REJECTION, NATIVE_REJECTION],
            &["forced", "native", "auto"],
        ),
    ];
    for (name, rejected, expected) in cases {
        let (model, transport) = provider(unique_model(name));
        rejections(&transport, rejected);
        run(&model, request(person(), structured_output_options(person_schema()))).await;
        assert_eq!(mechanisms(&transport, Command::ConverseStream), expected, "{name}");

        let (model, transport) = provider(unique_model(name));
        transport.set_default(Vec::new());
        run(&model, request(person(), structured_output_options(person_schema()))).await;
        assert_eq!(
            mechanisms(&transport, Command::ConverseStream),
            [*expected.last().unwrap()],
            "{name}"
        );
    }
}

#[tokio::test]
async fn falls_back_on_a_non_streaming_request() {
    let (model, transport) = provider(BedrockModelConfig {
        stream: Some(false),
        ..unique_model("non-streaming")
    });
    transport.reject(validation(FORCED_REJECTION));
    transport.push_chunks(vec![json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "{\"name\": \"John\", \"age\": 30}"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
    })]);
    run(&model, request(person(), structured_output_options(person_schema()))).await;
    assert_eq!(mechanisms(&transport, Command::Converse), ["forced", "native"]);
}

#[tokio::test]
async fn skips_native_output_for_a_schema_it_cannot_represent() {
    let (model, transport) = provider(unique_model("record"));
    rejections(&transport, &[FORCED_REJECTION]);
    let record_schema = json!({
        "type": "object",
        "properties": {"scores": {"type": "object", "additionalProperties": {"type": "number"}}},
        "required": ["scores"]
    });
    run(&model, request(person(), structured_output_options(record_schema))).await;
    assert_eq!(mechanisms(&transport, Command::ConverseStream), ["forced", "auto"]);
}

#[tokio::test]
async fn starts_at_native_output_for_model_id_which_the_shared_model_info_says_cannot_be_forced() {
    for model_id in [
        "us.anthropic.claude-opus-5-5",
        // Accepts forcing; false on purpose so the retry keeps thinking (#6236).
        "global.anthropic.claude-haiku-5-5",
    ] {
        let (model, transport) = provider(with_model_id(model_id));
        transport.set_default(Vec::new());
        run(&model, request(person(), structured_output_options(person_schema()))).await;
        assert_eq!(transport.call_count(), 1, "{model_id}");
        assert_eq!(
            mechanisms(&transport, Command::ConverseStream),
            ["native"],
            "{model_id}"
        );
    }
}

#[tokio::test]
async fn skips_native_output_when_the_info_override_says_the_model_lacks_it() {
    let (model, transport) = provider(BedrockModelConfig {
        model_info: Some(ModelInfo {
            capabilities: ModelCapabilities {
                native_structured_output: Some(false),
                ..ModelCapabilities::default()
            },
            ..ModelInfo::default()
        }),
        ..unique_model("info-override")
    });
    rejections(&transport, &[FORCED_REJECTION]);
    run(&model, request(person(), structured_output_options(person_schema()))).await;
    assert_eq!(mechanisms(&transport, Command::ConverseStream), ["forced", "auto"]);
}

#[tokio::test]
async fn surfaces_an_unrelated_validation_error_without_retrying() {
    let (model, transport) = provider(unique_model("unrelated"));
    rejections(&transport, &["Malformed input request"]);
    let error = run_error(&model, request(person(), structured_output_options(person_schema()))).await;
    assert!(error.to_string().contains("Malformed input request"), "{error}");
    assert_eq!(transport.call_count(), 1);
}

fn thinking() -> JsonValue {
    json!({"type": "adaptive"})
}

fn sent_fields(transport: &MockTransport, command: Command) -> Vec<JsonValue> {
    transport
        .requests(command)
        .iter()
        .map(|request| {
            request
                .get("additionalModelRequestFields")
                .cloned()
                .unwrap_or(JsonValue::Null)
        })
        .collect()
}

#[tokio::test]
async fn retries_the_next_mechanism_with_drop_block_when_its_replayed_thinking_is_stale() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_request_fields: Some(json!({"thinking": thinking()})),
        ..unique_model("stale-native")
    });
    rejections(&transport, &[FORCED_REJECTION, BINDING_ERROR]);
    run(&model, request(person(), structured_output_options(person_schema()))).await;
    let sent: Vec<(&str, JsonValue)> = transport
        .requests(Command::ConverseStream)
        .iter()
        .map(|request| {
            (
                mechanism_of(request),
                request
                    .get("additionalModelRequestFields")
                    .cloned()
                    .unwrap_or(JsonValue::Null),
            )
        })
        .collect();
    assert_eq!(
        sent,
        [
            ("forced", JsonValue::Null),
            ("native", json!({"thinking": thinking()})),
            (
                "native",
                json!({
                    "thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
                    "anthropic_beta": ["thinking-binding-controls-2026-08-01"]
                })
            ),
        ]
    );
}

#[tokio::test]
async fn sends_name_with_auto_tool_choice_keeping_the_thinking_config_forcing_strips() {
    let cases: [(&str, &[&str]); 2] = [
        ("native", &[FORCED_REJECTION]),
        ("auto", &[FORCED_REJECTION, NATIVE_REJECTION]),
    ];
    for (name, rejected) in cases {
        let (model, transport) = provider(BedrockModelConfig {
            additional_request_fields: Some(json!({"thinking": thinking()})),
            ..unique_model(&format!("keeps-thinking-{name}"))
        });
        rejections(&transport, rejected);
        run(&model, request(person(), structured_output_options(person_schema()))).await;
        let last = transport.last();
        assert_eq!(last["toolConfig"]["toolChoice"], json!({"auto": {}}), "{name}");
        assert_eq!(
            last["additionalModelRequestFields"],
            json!({"thinking": thinking()}),
            "{name}"
        );
    }
}

#[tokio::test]
async fn sends_native_output_with_the_converted_schema_keeping_other_output_config_settings() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_args: Some(json!({"outputConfig": {"effort": "high"}})),
        ..unique_model("output-config")
    });
    rejections(&transport, &[FORCED_REJECTION]);
    run(&model, request(person(), structured_output_options(person_schema()))).await;
    let schema = serde_json::to_string(&to_native_output_schema(&person_schema()).unwrap()).unwrap();
    assert_eq!(
        transport.last()["outputConfig"],
        json!({
            "effort": "high",
            "textFormat": {
                "type": "json_schema",
                "structure": {"jsonSchema": {"schema": schema, "name": "strands_structured_output"}}
            }
        })
    );
}

#[test]
fn clearing_structured_output_support_forgets_rejections() {
    clear_structured_output_support();
}

fn drop_block_fields() -> JsonValue {
    json!({
        "thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
        "anthropic_beta": ["other-beta", "thinking-binding-controls-2026-08-01"]
    })
}

#[tokio::test]
async fn retries_a_mode_request_once_with_drop_block_and_keeps_it_on() {
    for (stream, command) in [(true, Command::ConverseStream), (false, Command::Converse)] {
        let (model, transport) = provider(BedrockModelConfig {
            stream: Some(stream),
            additional_request_fields: Some(json!({"thinking": thinking(), "anthropic_beta": ["other-beta"]})),
            ..with_model_id("m1")
        });
        transport.reject(validation(BINDING_ERROR));
        if stream {
            transport.set_default(Vec::new());
        }
        let (logs, guard) = crate::test_support::record_logs();
        run(&model, request(hello(), Options::default())).await;
        drop(guard);
        assert_eq!(
            sent_fields(&transport, command),
            [
                json!({"thinking": thinking(), "anthropic_beta": ["other-beta"]}),
                drop_block_fields()
            ]
        );
        assert!(logs.text().contains("retrying with drop_block"), "{}", logs.text());

        run(&model, request(hello(), Options::default())).await;
        assert_eq!(transport.call_count(), 3);
        assert_eq!(sent_fields(&transport, command).last().unwrap(), &drop_block_fields());
    }
}

fn forced() -> Options {
    Options {
        tool_specs: vec![ToolSpec::new("calc", "Calculator")],
        tool_choice: Some(ToolChoice::Any),
        ..Options::default()
    }
}

#[tokio::test]
async fn re_throws_the_binding_error_with_name() {
    let cases = [
        (
            "a caller-set block_binding",
            Some(json!({"thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "error"}}})),
            Options::default(),
        ),
        ("a forced tool and no thinking config", None, forced()),
    ];
    for (name, fields, options) in cases {
        let (model, transport) = provider(BedrockModelConfig {
            additional_request_fields: fields,
            ..with_model_id("m1")
        });
        transport.reject(validation(BINDING_ERROR));
        let error = run_error(&model, request(hello(), options)).await;
        assert!(
            error.to_string().contains("bound to a different conversation"),
            "{name}"
        );
        assert_eq!(transport.call_count(), 1, "{name}");
    }
}

#[tokio::test]
async fn retries_with_adaptive_thinking_when_no_thinking_config_is_set() {
    let (model, transport) = provider(with_model_id("m1"));
    transport.reject(validation(BINDING_ERROR));
    transport.set_default(Vec::new());

    run(&model, request(hello(), Options::default())).await;
    run(&model, request(hello(), Options::default())).await;
    run(&model, request(hello(), forced())).await;

    let synthetic = json!({
        "thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": "drop_block"}},
        "anthropic_beta": ["thinking-binding-controls-2026-08-01"]
    });
    assert_eq!(
        sent_fields(&transport, Command::ConverseStream),
        [JsonValue::Null, synthetic.clone(), synthetic, JsonValue::Null]
    );
}

#[tokio::test]
async fn keeps_drop_block_on_for_thinking_set_in_additional_args() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_args: Some(json!({
            "additionalModelRequestFields": {"thinking": thinking(), "anthropic_beta": ["other-beta"]}
        })),
        ..with_model_id("m1")
    });
    transport.reject(validation(BINDING_ERROR));
    transport.set_default(Vec::new());

    run(&model, request(hello(), Options::default())).await;
    run(&model, request(hello(), Options::default())).await;

    assert_eq!(transport.call_count(), 3);
    assert_eq!(
        sent_fields(&transport, Command::ConverseStream).last().unwrap(),
        &drop_block_fields()
    );
}

#[tokio::test]
async fn does_not_keep_drop_block_on_after_a_rejected_retry() {
    let (model, transport) = provider(BedrockModelConfig {
        temperature: Some(0.2),
        ..with_model_id("m1")
    });
    transport.reject(validation(BINDING_ERROR));
    transport.reject(validation("`temperature` may only be set to 1"));
    transport.set_default(Vec::new());

    let error = run_error(&model, request(hello(), Options::default())).await;
    assert!(error.to_string().contains("temperature"), "{error}");
    run(&model, request(hello(), Options::default())).await;

    assert_eq!(
        sent_fields(&transport, Command::ConverseStream).last().unwrap(),
        &JsonValue::Null
    );
}

#[tokio::test]
async fn re_throws_the_binding_message_on_a_non_validation_error() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_request_fields: Some(json!({"thinking": thinking()})),
        ..with_model_id("m1")
    });
    transport.reject(plain_error(BINDING_ERROR));
    let error = run_error(&model, request(hello(), Options::default())).await;
    assert!(error.to_string().contains("bound to a different conversation"));
    assert_eq!(transport.call_count(), 1);
}

#[tokio::test]
async fn maps_name_on_the_retry_to_its_sdk_error() {
    let throttle = Reply::Ok(vec![Ok(json!({"throttlingException": {"message": "Rate exceeded"}}))]);
    let overflow = Reply::Reject(plain_error("Input is too long for requested model"));
    for (reply, expected) in [
        (throttle, "ModelThrottledError"),
        (overflow, "ContextWindowOverflowError"),
    ] {
        let (model, transport) = provider(BedrockModelConfig {
            additional_request_fields: Some(json!({"thinking": thinking()})),
            ..with_model_id("m1")
        });
        transport.reject(validation(BINDING_ERROR));
        transport.push(reply);
        let error = run_error(&model, request(hello(), Options::default())).await;
        assert_eq!(error.name(), expected);
        assert_eq!(transport.call_count(), 2);
    }
}

#[tokio::test]
async fn re_throws_a_second_binding_error_without_retrying_again() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_request_fields: Some(json!({"thinking": thinking()})),
        ..with_model_id("m1")
    });
    transport.reject(validation(BINDING_ERROR));
    transport.reject(validation(BINDING_ERROR));
    let error = run_error(&model, request(hello(), Options::default())).await;
    assert!(error.to_string().contains("bound to a different conversation"));
    assert_eq!(transport.call_count(), 2);
}

#[tokio::test]
async fn keeps_thinking_off_when_a_forced_tool_choice_follows_the_retry() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_request_fields: Some(json!({"thinking": thinking()})),
        ..with_model_id("m1")
    });
    transport.reject(validation(BINDING_ERROR));
    transport.set_default(Vec::new());
    run(&model, request(hello(), Options::default())).await;
    run(&model, request(hello(), forced())).await;
    assert_eq!(
        sent_fields(&transport, Command::ConverseStream).last().unwrap(),
        &JsonValue::Null
    );
}

#[tokio::test]
async fn stops_a_fake_in_flight_bedrock_producer_when_the_signal_aborts() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {"start": {}, "contentBlockIndex": 0}}),
        json!({"contentBlockDelta": {"delta": {"text": "token "}, "contentBlockIndex": 0}}),
        json!({"contentBlockDelta": {"delta": {"text": "token "}, "contentBlockIndex": 0}}),
    ]);
    let handle = CancelHandle::new();
    let mut model_request = request(hello(), Options::default());
    model_request.cancel_signal = Some(handle.signal());
    let mut stream = model.stream(model_request);
    let first = stream.next().await.unwrap().unwrap();
    assert!(matches!(first, ModelStreamEvent::MessageStart(_)));
    handle.cancel(CancelOptions::default());
    let next = stream.next().await.unwrap();
    assert_eq!(next.unwrap_err().to_string(), "Request aborted");
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn handles_tool_use_input_delta() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {"start": {"toolUse": {"name": "calc", "toolUseId": "id"}}}}),
        json!({"contentBlockDelta": {"delta": {"toolUse": {"input": "{\"a\": 1}"}}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": "tool_use"}}),
        json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
    ]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert!(events.contains(&json!({
        "type": "modelContentBlockDeltaEvent",
        "delta": {"type": "toolUseInputDelta", "input": "{\"a\": 1}"}
    })));
}

#[tokio::test]
async fn handles_reasoning_content_delta_with_both_text_and_signature_as_well_as_redacted_content() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {}}),
        json!({"contentBlockDelta": {"delta": {"reasoningContent": {"text": "thinking...", "signature": "sig123"}}}}),
        json!({"contentBlockDelta": {"delta": {"reasoningContent": {"redactedContent": "AA=="}}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": "end_turn"}}),
        json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
    ]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert!(events.contains(&json!({
        "type": "modelContentBlockDeltaEvent",
        "delta": {"type": "reasoningContentDelta", "text": "thinking...", "signature": "sig123"}
    })));
    assert!(events.contains(&json!({
        "type": "modelContentBlockDeltaEvent",
        "delta": {"type": "reasoningContentDelta", "redactedContent": "AA=="}
    })));
}

fn reasoning_delta(events: &[JsonValue]) -> JsonValue {
    events
        .iter()
        .find(|event| event["delta"]["type"] == "reasoningContentDelta")
        .cloned()
        .unwrap()
}

#[tokio::test]
async fn handles_reasoning_content_delta_with_only_text_skips_unsupported_types() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {}}),
        json!({"contentBlockDelta": {"delta": {"reasoningContent": {"text": "thinking..."}}}}),
        json!({"contentBlockDelta": {"delta": {"unknown": "type"}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": "end_turn"}}),
        json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
        json!({"unknown": "type"}),
    ]);
    let (logs, _guard) = crate::test_support::record_logs();
    let events = events_json(&model, request(hello(), Options::default())).await;
    let delta = reasoning_delta(&events);
    assert_eq!(delta["delta"]["text"], "thinking...");
    assert!(delta["delta"].get("signature").is_none());
    assert!(
        logs.text()
            .contains("delta_key=<unknown> | skipping unsupported delta key")
    );
    assert!(
        logs.text()
            .contains("event_type=<unknown> | unsupported bedrock event type")
    );
}

#[tokio::test]
async fn handles_reasoning_content_delta_with_only_signature() {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![
        json!({"messageStart": {"role": "assistant"}}),
        json!({"contentBlockStart": {}}),
        json!({"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "sig123"}}}}),
        json!({"contentBlockStop": {}}),
        json!({"messageStop": {"stopReason": "end_turn"}}),
        json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
    ]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    let delta = reasoning_delta(&events);
    assert!(delta["delta"].get("text").is_none());
    assert_eq!(delta["delta"]["signature"], "sig123");
}

fn metadata_event(events: &[JsonValue]) -> JsonValue {
    events
        .iter()
        .find(|event| event["type"] == "modelMetadataEvent")
        .cloned()
        .unwrap()
}

#[tokio::test]
async fn handles_cache_usage_metrics() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let mut chunks = hello_chunks();
    chunks[5] = json!({"metadata": {"usage": {
        "inputTokens": 100, "outputTokens": 50, "totalTokens": 150, "cacheReadInputTokens": 80, "cacheWriteInputTokens": 20
    }}});
    transport.push_chunks(chunks);
    let events = events_json(&model, request(hello(), Options::default())).await;
    let metadata = metadata_event(&events);
    assert_eq!(metadata["usage"]["cacheReadInputTokens"], 80);
    assert_eq!(metadata["usage"]["cacheWriteInputTokens"], 20);
}

#[tokio::test]
async fn handles_cache_usage_metrics_in_non_streaming_mode() {
    let (model, transport) = provider(mode(false));
    transport.push_chunks(vec![json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150, "cacheReadInputTokens": 80, "cacheWriteInputTokens": 20},
        "metrics": {"latencyMs": 100}
    })]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert_eq!(
        metadata_event(&events),
        json!({
            "type": "modelMetadataEvent",
            "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150, "cacheReadInputTokens": 80, "cacheWriteInputTokens": 20},
            "metrics": {"latencyMs": 100}
        })
    );
}

#[tokio::test]
async fn omits_cache_counters_in_non_streaming_mode_when_usage_does_not_report_them() {
    let (model, transport) = provider(mode(false));
    transport.push_chunks(vec![json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hello"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
        "metrics": {"latencyMs": 100}
    })]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert_eq!(
        metadata_event(&events),
        json!({
            "type": "modelMetadataEvent",
            "usage": {"inputTokens": 100, "outputTokens": 50, "totalTokens": 150},
            "metrics": {"latencyMs": 100}
        })
    );
}

#[tokio::test]
async fn handles_trace_in_metadata() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let mut chunks = hello_chunks();
    chunks[5] = json!({"metadata": {
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "trace": {"guardrail": {"action": "INTERVENED"}}
    }});
    transport.push_chunks(chunks);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert_eq!(
        metadata_event(&events)["trace"],
        json!({"guardrail": {"action": "INTERVENED"}})
    );
}

#[tokio::test]
async fn handles_additional_model_response_fields() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let mut chunks = hello_chunks();
    chunks[4] =
        json!({"messageStop": {"stopReason": "end_turn", "additionalModelResponseFields": {"customField": "value"}}});
    transport.push_chunks(chunks);
    let events = events_json(&model, request(hello(), Options::default())).await;
    let stop = events
        .iter()
        .find(|event| event["type"] == "modelMessageStopEvent")
        .unwrap();
    assert_eq!(stop["additionalModelResponseFields"], json!({"customField": "value"}));
}

#[tokio::test]
async fn handles_stop_reason_types() {
    let cases = [
        ("end_turn", "endTurn"),
        ("tool_use", "toolUse"),
        ("max_tokens", "maxTokens"),
        ("stop_sequence", "stopSequence"),
        ("content_filtered", "contentFiltered"),
        ("guardrail_intervened", "guardrailIntervened"),
        ("model_context_window_exceeded", "modelContextWindowExceeded"),
        ("new_stop_reason", "newStopReason"),
    ];
    for (bedrock_reason, expected) in cases {
        let (model, transport) = provider(BedrockModelConfig::default());
        transport.push_chunks(vec![
            json!({"messageStart": {"role": "assistant"}}),
            json!({"messageStop": {"stopReason": bedrock_reason}}),
            json!({"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}),
        ]);
        let events = events_json(&model, request(hello(), Options::default())).await;
        let stop = events
            .iter()
            .find(|event| event["type"] == "modelMessageStopEvent")
            .unwrap();
        assert_eq!(stop["stopReason"], expected, "{bedrock_reason}");
    }
}

#[tokio::test]
async fn adjusts_a_converse_end_turn_with_a_tool_use_to_tool_use() {
    let (model, transport) = provider(mode(false));
    transport.push_chunks(vec![json!({
        "output": {"message": {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "calc", "input": {}}}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    })]);
    let events = events_json(&model, request(hello(), Options::default())).await;
    assert!(events.contains(&json!({"type": "modelMessageStopEvent", "stopReason": "toolUse"})));
}

async fn throttle_error(chunk: JsonValue) -> Error {
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![json!({"messageStart": {"role": "assistant"}}), chunk]);
    run_error(&model, request(hello(), Options::default())).await
}

#[tokio::test]
async fn throws_model_throttled_error_when_throttling_exception_is_received() {
    let error = throttle_error(json!({"throttlingException": {"message": "Rate exceeded"}})).await;
    assert_eq!(error.name(), "ModelThrottledError");
}

#[tokio::test]
async fn includes_throttling_message_in_model_throttled_error() {
    let error = throttle_error(json!({"throttlingException": {"message": "Too many requests"}})).await;
    assert_eq!(error.to_string(), "Too many requests");
}

#[tokio::test]
async fn uses_default_message_when_throttling_exception_has_no_message() {
    let error = throttle_error(json!({"throttlingException": {}})).await;
    assert_eq!(error.to_string(), "Request was throttled by the model provider");
}

#[tokio::test]
async fn rethrows_in_stream_exceptions_with_their_name() {
    let error = throttle_error(json!({"modelStreamErrorException": {"message": "stream broke"}})).await;
    assert_eq!(
        (error.name(), error.to_string().as_str()),
        ("ModelError", "stream broke")
    );
    let source = std::error::Error::source(&error).unwrap().to_string();
    assert_eq!(source, "ModelStreamErrorException: stream broke");
}

#[tokio::test]
async fn rejects_an_unexpected_role() {
    let error = throttle_error(json!({"messageStart": {"role": "system"}})).await;
    let (model, transport) = provider(BedrockModelConfig::default());
    transport.push_chunks(vec![json!({"messageStart": {"role": "system"}})]);
    let first = run_error(&model, request(hello(), Options::default())).await;
    assert_eq!(first.to_string(), "Unexpected role from Bedrock: 'system'");
    assert_eq!(error.to_string(), "Unexpected role from Bedrock: 'system'");
}

/// Sets its flag when dropped, standing in for the response body of an in-flight request.
struct BodyGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for BodyGuard {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Streams one chunk and then waits forever, holding a [`BodyGuard`].
struct PendingTransport(Arc<std::sync::atomic::AtomicBool>);

#[async_trait::async_trait]
impl BedrockTransport for PendingTransport {
    async fn converse_stream(&self, _request: JsonObject) -> std::result::Result<ChunkStream, BedrockError> {
        let guard = BodyGuard(Arc::clone(&self.0));
        let first = into_object(json!({"messageStart": {"role": "assistant"}}));
        Ok(Box::pin(futures::stream::iter([Ok(first)]).chain(
            futures::stream::pending::<std::result::Result<JsonObject, BedrockError>>().map(move |chunk| {
                let _ = &guard;
                chunk
            }),
        )))
    }

    async fn converse(&self, _request: JsonObject) -> std::result::Result<JsonObject, BedrockError> {
        Err(plain_error("unused"))
    }

    async fn count_tokens(
        &self,
        _model_id: String,
        _input: JsonObject,
    ) -> std::result::Result<Option<u64>, BedrockError> {
        Ok(None)
    }
}

#[tokio::test]
async fn releases_the_response_before_reporting_the_abort() {
    let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let model = BedrockModel::with_transport(
        BedrockModelConfig::default(),
        Arc::new(PendingTransport(Arc::clone(&released))),
    );
    let handle = CancelHandle::new();
    let mut model_request = request(hello(), Options::default());
    model_request.cancel_signal = Some(handle.signal());
    let mut stream = model.stream(model_request);
    assert!(matches!(
        stream.next().await,
        Some(Ok(ModelStreamEvent::MessageStart(_)))
    ));
    assert!(!released.load(std::sync::atomic::Ordering::SeqCst));
    handle.cancel(CancelOptions::default());
    assert_eq!(stream.next().await.unwrap().unwrap_err().to_string(), "Request aborted");
    assert!(
        released.load(std::sync::atomic::Ordering::SeqCst),
        "the response is still held while the consumer sees the abort"
    );
}
