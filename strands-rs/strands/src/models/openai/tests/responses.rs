//! Responses API request formatting, stream event mapping, cancellation and error mapping tests.

use serde_json::json;

use super::*;
use crate::models::CacheKey;
use crate::state_store::StateStore;
use crate::types::{
    AgentMetadata, Citation, CitationGeneratedContent, CitationSourceContent, CitationsBlock, ContentBlock,
    DocumentBlock, DocumentCharLocation, DocumentFormat, DocumentSource, ImageBlock, ImageFormat, ImageSource, Role,
    ToolChoice, ToolResultBlock, ToolSpec, ToolUseBlock, UnknownBlock,
};

fn created(id: &str) -> JsonValue {
    json!({"type": "response.created", "response": {"id": id}})
}

fn text_delta(delta: &str) -> JsonValue {
    json!({"type": "response.output_text.delta", "delta": delta})
}

fn completed(usage: Option<JsonValue>) -> JsonValue {
    match usage {
        Some(usage) => json!({"type": "response.completed", "response": {"usage": usage}}),
        None => json!({"type": "response.completed", "response": {}}),
    }
}

fn citation(url: &str, title: &str, cited: &str) -> JsonValue {
    json!({
        "type": "response.output_text.annotation.added",
        "annotation": {"type": "url_citation", "url": url, "title": title, "cited_text": cited}
    })
}

fn user(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::User, content)
}

fn assistant(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::Assistant, content)
}

fn png(bytes: &[u8]) -> ImageBlock {
    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes.to_vec()))
}

fn x() -> ModelRequest {
    request(vec![Message::user("x")])
}

async fn events_for(script: Vec<JsonValue>) -> Vec<JsonValue> {
    collect(&responses_model(&MockClient::replying(script)), x())
        .await
        .unwrap()
}

mod cancellation {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn stops_an_in_flight_responses_producer_when_the_signal_aborts() {
        super::super::chat::stream::stops_on_cancel(
            OpenAIApi::Responses,
            |_| text_delta("token "),
            created("response-1"),
            completed(None),
        )
        .await;
    }
}

mod request_formatting {
    use super::*;

    /// The request a Responses model built from `options` sends.
    async fn run_once(options: OpenAIModelOptions, request: ModelRequest) -> JsonValue {
        let client = MockClient::replying(vec![
            created("resp_123"),
            json!({"type": "response.completed", "response": {"usage": null}}),
        ]);
        let model = model_with(
            &client,
            OpenAIModelOptions {
                api: OpenAIApi::Responses,
                ..options
            },
        );
        collect(&model, request).await.unwrap();
        assert_eq!(client.requests()[0].path, "/responses");
        client.last()
    }

    async fn run(options: OpenAIModelOptions) -> JsonValue {
        run_once(options, request(vec![Message::user("Hi")])).await
    }

    fn with_params(params: JsonValue) -> OpenAIModelOptions {
        OpenAIModelOptions {
            params: Some(params),
            ..Default::default()
        }
    }

    fn with_cache(cache_config: CacheConfig) -> OpenAIModelOptions {
        OpenAIModelOptions {
            cache_config: Some(cache_config),
            ..Default::default()
        }
    }

    fn with_session(session: Option<&str>) -> ModelRequest {
        let metadata = match session {
            Some(session) => AgentMetadata::new().with_session_id(session),
            None => AgentMetadata::new(),
        };
        ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .agent_metadata(metadata)
            .build()
    }

    fn stateful() -> OpenAIModelOptions {
        OpenAIModelOptions {
            stateful: Some(true),
            ..Default::default()
        }
    }

    fn previous(state: &str) -> ModelRequest {
        let model_state = StateStore::new();
        model_state.set("responseId", state).unwrap();
        ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .model_state(model_state)
            .build()
    }

    #[tokio::test]
    async fn includes_model_input_stream_and_store_false_by_default() {
        let body = run(OpenAIModelOptions::default()).await;
        assert_eq!(
            body,
            json!({
                "model": "gpt-5.4",
                "input": [{"role": "user", "content": [{"type": "input_text", "text": "Hi"}]}],
                "stream": true,
                "store": false
            })
        );
    }

    #[tokio::test]
    async fn sets_store_true_when_stateful_is_enabled() {
        assert_eq!(run(stateful()).await["store"], true);
    }

    #[tokio::test]
    async fn chains_previous_response_id_when_stateful_and_model_state_has_response_id() {
        assert_eq!(
            run_once(stateful(), previous("resp_prev")).await["previous_response_id"],
            "resp_prev"
        );
    }

    #[tokio::test]
    async fn omits_previous_response_id_when_stateful_is_disabled_even_with_response_id_in_model_state() {
        let body = run_once(OpenAIModelOptions::default(), previous("resp_prev")).await;
        assert!(body.get("previous_response_id").is_none());
    }

    #[tokio::test]
    async fn maps_system_prompt_string_to_instructions() {
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .system_prompt("Be helpful.")
            .build();
        assert_eq!(
            run_once(OpenAIModelOptions::default(), request).await["instructions"],
            "Be helpful."
        );
    }

    #[tokio::test]
    async fn joins_system_prompt_text_blocks_into_instructions() {
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .system_prompt(vec![
                crate::types::SystemContentBlock::from("A"),
                crate::types::CachePointBlock::new().into(),
                crate::types::SystemContentBlock::from("B"),
            ])
            .build();
        assert_eq!(
            run_once(OpenAIModelOptions::default(), request).await["instructions"],
            "AB"
        );
    }

    #[tokio::test]
    async fn merges_tool_specs_with_built_in_tools_from_params() {
        let request = ModelRequest::builder()
            .messages(vec![Message::user("Hi")])
            .tool_specs(vec![
                ToolSpec::new("calc", "calculator").with_input_schema(json!({"type": "object", "properties": {}})),
            ])
            .build();
        let body = run_once(with_params(json!({"tools": [{"type": "web_search"}]})), request).await;
        assert_eq!(
            body["tools"],
            json!([
                {"type": "web_search"},
                {"type": "function", "name": "calc", "description": "calculator", "parameters": {"type": "object", "properties": {}}, "strict": null}
            ])
        );
        let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["tools", "model", "input", "stream", "store"]);
    }

    #[tokio::test]
    async fn maps_tool_choice_variants() {
        for (choice, expected) in [
            (ToolChoice::Auto, json!("auto")),
            (ToolChoice::Any, json!("required")),
            (ToolChoice::tool("calc"), json!({"type": "function", "name": "calc"})),
        ] {
            let request = ModelRequest::builder()
                .messages(vec![Message::user("Hi")])
                .tool_specs(vec![ToolSpec::new("calc", "d")])
                .tool_choice(choice)
                .build();
            let body = run_once(OpenAIModelOptions::default(), request).await;
            assert_eq!(body["tool_choice"], expected);
            assert_eq!(body["tools"][0]["parameters"], json!({}));
        }
    }

    #[tokio::test]
    async fn formats_temperature_max_tokens_to_max_output_tokens_and_top_p() {
        let body = run(OpenAIModelOptions {
            temperature: Some(0.3),
            max_tokens: Some(512),
            top_p: Some(0.8),
            ..Default::default()
        })
        .await;
        assert_eq!(body["temperature"], 0.3);
        assert_eq!(body["max_output_tokens"], 512);
        assert_eq!(body["top_p"], 0.8);
    }

    #[tokio::test]
    async fn maps_cache_config_cache_key_to_prompt_cache_key() {
        assert_eq!(
            run(with_cache(CacheConfig::builder().cache_key("tenant-42").build())).await["prompt_cache_key"],
            "tenant-42"
        );
    }

    #[tokio::test]
    async fn omits_prompt_cache_key_when_cache_config_is_unset() {
        assert!(
            run(OpenAIModelOptions::default())
                .await
                .get("prompt_cache_key")
                .is_none()
        );
    }

    #[tokio::test]
    async fn lets_an_explicit_prompt_cache_key_in_params_win_over_cache_config() {
        let options = OpenAIModelOptions {
            cache_config: Some(CacheConfig::builder().cache_key("from-config").build()),
            ..with_params(json!({"prompt_cache_key": "explicit"}))
        };
        assert_eq!(run(options).await["prompt_cache_key"], "explicit");
    }

    #[tokio::test]
    async fn derives_prompt_cache_key_from_the_agent_metadata_session_when_cache_key_is_unset() {
        let body = run_once(with_cache(CacheConfig::default()), with_session(Some("s1"))).await;
        assert_eq!(body["prompt_cache_key"], "strands-s1");
    }

    #[tokio::test]
    async fn lets_a_configured_cache_key_win_over_the_agent_metadata_session() {
        let body = run_once(
            with_cache(CacheConfig::builder().cache_key("tenant-42").build()),
            with_session(Some("s1")),
        )
        .await;
        assert_eq!(body["prompt_cache_key"], "tenant-42");
    }

    #[tokio::test]
    async fn treats_a_false_cache_key_as_an_opt_out_even_with_an_agent_metadata_session() {
        let cache_config = CacheConfig {
            cache_key: Some(CacheKey::Disabled),
            ..Default::default()
        };
        let body = run_once(with_cache(cache_config), with_session(Some("s1"))).await;
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[tokio::test]
    async fn omits_prompt_cache_key_when_the_agent_metadata_carries_no_session() {
        let body = run_once(with_cache(CacheConfig::default()), with_session(None)).await;
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[tokio::test]
    async fn maps_retention_literal_cache_config_ttl_to_prompt_cache_retention() {
        for ttl in ["24h", "in_memory"] {
            assert_eq!(
                run(with_cache(CacheConfig::builder().ttl(ttl).build())).await["prompt_cache_retention"],
                ttl
            );
        }
    }

    #[tokio::test]
    async fn ignores_a_non_retention_cache_config_ttl_and_warns() {
        let warning = "ttl=<5m> | cacheConfig.ttl is not an openai retention value, ignoring";
        forget_warning(warning);
        let (logs, _guard) = record_logs();
        let body = run(with_cache(CacheConfig::builder().ttl("5m").build())).await;
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(logs.text().contains("not an openai retention value"), "{}", logs.text());
    }

    #[tokio::test]
    async fn lets_an_explicit_prompt_cache_retention_in_params_win_over_cache_config() {
        let options = OpenAIModelOptions {
            cache_config: Some(CacheConfig::builder().ttl("in_memory").build()),
            ..with_params(json!({"prompt_cache_retention": "24h"}))
        };
        assert_eq!(run(options).await["prompt_cache_retention"], "24h");
    }

    #[tokio::test]
    async fn passes_through_extra_params_fields_to_the_request() {
        let body = run(with_params(json!({"reasoning": {"summary": "auto"}}))).await;
        assert_eq!(body["reasoning"], json!({"summary": "auto"}));
    }

    #[tokio::test]
    async fn provider_managed_fields_in_params_are_overridden_and_cannot_take_effect() {
        let options = OpenAIModelOptions {
            model_id: Some("gpt-4o".to_owned()),
            stateful: Some(true),
            ..with_params(json!({"model": "attacker-model", "input": "hijacked", "stream": false, "store": false}))
        };
        let body = run(options).await;
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], true);
        assert!(body["input"].is_array());
    }

    fn find<'a>(body: &'a JsonValue, kind: &str) -> &'a JsonValue {
        body["input"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["type"] == kind)
            .unwrap()
    }

    async fn run_messages(messages: Vec<Message>) -> JsonValue {
        run_once(pinned(OpenAIApi::Responses), request(messages)).await
    }

    #[tokio::test]
    async fn emits_tool_use_and_tool_result_as_separate_top_level_items() {
        let body = run_messages(vec![
            Message::user("run it"),
            assistant(vec![ToolUseBlock::new("calc", "call_1", json!({"expr": "2+2"})).into()]),
            user(vec![ToolResultBlock::success("call_1", vec!["4".into()]).into()]),
        ])
        .await;
        assert_eq!(
            find(&body, "function_call"),
            &json!({"type": "function_call", "call_id": "call_1", "name": "calc", "arguments": "{\"expr\":\"2+2\"}"})
        );
        assert_eq!(
            find(&body, "function_call_output"),
            &json!({"type": "function_call_output", "call_id": "call_1", "output": "4"})
        );
    }

    #[tokio::test]
    async fn prefixes_errored_tool_results_with_error() {
        let body = run_messages(vec![
            Message::user("x"),
            user(vec![ToolResultBlock::error("t1", vec!["boom".into()]).into()]),
        ])
        .await;
        assert_eq!(find(&body, "function_call_output")["output"], "[ERROR] boom");
    }

    #[tokio::test]
    async fn emits_an_array_output_with_input_image_when_a_tool_result_carries_image_bytes() {
        let result = ToolResultBlock::success("img_tool", vec!["here is the image".into(), png(&[1, 2, 3, 4]).into()]);
        let body = run_messages(vec![Message::user("fetch"), user(vec![result.into()])]).await;
        assert_eq!(
            find(&body, "function_call_output")["output"],
            json!([
                {"type": "input_text", "text": "here is the image"},
                {"type": "input_image", "image_url": "data:image/png;base64,AQIDBA=="}
            ])
        );
    }

    #[tokio::test]
    async fn emits_an_array_output_with_input_file_when_a_tool_result_carries_a_document() {
        let document = DocumentBlock::new(
            "report.pdf",
            DocumentFormat::Pdf,
            DocumentSource::Bytes(vec![5, 6, 7, 8]),
        );
        let result = ToolResultBlock::success("doc_tool", vec![document.into()]);
        let body = run_messages(vec![Message::user("read"), user(vec![result.into()])]).await;
        assert_eq!(
            find(&body, "function_call_output")["output"],
            json!([{"type": "input_file", "file_data": "data:application/pdf;base64,BQYHCA==", "filename": "report.pdf"}])
        );
    }

    #[tokio::test]
    async fn keeps_tool_result_output_as_a_plain_string_when_only_text_is_present() {
        let result = ToolResultBlock::success("text_tool", vec!["pong".into()]);
        let body = run_messages(vec![Message::user("ping"), user(vec![result.into()])]).await;
        assert_eq!(find(&body, "function_call_output")["output"], "pong");
    }

    #[tokio::test]
    async fn serializes_assistant_history_as_a_string_easy_input_message() {
        let body = run_messages(vec![
            Message::user("What is 2+2?"),
            Message::assistant("4"),
            Message::user("What about 3+3?"),
        ])
        .await;
        assert_eq!(
            body["input"],
            json!([
                {"role": "user", "content": [{"type": "input_text", "text": "What is 2+2?"}]},
                {"role": "assistant", "content": "4"},
                {"role": "user", "content": [{"type": "input_text", "text": "What about 3+3?"}]}
            ])
        );
    }

    #[tokio::test]
    async fn joins_multiple_assistant_text_blocks_with_newlines() {
        let body = run_messages(vec![
            Message::user("list two words"),
            assistant(vec![ContentBlock::text("First."), ContentBlock::text("Second.")]),
            Message::user("thanks"),
        ])
        .await;
        assert_eq!(
            body["input"][1],
            json!({"role": "assistant", "content": "First.\nSecond."})
        );
    }

    #[tokio::test]
    async fn drops_non_text_assistant_history_content_with_a_warning() {
        let (logs, _guard) = record_logs();
        let body = run_messages(vec![
            Message::user("draw something"),
            assistant(vec![ContentBlock::text("Here it is."), png(&[1, 2, 3]).into()]),
            Message::user("nice"),
        ])
        .await;
        assert_eq!(body["input"][1], json!({"role": "assistant", "content": "Here it is."}));
        assert!(
            logs.text().contains("no valid responses api input shape"),
            "{}",
            logs.text()
        );
        assert!(logs.text().contains("content_type=<input_image>"), "{}", logs.text());
    }

    #[tokio::test]
    async fn omits_an_assistant_history_turn_whose_content_is_entirely_non_text() {
        let (logs, _guard) = record_logs();
        let body = run_messages(vec![
            Message::user("draw something"),
            assistant(vec![png(&[1, 2, 3]).into()]),
            Message::user("nice"),
        ])
        .await;
        assert!(
            body["input"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["role"] != "assistant")
        );
        assert!(logs.text().contains("content_type=<input_image>"), "{}", logs.text());
    }

    #[tokio::test]
    async fn serializes_user_role_citations_content_as_input_text() {
        let citations = CitationsBlock::new(
            vec![Citation::new(
                DocumentCharLocation::new(0, 0, 10),
                "doc-0",
                vec![CitationSourceContent::new("source")],
                "Test",
            )],
            vec![CitationGeneratedContent::new("quoted passage")],
        );
        let body = run_messages(vec![user(vec![citations.into()])]).await;
        assert_eq!(
            body["input"][0],
            json!({"role": "user", "content": [{"type": "input_text", "text": "quoted passage"}]})
        );
    }

    #[tokio::test]
    async fn skips_unknown_blocks_in_messages_and_tool_results_without_a_warning() {
        let (logs, _guard) = record_logs();
        let unknown = || UnknownBlock::new(json!({"futureBlock": {"value": 1}}).as_object().cloned().unwrap());
        let result = ToolResultBlock::success(
            "tu1",
            vec!["done".into(), crate::types::ToolResultContent::Unknown(unknown())],
        );
        let body = run_messages(vec![
            user(vec![ContentBlock::text("hello"), ContentBlock::Unknown(unknown())]),
            assistant(vec![ToolUseBlock::new("tool", "tu1", json!({})).into()]),
            user(vec![result.into()]),
        ])
        .await;
        assert_eq!(
            body["input"][0],
            json!({"role": "user", "content": [{"type": "input_text", "text": "hello"}]})
        );
        let last = body["input"].as_array().unwrap().last().unwrap();
        assert_eq!(last["type"], "function_call_output");
        assert_eq!(last["call_id"], "tu1");
        assert!(!body.to_string().contains("futureBlock"));
        assert!(!logs.text().contains("WARN"), "{}", logs.text());
    }

    #[tokio::test]
    async fn warns_about_reasoning_history_and_unsupported_sources() {
        let (logs, _guard) = record_logs();
        let document = DocumentBlock::new("a.txt", DocumentFormat::Txt, DocumentSource::Text("text".to_owned()));
        let body = run_messages(vec![
            user(vec![ContentBlock::text("q"), document.into()]),
            assistant(vec![
                crate::types::ReasoningBlock::new().with_text("thought").into(),
                ContentBlock::text("a"),
            ]),
        ])
        .await;
        assert_eq!(body["input"][1], json!({"role": "assistant", "content": "a"}));
        let text = logs.text();
        assert!(text.contains("block_type=<reasoningBlock> | reasoning content is not yet supported in multi-turn conversations with the responses api"), "{text}");
        assert!(
            text.contains("source_type=<documentSourceText> | only byte source documents supported in responses api"),
            "{text}"
        );
    }
}

mod stream_event_mapping {
    use super::*;

    #[tokio::test]
    async fn captures_response_id_on_response_created_when_stateful() {
        let client = MockClient::replying(vec![created("resp_abc"), completed(None)]);
        let model = model_with(
            &client,
            OpenAIModelOptions {
                stateful: Some(true),
                ..options(OpenAIApi::Responses)
            },
        );
        let model_state = StateStore::new();
        let request = ModelRequest::builder()
            .messages(vec![Message::user("hi")])
            .model_state(model_state.clone())
            .build();
        collect(&model, request).await.unwrap();
        assert_eq!(model_state.get_value("responseId"), Some(json!("resp_abc")));
    }

    #[tokio::test]
    async fn does_not_capture_response_id_when_stateful_is_disabled() {
        let client = MockClient::replying(vec![created("resp_abc"), completed(None)]);
        let model_state = StateStore::new();
        let request = ModelRequest::builder()
            .messages(vec![Message::user("hi")])
            .model_state(model_state.clone())
            .build();
        collect(&responses_model(&client), request).await.unwrap();
        assert_eq!(model_state.get_value("responseId"), None);
    }

    #[tokio::test]
    async fn emits_text_deltas_inside_a_content_block() {
        let events = events_for(vec![
            created("r"),
            text_delta("Hello"),
            text_delta(" world"),
            completed(None),
        ])
        .await;
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": " world"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            ]
        );
    }

    #[tokio::test]
    async fn switches_content_blocks_between_reasoning_and_text() {
        let events = events_for(vec![
            created("r"),
            json!({"type": "response.reasoning_text.delta", "delta": "thinking..."}),
            text_delta("answer"),
            completed(None),
        ])
        .await;
        assert_eq!(
            types(&events),
            vec![
                "modelMessageStartEvent",
                "modelContentBlockStartEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockStopEvent",
                "modelContentBlockStartEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockStopEvent",
                "modelMessageStopEvent",
            ]
        );
        assert_eq!(
            events[2]["delta"],
            json!({"type": "reasoningContentDelta", "text": "thinking..."})
        );
    }

    #[tokio::test]
    async fn emits_tool_call_triplet_after_stream_close_and_sets_stop_reason_tool_use() {
        let events = events_for(vec![
            created("r"),
            json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "item_1", "call_id": "call_1", "name": "calc"}}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": "{\"a\":"}),
            json!({"type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": "1}"}),
            json!({"type": "response.function_call_arguments.done", "item_id": "item_1", "arguments": "{\"a\":1}"}),
            completed(None),
        ])
        .await;
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "calc", "toolUseId": "call_1"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "{\"a\":1}"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "toolUse"}),
            ]
        );
    }

    #[tokio::test]
    async fn skips_a_function_call_without_an_item_id() {
        let (logs, _guard) = record_logs();
        let events = events_for(vec![
            created("r"),
            json!({"type": "response.output_item.added", "item": {"type": "function_call", "call_id": "call_1", "name": "calc"}}),
            completed(None),
        ])
        .await;
        assert_eq!(types(&events), vec!["modelMessageStartEvent", "modelMessageStopEvent"]);
        assert!(
            logs.text()
                .contains("call_id=<call_1> name=<calc> | function_call event missing item id — skipping"),
            "{}",
            logs.text()
        );
    }

    #[tokio::test]
    async fn maps_response_incomplete_with_max_output_tokens_to_stop_reason_max_tokens() {
        let events = events_for(vec![
            created("r"),
            text_delta("partial"),
            json!({"type": "response.incomplete", "response": {
                "incomplete_details": {"reason": "max_output_tokens"},
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
            }}),
        ])
        .await;
        assert_eq!(events.last().unwrap()["stopReason"], "maxTokens");
        let metadata = events
            .iter()
            .find(|event| event["type"] == "modelMetadataEvent")
            .unwrap();
        assert_eq!(
            metadata["usage"],
            json!({"inputTokens": 10, "outputTokens": 5, "totalTokens": 15})
        );
    }

    #[tokio::test]
    async fn maps_response_incomplete_with_content_filter_to_stop_reason_content_filtered() {
        let events = events_for(vec![
            created("r"),
            text_delta("partial"),
            json!({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "content_filter"}}}),
        ])
        .await;
        assert_eq!(
            events,
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent"}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "partial"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": "contentFiltered"}),
            ]
        );
    }

    mod when_a_function_call_is_in_flight_at_response_incomplete {
        use super::*;

        fn truncated_call(reason: &str) -> Arc<MockClient> {
            MockClient::replying(vec![
                created("r"),
                json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "item_1", "call_id": "call_1", "name": "write_file"}}),
                json!({"type": "response.function_call_arguments.delta", "item_id": "item_1", "delta": "{\"path\": \"notes.md\", \"content\": \"Lorem"}),
                json!({"type": "response.incomplete", "response": {"incomplete_details": {"reason": reason}}}),
            ])
        }

        fn tool_call_events(stop_reason: &str) -> Vec<JsonValue> {
            vec![
                json!({"type": "modelMessageStartEvent", "role": "assistant"}),
                json!({"type": "modelContentBlockStartEvent", "start": {"type": "toolUseStart", "name": "write_file", "toolUseId": "call_1"}}),
                json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "toolUseInputDelta", "input": "{\"path\": \"notes.md\", \"content\": \"Lorem"}}),
                json!({"type": "modelContentBlockStopEvent"}),
                json!({"type": "modelMessageStopEvent", "stopReason": stop_reason}),
            ]
        }

        #[tokio::test]
        async fn reports_max_tokens_instead_of_tool_use_for_max_output_tokens() {
            let events = collect(&responses_model(&truncated_call("max_output_tokens")), x())
                .await
                .unwrap();
            assert_eq!(events, tool_call_events("maxTokens"));
        }

        #[tokio::test]
        async fn throws_max_tokens_error_from_stream_aggregated_for_max_output_tokens() {
            let error = aggregate(&responses_model(&truncated_call("max_output_tokens")), x())
                .await
                .unwrap_err();
            assert!(matches!(error, Error::MaxTokens(_)), "{error:?}");
        }

        #[tokio::test]
        async fn keeps_tool_use_for_content_filter() {
            let events = collect(&responses_model(&truncated_call("content_filter")), x())
                .await
                .unwrap();
            assert_eq!(events, tool_call_events("toolUse"));
        }
    }

    async fn usage_of(usage: JsonValue) -> JsonValue {
        let events = events_for(vec![created("r"), text_delta("hi"), completed(Some(usage))]).await;
        events
            .iter()
            .find(|event| event["type"] == "modelMetadataEvent")
            .unwrap()["usage"]
            .clone()
    }

    #[tokio::test]
    async fn plumbs_prompt_cache_reads_into_cache_read_input_tokens() {
        let usage = usage_of(json!({
            "input_tokens": 1553, "output_tokens": 42, "total_tokens": 1595,
            "input_tokens_details": {"cached_tokens": 873}
        }))
        .await;
        assert_eq!(
            usage,
            json!({"inputTokens": 1553, "outputTokens": 42, "totalTokens": 1595, "cacheReadInputTokens": 873})
        );
    }

    #[tokio::test]
    async fn omits_cache_read_input_tokens_when_there_is_no_cache_hit() {
        let usage = usage_of(json!({
            "input_tokens": 1553, "output_tokens": 42, "total_tokens": 1595,
            "input_tokens_details": {"cached_tokens": 0}
        }))
        .await;
        assert_eq!(
            usage,
            json!({"inputTokens": 1553, "outputTokens": 42, "totalTokens": 1595})
        );
    }

    #[tokio::test]
    async fn plumbs_prompt_cache_writes_into_cache_write_input_tokens() {
        let usage = usage_of(json!({
            "input_tokens": 1553, "output_tokens": 42, "total_tokens": 1595,
            "input_tokens_details": {"cached_tokens": 873, "cache_write_tokens": 40}
        }))
        .await;
        assert_eq!(
            usage,
            json!({
                "inputTokens": 1553, "outputTokens": 42, "totalTokens": 1595,
                "cacheReadInputTokens": 873, "cacheWriteInputTokens": 40
            })
        );
    }

    #[tokio::test]
    async fn omits_cache_write_input_tokens_when_cache_write_tokens_is_0_or_absent() {
        let usage = usage_of(json!({
            "input_tokens": 1553, "output_tokens": 42, "total_tokens": 1595,
            "input_tokens_details": {"cached_tokens": 873, "cache_write_tokens": 0}
        }))
        .await;
        assert_eq!(
            usage,
            json!({"inputTokens": 1553, "outputTokens": 42, "totalTokens": 1595, "cacheReadInputTokens": 873})
        );
    }

    #[tokio::test]
    async fn emits_url_citation_delta_from_response_output_text_annotation_added() {
        let events = events_for(vec![
            created("r"),
            text_delta("The answer is here."),
            citation("https://example.com", "Example", "here"),
            completed(None),
        ])
        .await;
        let delta = events
            .iter()
            .find(|event| event["delta"]["type"] == "citationsDelta")
            .unwrap();
        assert_eq!(
            delta["delta"],
            json!({
                "type": "citationsDelta",
                "citations": [{
                    "location": {"type": "web", "url": "https://example.com"},
                    "source": "https://example.com",
                    "sourceContent": [],
                    "title": "Example"
                }],
                "content": [{"text": "here"}]
            })
        );
    }

    #[tokio::test]
    async fn closes_the_text_block_before_a_citation_producing_separate_blocks_when_stream_ends_after_citation() {
        let events = events_for(vec![
            created("r"),
            text_delta("Before citation"),
            citation("https://example.com", "Source", "cited"),
            completed(None),
        ])
        .await;
        assert_eq!(
            types(&events),
            vec![
                "modelMessageStartEvent",
                "modelContentBlockStartEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockStopEvent",
                "modelContentBlockStartEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockStopEvent",
                "modelMessageStopEvent",
            ]
        );
    }

    fn delta_types(events: &[JsonValue]) -> Vec<&str> {
        events
            .iter()
            .filter(|event| event["type"] == "modelContentBlockDeltaEvent")
            .map(|event| event["delta"]["type"].as_str().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn closes_the_text_block_before_a_citation_and_opens_a_new_text_block_after() {
        let events = events_for(vec![
            created("r"),
            text_delta("Before "),
            citation("https://example.com", "Source", "cited"),
            text_delta(" after"),
            completed(None),
        ])
        .await;
        assert_eq!(delta_types(&events), vec!["textDelta", "citationsDelta", "textDelta"]);
        assert_eq!(
            types(&events)
                .iter()
                .filter(|kind| **kind == "modelContentBlockStartEvent")
                .count(),
            3
        );
    }

    #[tokio::test]
    async fn keeps_consecutive_citations_in_the_same_block_without_extra_stop_start() {
        let events = events_for(vec![
            created("r"),
            citation("https://a.com", "A", "a"),
            citation("https://b.com", "B", "b"),
            completed(None),
        ])
        .await;
        assert_eq!(
            types(&events),
            vec![
                "modelMessageStartEvent",
                "modelContentBlockStartEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockDeltaEvent",
                "modelContentBlockStopEvent",
                "modelMessageStopEvent",
            ]
        );
    }

    #[tokio::test]
    async fn handles_text_citation_text_citation_text_with_separate_blocks_each_time() {
        let events = events_for(vec![
            created("r"),
            text_delta("intro "),
            citation("https://1.com", "1", "c1"),
            text_delta("middle "),
            citation("https://2.com", "2", "c2"),
            text_delta("end"),
            completed(None),
        ])
        .await;
        assert_eq!(
            delta_types(&events),
            vec![
                "textDelta",
                "citationsDelta",
                "textDelta",
                "citationsDelta",
                "textDelta"
            ]
        );
        let kinds = types(&events);
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == "modelContentBlockStartEvent")
                .count(),
            5
        );
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == "modelContentBlockStopEvent")
                .count(),
            5
        );
    }

    #[tokio::test]
    async fn warns_about_unsupported_annotation_types() {
        let (logs, _guard) = record_logs();
        let events = events_for(vec![
            created("r"),
            json!({"type": "response.output_text.annotation.added", "annotation": {"type": "file_citation"}}),
            completed(None),
        ])
        .await;
        assert_eq!(types(&events), vec!["modelMessageStartEvent", "modelMessageStopEvent"]);
        assert!(
            logs.text()
                .contains("annotation_type=<file_citation> | unsupported annotation type in responses api"),
            "{}",
            logs.text()
        );
    }
}

mod error_mapping {
    use super::*;

    #[tokio::test]
    async fn throws_response_failed_instead_of_finalizing_an_empty_successful_response() {
        let client = MockClient::replying(vec![
            created("r"),
            json!({"type": "response.failed", "response": {"error": {
                "code": "server_error", "message": "The model failed while processing the request."
            }}}),
        ]);
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::Model(_)), "{error:?}");
        assert_eq!(error.to_string(), "The model failed while processing the request.");
        let source = std::error::Error::source(&error)
            .unwrap()
            .downcast_ref::<super::super::super::responses::ResponsesStreamError>()
            .unwrap();
        assert_eq!(source.code.as_deref(), Some("server_error"));
    }

    #[tokio::test]
    async fn wraps_a_response_failed_context_limit_as_context_window_overflow_error() {
        let client = MockClient::replying(vec![json!({"type": "response.failed", "response": {"error": {
            "code": "invalid_prompt",
            "message": "prompt tokens (320666) exceed customer model maximum (278528) for model-id"
        }}})]);
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    }

    #[tokio::test]
    async fn throws_the_fallback_message_when_response_failed_has_no_error_details() {
        let client = MockClient::replying(vec![json!({"type": "response.failed", "response": {"error": null}})]);
        let error = collect_error(&responses_model(&client), x()).await;
        assert_eq!(error.to_string(), "OpenAI Responses API response failed");
    }

    #[tokio::test]
    async fn maps_a_responses_error_event_through_the_existing_error_classifier() {
        let client = MockClient::replying(vec![json!({
            "type": "error", "code": "rate_limit_exceeded", "message": "Rate limit exceeded while streaming."
        })]);
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    }

    #[tokio::test]
    async fn wraps_429_as_model_throttled_error() {
        let client = MockClient::failing(Vec::new(), || status_error(429, "Too many requests", None));
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    }

    #[tokio::test]
    async fn wraps_context_length_exceeded_as_context_window_overflow_error() {
        let client = MockClient::failing(Vec::new(), || {
            status_error(
                400,
                "This model has a maximum context length of 8k.",
                Some("context_length_exceeded"),
            )
        });
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    }

    #[tokio::test]
    async fn rethrows_unknown_errors_untouched() {
        let client = MockClient::failing(Vec::new(), || status_error(500, "some other failure", None));
        let error = collect_error(&responses_model(&client), x()).await;
        assert!(matches!(error, Error::Model(_)), "{error:?}");
        assert_eq!(error.to_string(), "500 some other failure");
    }
}
