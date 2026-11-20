//! Server-side summary tests. The client-side fallback runs for real against the mock's stream.

use serde_json::json;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::types::Role;

fn stored_compaction(text: &str, signature: &str) -> ContentBlock {
    SummaryBlock::new(text)
        .with_provider("anthropic")
        .with_signature(signature)
        .into()
}

/// The events of a compaction response with `content` and `stop_reason`.
fn compaction_response(stop_reason: &str, content: Vec<JsonValue>, usage: &JsonValue) -> Events {
    let mut events =
        vec![json!({"type": "message_start", "message": {"role": "assistant", "content": [], "usage": usage}})];
    for (index, block) in content.into_iter().enumerate() {
        events.push(json!({"type": "content_block_start", "index": index, "content_block": block}));
        events.push(json!({"type": "content_block_stop", "index": index}));
    }
    events.push(json!({"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": usage["output_tokens"]}}));
    events.push(json!({"type": "message_stop"}));
    events.into_iter().map(Ok).collect()
}

/// A client-side summary reply, as the base implementation's stream sees it.
fn client_side_reply() -> Events {
    let [delta, stop] = message_end("end_turn", 5);
    [
        message_start(10),
        json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": "client-side"}}),
        json!({"type": "content_block_stop", "index": 0}),
        delta,
        stop,
    ]
    .into_iter()
    .map(Ok)
    .collect()
}

fn compaction_client(responses: Vec<Events>) -> Arc<MockClient> {
    MockClient::with_beta(|_| client_side_reply(), responses)
}

fn compaction_model(client: &Arc<MockClient>) -> AnthropicModel {
    model(
        client,
        config()
            .model_id("claude-sonnet-5-5")
            .max_tokens(1)
            .stop_sequences(vec!["STOP".to_owned()])
            .build(),
    )
}

fn hi_messages() -> Vec<Message> {
    vec![Message::user("hi")]
}

fn compaction_usage() -> JsonValue {
    json!({"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 5})
}

fn formatted_compaction_usage() -> Usage {
    Usage::new(100, 20, 155)
        .with_cache_read_input_tokens(30)
        .with_cache_write_input_tokens(5)
}

fn client_side_summary() -> Vec<ContentBlock> {
    vec![SummaryBlock::new("client-side").into()]
}

#[tokio::test]
async fn sends_a_compaction_request_and_returns_the_summary_block() {
    let client = compaction_client(vec![compaction_response(
        "compaction",
        vec![json!({"type": "compaction", "content": "the summary", "signature": "s1"})],
        &json!({}),
    )]);
    let provider = compaction_model(&client);
    provider
        .update_config(config().params(json!({"context_management": {"edits": []}})).build())
        .unwrap();
    let options = SummarizeOptions {
        system_prompt: Some("sys".into()),
        tool_specs: vec![ToolSpec::new("read", "Read a file").with_input_schema(json!({"type": "object"}))],
        instructions: Some("keep ids".to_owned()),
        ..Default::default()
    };
    let messages = vec![Message::user("hi"), Message::assistant("yo")];

    let result = provider.summarize(messages, options).await.unwrap();

    assert_eq!(
        client.last(),
        json!({
            "model": "claude-sonnet-5-5",
            "max_tokens": 1,
            "stream": true,
            "system": "sys",
            "tools": [{"name": "read", "description": "Read a file", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "yo"}]}
            ],
            "compaction": {"type": "summarize", "instructions": "keep ids"}
        })
    );
    assert_eq!(client.last_beta().as_deref(), Some("compact-2026-09-04"));
    assert_eq!(result.content, [stored_compaction("the summary", "s1")]);
}

#[tokio::test]
async fn maps_a_context_overflow_from_the_compaction_request_like_stream() {
    let client = compaction_client(vec![vec![Err(HttpError::decode(
        "prompt is too long: 300000 tokens",
        "prompt is too long: 300000 tokens",
    ))]]);

    let error = compaction_model(&client)
        .summarize(hi_messages(), SummarizeOptions::default())
        .await
        .unwrap_err();

    assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
}

#[tokio::test]
async fn returns_the_compaction_usage() {
    let client = compaction_client(vec![compaction_response(
        "compaction",
        vec![json!({"type": "compaction", "content": "the summary"})],
        &compaction_usage(),
    )]);

    let result = compaction_model(&client)
        .summarize(hi_messages(), SummarizeOptions::default())
        .await
        .unwrap();

    assert_eq!(
        result,
        SummarizeResult::new(vec![SummaryBlock::new("the summary").with_provider("anthropic").into()])
            .with_usage(formatted_compaction_usage())
    );
}

#[tokio::test]
async fn counts_the_compaction_iterations_usage() {
    let mut usage =
        json!({"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0});
    let mut iteration = compaction_usage();
    iteration["type"] = json!("compaction");
    usage["iterations"] = json!([iteration]);
    let client = compaction_client(vec![compaction_response(
        "compaction",
        vec![json!({"type": "compaction", "content": "the summary"})],
        &usage,
    )]);

    let result = compaction_model(&client)
        .summarize(hi_messages(), SummarizeOptions::default())
        .await
        .unwrap();

    assert_eq!(result.usage, Some(formatted_compaction_usage()));
}

#[tokio::test]
async fn uses_the_base_implementation_without_a_compaction_block() {
    for content in [vec![], vec![json!({"type": "text", "text": "x"})]] {
        let client = compaction_client(vec![compaction_response("end_turn", content, &compaction_usage())]);
        let options = SummarizeOptions {
            instructions: Some("keep ids".to_owned()),
            ..Default::default()
        };

        let result = compaction_model(&client)
            .summarize(hi_messages(), options)
            .await
            .unwrap();

        assert_eq!(client.calls(), 2);
        assert_eq!(result.content, client_side_summary());
        assert_eq!(
            result.usage,
            Some(
                Usage::new(110, 25, 170)
                    .with_cache_read_input_tokens(30)
                    .with_cache_write_input_tokens(5)
            )
        );
    }
}

#[tokio::test]
async fn uses_the_base_implementation_when_compaction_fails() {
    let failures: [fn() -> HttpError; 4] = [
        || api_error(400, "does not support the compaction strategy"),
        || api_error(529, "overloaded"),
        HttpError::timeout,
        || HttpError::connection("connection"),
    ];
    for failure in failures {
        let (logs, _guard) = record_logs();
        let client = compaction_client(vec![vec![Err(failure())]]);

        let result = compaction_model(&client)
            .summarize(hi_messages(), SummarizeOptions::default())
            .await
            .unwrap();

        assert_eq!(result.content, client_side_summary());
        assert!(
            logs.text()
                .contains("compaction request failed | summarizing client-side")
        );
    }
}

#[tokio::test]
async fn sends_no_client_side_request_after_a_cancel_during_compaction() {
    let handle = CancelHandle::new();
    let cancel = handle.clone();
    let client = MockClient::with_beta(|_| client_side_reply(), Vec::new());
    let failing = Arc::new(CancellingClient {
        inner: client,
        handle: cancel,
    });
    let provider = AnthropicModel::from_parts(
        prepare_config(config().model_id("claude-sonnet-5-5").max_tokens(1).build()).unwrap(),
        Arc::clone(&failing) as Arc<dyn AnthropicClient>,
        Vec::new(),
        None,
    );
    let options = SummarizeOptions {
        cancel_signal: Some(handle.signal()),
        ..Default::default()
    };

    let result = provider.summarize(hi_messages(), options).await.unwrap();

    assert_eq!(result, SummarizeResult::new(Vec::new()).with_usage(Usage::default()));
    assert_eq!(failing.inner.calls(), 0);
}

/// Cancels during the compaction request, which then fails with a connection error.
struct CancellingClient {
    inner: Arc<MockClient>,
    handle: CancelHandle,
}

impl AnthropicClient for CancellingClient {
    fn stream(&self, request: ClientRequest) -> EventStream {
        self.inner.stream(request)
    }

    fn beta_stream(&self, _request: ClientRequest) -> Option<EventStream> {
        self.handle.cancel(CancelOptions::default());
        Some(Box::pin(futures::stream::iter(vec![Err(HttpError::connection(
            "aborted",
        ))])))
    }

    fn count_tokens(
        &self,
        request: ClientRequest,
    ) -> Option<BoxFuture<'static, std::result::Result<JsonValue, HttpError>>> {
        self.inner.count_tokens(request)
    }
}

#[tokio::test]
async fn throws_errors_other_than_an_api_error() {
    let client = compaction_client(vec![vec![Err(HttpError::decode("overloaded", "overloaded"))]]);

    let error = compaction_model(&client)
        .summarize(hi_messages(), SummarizeOptions::default())
        .await
        .unwrap_err();

    assert_eq!(error.to_string(), "overloaded");
    assert_eq!(client.calls(), 1);
}

#[tokio::test]
async fn uses_the_base_implementation_for_a_client_without_the_beta_messages_api() {
    let (logs, _guard) = record_logs();
    let client = MockClient::new(|_| client_side_reply());

    let result = compaction_model(&client)
        .summarize(hi_messages(), SummarizeOptions::default())
        .await
        .unwrap();

    assert_eq!(result.content, client_side_summary());
    assert!(logs.text().contains("client has no beta messages API"));
}

#[tokio::test]
async fn uses_the_base_implementation_without_the_capability() {
    let turned_off = ModelInfo {
        capabilities: ModelCapabilities {
            server_side_summary: Some(false),
            ..Default::default()
        },
        ..Default::default()
    };
    for config in [
        config().model_id("claude-sonnet-4-5").max_tokens(1).build(),
        config()
            .model_id("claude-sonnet-5-5")
            .max_tokens(1)
            .model_info(turned_off)
            .build(),
    ] {
        let client = compaction_client(Vec::new());
        let options = SummarizeOptions {
            system_prompt: Some("sys".into()),
            instructions: Some("keep ids".to_owned()),
            ..Default::default()
        };

        let result = model(&client, config).summarize(hi_messages(), options).await.unwrap();

        assert_eq!(result.content, client_side_summary());
        assert_eq!(client.calls(), 1);
        assert!(client.last().get("compaction").is_none());
    }
}

#[tokio::test]
async fn sends_messages_from_the_last_compaction_block() {
    let client = compaction_client(Vec::new());
    let messages = vec![
        Message::user("first"),
        Message::new(Role::Assistant, vec![stored_compaction("old", "sig")]),
        Message::user("more"),
        Message::new(
            Role::Assistant,
            vec![stored_compaction("new", "s2"), ContentBlock::text("after")],
        ),
        Message::user("next"),
    ];

    collect(&compaction_model(&client), request(messages)).await.unwrap();

    assert_eq!(
        client.last()["messages"],
        json!([
            {"role": "assistant", "content": [{"type": "compaction", "content": "new", "signature": "s2"}, {"type": "text", "text": "after"}]},
            {"role": "user", "content": [{"type": "text", "text": "next"}]}
        ])
    );
    assert_eq!(client.last_beta().as_deref(), Some("compact-2026-09-04"));
}

#[tokio::test]
async fn counts_tokens_from_the_last_compaction_block() {
    let client = MockClient::counting(|| Ok(json!({"input_tokens": 7})));
    let counting = model(
        &client,
        config()
            .model_id("claude-sonnet-5-5")
            .max_tokens(1)
            .use_native_token_count(true)
            .build(),
    );
    let messages = vec![
        Message::user("first ".repeat(500)),
        Message::new(Role::Assistant, vec![stored_compaction("new", "s2")]),
        Message::user("next"),
    ];

    assert_eq!(
        counting
            .count_tokens(&messages, CountTokensOptions::default())
            .await
            .unwrap(),
        7
    );
    let sent = &client.count_requests()[0];
    assert_eq!(
        sent.body["messages"],
        json!([
            {"role": "assistant", "content": [{"type": "compaction", "content": "new", "signature": "s2"}]},
            {"role": "user", "content": [{"type": "text", "text": "next"}]}
        ])
    );
    assert_eq!(sent.beta.as_deref(), Some("compact-2026-09-04"));

    let estimating = model(&client, config().model_id("claude-sonnet-5-5").max_tokens(1).build());
    assert_eq!(
        estimating
            .count_tokens(&messages, CountTokensOptions::default())
            .await
            .unwrap(),
        estimating
            .count_tokens(&messages[1..], CountTokensOptions::default())
            .await
            .unwrap()
    );
}

#[test]
fn turns_server_side_summary_on_by_default_for_listed_models() {
    for model_id in [
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "claude-opus-5-5",
        "claude-fable-5-1",
        "claude-sonnet-5-5-20260401",
    ] {
        let provider = model(
            &MockClient::capture(),
            config().model_id(model_id).max_tokens(1).build(),
        );
        assert_eq!(
            provider.model_info().capabilities.server_side_summary,
            Some(true),
            "{model_id}"
        );
    }
}

#[test]
fn leaves_server_side_summary_unknown_for_other_models() {
    for model_id in ["claude-sonnet-4-5", "m1"] {
        let provider = model(
            &MockClient::capture(),
            config().model_id(model_id).max_tokens(1).build(),
        );
        assert_eq!(
            provider.model_info().capabilities.server_side_summary,
            None,
            "{model_id}"
        );
    }
}

#[tokio::test]
async fn sends_the_compaction_text_without_the_capability() {
    let client = compaction_client(Vec::new());
    let provider = compaction_model(&client);
    let turned_off = ModelInfo {
        capabilities: ModelCapabilities {
            server_side_summary: Some(false),
            ..Default::default()
        },
        ..Default::default()
    };
    provider.update_config(config().model_info(turned_off).build()).unwrap();
    let messages = vec![
        Message::user("first"),
        Message::new(Role::Assistant, vec![stored_compaction("old", "sig")]),
    ];

    collect(&provider, request(messages)).await.unwrap();

    assert_eq!(provider.model_info().capabilities.server_side_summary, Some(false));
    assert_eq!(
        client.last()["messages"][1]["content"],
        json!([{"type": "text", "text": "old"}])
    );
    assert_eq!(client.last_beta(), None);
}
