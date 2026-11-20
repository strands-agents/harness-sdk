//! These requests go to a [`TestServer`] on a local port.

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::types::ToolResultStatus;
use crate::vended_tools::test_support::{
    RecordedRequest, Reply, TestServer, agent, direct_client, error_text, ok_json, run_with_signal, text,
};

fn tool() -> FunctionTool {
    with_client(LazyClient::with(direct_client()))
}

async fn request(input: JsonValue) -> JsonValue {
    ok_json(&tool(), input, &agent()).await
}

#[tokio::test]
async fn returns_successful_response() {
    let cases = [
        ("GET", "200 OK", 200, "OK"),
        ("POST", "201 Created", 201, "Created"),
        ("PUT", "200 OK", 200, "OK"),
        ("DELETE", "200 OK", 200, "OK"),
        ("PATCH", "200 OK", 200, "OK"),
        ("HEAD", "200 OK", 200, "OK"),
        ("OPTIONS", "200 OK", 200, "OK"),
    ];
    for (method, status_line, status, status_text) in cases {
        let server =
            TestServer::start(move |_| Reply::status(status_line, "application/json", "{\"success\":true}")).await;
        let result = request(json!({"method": method, "url": format!("{}/resource", server.url)})).await;
        assert_eq!(result["status"], status, "{method}");
        assert_eq!(result["statusText"], status_text);
        assert_eq!(result["headers"]["content-type"], "application/json");
        let body = if method == "HEAD" { "" } else { "{\"success\":true}" };
        assert_eq!(result["body"], body);
        assert_eq!(server.requests()[0].method, method);
    }
}

#[tokio::test]
async fn sends_request_with_custom_headers_and_body() {
    let server = TestServer::start(|_| Reply::ok("application/json", "{\"id\":123}")).await;
    request(json!({
        "method": "POST",
        "url": format!("{}/users", server.url),
        "body": "{\"name\":\"test\"}",
        "headers": {"Content-Type": "application/json"}
    }))
    .await;
    let received = &server.requests()[0];
    assert_eq!((received.method.as_str(), received.path.as_str()), ("POST", "/users"));
    assert_eq!(received.header("content-type"), Some("application/json"));
    assert_eq!(received.body, b"{\"name\":\"test\"}");
}

#[tokio::test]
async fn handles_empty_and_string_response_bodies() {
    let server = TestServer::start(|request| {
        if request.path == "/empty" {
            Reply::status("204 No Content", "text/plain", "")
        } else {
            Reply::ok("text/plain", "Plain text response")
        }
    })
    .await;
    let empty = request(json!({"method": "DELETE", "url": format!("{}/empty", server.url)})).await;
    assert_eq!(empty["body"], "");
    let text = request(json!({"method": "GET", "url": format!("{}/text", server.url)})).await;
    assert_eq!(text["body"], "Plain text response");
}

#[tokio::test]
async fn converts_response_headers_to_plain_object() {
    let server = TestServer::start(|_| Reply::Respond {
        status: "200 OK",
        headers: vec![
            ("content-type", "application/json".to_owned()),
            ("x-custom-header", "value".to_owned()),
        ],
        body: b"{}".to_vec(),
    })
    .await;
    let result = request(json!({"method": "GET", "url": server.url})).await;
    assert_eq!(result["headers"]["content-type"], "application/json");
    assert_eq!(result["headers"]["x-custom-header"], "value");
    let names: Vec<&String> = result["headers"].as_object().unwrap().keys().collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

#[tokio::test]
async fn throws_error_for_non_2xx_status_codes() {
    let cases = [
        ("301 Moved Permanently", "HTTP 301 Moved Permanently"),
        ("404 Not Found", "HTTP 404 Not Found"),
        ("500 Internal Server Error", "HTTP 500 Internal Server Error"),
    ];
    for (status, expected) in cases {
        let server = TestServer::start(move |_| Reply::Respond {
            status,
            headers: Vec::new(),
            body: b"nope".to_vec(),
        })
        .await;
        let url = format!("{}/missing", server.url);
        let message = error_text(&tool(), json!({"method": "GET", "url": url}), &agent()).await;
        assert_eq!(message, format!("{expected}: GET {url}"));
    }
}

#[tokio::test(start_paused = true)]
async fn throws_timeout_error_when_request_exceeds_timeout() {
    let server = TestServer::start(|_| Reply::Hang).await;
    let message = error_text(
        &tool(),
        json!({"method": "GET", "url": server.url, "timeout": 0.1}),
        &agent(),
    )
    .await;
    assert_eq!(
        message,
        format!("Request timed out after 0.1 seconds: GET {}", server.url)
    );
}

#[tokio::test]
async fn throws_error_for_network_failures() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let result = crate::vended_tools::test_support::run(&tool(), json!({"method": "GET", "url": url}), &agent()).await;
    assert_eq!(result.status, ToolResultStatus::Error);
}

#[tokio::test]
async fn uses_context_cancel_signal_when_it_differs_from_the_agent_signal() {
    let handle = CancelHandle::new();
    let canceller = handle.clone();
    let server = TestServer::start(move |_| {
        canceller.cancel(CancelOptions::default());
        Reply::Hang
    })
    .await;
    let agent = agent();
    let result = run_with_signal(
        &tool(),
        json!({"method": "GET", "url": server.url}),
        &agent,
        handle.signal(),
    )
    .await;
    assert_eq!(text(&result), format!("Error: Request cancelled: GET {}", server.url));
    assert!(!agent.cancel_signal().is_cancelled());
}

#[tokio::test]
async fn rejects_invalid_input() {
    let message = error_text(&tool(), json!({"method": "FETCH", "url": "not a url"}), &agent()).await;
    assert!(message.contains("/method: Invalid option"), "{message}");
    assert!(message.contains("/url: Invalid URL"), "{message}");
}

#[tokio::test]
async fn rejects_a_body_on_get_and_head_as_fetch_does() {
    let server = TestServer::start(|_| Reply::ok("text/plain", "ok")).await;
    for method in ["GET", "HEAD"] {
        for body in ["x", ""] {
            let input = json!({"method": method, "url": server.url, "body": body});
            assert_eq!(
                error_text(&tool(), input, &agent()).await,
                "Request with GET/HEAD method cannot have body."
            );
        }
    }
    assert!(server.requests().is_empty());
}

fn redirects(request: &RecordedRequest) -> Reply {
    let remaining: usize = request.path.trim_start_matches("/r/").parse().unwrap_or(0);
    if remaining == 0 {
        return Reply::ok("text/plain", "arrived");
    }
    Reply::Respond {
        status: "302 Found",
        headers: vec![("location", format!("/r/{}", remaining - 1))],
        body: Vec::new(),
    }
}

#[tokio::test]
async fn follows_up_to_twenty_redirects_as_fetch_does() {
    let server = TestServer::start(redirects).await;
    let followed = request(json!({"method": "GET", "url": format!("{}/r/20", server.url)})).await;
    assert_eq!(followed["body"], "arrived");
    let result = crate::vended_tools::test_support::run(
        &tool(),
        json!({"method": "GET", "url": format!("{}/r/21", server.url)}),
        &agent(),
    )
    .await;
    assert_eq!(result.status, ToolResultStatus::Error);
}

#[tokio::test]
async fn decompresses_gzip_and_deflate_responses_as_fetch_does() {
    const GZIP: [u8; 30] = [
        31, 139, 8, 0, 0, 0, 0, 0, 2, 19, 203, 72, 205, 201, 201, 87, 72, 175, 202, 44, 0, 0, 25, 106, 210, 223, 10, 0,
        0, 0,
    ];
    const DEFLATE: [u8; 21] = [
        120, 156, 203, 72, 205, 201, 201, 87, 72, 73, 77, 203, 73, 44, 73, 5, 0, 35, 12, 5, 10,
    ];
    let server = TestServer::start(|request| {
        let (encoding, body) = if request.path == "/gzip" {
            ("gzip", GZIP.to_vec())
        } else {
            ("deflate", DEFLATE.to_vec())
        };
        Reply::Respond {
            status: "200 OK",
            headers: vec![
                ("content-type", "text/plain".to_owned()),
                ("content-encoding", encoding.to_owned()),
            ],
            body,
        }
    })
    .await;
    let gzip = request(json!({"method": "GET", "url": format!("{}/gzip", server.url)})).await;
    assert_eq!(gzip["body"], "hello gzip");
    let deflate = request(json!({"method": "GET", "url": format!("{}/deflate", server.url)})).await;
    assert_eq!(deflate["body"], "hello deflate");
    let accepted = server.requests()[0]
        .header("accept-encoding")
        .unwrap_or_default()
        .to_owned();
    for encoding in ["gzip", "deflate", "br"] {
        assert!(accepted.contains(encoding), "{accepted}");
    }
}
