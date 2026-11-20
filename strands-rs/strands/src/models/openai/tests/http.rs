//! The provider end to end on its real HTTP client, against a local server: paths, headers, the
//! SDK's environment variables, API key functions, SSE decoding, transport retries and error
//! mapping.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;

use super::super::client::HttpOpenAIClient;
use super::*;
use crate::models::http::mock_server::{
    MockResponse, MockServer, RecordingSleeper, SSE_CHUNKED_HEAD, chunked, raw_server,
};
use crate::models::http::{DEFAULT_TIMEOUT, ErrorPayload, HttpTransport, HttpTransportConfig, header_map};
use crate::retry::Sleeper;

/// An SSE reply of data-only events, as Chat Completions streams, ending with `[DONE]`.
fn chat_reply(chunks: &[JsonValue]) -> MockResponse {
    let mut body: String = chunks.iter().map(|chunk| format!("data: {chunk}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    MockResponse::Reply {
        status: 200,
        headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
        body,
    }
}

fn hello_chunks() -> Vec<JsonValue> {
    vec![
        json!({"choices": [{"delta": {"role": "assistant"}, "index": 0}]}),
        json!({"choices": [{"delta": {"content": "Hello"}, "index": 0}]}),
        json!({"choices": [{"finish_reason": "stop", "delta": {}, "index": 0}]}),
        json!({"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}}),
    ]
}

fn responses_reply() -> MockResponse {
    MockResponse::sse(&[
        (
            "response.created",
            json!({"type": "response.created", "response": {"id": "resp_1"}}),
        ),
        (
            "response.output_text.delta",
            json!({"type": "response.output_text.delta", "delta": "Hello"}),
        ),
        (
            "response.completed",
            json!({"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 1, "total_tokens": 4}}}),
        ),
    ])
}

fn http_options(server: &MockServer, api: OpenAIApi) -> OpenAIModelOptions {
    OpenAIModelOptions {
        model_id: Some("gpt-5.4-mini".to_owned()),
        api_key: Some("sk-test".into()),
        client_config: Some(OpenAIClientConfig::builder().base_url(server.url()).build()),
        ..options(api)
    }
}

fn http_model(options: OpenAIModelOptions, vars: &[(&str, &str)]) -> OpenAIModel {
    constructing(|| OpenAIModel::with_env(options, &env_of(vars))).unwrap()
}

/// A model on the real client with recorded instead of real retry waits.
fn retrying_model(server: &MockServer, sleeper: &Arc<RecordingSleeper>, api: OpenAIApi) -> OpenAIModel {
    let transport = HttpTransport::new(HttpTransportConfig {
        base_url: server.url().to_owned(),
        default_headers: header_map([("authorization", "Bearer sk-test")]).unwrap(),
        max_retries: 2,
        timeout: DEFAULT_TIMEOUT,
        error_payload: ErrorPayload::ErrorField,
    })
    .unwrap()
    .with_sleeper(Arc::clone(sleeper) as Arc<dyn Sleeper>)
    .with_random(Arc::new(|| 0.0));
    let client = HttpOpenAIClient::with_transport(transport, None);
    OpenAIModel::from_parts(
        api,
        OpenAIModelConfig::builder().model_id("gpt-5.4-mini").build(),
        Arc::new(client),
    )
}

#[tokio::test]
async fn streams_chat_completions_over_http_with_the_sdk_headers() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks())]).await;
    let model = http_model(http_options(&server, OpenAIApi::Chat), &[]);
    let events = collect(&model, hi()).await.unwrap();
    assert_eq!(
        events,
        vec![
            json!({"type": "modelMessageStartEvent", "role": "assistant"}),
            json!({"type": "modelContentBlockStartEvent"}),
            json!({"type": "modelContentBlockDeltaEvent", "delta": {"type": "textDelta", "text": "Hello"}}),
            json!({"type": "modelContentBlockStopEvent"}),
            json!({"type": "modelMessageStopEvent", "stopReason": "endTurn"}),
            json!({"type": "modelMetadataEvent", "usage": {"inputTokens": 3, "outputTokens": 1, "totalTokens": 4}}),
        ]
    );
    let request = &server.requests()[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/chat/completions");
    assert_eq!(request.header("authorization"), Some("Bearer sk-test"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("accept"), Some("application/json"));
    assert!(
        request
            .header("user-agent")
            .unwrap()
            .starts_with("strands-agents-rust/")
    );
    assert_eq!(
        request.json(),
        json!({
            "model": "gpt-5.4-mini",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            "stream": true,
            "stream_options": {"include_usage": true}
        })
    );
}

#[tokio::test]
async fn streams_the_responses_api_over_http() {
    let server = MockServer::start(vec![responses_reply()]).await;
    let model = http_model(http_options(&server, OpenAIApi::Responses), &[]);
    let (_, result) = aggregate(&model, hi()).await.unwrap();
    assert_eq!(result.message.text(), "Hello");
    assert_eq!(server.requests()[0].path, "/responses");
    assert_eq!(server.requests()[0].header("authorization"), Some("Bearer sk-test"));
    assert_eq!(server.requests()[0].json()["store"], false);
}

#[tokio::test]
async fn reads_the_sdk_environment_variables_and_lets_default_headers_win() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks())]).await;
    let options = OpenAIModelOptions {
        model_id: Some("gpt-5.4-mini".to_owned()),
        client_config: Some(
            OpenAIClientConfig::builder()
                .project("proj-config")
                .default_headers(vec![("x-custom".to_owned(), "1".to_owned())])
                .build(),
        ),
        ..options(OpenAIApi::Chat)
    };
    let base_url = format!("{}/", server.url());
    let model = http_model(
        options,
        &[
            ("OPENAI_API_KEY", "sk-from-env"),
            ("OPENAI_BASE_URL", base_url.as_str()),
            ("OPENAI_ORG_ID", "org-env"),
            ("OPENAI_PROJECT_ID", "proj-env"),
        ],
    );
    collect(&model, hi()).await.unwrap();
    let request = &server.requests()[0];
    assert_eq!(request.path, "/chat/completions");
    assert_eq!(request.header("authorization"), Some("Bearer sk-from-env"));
    assert_eq!(request.header("openai-organization"), Some("org-env"));
    assert_eq!(request.header("openai-project"), Some("proj-config"));
    assert_eq!(request.header("x-custom"), Some("1"));
}

#[tokio::test]
async fn explicit_api_key_takes_precedence_over_environment_variable() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks())]).await;
    let model = http_model(
        http_options(&server, OpenAIApi::Chat),
        &[("OPENAI_API_KEY", "sk-from-env")],
    );
    collect(&model, hi()).await.unwrap();
    assert_eq!(server.requests()[0].header("authorization"), Some("Bearer sk-test"));
}

#[tokio::test]
async fn uses_custom_client_configuration() {
    let server = MockServer::start(vec![MockResponse::Hang]).await;
    let options = OpenAIModelOptions {
        client_config: Some(
            OpenAIClientConfig::builder()
                .base_url(server.url())
                .timeout(Duration::from_millis(50))
                .max_retries(0)
                .build(),
        ),
        ..http_options(&server, OpenAIApi::Chat)
    };
    let error = collect_error(&http_model(options, &[]), hi()).await;
    assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
    assert_eq!(error.to_string(), "Request timed out.");
}

#[tokio::test]
async fn calls_an_async_api_key_function_before_each_request() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks()), chat_reply(&hello_chunks())]).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let api_key = ApiKey::setter(move || {
        let call = counter.fetch_add(1, Ordering::SeqCst) + 1;
        async move { Ok(format!("sk-async-key-{call}")) }
    });
    let options = OpenAIModelOptions {
        api_key: Some(api_key),
        ..http_options(&server, OpenAIApi::Chat)
    };
    let model = http_model(options, &[]);
    collect(&model, hi()).await.unwrap();
    collect(&model, hi()).await.unwrap();
    let requests = server.requests();
    assert_eq!(requests[0].header("authorization"), Some("Bearer sk-async-key-1"));
    assert_eq!(requests[1].header("authorization"), Some("Bearer sk-async-key-2"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn reports_an_api_key_function_failure_without_sending() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks())]).await;
    let options = OpenAIModelOptions {
        api_key: Some(ApiKey::setter(|| async { Err("vault unavailable".into()) })),
        ..http_options(&server, OpenAIApi::Chat)
    };
    let error = collect_error(&http_model(options, &[]), hi()).await;
    assert!(matches!(error, Error::Model(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        "Failed to get token from 'api_key' function: vault unavailable"
    );
    assert!(server.requests().is_empty());

    let options = OpenAIModelOptions {
        api_key: Some(ApiKey::setter(|| async { Ok(String::new()) })),
        ..http_options(&server, OpenAIApi::Chat)
    };
    let error = collect_error(&http_model(options, &[]), hi()).await;
    assert_eq!(
        error.to_string(),
        "Expected 'api_key' function argument to return a string but it returned "
    );
}

#[tokio::test]
async fn retries_a_429_then_maps_it_to_model_throttled_error() {
    let body = json!({"error": {"message": "Rate limit reached for gpt-5.4-mini", "type": "requests", "code": "rate_limit_exceeded"}});
    let server = MockServer::start(vec![MockResponse::json(429, &body); 3]).await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let error = collect_error(&retrying_model(&server, &sleeper, OpenAIApi::Chat), hi()).await;
    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    assert_eq!(error.to_string(), "429 Rate limit reached for gpt-5.4-mini");
    assert_eq!(server.requests().len(), 3);
    assert_eq!(
        sleeper.delays(),
        vec![Duration::from_millis(500), Duration::from_secs(1)]
    );
}

#[tokio::test]
async fn maps_a_context_length_error_body_to_context_window_overflow_error() {
    let body = json!({"error": {"message": "This model's maximum context length is 128000 tokens.", "code": "context_length_exceeded"}});
    let server = MockServer::start(vec![MockResponse::json(400, &body)]).await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let error = collect_error(&retrying_model(&server, &sleeper, OpenAIApi::Responses), hi()).await;
    assert!(matches!(error, Error::ContextWindowOverflow(_)), "{error:?}");
    assert_eq!(
        error.to_string(),
        "400 This model's maximum context length is 128000 tokens."
    );
    assert!(sleeper.delays().is_empty());
}

#[tokio::test]
async fn maps_an_error_object_in_the_stream() {
    let server = MockServer::start(vec![chat_reply(&[
        json!({"choices": [{"delta": {"role": "assistant"}, "index": 0}]}),
        json!({"error": {"message": "Rate limit exceeded", "code": 429}}),
    ])])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let error = collect_error(&retrying_model(&server, &sleeper, OpenAIApi::Chat), hi()).await;
    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    assert_eq!(error.to_string(), "Rate limit exceeded");
}

#[tokio::test]
async fn maps_a_dropped_connection_to_model_network_error_after_retries() {
    let server = MockServer::start(vec![MockResponse::Drop, MockResponse::Drop, MockResponse::Drop]).await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let error = collect_error(&retrying_model(&server, &sleeper, OpenAIApi::Responses), hi()).await;
    assert!(matches!(error, Error::ModelNetwork(_)), "{error:?}");
    assert_eq!(error.to_string(), "Connection error.");
    assert_eq!(server.requests().len(), 3);
}

#[tokio::test]
async fn reports_event_data_that_is_not_json() {
    let server = MockServer::start(vec![MockResponse::Reply {
        status: 200,
        headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
        body: "data: {not json\n\n".to_owned(),
    }])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let error = collect_error(&retrying_model(&server, &sleeper, OpenAIApi::Chat), hi()).await;
    assert!(matches!(error, Error::Model(_)), "{error:?}");
    assert!(
        error.to_string().starts_with("could not parse event data as JSON"),
        "{error}"
    );
}

#[tokio::test]
async fn closes_the_connection_before_reporting_the_abort() {
    let first = format!(
        "data: {}\n\n",
        json!({"choices": [{"delta": {"role": "assistant", "content": "Hel"}, "index": 0}]})
    );
    let (url, closed) = raw_server(SSE_CHUNKED_HEAD, chunked(&[first.as_bytes()], false), true).await;
    let options = OpenAIModelOptions {
        model_id: Some("gpt-5.4-mini".to_owned()),
        api_key: Some("sk-test".into()),
        client_config: Some(OpenAIClientConfig::builder().base_url(url).build()),
        ..options(OpenAIApi::Chat)
    };
    let model = http_model(options, &[]);
    let handle = crate::cancel::CancelHandle::new();
    let request = ModelRequest::builder()
        .messages(vec![Message::user("Hello")])
        .cancel_signal(handle.signal())
        .build();
    let mut stream = Model::stream(&model, request);
    assert!(stream.next().await.unwrap().is_ok());
    handle.cancel(crate::cancel::CancelOptions::default());
    let mut last = None;
    while let Some(item) = stream.next().await {
        if let Err(error) = item {
            last = Some(error.to_string());
            break;
        }
    }
    assert_eq!(last.as_deref(), Some("Request was aborted."));

    // The stream is still held here: the provider closed the connection before yielding the abort.
    tokio::time::timeout(Duration::from_secs(5), closed)
        .await
        .expect("the provider closes the connection")
        .unwrap();
    drop(stream);
}

#[tokio::test]
async fn trims_environment_values_and_reads_openai_custom_headers() {
    let server = MockServer::start(vec![chat_reply(&hello_chunks())]).await;
    let options = OpenAIModelOptions {
        model_id: Some("gpt-5.4-mini".to_owned()),
        client_config: Some(
            OpenAIClientConfig::builder()
                .default_headers(vec![("x-both".to_owned(), "config".to_owned())])
                .build(),
        ),
        ..options(OpenAIApi::Chat)
    };
    let base_url = format!(" {}\n", server.url());
    let model = http_model(
        options,
        &[
            ("OPENAI_API_KEY", "sk-from-env\n"),
            ("OPENAI_BASE_URL", base_url.as_str()),
            ("OPENAI_ORG_ID", "  "),
            ("OPENAI_PROJECT_ID", " proj-env "),
            ("OPENAI_CUSTOM_HEADERS", "x-env: env\nx-both: env\n"),
        ],
    );
    collect(&model, hi()).await.unwrap();
    let request = &server.requests()[0];
    assert_eq!(request.header("authorization"), Some("Bearer sk-from-env"));
    assert_eq!(request.header("openai-organization"), None);
    assert_eq!(request.header("openai-project"), Some("proj-env"));
    assert_eq!(request.header("x-env"), Some("env"));
    assert_eq!(request.header("x-both"), Some("config"));
}

#[test]
fn rejects_an_invalid_base_url_when_built() {
    let options = OpenAIModelOptions {
        api_key: Some("sk-test".into()),
        client_config: Some(OpenAIClientConfig::builder().base_url("api.openai.com/v1").build()),
        ..options(OpenAIApi::Chat)
    };
    let error = constructing(|| OpenAIModel::with_env(options, &env_of(&[]))).unwrap_err();
    assert!(
        error.to_string().starts_with("invalid base url 'api.openai.com/v1'"),
        "{error}"
    );
}

#[test]
fn redacts_the_api_key_and_credential_headers_in_debug_output() {
    let options = OpenAIModelOptions {
        api_key: Some("sk-key-SECRET".into()),
        client_config: Some(
            OpenAIClientConfig::builder()
                .default_headers(vec![
                    ("Authorization".to_owned(), "Bearer sk-header-SECRET".to_owned()),
                    ("x-trace".to_owned(), "visible".to_owned()),
                ])
                .build(),
        ),
        ..options(OpenAIApi::Chat)
    };
    let printed = format!("{options:?}");
    assert!(!printed.contains("SECRET"), "{printed}");
    assert!(printed.contains("visible"), "{printed}");
}
