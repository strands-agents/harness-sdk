//! These use a scripted [`MockModel`] summarizer, a fake sandbox, and local TCP servers for the
//! direct transport and the end-to-end run.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use serde_json::{Value, json};
use strands::agent::DirectToolCallOptions;
use strands::sandbox::{
    ExecuteOptions, ExecutionResult, ExecutionStream, FileInfo, NotASandboxLocalEnvironment, Sandbox,
};
use strands::testing::MockModel;
use strands::types::{ContentBlock, ToolResultContent};
use strands::{Agent, Error};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::sandbox::SHELL_PROBE;

#[derive(Clone)]
struct Response {
    body: Vec<u8>,
    content_type: String,
    url: String,
    exit_code: i32,
    stderr: String,
}

impl Default for Response {
    fn default() -> Self {
        Self {
            body: Vec::new(),
            content_type: "text/html".to_owned(),
            url: "https://example.com/final".to_owned(),
            exit_code: 0,
            stderr: String::new(),
        }
    }
}

/// A sandbox that answers the shell probe and returns `response` for any other command, as the
/// curl pipeline would print it: two trailer lines, then the base64 body.
struct FakeSandbox {
    response: Response,
    powershell: bool,
    fail: bool,
    commands: Mutex<Vec<String>>,
}

impl FakeSandbox {
    fn new(response: Response) -> Arc<Self> {
        Arc::new(Self {
            response,
            powershell: false,
            fail: false,
            commands: Mutex::new(Vec::new()),
        })
    }

    fn powershell(response: Response) -> Arc<Self> {
        Arc::new(Self {
            response,
            powershell: true,
            fail: false,
            commands: Mutex::new(Vec::new()),
        })
    }

    fn failing() -> Arc<Self> {
        Arc::new(Self {
            response: Response::default(),
            powershell: false,
            fail: true,
            commands: Mutex::new(Vec::new()),
        })
    }

    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }

    fn curl(&self) -> String {
        self.commands()
            .into_iter()
            .find(|command| command.contains("curl"))
            .unwrap()
    }

    fn render(&self) -> String {
        let encoded = base64::engine::general_purpose::STANDARD.encode(&self.response.body);
        let trailer = [self.response.content_type.as_str(), self.response.url.as_str()];
        if self.powershell {
            return format!("{}\r\n{encoded}\r\n", trailer.join("\r\n"));
        }
        let wrapped: Vec<String> = encoded
            .as_bytes()
            .chunks(76)
            .map(|chunk| String::from_utf8(chunk.to_vec()).unwrap())
            .collect();
        format!("{}\n{}\n", trailer.join("\n"), wrapped.join("\n"))
    }
}

#[async_trait]
impl Sandbox for FakeSandbox {
    fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    fn execute_code_streaming(&self, _code: &str, _language: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(futures::stream::empty())
    }

    async fn execute(&self, command: &str, _options: ExecuteOptions) -> strands::Result<ExecutionResult> {
        if self.fail {
            return Err(Error::other("sandbox gone"));
        }
        self.commands.lock().unwrap().push(command.to_owned());
        if command == SHELL_PROBE {
            let stdout = if self.powershell { "Desktop\r\n" } else { "\n" };
            return Ok(ExecutionResult::new(0, stdout, ""));
        }
        let stdout = if self.response.exit_code == 0 {
            self.render()
        } else {
            String::new()
        };
        Ok(ExecutionResult::new(
            self.response.exit_code,
            stdout,
            self.response.stderr.clone(),
        ))
    }

    async fn read_file(&self, _path: &str) -> strands::Result<Vec<u8>> {
        Err(Error::other("unsupported"))
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> strands::Result<()> {
        Err(Error::other("unsupported"))
    }

    async fn remove_file(&self, _path: &str) -> strands::Result<()> {
        Err(Error::other("unsupported"))
    }

    async fn list_files(&self, _path: &str) -> strands::Result<Vec<FileInfo>> {
        Err(Error::other("unsupported"))
    }
}

fn summarizer() -> Arc<MockModel> {
    Arc::new(MockModel::new().with_turn("summary answer").with_turn("summary answer"))
}

fn tool(model: &Arc<MockModel>, transport: WebFetchTransport) -> FunctionTool {
    let config = WebFetchConfig {
        transport: Some(transport),
        ..WebFetchConfig::default()
    };
    web_fetch_tool(config, Some(model.clone() as Arc<dyn Model>)).unwrap()
}

async fn invoke(tool: &FunctionTool, input: Value, sandbox: Arc<dyn Sandbox>) -> String {
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([tool.clone()])
        .sandbox(sandbox)
        .printer(false)
        .build()
        .unwrap();
    let result = agent
        .tool("web_fetch")
        .invoke_with(
            input,
            DirectToolCallOptions {
                record_direct_tool_call: Some(false),
            },
        )
        .await
        .unwrap();
    match result.content.as_slice() {
        [ToolResultContent::Text(text)] => text.text.clone(),
        other => panic!("expected text, got {other:?}"),
    }
}

fn prompts(model: &MockModel) -> Vec<String> {
    model
        .requests()
        .iter()
        .map(|request| {
            request.messages[0]
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text(text) => Some(text.text.clone()),
                    _ => None,
                })
                .collect::<String>()
        })
        .collect()
}

fn text_response(body: &str, content_type: &str) -> Response {
    Response {
        body: body.as_bytes().to_vec(),
        content_type: content_type.to_owned(),
        ..Response::default()
    }
}

#[tokio::test]
async fn reduces_html_to_text_and_answers_via_the_summarizer_model() {
    let sandbox = FakeSandbox::new(text_response(
        "<html><body><script>x=1</script><p>Hello  <b>world</b></p></body></html>",
        "text/html",
    ));
    let model = summarizer();
    let tool = tool(&model, WebFetchTransport::Curl);
    let answer = invoke(
        &tool,
        json!({"url": "https://example.com", "prompt": "What does it say?"}),
        sandbox,
    )
    .await;
    assert_eq!(answer, "summary answer");
    let prompt = &prompts(&model)[0];
    assert!(prompt.contains("What does it say?"));
    assert!(prompt.contains("Fetched URL: https://example.com/final"));
    assert!(prompt.contains("Hello world"));
    assert!(!prompt.contains("<script>"));
}

#[tokio::test]
async fn runs_curl_in_the_agent_sandbox_with_the_url_quoted_and_globbing_off_then_removes_the_body_file() {
    let sandbox = FakeSandbox::new(text_response("body", "text/plain"));
    let model = summarizer();
    let tool = tool(&model, WebFetchTransport::Curl);
    invoke(&tool, json!({"url": "https://example.com/a'b$(id);c"}), sandbox.clone()).await;
    let command = sandbox.curl();
    assert!(command.contains(r"'https://example.com/a'\''b$(id);c'"), "{command}");
    for flag in [
        "-g",
        "--fail",
        "--proto '=http,https'",
        "--proto-redir '=http,https'",
        "--max-time",
        "-o \"$f\"",
        "%{content_type}",
        "%{url_effective}",
        " -- '",
    ] {
        assert!(command.contains(flag), "{flag}");
    }
    assert_eq!(sandbox.commands(), [SHELL_PROBE.to_owned(), command.clone()]);
    assert!(command.starts_with("f=$(mktemp -t strands-web-fetch.XXXXXX) && "));
    assert!(command.ends_with("| base64; s=$?; rm -f \"$f\"; exit $s"));
}

#[tokio::test]
async fn handles_a_missing_content_type_without_shifting_the_trailer() {
    let sandbox = FakeSandbox::new(Response {
        body: b"a < b <i>".to_vec(),
        content_type: String::new(),
        url: "https://example.com/report.html".to_owned(),
        ..Response::default()
    });
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com"}), sandbox).await,
        "a < b <i>"
    );
}

#[tokio::test]
async fn truncates_the_body_in_the_sandbox_instead_of_rejecting_large_pages() {
    let sandbox = FakeSandbox::new(text_response("x", "text/html"));
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    invoke(&tool, json!({"url": "https://example.com"}), sandbox.clone()).await;
    assert!(sandbox.curl().contains("&& head -c 5242880 \"$f\" | base64"));
    assert!(!sandbox.curl().contains("--max-filesize"));
}

#[tokio::test]
async fn honours_the_response_charset_and_falls_back_to_utf_8_for_an_unknown_one() {
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    let latin1 = FakeSandbox::new(Response {
        body: vec![b'c', b'a', b'f', 0xe9],
        content_type: "text/plain; charset=ISO-8859-1".to_owned(),
        ..Response::default()
    });
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com/latin1"}), latin1).await,
        "café"
    );
    let unknown = FakeSandbox::new(text_response("é", "text/plain; charset=not-a-codec"));
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com/unknown"}), unknown).await,
        "é"
    );
}

#[tokio::test]
async fn returns_the_raw_page_content_when_no_prompt_is_given() {
    let sandbox = FakeSandbox::new(text_response("body text", "text/plain"));
    let model = summarizer();
    let tool = tool(&model, WebFetchTransport::Curl);
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com"}), sandbox.clone()).await,
        "body text"
    );
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com", "prompt": "   "}), sandbox).await,
        "body text"
    );
    assert_eq!(model.call_count(), 0);
}

#[tokio::test]
async fn reports_a_curl_failure_without_invoking_the_summarizer_and_still_cleans_up() {
    let sandbox = FakeSandbox::new(Response {
        exit_code: 22,
        stderr: "curl: (22) The requested URL returned error: 500\n".to_owned(),
        ..Response::default()
    });
    let model = summarizer();
    let tool = tool(&model, WebFetchTransport::Curl);
    let answer = invoke(
        &tool,
        json!({"url": "https://example.com", "prompt": "anything"}),
        sandbox.clone(),
    )
    .await;
    assert!(answer.contains("Failed to fetch https://example.com"));
    assert!(answer.contains("500"));
    assert_eq!(model.call_count(), 0);
    assert_eq!(sandbox.commands().len(), 2);
}

#[tokio::test]
async fn probes_the_shell_once_per_sandbox() {
    let sandbox = FakeSandbox::new(text_response("page", "text/plain"));
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    invoke(&tool, json!({"url": "https://example.com/a"}), sandbox.clone()).await;
    invoke(&tool, json!({"url": "https://example.com/b"}), sandbox.clone()).await;
    let commands = sandbox.commands();
    assert_eq!(commands.iter().filter(|command| *command == SHELL_PROBE).count(), 1);
    assert_eq!(commands.len(), 3);
}

#[tokio::test]
async fn runs_curl_exe_through_powershell_and_reads_crlf_output() {
    let sandbox = FakeSandbox::powershell(text_response("Hello wörld", "text/plain; charset=utf-8"));
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    assert_eq!(
        invoke(&tool, json!({"url": "https://example.com/it's"}), sandbox.clone()).await,
        "Hello wörld"
    );
    let command = sandbox.curl();
    assert!(
        command.contains("\n  curl.exe -sSL -g --fail --proto '=http,https' --proto-redir '=http,https' --max-time ")
    );
    assert_eq!(command.split("'https://example.com/it''s'").count(), 2);
    assert!(command.contains("$([guid]::NewGuid())"));
    assert!(command.contains("strands-web-fetch-"));
    assert!(command.contains(&format!(".ReadBytes([Math]::Min($in.Length, {}))", 5 * 1024 * 1024)));
    assert!(command.ends_with("exit $s"));
    assert!(command.contains("\n$s = 127\ntry {\n"));
    assert!(command.contains("} catch { if ($s -eq 0) { $s = 1 }; [Console]::Error.Write($_.Exception.Message) }"));
    assert_eq!(command.split("-LiteralPath").count(), 3);
    assert!(!command.contains("mktemp"));
    assert!(!command.contains("&&"));
}

#[tokio::test]
async fn reports_a_powershell_curl_failure() {
    let sandbox = FakeSandbox::powershell(Response {
        exit_code: 22,
        stderr: "curl: (22) The requested URL returned error: 404\r\n".to_owned(),
        ..Response::default()
    });
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    let answer = invoke(&tool, json!({"url": "https://example.com/missing"}), sandbox).await;
    assert!(Regex::new(r"\(22\).*404").unwrap().is_match(&answer), "{answer}");
}

#[tokio::test]
async fn reports_a_sandbox_failure_as_a_fetch_failure() {
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    let answer = invoke(&tool, json!({"url": "https://example.com"}), FakeSandbox::failing()).await;
    assert_eq!(answer, "Failed to fetch https://example.com: sandbox gone");
}

#[tokio::test]
async fn rejects_a_non_http_scheme_before_touching_the_sandbox() {
    let sandbox = FakeSandbox::new(Response::default());
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    let answer = invoke(
        &tool,
        json!({"url": "ftp://example.com/f", "prompt": "x"}),
        sandbox.clone(),
    )
    .await;
    assert!(answer.contains("only supports http"), "{answer}");
    assert!(sandbox.commands().is_empty());
}

#[tokio::test]
async fn rejects_the_malformed_url_before_touching_the_sandbox() {
    for url in [
        "https://example.com/a b",
        "https://example.com/x`id`",
        "https://example.com/\"x\"",
        "https://example.com/x\nrm -rf /",
        "https://example.com/{a,b}",
        "https://example.com/日本",
        "https:///no-host",
        "javascript:alert(1)",
        "",
    ] {
        let sandbox = FakeSandbox::new(Response::default());
        let tool = tool(&summarizer(), WebFetchTransport::Curl);
        let answer = invoke(&tool, json!({"url": url}), sandbox.clone()).await;
        assert!(answer.contains("Failed to fetch"), "{url}: {answer}");
        assert!(sandbox.commands().is_empty(), "{url}");
    }
}

#[tokio::test]
async fn accepts_rfc_3986_urls_and_trims_whitespace() {
    let sandbox = FakeSandbox::new(text_response("ok", "text/plain"));
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    assert_eq!(
        invoke(&tool, json!({"url": " https://e.com/a?b=c&d=%20#f "}), sandbox.clone()).await,
        "ok"
    );
    assert!(sandbox.curl().contains("'https://e.com/a?b=c&d=%20#f'"));
    assert_eq!(
        invoke(&tool, json!({"url": "http://[::1]:8080/x"}), sandbox).await,
        "ok"
    );
}

/// Serves each connection with `respond(path, request)`, which writes the whole response.
async fn serve<F, Fut>(respond: F) -> String
where
    F: Fn(String, String, tokio::net::TcpStream) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let respond = Arc::new(respond);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let respond = respond.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = socket.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_owned();
                respond(path, request, socket).await;
            });
        }
    });
    base
}

async fn reply(mut socket: tokio::net::TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body).await;
    let _ = socket.shutdown().await;
}

#[tokio::test]
async fn fetches_from_the_process_with_the_direct_transport_skipping_the_sandbox() {
    let agents: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = agents.clone();
    let base = serve(move |_path, request, socket| {
        let user_agent = request
            .lines()
            .find_map(|line| {
                line.strip_prefix("user-agent: ")
                    .or_else(|| line.strip_prefix("User-Agent: "))
            })
            .unwrap_or_default()
            .to_owned();
        seen.lock().unwrap().push(user_agent);
        async move {
            reply(
                socket,
                "200 OK",
                &[("Content-Type", "text/html; charset=utf-8".to_owned())],
                b"<p>Hi <b>there</b></p>",
            )
            .await;
        }
    })
    .await;
    let sandbox = FakeSandbox::new(Response::default());
    let tool = tool(&summarizer(), WebFetchTransport::Direct);
    assert_eq!(
        invoke(&tool, json!({"url": format!("{base}/")}), sandbox.clone()).await,
        "Hi there"
    );
    assert_eq!(*agents.lock().unwrap(), ["strands-harness/1.0"]);
    assert!(sandbox.commands().is_empty());
    let answer = invoke(&tool, json!({"url": format!("{base}/a b")}), sandbox).await;
    assert!(answer.contains("Failed to fetch"));
    assert_eq!(agents.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn caps_a_direct_transport_body_without_buffering_the_rest_of_the_stream() {
    let chunks = Arc::new(AtomicUsize::new(0));
    let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
    let closed_tx = Arc::new(Mutex::new(Some(closed_tx)));
    let sent = chunks.clone();
    let base = serve(move |_path, _request, mut socket| {
        let (sent, closed) = (sent.clone(), closed_tx.clone());
        async move {
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n";
            if socket.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            let chunk = vec![b'x'; 64 * 1024];
            loop {
                let frame = [
                    format!("{:x}\r\n", chunk.len()).into_bytes(),
                    chunk.clone(),
                    b"\r\n".to_vec(),
                ]
                .concat();
                if socket.write_all(&frame).await.is_err() {
                    if let Some(closed) = closed.lock().unwrap().take() {
                        let _ = closed.send(());
                    }
                    return;
                }
                if sent.fetch_add(1, Ordering::SeqCst) > 10_000 {
                    return;
                }
            }
        }
    })
    .await;
    let tool = tool(&summarizer(), WebFetchTransport::Direct);
    let text = invoke(
        &tool,
        json!({"url": format!("{base}/endless")}),
        FakeSandbox::new(Response::default()),
    )
    .await;
    assert_eq!(text, "x".repeat(50_000));
    tokio::time::timeout(Duration::from_secs(30), closed_rx)
        .await
        .expect("the server saw the stream cancelled")
        .unwrap();
    assert!(chunks.load(Ordering::SeqCst) < 1000);
}

#[test]
fn rejects_an_unknown_transport() {
    let error = serde_json::from_value::<WebFetchTransport>(json!("wget")).unwrap_err();
    assert!(error.to_string().contains("unknown variant `wget`"), "{error}");
    assert_eq!(
        serde_json::from_value::<WebFetchTransport>(json!("direct")).unwrap(),
        WebFetchTransport::Direct
    );
}

#[tokio::test(start_paused = true)]
async fn caches_the_fetched_page_within_the_ttl() {
    let sandbox = FakeSandbox::new(text_response("body text", "text/plain"));
    let model = Arc::new(MockModel::new().with_turn("a").with_turn("b").with_turn("c"));
    let tool = tool(&model, WebFetchTransport::Curl);
    invoke(
        &tool,
        json!({"url": "https://example.com", "prompt": "first"}),
        sandbox.clone(),
    )
    .await;
    invoke(
        &tool,
        json!({"url": "https://example.com", "prompt": "second"}),
        sandbox.clone(),
    )
    .await;
    assert_eq!(sandbox.commands().len(), 2);
    assert_eq!(model.call_count(), 2);
    tokio::time::advance(CACHE_TTL).await;
    invoke(
        &tool,
        json!({"url": "https://example.com", "prompt": "third"}),
        sandbox.clone(),
    )
    .await;
    assert_eq!(sandbox.commands().len(), 3);
}

#[tokio::test]
async fn falls_back_to_the_agent_aux_model_without_a_summarizer() {
    let sandbox: Arc<dyn Sandbox> = FakeSandbox::new(text_response("page", "text/plain"));
    let tool = web_fetch_tool(WebFetchConfig::default(), None).unwrap();
    let aux = Arc::new(MockModel::new().with_turn("from aux"));
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .aux_model(aux as Arc<dyn Model>)
        .tools([tool])
        .sandbox(sandbox)
        .printer(false)
        .build()
        .unwrap();
    let result = agent
        .tool("web_fetch")
        .invoke(json!({"url": "https://example.com", "prompt": "q"}))
        .await
        .unwrap();
    assert_eq!(result.content, [ToolResultContent::text("from aux")]);
}

#[tokio::test]
async fn fetches_end_to_end_through_the_local_environment_sandbox() {
    let base = serve(|path, _request, socket| async move {
        let html = ("Content-Type", "text/html; charset=utf-8".to_owned());
        match path.as_str() {
            "/redirect" => reply(socket, "302 Found", &[("Location", "/page".to_owned())], b"").await,
            "/huge" => {
                reply(
                    socket,
                    "200 OK",
                    &[("Content-Type", "text/plain".to_owned())],
                    &vec![b'x'; 6 * 1024 * 1024],
                )
                .await;
            }
            "/notype" => reply(socket, "200 OK", &[], b"a < b").await,
            "/big" => {
                reply(
                    socket,
                    "200 OK",
                    &[("Content-Type", "text/plain; charset=utf-8".to_owned())],
                    "日".repeat(100_000).as_bytes(),
                )
                .await;
            }
            "/missing" => {
                let body = b"<html><body><script>x</script><p>Hello <b>w\xc3\xb6rld</b></p></body></html>";
                reply(socket, "404 Not Found", &[html], body).await;
            }
            _ => {
                let body = "<html><body><script>x</script><p>Hello <b>wörld</b></p></body></html>";
                reply(socket, "200 OK", &[html], body.as_bytes()).await;
            }
        }
    })
    .await;
    let sandbox: Arc<dyn Sandbox> = Arc::new(NotASandboxLocalEnvironment::new());
    let tool = tool(&summarizer(), WebFetchTransport::Curl);
    assert_eq!(
        invoke(&tool, json!({"url": format!("{base}/redirect")}), sandbox.clone()).await,
        "Hello wörld"
    );
    assert_eq!(
        invoke(&tool, json!({"url": format!("{base}/big")}), sandbox.clone()).await,
        "日".repeat(50_000)
    );
    assert_eq!(
        invoke(&tool, json!({"url": format!("{base}/huge")}), sandbox.clone()).await,
        "x".repeat(50_000)
    );
    assert_eq!(
        invoke(&tool, json!({"url": format!("{base}/notype")}), sandbox.clone()).await,
        "a < b"
    );
    let leftovers = sandbox
        .execute(
            "ls \"${TMPDIR:-/tmp}\" | grep -c strands-web-fetch",
            ExecuteOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(leftovers.stdout.trim(), "0");
    let missing = invoke(&tool, json!({"url": format!("{base}/missing")}), sandbox).await;
    assert!(missing.contains("404"), "{missing}");
}

#[test]
fn spec_matches_harness_ts() {
    let spec = strands::Tool::tool_spec(&web_fetch_tool(WebFetchConfig::default(), None).unwrap());
    assert_eq!(
        serde_json::to_string(&spec).unwrap(),
        r#"{"name":"web_fetch","description":"Fetch a URL and answer a prompt about its content. Performs an HTTP GET, reduces the response to text, and asks a small fast model to answer the prompt using only that content, returning the answer rather than the raw page so large pages do not flood the conversation. Fetched content is cached for 15 minutes, so repeated fetches of the same URL are fast while each prompt is answered fresh.","inputSchema":{"type":"object","properties":{"url":{"type":"string","description":"The http(s) URL to fetch."},"prompt":{"description":"What to extract from or answer about the fetched content. Leave empty to get the whole page content back verbatim instead of a model-generated answer.","type":"string"}},"required":["url"],"additionalProperties":false}}"#
    );
}
