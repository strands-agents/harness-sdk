//! These tests fetch from a [`TestServer`] on a local port and run a real analyst on a
//! [`MockModel`].

use super::*;
use crate::agent::InvokeLimits;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::models::streaming::Usage;
use crate::testing::{MockModel, MockTurn};
use crate::tools::Tool;
use crate::types::ReasoningBlock;
use crate::vended_tools::test_support::{
    RecordedRequest, Reply, TestServer, agent, direct_client, error_text, ok_text, run_with_signal, text,
};

fn markdown_tool(options: MakeWebFetchOptions) -> FunctionTool {
    let options = MakeWebFetchOptions {
        mode: Some(WebFetchMode::Markdown),
        ..options
    };
    make_web_fetch_with(options, LazyClient::with(direct_client())).unwrap()
}

fn agentic_tool(model: Option<MockModel>, options: MakeWebFetchOptions) -> FunctionTool {
    let options = MakeWebFetchOptions {
        model: model.map(|model| Arc::new(model) as Arc<dyn Model>),
        ..options
    };
    make_web_fetch_with(options, LazyClient::with(direct_client())).unwrap()
}

async fn serve(content_type: &'static str, body: &'static [u8]) -> TestServer {
    TestServer::start(move |_| Reply::ok(content_type, body.to_vec())).await
}

fn last_prompt(model: &MockModel) -> String {
    let request = model.requests().pop().unwrap();
    request.messages.last().unwrap().text()
}

#[test]
fn defaults_to_agentic_mode() {
    let tool = make_web_fetch(MakeWebFetchOptions::default()).unwrap();
    assert_eq!(tool.description(), WEB_FETCH_DESCRIPTION_AGENTIC);
    assert_eq!(web_fetch().name(), "web_fetch");
}

#[test]
fn markdown_mode_uses_markdown_description() {
    let tool = make_web_fetch(MakeWebFetchOptions::builder().mode(WebFetchMode::Markdown).build()).unwrap();
    assert_eq!(tool.description(), WEB_FETCH_DESCRIPTION_MARKDOWN);
}

#[test]
fn custom_name_and_description_override_defaults() {
    let tool = make_web_fetch(
        MakeWebFetchOptions::builder()
            .name("fetch_page")
            .description("custom desc")
            .build(),
    )
    .unwrap();
    assert_eq!(tool.name(), "fetch_page");
    assert_eq!(tool.description(), "custom desc");
}

#[test]
fn rejects_non_positive_limits() {
    let error = make_web_fetch(MakeWebFetchOptions::builder().max_bytes(0).build()).unwrap_err();
    assert!(error.to_string().contains("maxBytes"));
    let error = make_web_fetch(MakeWebFetchOptions::builder().max_content_chars(0).build()).unwrap_err();
    assert!(error.to_string().contains("maxContentChars"));
}

#[test]
fn exports_correct_default_constants() {
    assert_eq!(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
    assert_eq!(DEFAULT_MAX_CONTENT_CHARS, 50_000);
}

#[tokio::test]
async fn html_response_is_converted_to_markdown() {
    let server = serve("text/html", b"<h1>Hi</h1>").await;
    let result = ok_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": server.url}),
        &agent(),
    )
    .await;
    assert_eq!(result, "# Hi\n");
}

#[tokio::test]
async fn xml_content_type_is_also_converted_to_markdown() {
    let server = serve("application/xhtml+xml", b"<p>xhtml</p>").await;
    let result = ok_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": server.url}),
        &agent(),
    )
    .await;
    assert_eq!(result, "xhtml\n");
}

#[tokio::test]
async fn non_html_response_is_returned_as_is() {
    let server = serve("text/plain", b"plain text response").await;
    let url = format!("{}/robots.txt", server.url);
    let result = ok_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": url}),
        &agent(),
    )
    .await;
    assert_eq!(result, "plain text response");
}

#[tokio::test]
async fn content_is_truncated_at_max_content_chars() {
    let server = TestServer::start(|_| Reply::ok("text/plain", "x".repeat(200))).await;
    let tool = markdown_tool(MakeWebFetchOptions::builder().max_content_chars(50).build());
    let result = ok_text(&tool, json!({"url": server.url}), &agent()).await;
    assert_eq!(result, format!("{}\n\n[content truncated]", "x".repeat(50)));
}

#[tokio::test]
async fn rejects_non_http_scheme_and_invalid_url() {
    let tool = markdown_tool(MakeWebFetchOptions::default());
    let message = error_text(&tool, json!({"url": "file:///etc/passwd"}), &agent()).await;
    assert_eq!(
        message,
        "url=<file:///etc/passwd> | fetch failed: only http and https URLs are supported"
    );
    let message = error_text(&tool, json!({"url": "not a url"}), &agent()).await;
    assert_eq!(message, "url=<not a url> | fetch failed: invalid URL");
}

#[tokio::test]
async fn rejects_4xx_status() {
    let server = TestServer::start(|_| Reply::status("404 Not Found", "text/plain", "Not Found")).await;
    let url = format!("{}/missing", server.url);
    let message = error_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": url}),
        &agent(),
    )
    .await;
    assert_eq!(message, format!("HTTP 404 Not Found: GET {url}"));
}

#[tokio::test]
async fn rejects_response_body_exceeding_max_bytes() {
    let server = TestServer::start(|_| Reply::ok("text/plain", vec![b'a'; 101])).await;
    let tool = markdown_tool(MakeWebFetchOptions::builder().max_bytes(100).build());
    let message = error_text(&tool, json!({"url": server.url}), &agent()).await;
    assert_eq!(
        message,
        "Response body exceeded max_bytes=100. Refusing to buffer more."
    );
}

#[tokio::test]
async fn wraps_network_errors() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    drop(listener);
    let message = error_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": url}),
        &agent(),
    )
    .await;
    assert!(
        message.starts_with(&format!("url=<{url}> | fetch failed: ")),
        "{message}"
    );
}

#[tokio::test]
async fn throws_on_abort_signal() {
    let handle = CancelHandle::new();
    let canceller = handle.clone();
    let server = TestServer::start(move |_| {
        canceller.cancel(CancelOptions::default());
        Reply::Hang
    })
    .await;
    let tool = markdown_tool(MakeWebFetchOptions::default());
    let result = run_with_signal(&tool, json!({"url": server.url}), &agent(), handle.signal()).await;
    assert_eq!(text(&result), "Error: Web fetch tool request cancelled");
}

#[tokio::test]
async fn decodes_response_body_using_charset_from_content_type() {
    let server = serve(
        "text/plain; charset=iso-8859-1",
        &[0x3c, 0x70, 0x3e, 0xa9, 0x3c, 0x2f, 0x70, 0x3e],
    )
    .await;
    let result = ok_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": server.url}),
        &agent(),
    )
    .await;
    assert_eq!(result, "<p>\u{a9}</p>");
}

#[tokio::test]
async fn sends_correct_user_agent_header() {
    let server = serve("text/plain", b"ok").await;
    ok_text(
        &markdown_tool(MakeWebFetchOptions::default()),
        json!({"url": server.url}),
        &agent(),
    )
    .await;
    let request: RecordedRequest = server.requests().remove(0);
    assert_eq!(request.header("user-agent"), Some("strands-agents-web-fetch/1.0"));
    assert_eq!(
        request.header("accept"),
        Some("text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
    );
}

#[tokio::test]
async fn requires_a_non_empty_prompt() {
    let server = serve("text/html", b"<p>content</p>").await;
    let tool = agentic_tool(Some(MockModel::new()), MakeWebFetchOptions::default());
    let message = error_text(&tool, json!({"url": server.url, "prompt": "   "}), &agent()).await;
    assert_eq!(message, "web_fetch: agentic mode requires a non-empty prompt.");
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn uses_factory_model_when_provided() {
    let server = serve("text/html", b"<p>page content</p>").await;
    let model = MockModel::new().with_turn("the answer");
    let tool = agentic_tool(Some(model.clone()), MakeWebFetchOptions::default());
    let result = ok_text(&tool, json!({"url": server.url, "prompt": "What is this?"}), &agent()).await;
    assert_eq!(result, "the answer");
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test]
async fn falls_back_to_host_agent_aux_model() {
    let server = serve("text/html", b"<p>page content</p>").await;
    let aux = MockModel::new().with_turn("host answer");
    let host = agent().with_aux_model(Some(Arc::new(aux.clone())));
    let tool = agentic_tool(None, MakeWebFetchOptions::default());
    let result = ok_text(&tool, json!({"url": server.url, "prompt": "Summarize"}), &host).await;
    assert_eq!(result, "host answer");
    assert_eq!(aux.requests().len(), 1);
}

#[tokio::test]
async fn passes_prompt_and_page_content_to_analyst() {
    let server = serve("text/plain", b"page content").await;
    let model = MockModel::new().with_turn("the answer");
    let tool = agentic_tool(Some(model.clone()), MakeWebFetchOptions::default());
    let result = ok_text(
        &tool,
        json!({"url": server.url, "prompt": "What is this about?"}),
        &agent(),
    )
    .await;
    assert_eq!(result, "the answer");
    assert_eq!(
        last_prompt(&model),
        format!(
            "URL: {}\n\nRequest: What is this about?\n\n--- Content ---\npage content",
            server.url
        )
    );
    let system_prompt = model.requests()[0].system_prompt.clone().unwrap();
    assert_eq!(serde_json::to_value(system_prompt).unwrap(), json!(ANALYST_PROMPT));
}

#[tokio::test]
async fn strips_reasoning_blocks_from_analyst_result() {
    let server = serve("text/plain", b"page content").await;
    let model = MockModel::new().with_turn(MockTurn::content([
        ContentBlock::Reasoning(ReasoningBlock::new().with_text("internal chain-of-thought")),
        ContentBlock::text("the answer"),
    ]));
    let tool = agentic_tool(Some(model), MakeWebFetchOptions::default());
    let result = ok_text(&tool, json!({"url": server.url, "prompt": "Summarize"}), &agent()).await;
    assert_eq!(result, "the answer");
}

#[tokio::test]
async fn truncates_content_before_passing_to_analyst() {
    let server = TestServer::start(|_| Reply::ok("text/plain", "x".repeat(200))).await;
    let model = MockModel::new().with_turn("answer");
    let tool = agentic_tool(
        Some(model.clone()),
        MakeWebFetchOptions::builder().max_content_chars(50).build(),
    );
    ok_text(&tool, json!({"url": server.url, "prompt": "Summarize"}), &agent()).await;
    let prompt = last_prompt(&model);
    assert!(
        prompt.ends_with(&format!("{}\n\n[content truncated]", "x".repeat(50))),
        "{prompt}"
    );
}

#[tokio::test]
async fn wraps_analyst_error_with_url_context() {
    let server = serve("text/html", b"<p>content</p>").await;
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("analyst boom")));
    let tool = agentic_tool(Some(model), MakeWebFetchOptions::default());
    let message = error_text(&tool, json!({"url": server.url, "prompt": "Summarize"}), &agent()).await;
    assert!(
        message.starts_with(&format!("url=<{}> | web fetch analyst failed: ", server.url)),
        "{message}"
    );
    assert!(message.contains("analyst boom"), "{message}");
}

#[tokio::test]
async fn adds_the_analyst_usage_to_the_request_total_and_runs_it_past_a_spent_limit() {
    let server = serve("text/plain", b"page content").await;
    let model = MockModel::new().with_turn(MockTurn::text("the answer").with_usage(Usage::new(20, 6, 26)));
    let parent = InvocationContext::new(Some(InvokeLimits {
        turns: Some(1),
        ..InvokeLimits::default()
    }));
    for _ in 0..5 {
        parent.record_turn();
    }
    let host = agent().with_invocation_context(Some(parent.clone()));
    let tool = agentic_tool(Some(model), MakeWebFetchOptions::default());
    let result = ok_text(&tool, json!({"url": server.url, "prompt": "Summarize"}), &host).await;
    assert_eq!(result, "the answer");
    let usage = parent.usage();
    assert_eq!(usage.turns_taken, 5);
    assert_eq!(usage.usage, Usage::new(20, 6, 26));
}

#[test]
fn parses_charsets_like_the_ts_pattern() {
    assert_eq!(charset("text/html; charset=\"ISO-8859-1\""), "iso-8859-1");
    assert_eq!(charset("text/html; charset='utf-16le'; x=y"), "utf-16le");
    assert_eq!(charset("text/html;charset=Shift_JIS"), "shift_jis");
    assert_eq!(charset("text/html"), "utf-8");
    assert_eq!(charset("text/html; charset=;charset=latin1"), "latin1");
}

#[test]
fn parses_the_charset_after_non_ascii_text() {
    assert_eq!(charset("text/html; \u{130}; charset=iso-8859-1"), "iso-8859-1");
    assert_eq!(
        charset("text/html; \u{130}\u{130}\u{130}\u{130}\u{130}\u{130}\u{130}\u{130}\u{130}\u{130} charset="),
        "utf-8"
    );
    assert_eq!(charset("text/html; CHARSET=UTF-16LE"), "utf-16le");
    assert_eq!(charset("text/html; char\u{17F}et=latin1"), "utf-8");
}

#[test]
fn decodes_every_whatwg_label_of_windows_1252_and_utf_16() {
    for label in [
        "ansi_x3.4-1968",
        "cp819",
        "csisolatin1",
        "ibm819",
        "iso-ir-100",
        "iso88591",
        "iso_8859-1:1987",
        "x-cp1252",
    ] {
        assert_eq!(decode(&[0x80, 0xe9], label), "\u{20ac}\u{e9}", "{label}");
    }
    for label in ["csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff"] {
        assert_eq!(decode(&[b'h', 0, b'i', 0], label), "hi", "{label}");
    }
    assert_eq!(decode(&[0, b'h', 0, b'i'], "unicodefffe"), "hi");
}

#[test]
fn decodes_windows_1252_and_utf_16() {
    assert_eq!(decode(&[0x80, 0xe9], "windows-1252"), "\u{20ac}\u{e9}");
    assert_eq!(decode(&[0xff, 0xfe, b'h', 0, b'i', 0], "utf-16le"), "hi");
    assert_eq!(decode(b"\xEF\xBB\xBFhi \xFF", "utf-8"), "hi \u{FFFD}");
}

#[test]
fn truncates_at_utf_16_code_units_without_splitting_characters() {
    assert_eq!(truncate("ab\u{1F600}c".to_owned(), 3), "ab\n\n[content truncated]");
    assert_eq!(truncate("abc".to_owned(), 3), "abc");
}
