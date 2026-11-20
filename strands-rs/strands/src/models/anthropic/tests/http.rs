//! The provider end to end on its real HTTP client, against a local server: paths, headers, SSE
//! decoding, transport retries and error mapping.

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::models::http::mock_server::{
    MockResponse, MockServer, RecordingSleeper, SSE_CHUNKED_HEAD, chunked, raw_server,
};
use crate::models::http::{DEFAULT_TIMEOUT, ErrorPayload, HttpTransport, HttpTransportConfig, header_map};
use crate::retry::Sleeper;

fn text_reply() -> MockResponse {
    MockResponse::sse(&[
        ("message_start", message_start(3)),
        ("ping", json!({"type": "ping"})),
        (
            "content_block_start",
            json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ),
        (
            "content_block_delta",
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}),
        ),
        ("content_block_stop", json!({"type": "content_block_stop", "index": 0})),
        (
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 2}}),
        ),
        ("message_stop", json!({"type": "message_stop"})),
    ])
}

fn options(server: &MockServer, client_config: AnthropicClientConfig) -> AnthropicModelOptions {
    AnthropicModelOptions {
        model_id: Some("claude-haiku-4-5".to_owned()),
        max_tokens: Some(64),
        api_key: Some("sk-test".to_owned()),
        client_config: Some(AnthropicClientConfig {
            base_url: Some(server.url().to_owned()),
            ..client_config
        }),
        ..Default::default()
    }
}

fn http_model(server: &MockServer) -> AnthropicModel {
    AnthropicModel::with_env(options(server, AnthropicClientConfig::default()), &|_| None).unwrap()
}

/// A model on the real client with recorded instead of real retry waits.
fn retrying_model(server: &MockServer, sleeper: &Arc<RecordingSleeper>) -> AnthropicModel {
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: server.url().to_owned(),
        default_headers: header_map([("x-api-key", "sk-test")]).unwrap(),
        max_retries: 2,
        timeout: DEFAULT_TIMEOUT,
        error_payload: ErrorPayload::Body,
    })
    .unwrap()
    .with_sleeper(Arc::clone(sleeper) as Arc<dyn Sleeper>)
    .with_random(Arc::new(|| 0.0));
    let client = super::super::client::HttpAnthropicClient::with_transport(transport);
    AnthropicModel::from_parts(
        prepare_config(config().model_id("claude-haiku-4-5").max_tokens(64).build()).unwrap(),
        Arc::new(client),
        Vec::new(),
        None,
    )
}

#[tokio::test]
async fn streams_a_response_over_http_with_the_sdk_headers() {
    let server = MockServer::start(vec![text_reply()]).await;
    let provider = AnthropicModel::with_env(
        AnthropicModelOptions {
            betas: Some(vec!["beta-1".to_owned()]),
            ..options(
                &server,
                AnthropicClientConfig::builder()
                    .default_headers(vec![("x-custom".to_owned(), "config".to_owned())])
                    .build(),
            )
        },
        &|name| (name == "ANTHROPIC_CUSTOM_HEADERS").then(|| "x-env: env\nx-custom: env".to_owned()),
    )
    .unwrap();

    let events = collect(&provider, hi()).await.unwrap();

    assert_eq!(
        events,
        vec![
            json!({"type": "modelMessageStartEvent", "role": "assistant"}),
            json!({"type": "modelContentBlockStartEvent"}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
            json!({"type": "modelContentBlockStopEvent"}),
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}}),
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
        ]
    );
    let request = &server.requests()[0];
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.header("x-api-key"), Some("sk-test"));
    assert_eq!(request.header("anthropic-version"), Some("2026-10-21"));
    assert_eq!(request.header("anthropic-beta"), Some("beta-1"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("x-env"), Some("env"));
    assert_eq!(request.header("x-custom"), Some("config"));
    assert_eq!(
        request.json(),
        json!({
            "model": "claude-haiku-4-5",
            "max_tokens": 64,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            "stream": true
        })
    );
}

#[tokio::test]
async fn reads_the_base_url_from_anthropic_base_url() {
    let server = MockServer::start(vec![text_reply()]).await;
    let url = server.url().to_owned();
    let provider = AnthropicModel::with_env(
        AnthropicModelOptions::builder()
            .model_id("claude-haiku-4-5")
            .max_tokens(64)
            .api_key("sk-test")
            .build_options(),
        &move |name| (name == "ANTHROPIC_BASE_URL").then(|| url.clone()),
    )
    .unwrap();

    collect(&provider, hi()).await.unwrap();

    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn retries_an_overloaded_response_and_then_streams() {
    let server = MockServer::start(vec![
        MockResponse::json(
            529,
            &json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ),
        text_reply(),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let events = collect(&retrying_model(&server, &sleeper), hi()).await.unwrap();

    assert_eq!(events.len(), 6);
    assert_eq!(server.requests().len(), 2);
    assert_eq!(sleeper.delays(), [Duration::from_millis(500)]);
}

#[tokio::test]
async fn maps_a_429_after_the_retries_to_model_throttled_error() {
    let body = json!({"type": "error", "error": {"type": "rate_limit_error", "message": "Rate limited"}});
    let server = MockServer::start(vec![
        MockResponse::json(429, &body).with_header("retry-after", "1"),
        MockResponse::json(429, &body).with_header("retry-after", "2"),
        MockResponse::json(429, &body),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = collect(&retrying_model(&server, &sleeper), hi()).await.unwrap_err();

    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        r#"429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}"#
    );
    assert_eq!(sleeper.delays(), [Duration::from_secs(1), Duration::from_secs(2)]);
}

#[tokio::test]
async fn maps_a_400_context_overflow_without_retrying() {
    let body = json!({"type": "error", "error": {"type": "invalid_request_error", "message": "prompt is too long: 250000 tokens > 200000 maximum"}});
    let server = MockServer::start(vec![MockResponse::json(400, &body)]).await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = collect(&retrying_model(&server, &sleeper), hi()).await.unwrap_err();

    assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn maps_a_dropped_connection_to_model_network_error() {
    let server = MockServer::start(vec![MockResponse::Drop, MockResponse::Drop, MockResponse::Drop]).await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = collect(&retrying_model(&server, &sleeper), hi()).await.unwrap_err();

    assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
    assert_eq!(error.to_string(), "Connection error.");
    assert_eq!(server.requests().len(), 3);
}

#[tokio::test]
async fn surfaces_an_error_event_mid_stream_as_a_model_error() {
    let server = MockServer::start(vec![MockResponse::sse(&[
        ("message_start", message_start(3)),
        (
            "error",
            json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ),
    ])])
    .await;

    let mut stream = http_model(&server).stream(hi());
    let first = stream.next().await.unwrap().unwrap();
    let error = stream.next().await.unwrap().unwrap_err();

    assert!(matches!(first, ModelStreamEvent::MessageStart(_)));
    assert!(matches!(error, Error::Model(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
    );
}

#[tokio::test]
async fn counts_tokens_on_the_count_tokens_endpoint() {
    let server = MockServer::start(vec![MockResponse::json(200, &json!({"input_tokens": 12}))]).await;
    let provider = AnthropicModel::with_env(
        AnthropicModelOptions {
            use_native_token_count: Some(true),
            ..options(&server, AnthropicClientConfig::default())
        },
        &|_| None,
    )
    .unwrap();

    let count = provider
        .count_tokens(&[Message::user("hello")], CountTokensOptions::default())
        .await
        .unwrap();

    assert_eq!(count, 12);
    let request = &server.requests()[0];
    assert_eq!(request.path, "/v1/messages/count_tokens");
    assert_eq!(
        request.json(),
        json!({"model": "claude-haiku-4-5", "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]})
    );
}

#[tokio::test]
async fn sends_compaction_to_the_beta_endpoint() {
    let server = MockServer::start(vec![MockResponse::sse(&[
        ("message_start", json!({"type": "message_start", "message": {"role": "assistant", "content": [], "usage": {"input_tokens": 0, "output_tokens": 0}}})),
        ("content_block_start", json!({"type": "content_block_start", "index": 0, "content_block": {"type": "compaction", "content": ""}})),
        ("content_block_delta", json!({"type": "content_block_delta", "index": 0, "delta": {"type": "compaction_delta", "content": "the summary", "encrypted_content": "enc"}})),
        ("content_block_stop", json!({"type": "content_block_stop", "index": 0})),
        ("message_delta", json!({"type": "message_delta", "delta": {"stop_reason": "compaction"}, "usage": {"output_tokens": 0, "iterations": [{"input_tokens": 50, "output_tokens": 9}]}})),
        ("message_stop", json!({"type": "message_stop"})),
    ])])
    .await;
    let provider = AnthropicModel::with_env(
        AnthropicModelOptions {
            model_id: Some("claude-sonnet-5-5".to_owned()),
            ..options(&server, AnthropicClientConfig::default())
        },
        &|_| None,
    )
    .unwrap();

    let result = provider
        .summarize(vec![Message::user("hi")], SummarizeOptions::default())
        .await
        .unwrap();

    assert_eq!(
        result,
        SummarizeResult::new(vec![SummaryBlock::new("the summary").with_provider("anthropic").into()])
            .with_usage(Usage::new(50, 9, 59))
    );
    let request = &server.requests()[0];
    assert_eq!(request.path, "/v1/messages?beta=true");
    assert_eq!(request.header("anthropic-beta"), Some("compact-2026-09-04"));
    assert_eq!(request.json()["compaction"], json!({"type": "summarize"}));
}

fn raw_model(url: String) -> AnthropicModel {
    AnthropicModel::with_env(
        AnthropicModelOptions {
            model_id: Some("claude-haiku-4-5".to_owned()),
            max_tokens: Some(64),
            api_key: Some("sk-test".to_owned()),
            client_config: Some(AnthropicClientConfig::builder().base_url(url).build()),
            ..Default::default()
        },
        &|_| None,
    )
    .unwrap()
}

fn sse_event(name: &str, data: &JsonValue) -> Vec<u8> {
    format!("event: {name}\ndata: {data}\n\n").into_bytes()
}

#[tokio::test]
async fn closes_the_connection_when_the_stream_is_dropped() {
    let start = sse_event("message_start", &message_start(3));
    let block = sse_event(
        "content_block_start",
        &json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    );
    let (url, closed) = raw_server(SSE_CHUNKED_HEAD, chunked(&[&start, &block], false), true).await;
    let model = raw_model(url);
    let mut stream = Model::stream(&model, hi());
    assert!(stream.next().await.unwrap().is_ok());

    drop(stream);

    tokio::time::timeout(Duration::from_secs(5), closed)
        .await
        .expect("the client closes the connection")
        .unwrap();
}

#[tokio::test]
async fn ends_a_truncated_message_with_an_error() {
    let start = sse_event("message_start", &message_start(3));
    let block = sse_event(
        "content_block_start",
        &json!({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
    );
    let delta = sse_event(
        "content_block_delta",
        &json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hel"}}),
    );
    let (url, _closed) = raw_server(SSE_CHUNKED_HEAD, chunked(&[&start, &block, &delta], true), false).await;
    let model = raw_model(url);

    let items: Vec<_> = model.stream_aggregated(hi()).collect().await;

    assert!(items.last().unwrap().is_err(), "{items:?}");
}

#[tokio::test]
async fn trims_the_environment_api_key() {
    let server = MockServer::start(vec![text_reply()]).await;
    let url = server.url().to_owned();
    let model = AnthropicModel::with_env(
        AnthropicModelOptions {
            model_id: Some("claude-haiku-4-5".to_owned()),
            max_tokens: Some(64),
            ..Default::default()
        },
        &|name| match name {
            "ANTHROPIC_API_KEY" => Some("sk-env-key\n".to_owned()),
            "ANTHROPIC_BASE_URL" => Some(format!(" {url} ")),
            "ANTHROPIC_CUSTOM_HEADERS" => Some("   ".to_owned()),
            _ => None,
        },
    )
    .unwrap();

    collect(&model, hi()).await.unwrap();

    assert_eq!(server.requests()[0].header("x-api-key"), Some("sk-env-key"));
}

#[test]
fn rejects_an_api_key_that_is_not_a_valid_header_value() {
    let error = AnthropicModel::with_env(
        AnthropicModelOptions {
            api_key: Some("sk-bad\nkey".to_owned()),
            ..Default::default()
        },
        &|_| None,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "invalid value for http header 'x-api-key'");
    assert!(!error.to_string().contains("sk-bad"));
}

#[test]
fn rejects_an_invalid_base_url_when_built() {
    let error = AnthropicModel::with_env(
        AnthropicModelOptions {
            api_key: Some("sk-test".to_owned()),
            client_config: Some(AnthropicClientConfig::builder().base_url("api.anthropic.com").build()),
            ..Default::default()
        },
        &|_| None,
    )
    .unwrap_err();
    assert!(
        error.to_string().starts_with("invalid base url 'api.anthropic.com'"),
        "{error}"
    );
}

#[test]
fn redacts_the_api_key_and_credential_headers_in_debug_output() {
    let options = AnthropicModelOptions {
        api_key: Some("anthropic-key-SECRET".to_owned()),
        client_config: Some(
            AnthropicClientConfig::builder()
                .default_headers(vec![
                    ("x-api-key".to_owned(), "anthropic-header-SECRET".to_owned()),
                    ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
                ])
                .build(),
        ),
        ..Default::default()
    };
    let printed = format!("{options:?}");
    assert!(!printed.contains("SECRET"), "{printed}");
    assert!(printed.contains("2023-06-01"), "{printed}");
}
