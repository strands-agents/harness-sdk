//! Client construction and region configuration tests, against the AWS SDK client the provider
//! builds, plus end-to-end calls through the SDK to a local HTTP responder.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use aws_config::{BehaviorVersion, SdkConfig};
use aws_credential_types::Credentials;
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_sdk_bedrockruntime::config::Region;
use aws_smithy_types::retry::RetryConfig;
use serde_json::json;

use super::*;
use crate::models::bedrock::transport::{ClientOptions, SdkTransport, build_client};

fn options(sdk_config: Option<SdkConfig>) -> ClientOptions {
    ClientOptions {
        region: None,
        endpoint_url: None,
        credentials_provider: None,
        sdk_config,
        request_timeout: Duration::from_secs(5),
        api_key: None,
    }
}

fn shared_config(region: Option<&'static str>) -> SdkConfig {
    let mut builder = SdkConfig::builder()
        .behavior_version(BehaviorVersion::latest())
        .retry_config(RetryConfig::standard().with_max_attempts(1))
        .credentials_provider(SharedCredentialsProvider::new(Credentials::new(
            "test-access-key",
            "test-secret-key",
            None,
            None,
            "strands-test",
        )));
    if let Some(region) = region {
        builder = builder.region(Region::from_static(region));
    }
    builder.build()
}

#[tokio::test]
async fn uses_explicit_region_when_provided() {
    let client = build_client(&ClientOptions {
        region: Some("eu-west-1".into()),
        ..options(Some(shared_config(Some("us-east-1"))))
    })
    .await;
    assert_eq!(client.config().region().map(Region::as_ref), Some("eu-west-1"));
}

#[tokio::test]
async fn uses_the_shared_config_region() {
    let client = build_client(&options(Some(shared_config(Some("ap-southeast-2"))))).await;
    assert_eq!(client.config().region().map(Region::as_ref), Some("ap-southeast-2"));
}

#[tokio::test]
async fn defaults_to_us_west_2_when_region_is_missing() {
    let client = build_client(&options(Some(shared_config(None)))).await;
    assert_eq!(client.config().region().map(Region::as_ref), Some("us-west-2"));
}

#[tokio::test]
async fn identifies_the_sdk_in_the_user_agent() {
    let client = build_client(&options(Some(shared_config(None)))).await;
    assert_eq!(
        client.config().app_name().map(ToString::to_string).as_deref(),
        Some("strands-agents-rust-sdk")
    );
}

/// A canned HTTP response: status, headers and body.
type CannedResponse = (u16, Vec<(&'static str, String)>, Vec<u8>);

/// One recorded HTTP request.
#[derive(Debug)]
struct Recorded {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Serves one canned response per connection and reports each request it read.
fn responder(responses: Vec<CannedResponse>) -> (String, mpsc::Receiver<Recorded>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for (status, headers, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut recorded_headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                let (key, value) = line.split_once(':').unwrap();
                recorded_headers.push((key.trim().to_owned(), value.trim().to_owned()));
            }
            let length = recorded_headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map_or(0, |(_, value)| value.parse::<usize>().unwrap());
            let mut request_body = vec![0; length];
            reader.read_exact(&mut request_body).unwrap();
            sender
                .send(Recorded {
                    request_line: request_line.trim_end().to_owned(),
                    headers: recorded_headers,
                    body: request_body,
                })
                .unwrap();
            let mut response = format!(
                "HTTP/1.1 {status} OK\r\ncontent-length: {}\r\nconnection: close\r\n",
                body.len()
            );
            for (key, value) in headers {
                response.push_str(&format!("{key}: {value}\r\n"));
            }
            response.push_str("\r\n");
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
            stream.flush().unwrap();
        }
    });
    (address, receiver)
}

fn transport_for(endpoint: &str, api_key: Option<&str>) -> SdkTransport {
    SdkTransport::new(ClientOptions {
        endpoint_url: Some(endpoint.to_owned()),
        api_key: api_key.map(str::to_owned),
        ..options(Some(shared_config(Some("us-east-1"))))
    })
}

fn json_response(body: &JsonValue) -> CannedResponse {
    (
        200,
        vec![("content-type", "application/json".to_owned())],
        body.to_string().into_bytes(),
    )
}

fn formatted_request() -> JsonObject {
    let JsonValue::Object(request) = json!({
        "modelId": "us.amazon.nova-lite-v1:0",
        "messages": [{"role": "user", "content": [{"text": "Hello"}]}],
        "toolConfig": {"tools": [{"toolSpec": {"name": "t", "description": "d", "inputSchema": {"json": {
            "type": "object", "properties": {"zeta": {"type": "string"}, "alpha": {"type": "string"}, "mid": {"type": "string"}}
        }}}}]},
        "inferenceConfig": {"maxTokens": 10},
        "MyExtraArg": "dropped"
    }) else {
        unreachable!()
    };
    request
}

#[tokio::test]
async fn sends_the_formatted_json_as_the_converse_body_in_order() {
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hi"}, {"toolUse": {"toolUseId": "t1", "name": "t", "input": {"a": 1}}}]}},
        "stopReason": "tool_use",
        "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5},
        "metrics": {"latencyMs": 12}
    });
    let (endpoint, requests) = responder(vec![json_response(&output)]);
    let transport = transport_for(&endpoint, None);
    let response = transport.converse(formatted_request()).await.unwrap();
    let recorded = requests.recv().unwrap();
    assert_eq!(
        recorded.request_line,
        "POST /model/us.amazon.nova-lite-v1%3A0/converse HTTP/1.1"
    );
    assert_eq!(
        String::from_utf8(recorded.body.clone()).unwrap(),
        r#"{"messages":[{"role":"user","content":[{"text":"Hello"}]}],"toolConfig":{"tools":[{"toolSpec":{"name":"t","description":"d","inputSchema":{"json":{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"string"},"mid":{"type":"string"}}}}}}]},"inferenceConfig":{"maxTokens":10}}"#
    );
    assert!(
        recorded
            .header("authorization")
            .unwrap()
            .starts_with("AWS4-HMAC-SHA256")
    );
    assert!(
        recorded
            .header("x-amz-user-agent")
            .unwrap_or_default()
            .contains("app/strands-agents-rust-sdk")
            || recorded
                .header("user-agent")
                .unwrap_or_default()
                .contains("app/strands-agents-rust-sdk")
    );
    assert_eq!(JsonValue::Object(response), output);
}

#[tokio::test]
async fn adds_api_key_bearer_authentication_when_api_key_is_provided() {
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hi"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    });
    let (endpoint, requests) = responder(vec![json_response(&output)]);
    let transport = transport_for(&endpoint, Some("br-test-key"));
    transport.converse(formatted_request()).await.unwrap();
    assert_eq!(
        requests.recv().unwrap().header("authorization"),
        Some("Bearer br-test-key")
    );
}

#[tokio::test]
async fn maps_a_service_error_to_its_name_and_message() {
    let (endpoint, _requests) = responder(vec![(
        400,
        vec![
            ("x-amzn-errortype", "ValidationException".to_owned()),
            ("content-type", "application/json".to_owned()),
        ],
        br#"{"message":"The provided model identifier is invalid."}"#.to_vec(),
    )]);
    let transport = transport_for(&endpoint, None);
    let Err(error) = transport.converse(formatted_request()).await else {
        panic!("expected an error");
    };
    assert_eq!(error.name, "ValidationException");
    assert_eq!(error.message, "The provided model identifier is invalid.");
}

#[tokio::test]
async fn maps_a_connection_failure_to_a_network_error() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let transport = transport_for(&endpoint, None);
    let Err(error) = transport.converse(formatted_request()).await else {
        panic!("expected an error");
    };
    assert_eq!(error.kind, crate::models::bedrock::transport::BedrockErrorKind::Network);
    assert_eq!(crate::Error::from(error).name(), "ModelNetworkError");
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFF_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// Encodes one AWS event-stream message with string headers.
fn frame(headers: &[(&str, &str)], payload: &[u8]) -> Vec<u8> {
    let mut encoded_headers = Vec::new();
    for (name, value) in headers {
        encoded_headers.push(u8::try_from(name.len()).unwrap());
        encoded_headers.extend_from_slice(name.as_bytes());
        encoded_headers.push(7);
        encoded_headers.extend_from_slice(&u16::try_from(value.len()).unwrap().to_be_bytes());
        encoded_headers.extend_from_slice(value.as_bytes());
    }
    let total = u32::try_from(12 + encoded_headers.len() + payload.len() + 4).unwrap();
    let mut message = Vec::new();
    message.extend_from_slice(&total.to_be_bytes());
    message.extend_from_slice(&u32::try_from(encoded_headers.len()).unwrap().to_be_bytes());
    let prelude_crc = crc32(&message);
    message.extend_from_slice(&prelude_crc.to_be_bytes());
    message.extend_from_slice(&encoded_headers);
    message.extend_from_slice(payload);
    let message_crc = crc32(&message);
    message.extend_from_slice(&message_crc.to_be_bytes());
    message
}

fn event(event_type: &str, payload: &JsonValue) -> Vec<u8> {
    frame(
        &[
            (":message-type", "event"),
            (":event-type", event_type),
            (":content-type", "application/json"),
        ],
        payload.to_string().as_bytes(),
    )
}

fn exception(exception_type: &str, message: &str) -> Vec<u8> {
    frame(
        &[
            (":message-type", "exception"),
            (":exception-type", exception_type),
            (":content-type", "application/json"),
        ],
        json!({"message": message}).to_string().as_bytes(),
    )
}

fn event_stream_response(frames: &[Vec<u8>]) -> CannedResponse {
    (
        200,
        vec![("content-type", "application/vnd.amazon.eventstream".to_owned())],
        frames.concat(),
    )
}

async fn chunks(transport: &SdkTransport) -> Vec<Result<JsonValue, String>> {
    let mut stream = transport.converse_stream(formatted_request()).await.unwrap();
    let mut chunks = Vec::new();
    while let Some(chunk) = stream.next().await {
        chunks.push(chunk.map(JsonValue::Object).map_err(|error| error.to_string()));
    }
    chunks
}

#[tokio::test]
async fn streams_converse_stream_events_as_json_chunks() {
    let frames = vec![
        event("messageStart", &json!({"role": "assistant"})),
        event(
            "contentBlockStart",
            &json!({"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": "t1", "name": "calc"}}}),
        ),
        event(
            "contentBlockDelta",
            &json!({"contentBlockIndex": 0, "delta": {"toolUse": {"input": "{\"a\":1}"}}}),
        ),
        event("contentBlockStop", &json!({"contentBlockIndex": 0})),
        event(
            "contentBlockDelta",
            &json!({"contentBlockIndex": 1, "delta": {"reasoningContent": {"redactedContent": "AQID"}}}),
        ),
        event(
            "messageStop",
            &json!({"stopReason": "tool_use", "additionalModelResponseFields": {"k": "v"}}),
        ),
        event(
            "metadata",
            &json!({
                "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5, "cacheReadInputTokens": 1},
                "metrics": {"latencyMs": 9},
                "trace": {"guardrail": {"modelOutput": ["x"], "inputAssessment": {"g1": {"topicPolicy": {"topics": [
                    {"name": "t", "type": "DENY", "action": "BLOCKED", "detected": true}
                ]}}}}}
            }),
        ),
    ];
    let (endpoint, requests) = responder(vec![event_stream_response(&frames)]);
    let transport = transport_for(&endpoint, None);
    let chunks = chunks(&transport).await;
    assert_eq!(
        requests.recv().unwrap().request_line,
        "POST /model/us.amazon.nova-lite-v1%3A0/converse-stream HTTP/1.1"
    );
    let chunks: Vec<JsonValue> = chunks.into_iter().map(Result::unwrap).collect();
    assert_eq!(
        chunks,
        [
            json!({"messageStart": {"role": "assistant"}}),
            json!({"contentBlockStart": {"start": {"toolUse": {"toolUseId": "t1", "name": "calc"}}, "contentBlockIndex": 0}}),
            json!({"contentBlockDelta": {"delta": {"toolUse": {"input": "{\"a\":1}"}}, "contentBlockIndex": 0}}),
            json!({"contentBlockStop": {"contentBlockIndex": 0}}),
            json!({"contentBlockDelta": {"delta": {"reasoningContent": {"redactedContent": "AQID"}}, "contentBlockIndex": 1}}),
            json!({"messageStop": {"stopReason": "tool_use", "additionalModelResponseFields": {"k": "v"}}}),
            json!({"metadata": {
                "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5, "cacheReadInputTokens": 1},
                "metrics": {"latencyMs": 9},
                "trace": {"guardrail": {"modelOutput": ["x"], "inputAssessment": {"g1": {"topicPolicy": {"topics": [
                    {"name": "t", "type": "DENY", "action": "BLOCKED", "detected": true}
                ]}}}}}
            }}),
        ]
    );
}

#[tokio::test]
async fn turns_an_in_stream_throttling_exception_into_its_chunk() {
    let frames = vec![
        event("messageStart", &json!({"role": "assistant"})),
        exception("throttlingException", "Rate exceeded"),
    ];
    let (endpoint, _requests) = responder(vec![event_stream_response(&frames)]);
    let transport = transport_for(&endpoint, None);
    assert_eq!(
        chunks(&transport).await,
        [
            Ok(json!({"messageStart": {"role": "assistant"}})),
            Ok(json!({"throttlingException": {"message": "Rate exceeded"}}))
        ]
    );
}

#[tokio::test]
async fn streams_through_the_provider_end_to_end() {
    let frames = vec![
        event("messageStart", &json!({"role": "assistant"})),
        event(
            "contentBlockDelta",
            &json!({"contentBlockIndex": 0, "delta": {"text": "Hi"}}),
        ),
        event("contentBlockStop", &json!({"contentBlockIndex": 0})),
        event("messageStop", &json!({"stopReason": "end_turn"})),
        event(
            "metadata",
            &json!({"usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}, "metrics": {"latencyMs": 9}}),
        ),
    ];
    let (endpoint, requests) = responder(vec![event_stream_response(&frames)]);
    let model = crate::models::bedrock::BedrockModel::builder()
        .model_id("us.amazon.nova-lite-v1:0")
        .endpoint_url(endpoint)
        .sdk_config(shared_config(Some("us-east-1")))
        .build();
    let mut stream = model.stream_aggregated(request(hello(), Options::default()));
    let mut text = None;
    while let Some(item) = stream.next().await {
        if let crate::models::AggregatedEvent::Done(done) = item.unwrap() {
            text = Some(done.message.text());
        }
    }
    assert_eq!(text.as_deref(), Some("Hi"));
    let body: JsonValue = serde_json::from_slice(&requests.recv().unwrap().body).unwrap();
    assert_eq!(
        body["messages"],
        json!([{"role": "user", "content": [{"text": "Hello"}]}])
    );
}

#[tokio::test]
async fn turns_sdk_stall_detection_off_so_the_request_timeout_governs_inactivity() {
    let client = build_client(&options(Some(shared_config(None)))).await;
    let protection = client
        .config()
        .stalled_stream_protection()
        .expect("a stall protection setting");
    assert!(!protection.is_enabled());
}

#[test]
fn applies_a_default_120s_request_timeout() {
    assert_eq!(
        crate::models::bedrock::DEFAULT_REQUEST_TIMEOUT,
        Duration::from_secs(120)
    );
}

#[tokio::test]
async fn passes_custom_credentials_to_client() {
    let output = json!({
        "output": {"message": {"role": "assistant", "content": [{"text": "Hi"}]}},
        "stopReason": "end_turn",
        "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}
    });
    let (endpoint, requests) = responder(vec![json_response(&output)]);
    let credentials = Credentials::new("custom-access-key", "custom-secret-key", None, None, "custom");
    let transport = SdkTransport::new(ClientOptions {
        endpoint_url: Some(endpoint),
        credentials_provider: Some(SharedCredentialsProvider::new(credentials)),
        ..options(Some(shared_config(Some("us-west-2"))))
    });
    transport.converse(formatted_request()).await.unwrap();
    let authorization = requests.recv().unwrap().header("authorization").unwrap().to_owned();
    assert!(
        authorization.contains("Credential=custom-access-key/"),
        "{authorization}"
    );
}

fn attempt_timeout(client: &aws_sdk_bedrockruntime::Client) -> Option<Duration> {
    client
        .config()
        .timeout_config()
        .and_then(aws_smithy_types::timeout::TimeoutConfig::operation_attempt_timeout)
}

#[tokio::test]
async fn applies_the_request_timeout_option_to_the_default_request_handler() {
    let client = build_client(&ClientOptions {
        request_timeout: Duration::from_secs(600),
        ..options(Some(shared_config(None)))
    })
    .await;
    assert_eq!(attempt_timeout(&client), Some(Duration::from_secs(600)));
}

#[tokio::test]
async fn falls_back_to_the_default_when_request_timeout_is_explicitly_undefined() {
    let options = crate::models::bedrock::client_options(crate::models::bedrock::BedrockModelOptions {
        region: Some("us-west-2".into()),
        request_timeout: None,
        sdk_config: Some(shared_config(None)),
        ..Default::default()
    });
    assert_eq!(options.request_timeout, Duration::from_secs(120));
    let client = build_client(&options).await;
    assert_eq!(attempt_timeout(&client), Some(Duration::from_secs(120)));
}

#[tokio::test]
async fn lets_the_request_timeout_option_take_precedence_over_client_config_request_handler() {
    let timeouts = aws_smithy_types::timeout::TimeoutConfig::builder()
        .operation_attempt_timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(1))
        .build();
    let sdk_config = shared_config(None).into_builder().timeout_config(timeouts).build();
    let client = build_client(&ClientOptions {
        request_timeout: Duration::from_secs(600),
        ..options(Some(sdk_config))
    })
    .await;
    let config = client.config().timeout_config().expect("a timeout config");
    assert_eq!(config.operation_attempt_timeout(), Some(Duration::from_secs(600)));
    assert_eq!(config.connect_timeout(), Some(Duration::from_secs(1)));
}

/// Accepts connections without ever answering, adding a permit to `accepted` for each.
fn silent_listener(accepted: Arc<tokio::sync::Semaphore>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            held.push(stream);
            accepted.add_permits(1);
        }
    });
    address
}

/// The SDK's sleeper: a sleep of the attempt timeout ends once the server has accepted another
/// connection, so each attempt times out after reaching the server; every other sleep (retry
/// backoff) ends at once. Nothing waits for real.
#[derive(Debug)]
struct GatedSleep {
    attempt_timeout: Duration,
    accepted: Arc<tokio::sync::Semaphore>,
    timeouts: Arc<std::sync::atomic::AtomicUsize>,
}

impl aws_sdk_bedrockruntime::config::AsyncSleep for GatedSleep {
    fn sleep(&self, duration: Duration) -> aws_sdk_bedrockruntime::config::Sleep {
        if duration != self.attempt_timeout {
            return aws_sdk_bedrockruntime::config::Sleep::new(async {});
        }
        self.timeouts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let accepted = Arc::clone(&self.accepted);
        aws_sdk_bedrockruntime::config::Sleep::new(async move {
            if let Ok(permit) = accepted.acquire().await {
                permit.forget();
            }
        })
    }
}

/// `request_timeout` is per attempt: an attempt that times out is retried with the full timeout
/// again, rather than the timeout ending the whole retry loop.
#[tokio::test]
async fn times_out_each_attempt_and_retries_with_the_full_timeout() {
    let request_timeout = Duration::from_secs(7);
    let accepted = Arc::new(tokio::sync::Semaphore::new(0));
    let timeouts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let endpoint = silent_listener(Arc::clone(&accepted));
    let sleep = GatedSleep {
        attempt_timeout: request_timeout,
        accepted,
        timeouts: Arc::clone(&timeouts),
    };
    let sdk_config = shared_config(Some("us-east-1"))
        .into_builder()
        .retry_config(RetryConfig::standard().with_max_attempts(3))
        .timeout_config(
            aws_smithy_types::timeout::TimeoutConfig::builder()
                .disable_connect_timeout()
                .build(),
        )
        .sleep_impl(aws_sdk_bedrockruntime::config::SharedAsyncSleep::new(sleep))
        .build();
    let transport = SdkTransport::new(ClientOptions {
        endpoint_url: Some(endpoint),
        request_timeout,
        ..options(Some(sdk_config))
    });
    let Err(error) = transport.converse(formatted_request()).await else {
        panic!("the request should time out");
    };
    assert_eq!(
        error.kind,
        crate::models::bedrock::transport::BedrockErrorKind::Network,
        "{error}"
    );
    assert_eq!(timeouts.load(std::sync::atomic::Ordering::SeqCst), 3);
}
