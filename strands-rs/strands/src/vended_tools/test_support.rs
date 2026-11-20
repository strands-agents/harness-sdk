//! Helpers for the vended tool tests: run a tool to its result with a mock agent.

use std::sync::Arc;

use crate::agent::{InvocationState, ToolAgent};
use crate::cancel::CancelSignal;
use crate::sandbox::Sandbox;
use crate::testing::MockModel;
use crate::tools::{Tool, ToolContext, ToolOutcome};
use crate::types::{JsonValue, ToolResultBlock, ToolResultContent, ToolResultStatus, ToolUse};

/// A tool view of an agent with a mock model and empty state.
pub(crate) fn agent() -> ToolAgent {
    ToolAgent::new("agent", "test-ses", Arc::new(MockModel::new()))
}

/// [`agent`] with a sandbox.
pub(crate) fn agent_with_sandbox(sandbox: Arc<dyn Sandbox>) -> ToolAgent {
    agent().with_sandbox(sandbox)
}

/// The context of a call to `tool` with `input`.
pub(crate) fn context(tool: &dyn Tool, input: JsonValue, agent: &ToolAgent) -> ToolContext {
    ToolContext::new(
        ToolUse::new(tool.name(), "test-id", input),
        agent.clone(),
        InvocationState::new(),
    )
}

/// Runs a call to its outcome.
pub(crate) async fn outcome(tool: &dyn Tool, context: ToolContext) -> ToolOutcome {
    match tool.stream(context).run(|_| {}).await {
        Some(outcome) => outcome,
        None => panic!("tool ended without an outcome"),
    }
}

/// Runs a call with `input` to its result.
pub(crate) async fn run(tool: &dyn Tool, input: JsonValue, agent: &ToolAgent) -> ToolResultBlock {
    run_context(tool, context(tool, input, agent)).await
}

/// Runs a call with `input` and `signal` to its result.
pub(crate) async fn run_with_signal(
    tool: &dyn Tool,
    input: JsonValue,
    agent: &ToolAgent,
    signal: CancelSignal,
) -> ToolResultBlock {
    run_context(tool, context(tool, input, agent).with_cancel_signal(signal)).await
}

/// Runs a prepared call to its result.
pub(crate) async fn run_context(tool: &dyn Tool, context: ToolContext) -> ToolResultBlock {
    match outcome(tool, context).await {
        ToolOutcome::Result(result) => result,
        other => panic!("unexpected outcome {other:?}"),
    }
}

/// The text of a result's first block.
pub(crate) fn text(result: &ToolResultBlock) -> String {
    match result.content.first() {
        Some(ToolResultContent::Text(block)) => block.text.clone(),
        other => format!("{other:?}"),
    }
}

/// Runs a call that must succeed and returns its text.
pub(crate) async fn ok_text(tool: &dyn Tool, input: JsonValue, agent: &ToolAgent) -> String {
    let result = run(tool, input, agent).await;
    assert_eq!(result.status, ToolResultStatus::Success, "{result:?}");
    text(&result)
}

/// Runs a call that must succeed and returns its JSON content.
pub(crate) async fn ok_json(tool: &dyn Tool, input: JsonValue, agent: &ToolAgent) -> JsonValue {
    let result = run(tool, input, agent).await;
    assert_eq!(result.status, ToolResultStatus::Success, "{result:?}");
    match result.content.first() {
        Some(ToolResultContent::Json(block)) => block.json.clone(),
        other => panic!("expected JSON content, got {other:?}"),
    }
}

/// Runs a call that must fail and returns its message, without the `Error: ` prefix.
pub(crate) async fn error_text(tool: &dyn Tool, input: JsonValue, agent: &ToolAgent) -> String {
    let result = run(tool, input, agent).await;
    assert_eq!(result.status, ToolResultStatus::Error, "{result:?}");
    let text = text(&result);
    text.strip_prefix("Error: ").map_or(text.clone(), str::to_owned)
}

/// A sandbox that records writes and fails every other call, to show which sandbox a tool used.
#[derive(Default)]
pub(crate) struct RecordingSandbox {
    pub(crate) writes: std::sync::Mutex<Vec<(String, Vec<u8>)>>,
}

#[async_trait::async_trait]
impl Sandbox for RecordingSandbox {
    fn execute_streaming(
        &self,
        _command: &str,
        _options: crate::sandbox::ExecuteOptions,
    ) -> crate::sandbox::ExecutionStream {
        Box::pin(futures::stream::iter([Err(crate::Error::other(
            "recording sandbox used",
        ))]))
    }

    fn execute_code_streaming(
        &self,
        _code: &str,
        _language: &str,
        _options: crate::sandbox::ExecuteOptions,
    ) -> crate::sandbox::ExecutionStream {
        Box::pin(futures::stream::iter([Err(crate::Error::other(
            "recording sandbox used",
        ))]))
    }

    async fn read_file(&self, _path: &str) -> crate::Result<Vec<u8>> {
        Err(crate::Error::other("recording sandbox used"))
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> crate::Result<()> {
        self.writes.lock().unwrap().push((path.to_owned(), content.to_vec()));
        Ok(())
    }

    async fn remove_file(&self, _path: &str) -> crate::Result<()> {
        Err(crate::Error::other("recording sandbox used"))
    }

    async fn list_files(&self, _path: &str) -> crate::Result<Vec<crate::sandbox::FileInfo>> {
        Err(crate::Error::other("recording sandbox used"))
    }
}

/// A request a [`TestServer`] received.
#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl RecordedRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// How a [`TestServer`] answers a request.
pub(crate) enum Reply {
    /// A response with this status line (`200 OK`), headers and body.
    Respond {
        status: &'static str,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Never answers, keeping the connection open.
    Hang,
}

impl Reply {
    pub(crate) fn ok(content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self::status("200 OK", content_type, body)
    }

    pub(crate) fn status(status: &'static str, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Self::Respond {
            status,
            headers: vec![("content-type", content_type.to_owned())],
            body: body.into(),
        }
    }
}

type Handler = dyn Fn(&RecordedRequest) -> Reply + Send + Sync;

/// An HTTP/1.1 server on a local port for the HTTP tools' tests; no network beyond loopback.
pub(crate) struct TestServer {
    pub(crate) url: String,
    pub(crate) requests: Arc<std::sync::Mutex<Vec<RecordedRequest>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestServer {
    pub(crate) async fn start(handler: impl Fn(&RecordedRequest) -> Reply + Send + Sync + 'static) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(handler);
        let recorded = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let (handler, recorded) = (handler.clone(), recorded.clone());
                tokio::spawn(async move { serve(socket, handler.as_ref(), &recorded).await });
            }
        });
        Self { url, requests, task }
    }

    pub(crate) fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

async fn serve(
    mut socket: tokio::net::TcpStream,
    handler: &Handler,
    recorded: &std::sync::Mutex<Vec<RecordedRequest>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut data = Vec::new();
    let mut buffer = [0_u8; 4096];
    let head_end = loop {
        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(n) => data.extend_from_slice(&buffer[..n]),
        }
    };
    let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().unwrap_or_default().to_owned();
    let path = request_line.next().unwrap_or_default().to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = data[head_end + 4..].to_vec();
    while body.len() < length {
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&buffer[..n]),
        }
    }
    let request = RecordedRequest {
        method,
        path,
        headers,
        body,
    };
    recorded.lock().unwrap().push(request.clone());
    match handler(&request) {
        Reply::Hang => futures::future::pending::<()>().await,
        Reply::Respond { status, headers, body } => {
            let mut response = format!(
                "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n",
                body.len()
            );
            for (name, value) in headers {
                response.push_str(&format!("{name}: {value}\r\n"));
            }
            response.push_str("\r\n");
            let mut bytes = response.into_bytes();
            if request.method != "HEAD" {
                bytes.extend_from_slice(&body);
            }
            socket.write_all(&bytes).await.ok();
            socket.shutdown().await.ok();
        }
    }
}

/// An HTTP client that ignores proxy settings, so test requests reach the local server.
pub(crate) fn direct_client() -> reqwest::Client {
    crate::vended_tools::http_request::client_builder()
        .no_proxy()
        .build()
        .unwrap()
}
