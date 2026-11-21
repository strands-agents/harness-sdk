//! Message formatting tests (tool specs, strict tools, reasoning, cache point blocks) and format
//! errors.

use serde_json::json;

use super::*;
use crate::models::{CacheConfig, CacheStrategy};
use crate::types::{
    CachePointBlock, ReasoningBlock, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUseBlock, UnknownBlock,
};

fn calculator() -> ToolSpec {
    ToolSpec::new("calculator", "Perform calculations")
        .with_input_schema(json!({"type": "object", "properties": {"expression": {"type": "string"}}}))
}

fn unknown(data: JsonValue) -> UnknownBlock {
    let JsonValue::Object(data) = data else { unreachable!() };
    UnknownBlock::new(data)
}

#[tokio::test]
async fn formats_the_request_to_bedrock_properly() {
    let (model, transport) = provider(BedrockModelConfig {
        max_tokens: Some(1024),
        temperature: Some(0.7),
        top_p: Some(0.9),
        stop_sequences: Some(vec!["STOP".into()]),
        cache_config: Some(CacheConfig {
            strategy: Some(CacheStrategy::Auto),
            ..CacheConfig::default()
        }),
        additional_response_field_paths: Some(vec!["Hello!".into()]),
        additional_request_fields: Some(json!(["World!"])),
        additional_args: Some(json!({"MyExtraArg": "ExtraArg"})),
        ..with_model_id("anthropic.claude-sonnet-4-6")
    });
    let options = Options {
        system_prompt: Some("You are a helpful assistant".into()),
        tool_specs: vec![calculator()],
        tool_choice: Some(ToolChoice::Auto),
        ..Options::default()
    };
    run(&model, request(hello(), options)).await;
    assert_eq!(
        transport.last(),
        json!({
            "MyExtraArg": "ExtraArg",
            "additionalModelRequestFields": ["World!"],
            "additionalModelResponseFieldPaths": ["Hello!"],
            "modelId": "anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [{"text": "Hello"}, {"cachePoint": {"type": "default"}}]}],
            "system": [{"text": "You are a helpful assistant"}, {"cachePoint": {"type": "default"}}],
            "toolConfig": {
                "toolChoice": {"auto": {}},
                "tools": [
                    {"toolSpec": {
                        "name": "calculator",
                        "description": "Perform calculations",
                        "inputSchema": {"json": {"type": "object", "properties": {"expression": {"type": "string"}}}}
                    }},
                    {"cachePoint": {"type": "default"}}
                ]
            },
            "inferenceConfig": {"maxTokens": 1024, "temperature": 0.7, "topP": 0.9, "stopSequences": ["STOP"]}
        })
    );
}

#[tokio::test]
async fn formats_tool_use_messages() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
        "calculator",
        "tool-123",
        json!({"a": 5, "b": 3}),
    ))])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last()["messages"],
        json!([{"role": "assistant", "content": [
            {"toolUse": {"toolUseId": "tool-123", "name": "calculator", "input": {"a": 5, "b": 3}}}
        ]}])
    );
}

#[tokio::test]
async fn formats_tool_result_messages() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![user(vec![ContentBlock::ToolResult(ToolResultBlock::new(
        "tool-123",
        ToolResultStatus::Success,
        vec![
            ToolResultContent::text("Result: 8"),
            ToolResultContent::json(json!({"hello": "world"})),
        ],
    ))])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last(),
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "messages": [{"content": [{"toolResult": {
                "content": [{"text": "Result: 8"}, {"json": {"hello": "world"}}],
                "status": "success",
                "toolUseId": "tool-123"
            }}], "role": "user"}],
            "toolConfig": noop_tool_config(),
            "modelId": "global.anthropic.claude-sonnet-4-6"
        })
    );
}

#[tokio::test]
async fn skips_unknown_blocks() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![user(vec![
        ContentBlock::text("Hello"),
        ContentBlock::Unknown(unknown(json!({"futureBlock": {"value": 1}}))),
    ])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last(),
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "modelId": "global.anthropic.claude-sonnet-4-6",
            "messages": [{"role": "user", "content": [{"text": "Hello"}]}]
        })
    );
}

#[tokio::test]
async fn skips_unknown_content_in_a_tool_result() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![user(vec![ContentBlock::ToolResult(ToolResultBlock::new(
        "id-1",
        ToolResultStatus::Success,
        vec![
            ToolResultContent::text("loaded"),
            ToolResultContent::Unknown(unknown(json!({"futureBlock": {"name": "shell"}}))),
        ],
    ))])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last()["messages"][0]["content"],
        json!([{"toolResult": {"toolUseId": "id-1", "content": [{"text": "loaded"}], "status": "success"}}])
    );
}

#[tokio::test]
async fn names_the_tool_for_a_tool_reference_a_model_info_override_lets_through() {
    let native = crate::models::ModelInfo {
        capabilities: crate::models::ModelCapabilities {
            deferred_tool_loading: Some(crate::models::DeferredToolLoading::Native),
            ..crate::models::ModelCapabilities::default()
        },
        ..crate::models::ModelInfo::default()
    };
    let (model, transport) = provider(BedrockModelConfig {
        model_info: Some(native),
        ..BedrockModelConfig::default()
    });
    let messages = vec![user(vec![ContentBlock::ToolResult(ToolResultBlock::success(
        "id-1",
        vec![crate::types::ToolReferenceBlock::new("shell").into()],
    ))])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last()["messages"][0]["content"],
        json!([{"toolResult": {"toolUseId": "id-1", "content": [{"text": "Loaded shell."}], "status": "success"}}])
    );
}

mod deferred_tools {
    use super::*;
    use crate::models::DeferredToolLoading;

    #[test]
    fn reports_deferred_tool_loading_for_claude_another_model_a_model_with_strict_tools_and_a_model_that_can_not_take_stubs()
     {
        let cases = [
            (
                with_model_id("us.anthropic.claude-opus-5-5"),
                DeferredToolLoading::Stubs,
            ),
            (
                with_model_id("qwen.qwen3-235b-a22b-2507-v1:0"),
                DeferredToolLoading::Stubs,
            ),
            (
                BedrockModelConfig {
                    strict_tools: Some(true),
                    ..with_model_id("us.anthropic.claude-opus-5-5")
                },
                DeferredToolLoading::Unsupported,
            ),
            (
                with_model_id("us.amazon.nova-pro-v1:0"),
                DeferredToolLoading::Unsupported,
            ),
        ];
        for (config, expected) in cases {
            let (model, _) = provider(config);
            assert_eq!(model.model_info().capabilities.deferred_tool_loading, Some(expected));
        }
    }

    #[tokio::test]
    async fn sends_a_deferred_tool_as_a_full_spec_when_called_directly_since_model_proxy_makes_the_stubs() {
        let (model, transport) = provider(with_model_id("us.anthropic.claude-opus-5-5"));
        let input_schema = json!({"type": "object", "properties": {"expression": {"type": "string"}}});
        let request = ModelRequest {
            deferred_tools: ["calculator".to_owned()].into(),
            ..request(
                hello(),
                Options {
                    tool_specs: vec![ToolSpec::new("calculator", "Calculate").with_input_schema(input_schema.clone())],
                    ..Options::default()
                },
            )
        };
        run(&model, request).await;
        assert_eq!(
            transport.last()["toolConfig"]["tools"],
            json!([{"toolSpec": {"name": "calculator", "description": "Calculate", "inputSchema": {"json": input_schema}}}])
        );
    }
}

#[tokio::test]
async fn injects_noop_tool_config_when_messages_have_tool_blocks_but_no_tool_specs() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![
        assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
            "calc",
            "id-1",
            json!({"a": 1}),
        ))]),
        user(vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "id-1",
            vec![ToolResultContent::text("42")],
        ))]),
        Message::user("Summarize"),
    ];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(transport.last()["toolConfig"], noop_tool_config());
}

#[tokio::test]
async fn does_not_inject_noop_tool_config_when_messages_have_no_tool_blocks() {
    let (model, transport) = provider(BedrockModelConfig::default());
    run(&model, request(hello(), Options::default())).await;
    assert!(transport.last().get("toolConfig").is_none());
}

#[tokio::test]
async fn does_not_inject_noop_tool_config_when_tool_specs_are_provided() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![
        assistant(vec![ContentBlock::ToolUse(ToolUseBlock::new(
            "calc",
            "id-1",
            json!({}),
        ))]),
        user(vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "id-1",
            vec![ToolResultContent::text("ok")],
        ))]),
    ];
    let options = Options {
        tool_specs: vec![
            ToolSpec::new("calc", "Calculator").with_input_schema(json!({"type": "object", "properties": {}})),
        ],
        ..Options::default()
    };
    run(&model, request(messages, options)).await;
    let tools = transport.last()["toolConfig"]["tools"].clone();
    assert_eq!(tools[0]["toolSpec"]["name"], "calc");
    assert_eq!(tools.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn formats_tool_specs_without_output_schema_in_bedrock_requests() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let options = Options {
        tool_specs: vec![
            ToolSpec::new("calculator", "Calculate")
                .with_input_schema(json!({"type": "object"}))
                .with_output_schema(json!({"type": "object", "properties": {"result": {"type": "number"}}})),
        ],
        ..Options::default()
    };
    run(&model, request(hello(), options)).await;
    assert_eq!(
        transport.last()["toolConfig"]["tools"],
        json!([{"toolSpec": {"name": "calculator", "description": "Calculate", "inputSchema": {"json": {"type": "object"}}}}])
    );
}

fn strict(strict_tools: Option<bool>) -> BedrockModelConfig {
    BedrockModelConfig {
        strict_tools,
        ..with_model_id("global.anthropic.claude-sonnet-4-6")
    }
}

fn calc(schema: JsonValue) -> ToolSpec {
    ToolSpec::new("calc", "Calculator").with_input_schema(schema)
}

async fn last_tools(config: BedrockModelConfig, tool_specs: Vec<ToolSpec>) -> JsonValue {
    let (model, transport) = provider(config);
    let options = Options {
        tool_specs,
        ..Options::default()
    };
    run(&model, request(hello(), options)).await;
    transport.last()["toolConfig"]["tools"].clone()
}

#[tokio::test]
async fn injects_strict_true_and_closes_the_schema_when_strict_tools_is_true() {
    let tools = last_tools(
        strict(Some(true)),
        vec![calc(json!({"type": "object", "properties": {"a": {"type": "string"}}}))],
    )
    .await;
    assert_eq!(
        tools[0]["toolSpec"],
        json!({
            "name": "calc",
            "description": "Calculator",
            "inputSchema": {"json": {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": false}},
            "strict": true
        })
    );
}

#[tokio::test]
async fn does_not_mutate_the_caller_provided_input_schema() {
    let spec = calc(json!({"type": "object", "properties": {"a": {"type": "string"}}}));
    let tools = last_tools(strict(Some(true)), vec![spec.clone()]).await;
    assert_eq!(
        tools[0]["toolSpec"]["inputSchema"]["json"]["additionalProperties"],
        json!(false)
    );
    assert!(spec.input_schema.unwrap().get("additionalProperties").is_none());
}

#[tokio::test]
async fn preserves_an_existing_additional_properties_true() {
    let warning = "tool=<calc>, keywords=<additionalProperties> | tool schema uses keywords bedrock strict mode rejects, request may fail";
    crate::logging::forget_warning(warning);
    let (logs, _guard) = crate::test_support::record_logs();
    let tools = last_tools(
        strict(Some(true)),
        vec![calc(
            json!({"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": true}),
        )],
    )
    .await;
    assert_eq!(
        tools[0]["toolSpec"]["inputSchema"]["json"],
        json!({"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": true})
    );
    assert!(logs.text().contains(warning), "{}", logs.text());
}

#[tokio::test]
async fn warns_with_the_tool_name_and_keywords_when_a_schema_uses_bounds() {
    let warning = "tool=<calc>, keywords=<maximum,minimum> | tool schema uses keywords bedrock strict mode rejects, request may fail";
    crate::logging::forget_warning(warning);
    let (logs, _guard) = crate::test_support::record_logs();
    last_tools(
        strict(Some(true)),
        vec![calc(
            json!({"type": "object", "properties": {"n": {"type": "integer", "minimum": 0, "maximum": 9}}}),
        )],
    )
    .await;
    assert!(logs.text().contains(warning), "{}", logs.text());
}

#[tokio::test]
async fn patches_nested_object_schemas() {
    let tools = last_tools(
        strict(Some(true)),
        vec![calc(json!({
            "type": "object",
            "properties": {"outer": {"type": "object", "properties": {"inner": {"type": "string"}}}}
        }))],
    )
    .await;
    assert_eq!(
        tools[0]["toolSpec"]["inputSchema"]["json"],
        json!({
            "type": "object",
            "properties": {"outer": {"type": "object", "properties": {"inner": {"type": "string"}}, "additionalProperties": false}},
            "additionalProperties": false
        })
    );
}

#[tokio::test]
async fn omits_strict_and_leaves_the_schema_unchanged_by_default() {
    let schema = json!({"type": "object", "properties": {"a": {"type": "string"}}});
    let tools = last_tools(strict(None), vec![calc(schema.clone())]).await;
    assert!(tools[0]["toolSpec"].get("strict").is_none());
    assert_eq!(tools[0]["toolSpec"]["inputSchema"]["json"], schema);
}

#[tokio::test]
async fn omits_strict_when_strict_tools_is_false() {
    let schema = json!({"type": "object", "properties": {"a": {"type": "string"}}});
    let tools = last_tools(strict(Some(false)), vec![calc(schema.clone())]).await;
    assert!(tools[0]["toolSpec"].get("strict").is_none());
    assert_eq!(tools[0]["toolSpec"]["inputSchema"]["json"], schema);
}

#[tokio::test]
async fn applies_strict_to_every_tool_when_multiple_tool_specs_are_given() {
    let tools = last_tools(
        strict(Some(true)),
        vec![
            calc(json!({"type": "object", "properties": {"a": {"type": "string"}}})),
            ToolSpec::new("other", "Other").with_input_schema(json!({"type": "object", "properties": {}})),
        ],
    )
    .await;
    assert_eq!(
        tools,
        json!([
            {"toolSpec": {
                "name": "calc",
                "description": "Calculator",
                "inputSchema": {"json": {"type": "object", "properties": {"a": {"type": "string"}}, "additionalProperties": false}},
                "strict": true
            }},
            {"toolSpec": {
                "name": "other",
                "description": "Other",
                "inputSchema": {"json": {"type": "object", "properties": {}, "additionalProperties": false}},
                "strict": true
            }}
        ])
    );
}

#[tokio::test]
async fn formats_reasoning_messages_properly() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![user(vec![
        ContentBlock::Reasoning(ReasoningBlock::new().with_text("Hello").with_signature("World")),
        ContentBlock::Reasoning(ReasoningBlock::new().with_redacted_content(vec![0])),
    ])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last(),
        json!({
            "inferenceConfig": {"maxTokens": 128_000},
            "messages": [{"role": "user", "content": [
                {"reasoningContent": {"reasoningText": {"signature": "World", "text": "Hello"}}},
                {"reasoningContent": {"redactedContent": "AA=="}}
            ]}],
            "modelId": "global.anthropic.claude-sonnet-4-6"
        })
    );
}

#[tokio::test]
async fn formats_a_signature_only_reasoning_block() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let messages = vec![assistant(vec![
        ContentBlock::Reasoning(ReasoningBlock::new().with_signature("sig-abc")),
        ContentBlock::text("the answer"),
    ])];
    run(&model, request(messages, Options::default())).await;
    assert_eq!(
        transport.last()["messages"],
        json!([{"role": "assistant", "content": [
            {"reasoningContent": {"reasoningText": {"text": "", "signature": "sig-abc"}}},
            {"text": "the answer"}
        ]}])
    );
}

#[tokio::test]
async fn drops_the_replayed_reasoning_model_id_rejects() {
    let signed = json!({"reasoningContent": {"reasoningText": {"text": "Claude thinking", "signature": "sig"}}});
    let unsigned = json!({"reasoningContent": {"reasoningText": {"text": "gpt-oss thinking"}}});
    let redacted = json!({"reasoningContent": {"redactedContent": "AQID"}});
    let cases = [
        ("openai.gpt-oss-120b-1:0", vec![&unsigned, &redacted]),
        ("moonshot.kimi-k2-thinking", vec![&unsigned, &redacted]),
        ("minimax.minimax-m2.5", vec![&unsigned, &redacted]),
        ("global.anthropic.claude-opus-5", vec![&signed, &redacted]),
        (
            "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-5",
            vec![&signed, &redacted],
        ),
        ("us.amazon.nova-pro-v1:0", vec![&redacted]),
        ("us.meta.llama3-3-70b-instruct-v1:0", vec![&redacted]),
        ("openai.gpt-5.5", vec![&redacted]),
        ("openai.gpt-daybreak-blue-5.6-sol", vec![&redacted]),
        ("qwen.qwen3-coder-480b-a35b-v1:0", vec![&redacted]),
        ("us.deepseek.r1-v1:0", vec![]),
        (
            "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123",
            vec![&signed, &unsigned, &redacted],
        ),
        ("abc123xyz", vec![&signed, &unsigned, &redacted]),
    ];
    for (model_id, expected) in cases {
        let (model, transport) = provider(with_model_id(model_id));
        let messages = vec![
            Message::user("Hello"),
            assistant(vec![
                ContentBlock::Reasoning(ReasoningBlock::new().with_text("Claude thinking").with_signature("sig")),
                ContentBlock::Reasoning(ReasoningBlock::new().with_text("gpt-oss thinking")),
                ContentBlock::Reasoning(ReasoningBlock::new().with_redacted_content(vec![1, 2, 3])),
                ContentBlock::text("Response"),
            ]),
        ];
        run(&model, request(messages, Options::default())).await;
        let mut content: Vec<JsonValue> = expected.into_iter().cloned().collect();
        content.push(json!({"text": "Response"}));
        assert_eq!(
            transport.last()["messages"][1]["content"],
            JsonValue::Array(content),
            "{model_id}"
        );
    }
}

async fn formatted_messages(messages: Vec<Message>) -> JsonValue {
    let (model, transport) = provider(BedrockModelConfig::default());
    run(&model, request(messages, Options::default())).await;
    transport.last()["messages"].clone()
}

#[tokio::test]
async fn formats_cache_point_blocks_in_messages() {
    let messages = vec![user(vec![
        ContentBlock::text("Message with cache point"),
        ContentBlock::CachePoint(CachePointBlock::new()),
    ])];
    assert_eq!(
        formatted_messages(messages).await,
        json!([{"role": "user", "content": [{"text": "Message with cache point"}, {"cachePoint": {"type": "default"}}]}])
    );
}

#[tokio::test]
async fn preserves_ttl_on_user_supplied_cache_point_blocks_in_messages() {
    let messages = vec![user(vec![
        ContentBlock::text("Message with 1h cache point"),
        ContentBlock::CachePoint(CachePointBlock::new().with_ttl("1h")),
    ])];
    assert_eq!(
        formatted_messages(messages).await,
        json!([{"role": "user", "content": [
            {"text": "Message with 1h cache point"},
            {"cachePoint": {"type": "default", "ttl": "1h"}}
        ]}])
    );
}

#[tokio::test]
async fn omits_a_falsy_ttl_on_user_supplied_cache_point_blocks_in_messages() {
    let messages = vec![user(vec![
        ContentBlock::text("Message with cache point"),
        ContentBlock::CachePoint(CachePointBlock::new().with_ttl("")),
    ])];
    assert_eq!(
        formatted_messages(messages).await,
        json!([{"role": "user", "content": [{"text": "Message with cache point"}, {"cachePoint": {"type": "default"}}]}])
    );
}

#[tokio::test]
async fn preserves_ttl_on_cache_point_blocks_in_system_prompt() {
    let (model, transport) = provider(BedrockModelConfig::default());
    let options = Options {
        system_prompt: Some(SystemPrompt::Blocks(vec![
            crate::types::SystemContentBlock::text("You are a helpful assistant"),
            crate::types::SystemContentBlock::CachePoint(CachePointBlock::new().with_ttl("5m")),
        ])),
        ..Options::default()
    };
    run(&model, request(hello(), options)).await;
    assert_eq!(
        transport.last()["system"],
        json!([{"text": "You are a helpful assistant"}, {"cachePoint": {"type": "default", "ttl": "5m"}}])
    );
}

#[tokio::test]
async fn forwards_arbitrary_ttl_strings_without_client_side_validation_bedrock_validates_server_side() {
    let messages = vec![user(vec![
        ContentBlock::text("Hello"),
        ContentBlock::CachePoint(CachePointBlock::new().with_ttl("2h")),
    ])];
    let formatted = formatted_messages(messages).await;
    assert_eq!(
        formatted[0]["content"][1],
        json!({"cachePoint": {"type": "default", "ttl": "2h"}})
    );
}

#[tokio::test]
async fn throws_for_a_reasoning_block_with_no_text_signature_or_redacted_content() {
    let (model, _) = provider(BedrockModelConfig::default());
    let messages = vec![assistant(vec![ContentBlock::Reasoning(ReasoningBlock::new())])];
    let error = run_error(&model, request(messages, Options::default())).await;
    assert!(
        error
            .to_string()
            .contains("reasoning content requires one of 'text', 'signature', or 'redactedContent' to be set"),
        "{error}"
    );
}

#[tokio::test]
async fn throws_for_a_summary_block() {
    let (model, _) = provider(BedrockModelConfig::default());
    let messages = vec![user(vec![ContentBlock::Summary(crate::types::SummaryBlock::new(
        "summary",
    ))])];
    let error = run_error(&model, request(messages, Options::default())).await;
    assert_eq!(error.to_string(), "content_type=<summaryBlock> | unsupported type");
}

#[tokio::test]
async fn sends_guardrail_and_additional_args_keys_in_ts_order() {
    let (model, transport) = provider(BedrockModelConfig {
        additional_args: Some(json!({"requestMetadata": {"team": "a"}, "modelId": "override"})),
        ..with_model_id("unknown.model-v1:0")
    });
    run(&model, request(hello(), Options::default())).await;
    let keys: Vec<String> = transport.last().as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["modelId", "messages", "requestMetadata"]);
    assert_eq!(transport.last()["modelId"], "override");
}

mod blocks {
    //! Guard content, media blocks in messages and tool results, citations content blocks and the
    //! tool result status setting.

    use serde_json::json;

    use super::super::*;
    use crate::models::bedrock::IncludeToolResultStatus;
    use crate::types::{
        AudioBlock, AudioFormat, AudioSource, Citation, CitationGeneratedContent, CitationSourceContent,
        CitationsBlock, DocumentBlock, DocumentCharLocation, DocumentChunkLocation, DocumentFormat,
        DocumentPageLocation, DocumentSource, GuardContentImage, GuardContentText, GuardImageFormat, GuardQualifier,
        ImageBlock, ImageFormat, ImageSource, S3Location, SearchResultLocation, ToolResultBlock, ToolResultContent,
        ToolResultStatus, VideoBlock, VideoFormat, VideoSource, WebLocation,
    };

    async fn messages_json(config: BedrockModelConfig, messages: Vec<Message>) -> JsonValue {
        let (model, transport) = provider(config);
        run(&model, request(messages, Options::default())).await;
        transport.last()["messages"].clone()
    }

    async fn default_messages(messages: Vec<Message>) -> JsonValue {
        messages_json(BedrockModelConfig::default(), messages).await
    }

    fn tool_result(content: Vec<ToolResultContent>) -> Message {
        user(vec![ContentBlock::ToolResult(ToolResultBlock::success(
            "tool-1", content,
        ))])
    }

    fn tool_result_json(content: &JsonValue) -> JsonValue {
        json!([{"role": "user", "content": [{"toolResult": {"toolUseId": "tool-1", "content": content, "status": "success"}}]}])
    }

    #[tokio::test]
    async fn formats_guard_content_with_text_in_message() {
        let messages = vec![user(vec![
            ContentBlock::text("Verify this information:"),
            ContentBlock::GuardContent(
                GuardContentText::new(vec![GuardQualifier::GroundingSource], "The capital of France is Paris.").into(),
            ),
        ])];
        assert_eq!(
            default_messages(messages).await,
            json!([{"role": "user", "content": [
                {"text": "Verify this information:"},
                {"guardContent": {"text": {"text": "The capital of France is Paris.", "qualifiers": ["grounding_source"]}}}
            ]}])
        );
    }

    #[tokio::test]
    async fn formats_guard_content_with_image_in_message() {
        let messages = vec![user(vec![
            ContentBlock::text("Is this image safe?"),
            ContentBlock::GuardContent(GuardContentImage::new(GuardImageFormat::Jpeg, vec![1, 2, 3, 4]).into()),
        ])];
        assert_eq!(
            default_messages(messages).await,
            json!([{"role": "user", "content": [
                {"text": "Is this image safe?"},
                {"guardContent": {"image": {"format": "jpeg", "source": {"bytes": "AQIDBA=="}}}}
            ]}])
        );
    }

    #[tokio::test]
    async fn formats_image_block_in_tool_result() {
        let image = ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3]));
        assert_eq!(
            default_messages(vec![tool_result(vec![ToolResultContent::Image(image)])]).await,
            tool_result_json(&json!([{"image": {"format": "png", "source": {"bytes": "AQID"}}}]))
        );
    }

    #[tokio::test]
    async fn formats_video_block_in_tool_result_with_3gp_format_mapping() {
        let video = VideoBlock::new(VideoFormat::ThreeGp, VideoSource::Bytes(vec![4, 5, 6]));
        assert_eq!(
            default_messages(vec![tool_result(vec![ToolResultContent::Video(video)])]).await,
            tool_result_json(&json!([{"video": {"format": "three_gp", "source": {"bytes": "BAUG"}}}]))
        );
    }

    #[tokio::test]
    async fn formats_document_block_in_tool_result() {
        let document = DocumentBlock::new("report.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(vec![7, 8, 9]));
        assert_eq!(
            default_messages(vec![tool_result(vec![ToolResultContent::Document(document)])]).await,
            tool_result_json(
                &json!([{"document": {"name": "report.pdf", "format": "pdf", "source": {"bytes": "BwgJ"}}}])
            )
        );
    }

    #[tokio::test]
    async fn formats_mixed_text_and_media_content_in_tool_result() {
        let image = ImageBlock::new(ImageFormat::Jpeg, ImageSource::Bytes(vec![1, 2]));
        let content = vec![
            ToolResultContent::text("Here is the image:"),
            ToolResultContent::Image(image),
        ];
        assert_eq!(
            default_messages(vec![tool_result(content)]).await,
            tool_result_json(&json!([
                {"text": "Here is the image:"},
                {"image": {"format": "jpeg", "source": {"bytes": "AQI="}}}
            ]))
        );
    }

    async fn single_block(block: ContentBlock) -> JsonValue {
        default_messages(vec![user(vec![block])]).await[0]["content"][0].clone()
    }

    #[tokio::test]
    async fn formats_top_level_audio_block() {
        let block = ContentBlock::Audio(AudioBlock::new(AudioFormat::Mp3, AudioSource::Bytes(vec![1, 2, 3])));
        assert_eq!(
            single_block(block).await,
            json!({"audio": {"format": "mp3", "source": {"bytes": "AQID"}}})
        );
    }

    #[tokio::test]
    async fn formats_top_level_audio_block_with_s3_source() {
        let source = AudioSource::Location(S3Location::new("s3://bucket/audio.wav"));
        let block = ContentBlock::Audio(AudioBlock::new(AudioFormat::Wav, source));
        assert_eq!(
            single_block(block).await,
            json!({"audio": {"format": "wav", "source": {"s3Location": {"uri": "s3://bucket/audio.wav"}}}})
        );
    }

    #[tokio::test]
    async fn formats_top_level_image_block() {
        let block = ContentBlock::Image(ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(vec![1, 2, 3])));
        assert_eq!(
            single_block(block).await,
            json!({"image": {"format": "png", "source": {"bytes": "AQID"}}})
        );
    }

    #[tokio::test]
    async fn formats_top_level_image_block_with_s3_source() {
        let source = ImageSource::Location(S3Location::new("s3://bucket/image.png").with_bucket_owner("123456789012"));
        let block = ContentBlock::Image(ImageBlock::new(ImageFormat::Png, source));
        assert_eq!(
            single_block(block).await,
            json!({"image": {"format": "png", "source": {"s3Location": {"uri": "s3://bucket/image.png", "bucketOwner": "123456789012"}}}})
        );
    }

    #[tokio::test]
    async fn formats_an_s3_url_image_source_as_an_s3_location_and_skips_other_urls() {
        let s3 = ContentBlock::Image(ImageBlock::new(
            ImageFormat::Png,
            ImageSource::Url("s3://bucket/a.png".into()),
        ));
        assert_eq!(
            single_block(s3).await,
            json!({"image": {"format": "png", "source": {"s3Location": {"uri": "s3://bucket/a.png"}}}})
        );
        let https = ContentBlock::Image(ImageBlock::new(
            ImageFormat::Png,
            ImageSource::Url("https://x/a.png".into()),
        ));
        assert_eq!(single_block(https).await, json!({"image": {"format": "png"}}));
    }

    #[tokio::test]
    async fn formats_top_level_video_block_with_3gp_format_mapping() {
        let block = ContentBlock::Video(VideoBlock::new(VideoFormat::ThreeGp, VideoSource::Bytes(vec![4, 5, 6])));
        assert_eq!(
            single_block(block).await,
            json!({"video": {"format": "three_gp", "source": {"bytes": "BAUG"}}})
        );
    }

    #[tokio::test]
    async fn formats_a_video_block_with_an_s3_source() {
        let source = VideoSource::Location(S3Location::new("s3://bucket/clip.mp4"));
        let block = ContentBlock::Video(VideoBlock::new(VideoFormat::Mp4, source));
        assert_eq!(
            single_block(block).await,
            json!({"video": {"format": "mp4", "source": {"s3Location": {"uri": "s3://bucket/clip.mp4"}}}})
        );
    }

    #[tokio::test]
    async fn formats_top_level_document_block_with_text_source_converted_to_bytes() {
        let block = ContentBlock::Document(DocumentBlock::new(
            "notes.txt",
            DocumentFormat::Txt,
            DocumentSource::Text("Hello world".into()),
        ));
        assert_eq!(
            single_block(block).await,
            json!({"document": {"name": "notes.txt", "format": "txt", "source": {"bytes": "SGVsbG8gd29ybGQ="}}})
        );
    }

    #[tokio::test]
    async fn formats_a_document_with_content_citations_and_context() {
        let block = ContentBlock::Document(
            DocumentBlock::new(
                "doc",
                DocumentFormat::Txt,
                DocumentSource::Content(vec![crate::types::TextBlock::new("part one")]),
            )
            .with_citations(crate::types::DocumentCitations::new(true))
            .with_context("background"),
        );
        assert_eq!(
            single_block(block).await,
            json!({"document": {
                "name": "doc",
                "format": "txt",
                "source": {"content": [{"text": "part one"}]},
                "citations": {"enabled": true},
                "context": "background"
            }})
        );
    }

    fn sdk_citation(
        location: impl Into<crate::types::CitationLocation>,
        source: &str,
        text: &str,
        title: &str,
    ) -> Citation {
        Citation::new(location, source, vec![CitationSourceContent::new(text)], title)
    }

    #[tokio::test]
    async fn maps_sdk_citation_location_types_to_bedrock_object_key_format_through_formatting_pipeline() {
        let citations = vec![
            sdk_citation(
                DocumentCharLocation::new(0, 150, 300),
                "doc-0",
                "char source",
                "Text Document",
            ),
            sdk_citation(
                DocumentPageLocation::new(0, 2, 3),
                "doc-0",
                "page source",
                "PDF Document",
            ),
            sdk_citation(
                DocumentChunkLocation::new(1, 5, 8),
                "doc-1",
                "chunk source",
                "Chunked Document",
            ),
            sdk_citation(
                SearchResultLocation::new(0, 25, 150),
                "search-0",
                "search source",
                "Search Result",
            ),
            sdk_citation(
                WebLocation::new("https://example.com/doc").with_domain("example.com"),
                "web-0",
                "web source",
                "Web Page",
            ),
        ];
        let block = CitationsBlock::new(
            citations,
            vec![CitationGeneratedContent::new("generated text with all citation types")],
        );
        let messages = vec![
            assistant(vec![ContentBlock::Citations(block)]),
            Message::user("Follow up"),
        ];
        assert_eq!(
            default_messages(messages).await,
            json!([
                {"role": "assistant", "content": [{"citationsContent": {
                    "citations": [
                        {"location": {"documentChar": {"documentIndex": 0, "start": 150, "end": 300}}, "source": "doc-0", "sourceContent": [{"text": "char source"}], "title": "Text Document"},
                        {"location": {"documentPage": {"documentIndex": 0, "start": 2, "end": 3}}, "source": "doc-0", "sourceContent": [{"text": "page source"}], "title": "PDF Document"},
                        {"location": {"documentChunk": {"documentIndex": 1, "start": 5, "end": 8}}, "source": "doc-1", "sourceContent": [{"text": "chunk source"}], "title": "Chunked Document"},
                        {"location": {"searchResultLocation": {"searchResultIndex": 0, "start": 25, "end": 150}}, "source": "search-0", "sourceContent": [{"text": "search source"}], "title": "Search Result"},
                        {"location": {"web": {"url": "https://example.com/doc", "domain": "example.com"}}, "source": "web-0", "sourceContent": [{"text": "web source"}], "title": "Web Page"}
                    ],
                    "content": [{"text": "generated text with all citation types"}]
                }}]},
                {"role": "user", "content": [{"text": "Follow up"}]}
            ])
        );
    }

    #[tokio::test]
    async fn omits_an_empty_source_when_replaying_a_citation() {
        let block = CitationsBlock::new(
            vec![sdk_citation(
                DocumentPageLocation::new(0, 1, 2),
                "",
                "page source",
                "letter",
            )],
            vec![CitationGeneratedContent::new("summary")],
        );
        let messages = vec![
            assistant(vec![ContentBlock::Citations(block)]),
            Message::user("Follow up"),
        ];
        assert_eq!(
            default_messages(messages).await[0]["content"][0]["citationsContent"]["citations"][0],
            json!({
                "location": {"documentPage": {"documentIndex": 0, "start": 1, "end": 2}},
                "sourceContent": [{"text": "page source"}],
                "title": "letter"
            })
        );
    }

    fn status_message(status: ToolResultStatus) -> Vec<Message> {
        vec![user(vec![ContentBlock::ToolResult(ToolResultBlock::new(
            "tool-123",
            status,
            vec![ToolResultContent::text("Result")],
        ))])]
    }

    async fn status_request(config: BedrockModelConfig, status: ToolResultStatus) -> JsonValue {
        let (model, transport) = provider(config);
        run(&model, request(status_message(status), Options::default())).await;
        transport.last()
    }

    fn with_status(include: Option<IncludeToolResultStatus>, model_id: &str) -> BedrockModelConfig {
        BedrockModelConfig {
            include_tool_result_status: include,
            ..with_model_id(model_id)
        }
    }

    #[tokio::test]
    async fn always_includes_status_field_in_tool_results() {
        let config = BedrockModelConfig {
            include_tool_result_status: Some(true.into()),
            ..BedrockModelConfig::default()
        };
        assert_eq!(
            status_request(config, ToolResultStatus::Success).await,
            json!({
                "inferenceConfig": {"maxTokens": 128_000},
                "messages": [{"content": [{"toolResult": {"content": [{"text": "Result"}], "status": "success", "toolUseId": "tool-123"}}], "role": "user"}],
                "toolConfig": noop_tool_config(),
                "modelId": "global.anthropic.claude-sonnet-4-6"
            })
        );
    }

    #[tokio::test]
    async fn never_includes_status_field_in_tool_results() {
        let config = BedrockModelConfig {
            include_tool_result_status: Some(false.into()),
            ..BedrockModelConfig::default()
        };
        assert_eq!(
            status_request(config, ToolResultStatus::Success).await["messages"][0]["content"][0],
            json!({"toolResult": {"content": [{"text": "Result"}], "toolUseId": "tool-123"}})
        );
    }

    #[tokio::test]
    async fn includes_status_field_for_claude_models() {
        let config = with_status(
            Some(IncludeToolResultStatus::Auto),
            "anthropic.claude-3-5-sonnet-20241022-v2:0",
        );
        assert_eq!(
            status_request(config, ToolResultStatus::Success).await,
            json!({
                "inferenceConfig": {"maxTokens": 8192},
                "messages": [{"content": [{"toolResult": {"content": [{"text": "Result"}], "status": "success", "toolUseId": "tool-123"}}], "role": "user"}],
                "toolConfig": noop_tool_config(),
                "modelId": "anthropic.claude-3-5-sonnet-20241022-v2:0"
            })
        );
    }

    #[tokio::test]
    async fn includes_status_field_for_amazon_nova_models() {
        let config = with_status(Some(IncludeToolResultStatus::Auto), "us.amazon.nova-lite-v1:0");
        assert_eq!(
            status_request(config, ToolResultStatus::Error).await,
            json!({
                "messages": [{"content": [{"toolResult": {"content": [{"text": "Result"}], "status": "error", "toolUseId": "tool-123"}}], "role": "user"}],
                "toolConfig": noop_tool_config(),
                "modelId": "us.amazon.nova-lite-v1:0"
            })
        );
    }

    #[tokio::test]
    async fn omits_status_field_for_models_bedrock_does_not_document_as_supporting_it() {
        for model_id in ["us.writer.palmyra-x5-v1:0", "us.meta.llama4-scout-17b-instruct-v1:0"] {
            assert_eq!(
                status_request(with_status(None, model_id), ToolResultStatus::Success).await,
                json!({
                    "messages": [{"content": [{"toolResult": {"content": [{"text": "Result"}], "toolUseId": "tool-123"}}], "role": "user"}],
                    "toolConfig": noop_tool_config(),
                    "modelId": model_id
                }),
                "{model_id}"
            );
        }
    }
}
