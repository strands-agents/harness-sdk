//! Request formatting tests.

use serde_json::json;

use super::*;
use crate::models::streaming::Usage;
use crate::types::{
    CachePointBlock, DocumentBlock, DocumentFormat, DocumentSource, GuardContentBlock, GuardContentText,
    GuardQualifier, ImageBlock, ImageFormat, ImageSource, InjectedBlock, JsonBlock, MessageMetadata, ReasoningBlock,
    Role, S3Location, SystemContentBlock, SystemPrompt, ToolResultBlock, ToolResultContent, ToolResultStatus,
    UnknownBlock, VideoBlock, VideoFormat, VideoSource,
};

async fn send(config: AnthropicModelConfig, request: ModelRequest) -> Arc<MockClient> {
    let client = MockClient::capture();
    collect(&model(&client, config), request).await.unwrap();
    client
}

async fn send_messages(messages: Vec<Message>) -> JsonValue {
    send(AnthropicModelConfig::default(), super::request(messages))
        .await
        .last()
}

fn user(content: Vec<ContentBlock>) -> Message {
    Message::new(Role::User, content)
}

fn tool_result(status: ToolResultStatus, content: Vec<ToolResultContent>) -> ContentBlock {
    ContentBlock::ToolResult(ToolResultBlock::new("t1", status, content))
}

fn png(bytes: &[u8]) -> ImageBlock {
    ImageBlock::new(ImageFormat::Png, ImageSource::Bytes(bytes.to_vec()))
}

#[tokio::test]
async fn formats_basic_request_correctly() {
    let config = config()
        .model_id("claude-3-opus")
        .max_tokens(1000)
        .temperature(0.7)
        .build();
    let client = send(config, request(vec![Message::user("Hello")])).await;
    assert_eq!(
        client.last(),
        json!({
            "model": "claude-3-opus",
            "max_tokens": 1000,
            "temperature": 0.7,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello"}]}],
            "stream": true
        })
    );
}

#[tokio::test]
async fn never_sends_the_durable_message_id_to_the_provider() {
    let message = Message::user("Hello")
        .with_tracking_id("durable-1")
        .with_metadata(MessageMetadata::new().with_usage(Usage::new(1, 1, 2)));
    let sent = send_messages(vec![message]).await;
    assert_eq!(
        sent["messages"],
        json!([{"role": "user", "content": [{"type": "text", "text": "Hello"}]}])
    );
}

#[tokio::test]
async fn formats_tools_correctly() {
    let spec = ToolSpec::new("calc", "calculate").with_input_schema(json!({"type": "object", "properties": {}}));
    let request = ModelRequest {
        tool_specs: vec![spec],
        tool_choice: Some(ToolChoice::Auto),
        ..hi()
    };
    let sent = send(AnthropicModelConfig::default(), request).await.last();
    assert_eq!(
        sent["tools"],
        json!([{"name": "calc", "description": "calculate", "input_schema": {"type": "object", "properties": {}}}])
    );
    assert_eq!(sent["tool_choice"], json!({"type": "auto"}));
}

#[tokio::test]
async fn formats_a_signature_only_reasoning_block() {
    let message = Message::new(
        Role::Assistant,
        vec![
            ReasoningBlock::new().with_signature("sig-abc").into(),
            ContentBlock::text("answer"),
        ],
    );
    let sent = send_messages(vec![message]).await;
    assert_eq!(
        sent["messages"][0]["content"],
        json!([{"type": "thinking", "thinking": "", "signature": "sig-abc"}, {"type": "text", "text": "answer"}])
    );
}

#[tokio::test]
async fn skips_unknown_blocks() {
    let unknown = UnknownBlock::new(json!({"futureBlock": {"value": 1}}).as_object().unwrap().clone());
    let sent = send_messages(vec![user(vec![
        ContentBlock::text("Hello"),
        ContentBlock::Unknown(unknown),
    ])])
    .await;
    assert_eq!(
        sent["messages"],
        json!([{"role": "user", "content": [{"type": "text", "text": "Hello"}]}])
    );
}

mod prompt_caching_lookahead_logic {
    use super::*;

    #[tokio::test]
    async fn attaches_cache_control_to_message_content_block_followed_by_cache_point() {
        let sent = send_messages(vec![user(vec![
            ContentBlock::text("Cached content"),
            CachePointBlock::new().into(),
            ContentBlock::text("Non-cached content"),
        ])])
        .await;
        assert_eq!(
            sent["messages"][0]["content"],
            json!([
                {"type": "text", "text": "Cached content", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "Non-cached content"}
            ])
        );
    }

    #[tokio::test]
    async fn formats_system_prompt_string_without_cache() {
        let request = ModelRequest {
            system_prompt: Some("System instruction".into()),
            ..hi()
        };
        let sent = send(AnthropicModelConfig::default(), request).await.last();
        assert_eq!(sent["system"], "System instruction");
    }

    #[tokio::test]
    async fn formats_system_prompt_array_with_cache_points() {
        let request = ModelRequest {
            system_prompt: Some(SystemPrompt::Blocks(vec![
                SystemContentBlock::text("Heavy context"),
                CachePointBlock::new().into(),
                SystemContentBlock::text("Light context"),
            ])),
            ..hi()
        };
        let sent = send(AnthropicModelConfig::default(), request).await.last();
        assert_eq!(
            sent["system"],
            json!([
                {"type": "text", "text": "Heavy context", "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": "Light context"}
            ])
        );
    }
}

mod media_blocks {
    use super::*;

    async fn rejected(content: Vec<ContentBlock>) -> String {
        let client = MockClient::capture();
        collect(
            &model(&client, AnthropicModelConfig::default()),
            request(vec![user(content)]),
        )
        .await
        .unwrap_err()
        .to_string()
    }

    #[tokio::test]
    async fn formats_images_correctly() {
        let sent = send_messages(vec![user(vec![png(b"Hello").into()])]).await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "SGVsbG8="}})
        );
    }

    // Guards against https://github.com/strands-agents/harness-sdk/issues/3791.
    #[tokio::test]
    async fn formats_url_source_images_as_anthropic_url_sources() {
        let image = ImageBlock::new(
            ImageFormat::Png,
            ImageSource::Url("https://example.com/image.png".to_owned()),
        );
        let sent = send_messages(vec![user(vec![image.into()])]).await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({"type": "image", "source": {"type": "url", "url": "https://example.com/image.png"}})
        );
    }

    #[tokio::test]
    async fn formats_jpeg_gif_and_webp_media_types() {
        for (format, media_type) in [
            (ImageFormat::Jpeg, "image/jpeg"),
            (ImageFormat::Jpg, "image/jpeg"),
            (ImageFormat::Gif, "image/gif"),
            (ImageFormat::Webp, "image/webp"),
        ] {
            let image = ImageBlock::new(format, ImageSource::Bytes(vec![1]));
            let sent = send_messages(vec![user(vec![image.into()])]).await;
            assert_eq!(sent["messages"][0]["content"][0]["source"]["media_type"], media_type);
        }
    }

    #[tokio::test]
    async fn formats_pdfs_correctly() {
        let pdf = DocumentBlock::new("doc.pdf", DocumentFormat::Pdf, DocumentSource::Bytes(vec![1, 2, 3]));
        let sent = send_messages(vec![user(vec![pdf.into()])]).await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "AQID"}, "title": "doc.pdf"})
        );
    }

    // Guards against https://github.com/strands-agents/harness-sdk/issues/3785.
    #[tokio::test]
    async fn throws_for_a_document_format_with_no_anthropic_mapping() {
        let docx = DocumentBlock::new("report", DocumentFormat::Docx, DocumentSource::Bytes(vec![1, 2, 3]));
        assert_eq!(
            rejected(vec![docx.into()]).await,
            "Unsupported document format or source for Anthropic: format=docx, source=documentSourceBytes"
        );
    }

    #[tokio::test]
    async fn throws_for_a_supported_document_format_with_an_unsupported_source() {
        let pdf = DocumentBlock::new(
            "doc.pdf",
            DocumentFormat::Pdf,
            DocumentSource::Text("not deliverable as a pdf".to_owned()),
        );
        assert_eq!(
            rejected(vec![pdf.into()]).await,
            "Unsupported document format or source for Anthropic: format=pdf, source=documentSourceText"
        );
    }

    #[tokio::test]
    async fn throws_for_a_document_with_a_content_block_source() {
        let notes = DocumentBlock::new(
            "notes",
            DocumentFormat::Txt,
            DocumentSource::Content(vec![crate::types::TextBlock::new("inline content")]),
        );
        assert_eq!(
            rejected(vec![notes.into()]).await,
            "Unsupported document format or source for Anthropic: format=txt, source=documentSourceContentBlock"
        );
    }

    #[tokio::test]
    async fn throws_for_an_undeliverable_document_nested_in_a_tool_result() {
        let docx = DocumentBlock::new("report", DocumentFormat::Docx, DocumentSource::Bytes(vec![1, 2, 3]));
        assert_eq!(
            rejected(vec![tool_result(
                ToolResultStatus::Success,
                vec![ToolResultContent::Document(docx)]
            )])
            .await,
            "Unsupported document format or source for Anthropic: format=docx, source=documentSourceBytes"
        );
    }

    #[tokio::test]
    async fn sends_text_documents_as_text() {
        let csv = DocumentBlock::new("data.csv", DocumentFormat::Csv, DocumentSource::Bytes(b"a,b".to_vec()));
        let sent = send_messages(vec![user(vec![csv.into()])]).await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({"type": "text", "text": "a,b"})
        );
    }

    #[tokio::test]
    async fn logs_warning_for_unsupported_guard_content_block_in_user_message() {
        let guard = GuardContentBlock::Text(GuardContentText::new(vec![GuardQualifier::Query], "guard"));
        let sent = send_messages(vec![user(vec![ContentBlock::GuardContent(guard)])]).await;
        assert_eq!(sent["messages"], json!([]));
    }

    #[tokio::test]
    async fn skips_s3_image_sources_with_a_warning() {
        let (logs, _guard) = record_logs();
        let image = ImageBlock::new(
            ImageFormat::Png,
            ImageSource::Location(S3Location::new("s3://bucket/a.png")),
        );
        let sent = send_messages(vec![user(vec![ContentBlock::text("x"), image.into()])]).await;
        assert_eq!(sent["messages"][0]["content"], json!([{"type": "text", "text": "x"}]));
        assert!(
            logs.text()
                .contains("s3 location sources are not supported by anthropic")
        );
    }
}

mod tool_results {
    use super::*;

    #[tokio::test]
    async fn sends_an_offloaded_block_as_the_text_the_model_receives_at_top_level_and_inside_a_tool_result() {
        let placeholder = crate::types::TextBlock::offloaded(
            "[Dropped] [ref: tu-1]",
            crate::types::Offloaded::new(crate::types::OffloadMethod::Drop).with_reference("tu-1"),
        );
        let sent = send_messages(vec![user(vec![
            ContentBlock::Text(placeholder.clone()),
            tool_result(ToolResultStatus::Success, vec![ToolResultContent::Text(placeholder)]),
        ])])
        .await;
        assert_eq!(
            sent["messages"][0]["content"],
            json!([
                {"type": "text", "text": "[Dropped] [ref: tu-1]"},
                {"type": "tool_result", "tool_use_id": "t1", "is_error": false, "content": "[Dropped] [ref: tu-1]"}
            ])
        );
    }

    #[tokio::test]
    async fn formats_simple_text_tool_result() {
        let sent = send_messages(vec![user(vec![tool_result(
            ToolResultStatus::Success,
            vec![ToolResultContent::text("42")],
        )])])
        .await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({"type": "tool_result", "tool_use_id": "t1", "content": "42", "is_error": false})
        );
    }

    #[tokio::test]
    async fn formats_mixed_tool_result_json_image() {
        let sent = send_messages(vec![user(vec![tool_result(
            ToolResultStatus::Error,
            vec![
                ToolResultContent::Json(JsonBlock::new(json!({"error": "failed"}))),
                ToolResultContent::text("Details here"),
            ],
        )])])
        .await;
        assert_eq!(
            sent["messages"][0]["content"][0],
            json!({
                "type": "tool_result",
                "tool_use_id": "t1",
                "content": [{"type": "text", "text": "{\"error\":\"failed\"}"}, {"type": "text", "text": "Details here"}],
                "is_error": true
            })
        );
    }

    #[tokio::test]
    async fn formats_image_block_inside_tool_result_via_recursive_formatting() {
        let sent = send_messages(vec![user(vec![tool_result(
            ToolResultStatus::Success,
            vec![
                ToolResultContent::text("Here is the screenshot"),
                ToolResultContent::Image(png(b"Hello")),
            ],
        )])])
        .await;
        assert_eq!(
            sent["messages"][0]["content"][0]["content"],
            json!([
                {"type": "text", "text": "Here is the screenshot"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "SGVsbG8="}}
            ])
        );
    }

    #[tokio::test]
    async fn formats_document_block_inside_tool_result_as_text_for_text_formats() {
        let document = DocumentBlock::new(
            "data.json",
            DocumentFormat::Json,
            DocumentSource::Text("{\"key\":\"val\"}".to_owned()),
        );
        let sent = send_messages(vec![user(vec![tool_result(
            ToolResultStatus::Success,
            vec![ToolResultContent::Document(document)],
        )])])
        .await;
        assert_eq!(sent["messages"][0]["content"][0]["content"], "{\"key\":\"val\"}");
    }

    #[tokio::test]
    async fn skips_video_block_inside_tool_result_with_warning() {
        let (logs, _guard) = record_logs();
        let video = VideoBlock::new(VideoFormat::Mp4, VideoSource::Bytes(vec![1]));
        let sent = send_messages(vec![user(vec![tool_result(
            ToolResultStatus::Success,
            vec![ToolResultContent::text("result"), ToolResultContent::Video(video)],
        )])])
        .await;
        assert_eq!(sent["messages"][0]["content"][0]["content"], "result");
        assert!(logs.text().contains("video blocks not supported by anthropic"));
    }
}

mod injected_blocks {
    use super::*;

    fn injected(text: &str) -> ContentBlock {
        ContentBlock::Injected(InjectedBlock::new(text, "test"))
    }

    fn turn_scoped(texts: &[&str]) -> JsonValue {
        let content: Vec<JsonValue> = texts.iter().map(|text| json!({"type": "text", "text": text})).collect();
        json!({"role": "system", "content": content, "clear_at": "next_user_message"})
    }

    #[tokio::test]
    async fn sends_each_user_message_its_injected_text_as_a_turn_scoped_system_message_after_it() {
        let config = config()
            .model_id("claude-opus-5-5")
            .betas(vec!["interleaved-thinking-2025-05-14".to_owned()])
            .cache_config(CacheConfig::default())
            .build();
        let messages = vec![
            user(vec![ContentBlock::text("first"), injected("one")]),
            Message::assistant("ok"),
            user(vec![ContentBlock::text("second"), injected("two"), injected("three")]),
        ];
        let client = send(config, request(messages)).await;
        assert_eq!(
            client.last()["messages"],
            json!([
                {"role": "user", "content": [{"type": "text", "text": "first"}]},
                turn_scoped(&["one"]),
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}]},
                {"role": "user", "content": [{"type": "text", "text": "second", "cache_control": {"type": "ephemeral"}}]},
                turn_scoped(&["two", "three"])
            ])
        );
        assert_eq!(
            client.last_beta().as_deref(),
            Some("interleaved-thinking-2025-05-14,mid-conversation-system-clear-at-2026-08-21")
        );
    }

    #[tokio::test]
    async fn leaves_out_the_system_message_of_a_user_message_followed_directly_by_another() {
        let messages = vec![
            user(vec![ContentBlock::text("first"), injected("one")]),
            user(vec![ContentBlock::text("second"), injected("two")]),
        ];
        let client = send(config().model_id("claude-opus-5-5").build(), request(messages)).await;
        assert_eq!(
            client.last()["messages"],
            json!([
                {"role": "user", "content": [{"type": "text", "text": "first"}]},
                {"role": "user", "content": [{"type": "text", "text": "second"}]},
                turn_scoped(&["two"])
            ])
        );
    }

    #[tokio::test]
    async fn sends_no_injected_text_and_no_beta_to_a_model_without_temporary_messages() {
        let messages = vec![user(vec![ContentBlock::text("first"), injected("one")])];
        let client = send(config().model_id("claude-sonnet-4-6").build(), request(messages)).await;
        assert_eq!(
            client.last()["messages"],
            json!([{"role": "user", "content": [{"type": "text", "text": "first"}]}])
        );
        assert_eq!(client.last_beta(), None);
    }

    #[tokio::test]
    async fn leaves_cleared_injected_blocks_out_of_the_token_estimate() {
        let provider = model(&MockClient::capture(), config().model_id("claude-opus-5-5").build());
        let conversation = |first: Message| {
            vec![
                first,
                Message::assistant("ok"),
                user(vec![ContentBlock::text("second"), injected("two")]),
            ]
        };
        let with_earlier = conversation(user(vec![ContentBlock::text("first"), injected(&"x".repeat(400))]));
        let without_earlier = conversation(Message::user("first"));
        assert_eq!(
            provider
                .count_tokens(&with_earlier, CountTokensOptions::default())
                .await
                .unwrap(),
            provider
                .count_tokens(&without_earlier, CountTokensOptions::default())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn counts_the_system_message_natively_with_the_beta() {
        let client = MockClient::counting(|| Ok(json!({"input_tokens": 9})));
        let provider = model(
            &client,
            config()
                .model_id("claude-opus-5-5")
                .use_native_token_count(true)
                .build(),
        );
        let messages = vec![user(vec![ContentBlock::text("first"), injected("one")])];

        assert_eq!(
            provider
                .count_tokens(&messages, CountTokensOptions::default())
                .await
                .unwrap(),
            9
        );
        assert_eq!(
            client.count_requests()[0],
            ClientRequest {
                body: json!({
                    "model": "claude-opus-5-5",
                    "messages": [{"role": "user", "content": [{"type": "text", "text": "first"}]}, turn_scoped(&["one"])]
                }),
                beta: Some("mid-conversation-system-clear-at-2026-08-21".to_owned())
            }
        );
    }
}

mod beta_headers {
    use super::*;

    #[tokio::test]
    async fn does_not_pass_per_request_options_when_betas_is_unset() {
        let client = send(AnthropicModelConfig::default(), hi()).await;
        assert_eq!(client.last_beta(), None);
    }

    #[tokio::test]
    async fn forwards_configured_betas_as_a_per_request_anthropic_beta_header() {
        let betas = vec![
            "interleaved-thinking-2025-05-14".to_owned(),
            "mcp-client-2025-11-20".to_owned(),
        ];
        let client = send(config().betas(betas).build(), hi()).await;
        assert_eq!(
            client.last_beta().as_deref(),
            Some("interleaved-thinking-2025-05-14,mcp-client-2025-11-20")
        );
    }

    #[tokio::test]
    async fn reflects_update_config_betas_on_the_next_request() {
        let client = MockClient::capture();
        let provider = model(&client, AnthropicModelConfig::default());
        collect(&provider, hi()).await.unwrap();
        assert_eq!(client.last_beta(), None);

        provider
            .update_config(
                config()
                    .betas(vec!["interleaved-thinking-2025-05-14".to_owned()])
                    .build(),
            )
            .unwrap();
        collect(&provider, hi()).await.unwrap();

        assert_eq!(client.last_beta().as_deref(), Some("interleaved-thinking-2025-05-14"));
    }
}
