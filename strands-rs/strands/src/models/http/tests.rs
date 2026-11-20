//! Transport tests against a local server, including the retry policy of the official Anthropic and
//! OpenAI SDKs.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::json;

use super::mock_server::{MockResponse, MockServer, RecordingSleeper, SSE_CHUNKED_HEAD, chunked, raw_server};
use super::*;

fn transport(server: &MockServer, sleeper: &Arc<RecordingSleeper>) -> HttpTransport {
    HttpTransport::new(HttpTransportConfig {
        base_url: server.url().to_owned(),
        default_headers: header_map([("x-api-key", "key"), ("anthropic-beta", "client")]).unwrap(),
        max_retries: DEFAULT_MAX_RETRIES,
        timeout: DEFAULT_TIMEOUT,
        error_payload: ErrorPayload::Body,
    })
    .unwrap()
    .with_sleeper(Arc::clone(sleeper) as Arc<dyn Sleeper>)
    .with_random(Arc::new(|| 0.0))
}

async fn post(transport: &HttpTransport) -> Result<reqwest::Response, HttpError> {
    transport
        .post("/v1/messages", &json!({"a": 1}), &HeaderMap::new())
        .await
}

#[tokio::test]
async fn retries_retryable_statuses_and_then_succeeds() {
    for status in [408, 409, 429, 500, 503, 529] {
        let server = MockServer::start(vec![MockResponse::status(status, ""), MockResponse::status(200, "ok")]).await;
        let sleeper = Arc::new(RecordingSleeper::default());

        let response = post(&transport(&server, &sleeper)).await.unwrap();

        assert_eq!(response.text().await.unwrap(), "ok");
        assert_eq!(server.requests().len(), 2, "status {status}");
        assert_eq!(sleeper.delays(), vec![Duration::from_millis(500)], "status {status}");
    }
}

#[tokio::test]
async fn does_not_retry_other_client_errors() {
    for status in [400, 401, 403, 404, 422] {
        let server = MockServer::start(vec![MockResponse::status(status, "nope")]).await;
        let sleeper = Arc::new(RecordingSleeper::default());

        let error = post(&transport(&server, &sleeper)).await.unwrap_err();

        assert_eq!(error.status_code(), Some(status));
        assert_eq!(error.to_string(), format!("{status} nope"));
        assert_eq!(server.requests().len(), 1);
        assert!(sleeper.delays().is_empty());
    }
}

#[tokio::test]
async fn gives_up_after_two_retries_with_exponential_backoff() {
    let server = MockServer::start(vec![
        MockResponse::status(503, ""),
        MockResponse::status(503, ""),
        MockResponse::json(
            503,
            &json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}),
        ),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = post(&transport(&server, &sleeper)).await.unwrap_err();

    assert_eq!(server.requests().len(), 3);
    assert_eq!(
        sleeper.delays(),
        vec![Duration::from_millis(500), Duration::from_millis(1000)]
    );
    assert_eq!(
        error.to_string(),
        r#"503 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
    );
    assert_eq!(error.body().unwrap()["error"]["message"], "Overloaded");
}

#[tokio::test]
async fn obeys_x_should_retry() {
    let server = MockServer::start(vec![
        MockResponse::status(400, "").with_header("x-should-retry", "true"),
        MockResponse::status(500, "stop").with_header("x-should-retry", "false"),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = post(&transport(&server, &sleeper)).await.unwrap_err();

    assert_eq!(server.requests().len(), 2);
    assert_eq!(error.status_code(), Some(500));
    assert_eq!(error.to_string(), "500 stop");
}

#[tokio::test]
async fn waits_as_long_as_retry_after_headers_ask() {
    let server = MockServer::start(vec![
        MockResponse::status(429, "").with_header("retry-after-ms", "1500"),
        MockResponse::status(429, "").with_header("retry-after", "3"),
        MockResponse::status(200, ""),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());

    post(&transport(&server, &sleeper)).await.unwrap();

    assert_eq!(
        sleeper.delays(),
        vec![Duration::from_millis(1500), Duration::from_secs(3)]
    );
}

#[test]
fn computes_the_sdk_retry_delay() {
    let random = |value: f64| move || value;
    let no_headers = |remaining, max, value| retry_delay(None, remaining, max, &random(value));
    assert_eq!(no_headers(2, 2, 0.0), Duration::from_millis(500));
    assert_eq!(no_headers(1, 2, 0.0), Duration::from_millis(1000));
    assert_eq!(no_headers(2, 2, 1.0), Duration::from_millis(375));
    assert_eq!(no_headers(0, 10, 0.0), Duration::from_secs(8));

    let headers = |pairs: &[(&str, &str)]| header_map(pairs.iter().copied()).unwrap();
    let with = |pairs: &[(&str, &str)]| retry_delay(Some(&headers(pairs)), 2, 2, &random(0.0));
    assert_eq!(with(&[("retry-after-ms", "250.5")]), Duration::from_micros(250_500));
    assert_eq!(with(&[("retry-after", "2")]), Duration::from_secs(2));
    assert_eq!(
        with(&[("retry-after-ms", "0"), ("retry-after", "2")]),
        Duration::from_secs(2)
    );
    assert_eq!(with(&[("retry-after-ms", "0")]), Duration::ZERO);
    assert_eq!(with(&[("retry-after-ms", "soon")]), Duration::from_millis(500));
    assert_eq!(
        with(&[("retry-after", "Wed, 21 Oct 2015 07:28:00 GMT")]),
        Duration::ZERO
    );
    assert_eq!(with(&[("retry-after", "not a date")]), Duration::ZERO);

    let future = jiff::Timestamp::now() + jiff::SignedDuration::from_secs(60);
    let date = jiff::fmt::rfc2822::to_string(&future.to_zoned(jiff::tz::TimeZone::UTC)).unwrap();
    let delay = with(&[("retry-after", date.as_str())]);
    assert!(
        delay > Duration::from_secs(55) && delay <= Duration::from_secs(60),
        "{delay:?}"
    );
}

#[test]
fn parses_numbers_like_js_parse_float() {
    assert_eq!(parse_js_float("1.5"), Some(1.5));
    assert_eq!(parse_js_float("  2abc"), Some(2.0));
    assert_eq!(parse_js_float(".5"), Some(0.5));
    assert_eq!(parse_js_float("1e3x"), Some(1000.0));
    assert_eq!(parse_js_float("-3"), Some(-3.0));
    assert_eq!(parse_js_float("abc"), None);
    assert_eq!(parse_js_float("."), None);
    assert_eq!(parse_js_float("Infinity"), Some(f64::INFINITY));
}

#[tokio::test]
async fn retries_a_dropped_connection_and_reports_a_connection_error() {
    let server = MockServer::start(vec![MockResponse::Drop, MockResponse::Drop, MockResponse::Drop]).await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = post(&transport(&server, &sleeper)).await.unwrap_err();

    assert_eq!(server.requests().len(), 3);
    assert_eq!(error.kind(), HttpErrorKind::Connection);
    assert_eq!(error.to_string(), "Connection error.");
    assert!(error.is_network());
    assert_eq!(sleeper.delays().len(), 2);
}

// Paused time advances whenever the runtime idles on the socket, so only a server that never
// answers gives a deterministic outcome.
#[tokio::test(start_paused = true)]
async fn times_out_waiting_for_headers_and_retries() {
    let server = MockServer::start(vec![MockResponse::Hang, MockResponse::Hang, MockResponse::Hang]).await;
    let sleeper = Arc::new(RecordingSleeper::default());

    let error = post(&transport(&server, &sleeper)).await.unwrap_err();

    assert_eq!(error.kind(), HttpErrorKind::Timeout);
    assert_eq!(error.to_string(), "Request timed out.");
    assert!(error.is_network());
    assert_eq!(
        sleeper.delays(),
        vec![Duration::from_millis(500), Duration::from_millis(1000)]
    );
}

#[tokio::test]
async fn sends_json_with_default_headers_replaced_by_request_headers() {
    let server = MockServer::start(vec![MockResponse::status(200, "")]).await;
    let sleeper = Arc::new(RecordingSleeper::default());

    transport(&server, &sleeper)
        .post(
            "/v1/messages",
            &json!({"model": "m"}),
            &header_map([("anthropic-beta", "request")]).unwrap(),
        )
        .await
        .unwrap();

    let request = &server.requests()[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.path, "/v1/messages");
    assert_eq!(request.header("x-api-key"), Some("key"));
    assert_eq!(request.header("anthropic-beta"), Some("request"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.json(), json!({"model": "m"}));
}

#[test]
fn builds_the_sdk_error_messages() {
    let body = json!({"type": "error", "error": {"message": "bad"}});
    let status = |body: Option<JsonValue>, text: &str, payload| HttpError::status(400, body, text, payload).to_string();
    assert_eq!(
        status(Some(body.clone()), "", ErrorPayload::Body),
        r#"400 {"type":"error","error":{"message":"bad"}}"#
    );
    assert_eq!(status(Some(body), "", ErrorPayload::ErrorField), "400 bad");
    assert_eq!(status(None, "plain", ErrorPayload::Body), "400 plain");
    assert_eq!(status(None, "", ErrorPayload::Body), "400 status code (no body)");
    assert_eq!(
        HttpError::event(r#"{"type":"error","error":{"type":"overloaded_error"}}"#).to_string(),
        r#"{"type":"error","error":{"type":"overloaded_error"}}"#
    );
    assert_eq!(HttpError::event("oops").to_string(), r#""oops""#);
    assert!(!HttpError::decode("x", "x").is_api_error());
    assert!(HttpError::timeout().is_api_error());
}

#[tokio::test]
async fn parses_server_sent_events() {
    let body = "event: message_start\ndata: {\"a\":1}\n\n: comment\n\ndata: line one\ndata: line two\n\n";
    let server = MockServer::start(vec![MockResponse::Reply {
        status: 200,
        headers: vec![("content-type".to_owned(), "text/event-stream".to_owned())],
        body: body.to_owned(),
    }])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let response = post(&transport(&server, &sleeper)).await.unwrap();

    let events: Vec<SseEvent> = sse_events(response).map(Result::unwrap).collect().await;

    assert_eq!(
        events,
        vec![
            SseEvent {
                event: "message_start".to_owned(),
                data: r#"{"a":1}"#.to_owned()
            },
            SseEvent {
                event: "message".to_owned(),
                data: "line one\nline two".to_owned()
            },
        ]
    );
}

#[tokio::test]
async fn reads_a_json_body() {
    let server = MockServer::start(vec![
        MockResponse::json(200, &json!({"input_tokens": 3})),
        MockResponse::status(200, "not json"),
    ])
    .await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let transport = transport(&server, &sleeper);

    assert_eq!(
        json_body(post(&transport).await.unwrap()).await.unwrap(),
        json!({"input_tokens": 3})
    );
    let error = json_body(post(&transport).await.unwrap()).await.unwrap_err();
    assert_eq!(error.kind(), HttpErrorKind::Decode);
}

fn raw_transport(url: &str, sleeper: &Arc<RecordingSleeper>) -> HttpTransport {
    HttpTransport::new(HttpTransportConfig {
        base_url: url.to_owned(),
        default_headers: HeaderMap::new(),
        max_retries: DEFAULT_MAX_RETRIES,
        timeout: DEFAULT_TIMEOUT,
        error_payload: ErrorPayload::Body,
    })
    .unwrap()
    .with_sleeper(Arc::clone(sleeper) as Arc<dyn Sleeper>)
    .with_random(Arc::new(|| 0.0))
}

#[tokio::test]
async fn parses_events_split_byte_by_byte_with_crlf_utf8_and_comments() {
    let body = "event: message_start\r\ndata: {\"t\":\"caf\u{e9} \u{1F600}\"}\r\n\r\n: keep-alive\r\n\r\nevent: ping\r\n\r\ndata: one\r\ndata: two\r\n\r\nevent: x\rdata: cr-only\r\rdata: after\n\n";
    let pieces: Vec<&[u8]> = body.as_bytes().chunks(1).collect();
    let (url, _closed) = raw_server(SSE_CHUNKED_HEAD, chunked(&pieces, true), false).await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let response = raw_transport(&url, &sleeper)
        .post("/x", &json!({}), &HeaderMap::new())
        .await
        .unwrap();

    let events: Vec<SseEvent> = sse_events(response).map(Result::unwrap).collect().await;

    assert_eq!(events.len(), 4, "{events:?}");
    assert_eq!(events[0].data, "{\"t\":\"caf\u{e9} \u{1F600}\"}");
    assert_eq!(events[1].data, "one\ntwo");
    assert_eq!((events[2].event.as_str(), events[2].data.as_str()), ("x", "cr-only"));
    assert_eq!(events[3].data, "after");
}

#[tokio::test]
async fn reports_a_truncated_body_as_a_connection_error() {
    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: 1000\r\n\r\n";
    let (url, _closed) = raw_server(head, vec![b"event: message_start\ndata: {}\n\n".to_vec()], false).await;
    let sleeper = Arc::new(RecordingSleeper::default());
    let response = raw_transport(&url, &sleeper)
        .post("/x", &json!({}), &HeaderMap::new())
        .await
        .unwrap();

    let events: Vec<_> = sse_events(response).collect().await;

    assert!(events[0].is_ok());
    let error = events.last().unwrap().as_ref().unwrap_err();
    assert_eq!(error.kind(), HttpErrorKind::Connection);
}

#[test]
fn rejects_an_invalid_base_url_when_built_instead_of_retrying_it() {
    for base_url in ["not a url", "localhost:8080", "ftp://example.com", ""] {
        let error = HttpTransport::new(HttpTransportConfig {
            base_url: base_url.to_owned(),
            default_headers: HeaderMap::new(),
            max_retries: DEFAULT_MAX_RETRIES,
            timeout: DEFAULT_TIMEOUT,
            error_payload: ErrorPayload::Body,
        })
        .unwrap_err();
        assert_eq!(error.kind(), HttpErrorKind::Request, "{base_url}");
        assert!(
            error.message().starts_with(&format!("invalid base url '{base_url}'")),
            "{error}"
        );
        assert!(!error.is_network());
        assert!(!error.is_api_error());
    }
}

#[test]
fn rejects_invalid_headers_without_echoing_the_value() {
    let error = header_map([("x-api-key", "sk-secret\n")]).unwrap_err();
    assert_eq!(error.kind(), HttpErrorKind::Request);
    assert_eq!(error.message(), "invalid value for http header 'x-api-key'");
    let error = header_map([("bad header", "value")]).unwrap_err();
    assert_eq!(error.message(), "invalid http header name 'bad header'");
}

#[test]
fn redacts_credential_headers_in_debug_output() {
    let headers = [
        ("Authorization".to_owned(), "Bearer sk-secret".to_owned()),
        ("x-api-key".to_owned(), "anthropic-secret".to_owned()),
        ("Api-Key".to_owned(), "azure-secret".to_owned()),
        ("Proxy-Authorization".to_owned(), "Basic secret".to_owned()),
        ("cookie".to_owned(), "session=secret".to_owned()),
        ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
    ];
    let printed = format!("{:?}", RedactedHeaders(&headers));
    assert!(!printed.contains("secret"), "{printed}");
    assert!(printed.contains("2023-06-01"), "{printed}");
}

#[test]
fn reads_environment_values_trimmed_and_blank_as_unset() {
    let env = |name: &str| match name {
        "PADDED" => Some("  value\n".to_owned()),
        "BLANK" => Some(" \n".to_owned()),
        _ => None,
    };
    assert_eq!(read_env(&env, "PADDED").as_deref(), Some("value"));
    assert_eq!(read_env(&env, "BLANK"), None);
    assert_eq!(read_env(&env, "UNSET"), None);
}

/// Neither SDK clamps a server's `retry-after`, so neither does the transport.
#[test]
fn obeys_a_long_retry_after_unclamped() {
    let mut headers = HeaderMap::new();
    headers.insert("retry-after", HeaderValue::from_static("86400"));
    assert_eq!(retry_delay(Some(&headers), 2, 2, &|| 0.0), Duration::from_secs(86_400));
}
