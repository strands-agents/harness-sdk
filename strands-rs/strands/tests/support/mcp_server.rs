//! A local MCP server for the MCP client tests, built on `rmcp`'s server side. It serves over an
//! in-memory duplex stream, stdio (the `mcp_test_server` example), streamable HTTP and the
//! legacy HTTP+SSE protocol on localhost.

#![allow(
    dead_code,
    deprecated,
    unreachable_pub,
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a test fixture shared by several test targets; rmcp deprecates logging, which MCP clients still receive"
)]

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt;
use futures::channel::mpsc;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::Frame;
use hyper_util::rt::TokioIo;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ElicitRequestParams, ElicitationSchema,
    ErrorCode, ErrorData, GetPromptRequestParams, GetPromptResponse, GetPromptResult, Implementation, JsonObject,
    ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, LoggingLevel,
    LoggingMessageNotificationParam, PaginatedRequestParams, ProgressNotificationParam, Prompt, PromptMessage,
    ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource, ResourceContents, ResourceTemplate,
    Role, ServerCapabilities, ServerInfo, Tool, ToolAnnotations,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ServerHandler, ServiceExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// A tiny PNG prefix in base64.
pub const PNG_BASE64: &str = "iVBORw0KGgoAAAANSUhEUg==";

fn schema(value: Value) -> Arc<JsonObject> {
    match value {
        Value::Object(map) => Arc::new(map),
        _ => Arc::default(),
    }
}

/// The default tools.
pub fn default_tools() -> Vec<Tool> {
    let object = || schema(json!({"type": "object", "properties": {}}));
    vec![
        Tool::new(
            "echo",
            "Echoes input",
            schema(json!({"type": "object", "properties": {"value": {"type": "string"}}})),
        ),
        Tool::new("args", "Returns its arguments as JSON text", object()),
        Tool::new("meta", "Returns the request _meta as JSON text", object()),
        Tool::new("slow", "Reports progress over several steps", object()),
        Tool::new("fail", "Returns an error result", object()),
        Tool::new("protocol_error", "Fails with a JSON-RPC error", object()),
        Tool::new("content", "Returns content of a given kind", object()),
        Tool::new("structured", "Returns structured content", object()),
        Tool::new("log", "Emits a log message", object()),
        Tool::new("ask", "Asks the client for input", object()),
        Tool::new("add_tool", "Adds a tool and notifies the client", object()),
        Tool::new("wait", "Waits until cancelled", object()),
        Tool::new("env", "Returns an environment variable", object()),
        Tool::new("client_info", "Returns the client's initialize request", object()),
        Tool::new("ask_url", "Asks the client to open a URL", object()),
    ]
}

/// A tool with annotations, for the annotation tests.
pub fn annotated(name: &str, annotations: ToolAnnotations) -> Tool {
    Tool::new(name.to_owned(), "Annotated", schema(json!({"type": "object"}))).with_annotations(annotations)
}

#[derive(Default)]
struct State {
    tools: Vec<Tool>,
    calls: Vec<String>,
    cancelled: usize,
    list_delay: Option<Duration>,
    lists: usize,
    failing_lists: usize,
}

/// The test server. Clones share their state.
#[derive(Clone)]
pub struct TestServer {
    state: Arc<Mutex<State>>,
    page_size: Option<usize>,
    advertise_prompts: bool,
}

impl Default for TestServer {
    fn default() -> Self {
        Self::new()
    }
}

fn arg<'a>(arguments: &'a JsonObject, key: &str) -> Option<&'a Value> {
    arguments.get(key)
}

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value)])
}

fn content_of(kind: &str) -> Vec<ContentBlock> {
    match kind {
        "image" => vec![ContentBlock::image(PNG_BASE64, "image/png")],
        "bad_image" => vec![ContentBlock::image(PNG_BASE64, "image/bmp")],
        "audio" => vec![ContentBlock::audio("AAAA", "audio/wav")],
        "resource_text" => vec![ContentBlock::embedded_text("file:///notes.txt", "Some notes")],
        "resource_image" => vec![ContentBlock::resource(
            ResourceContents::blob(PNG_BASE64, "file:///image.png").with_mime_type("image/png"),
        )],
        "resource_pdf" => vec![ContentBlock::resource(
            ResourceContents::blob("JVBERi0=", "file:///doc.pdf").with_mime_type("application/pdf"),
        )],
        "resource_link" => vec![ContentBlock::resource_link(Resource::new("file:///a.txt", "a"))],
        "mixed" => vec![
            ContentBlock::text("Here is the image:"),
            ContentBlock::image(PNG_BASE64, "image/png"),
            ContentBlock::embedded_text("file:///notes.txt", "Some notes"),
        ],
        _ => Vec::new(),
    }
}

impl TestServer {
    pub fn new() -> Self {
        Self::with_tools(default_tools())
    }

    pub fn with_tools(tools: Vec<Tool>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                tools,
                ..State::default()
            })),
            page_size: None,
            advertise_prompts: true,
        }
    }

    /// Pages `tools/list`, `prompts/list` and `resources/list` by `size` items.
    pub fn paged(mut self, size: usize) -> Self {
        self.page_size = Some(size);
        self
    }

    /// Announces no prompts or resources capability.
    pub fn without_prompts(mut self) -> Self {
        self.advertise_prompts = false;
        self
    }

    /// The names of the tools called so far.
    pub fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }

    /// How many calls saw their request cancelled.
    pub fn cancelled(&self) -> usize {
        self.state.lock().unwrap().cancelled
    }

    /// How many `tools/list` requests arrived.
    pub fn lists(&self) -> usize {
        self.state.lock().unwrap().lists
    }

    /// Fails the next `count` `tools/list` requests.
    pub fn fail_lists(&self, count: usize) {
        self.state.lock().unwrap().failing_lists = count;
    }

    /// Delays every `tools/list` response.
    pub fn set_list_delay(&self, delay: Duration) {
        self.state.lock().unwrap().list_delay = Some(delay);
    }

    pub fn set_tools(&self, tools: Vec<Tool>) {
        self.state.lock().unwrap().tools = tools;
    }

    fn page<T: Clone>(&self, items: &[T], cursor: Option<&str>) -> (Vec<T>, Option<String>) {
        let Some(size) = self.page_size else {
            return (items.to_vec(), None);
        };
        let start: usize = cursor.and_then(|cursor| cursor.parse().ok()).unwrap_or(0);
        let end = (start + size).min(items.len());
        let next = (end < items.len()).then(|| end.to_string());
        (items[start..end].to_vec(), next)
    }

    async fn run_tool(
        &self,
        name: &str,
        arguments: JsonObject,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        match name {
            "echo" => Ok(text(
                arg(&arguments, "value").and_then(Value::as_str).unwrap_or_default(),
            )),
            "args" => Ok(text(Value::Object(arguments).to_string())),
            "meta" => Ok(text(serde_json::to_string(&context.meta).unwrap())),
            "slow" => self.slow(&arguments, context).await,
            "fail" => Ok(CallToolResult::error(vec![ContentBlock::text(
                arg(&arguments, "message")
                    .and_then(Value::as_str)
                    .unwrap_or("Service Unavailable"),
            )])),
            "protocol_error" => Err(ErrorData::new(
                ErrorCode(arg(&arguments, "code").and_then(Value::as_i64).unwrap_or(-32603) as i32),
                arg(&arguments, "message")
                    .and_then(Value::as_str)
                    .unwrap_or("boom")
                    .to_owned(),
                arg(&arguments, "data").cloned(),
            )),
            "content" => {
                let kind = arg(&arguments, "kind").and_then(Value::as_str).unwrap_or("empty");
                Ok(CallToolResult::success(content_of(kind)))
            }
            "structured" => {
                let mut result = CallToolResult::structured(json!({"temperature": 72}));
                result.content = vec![ContentBlock::text("{\"temperature\":72}")];
                Ok(result)
            }
            "log" => {
                let level: LoggingLevel =
                    serde_json::from_value(arg(&arguments, "level").cloned().unwrap_or(json!("info"))).unwrap();
                let mut params = LoggingMessageNotificationParam::new(
                    level,
                    arg(&arguments, "data").cloned().unwrap_or(json!("hello")),
                );
                params.logger = arg(&arguments, "logger").and_then(Value::as_str).map(str::to_owned);
                context.peer.notify_logging_message(params).await.unwrap();
                Ok(text("logged"))
            }
            "ask" => {
                let params = ElicitRequestParams::FormElicitationParams {
                    meta: None,
                    message: "Your name?".to_owned(),
                    requested_schema: ElicitationSchema::builder().required_string("name").build().unwrap(),
                };
                match context.peer.create_elicitation(params).await {
                    Ok(result) => Ok(text(serde_json::to_string(&result).unwrap())),
                    Err(error) => Ok(text(format!("elicitation failed: {error}"))),
                }
            }
            "add_tool" => {
                let name = arg(&arguments, "name")
                    .and_then(Value::as_str)
                    .unwrap_or("added")
                    .to_owned();
                self.state.lock().unwrap().tools.push(Tool::new(
                    name,
                    "Added at runtime",
                    schema(json!({"type": "object"})),
                ));
                context.peer.notify_tool_list_changed().await.unwrap();
                Ok(text("added"))
            }
            "wait" => {
                context.ct.cancelled().await;
                self.state.lock().unwrap().cancelled += 1;
                Ok(text("cancelled"))
            }
            "client_info" => Ok(text(serde_json::to_string(&context.peer.peer_info()).unwrap())),
            "ask_url" => {
                let params = ElicitRequestParams::UrlElicitationParams {
                    meta: None,
                    message: "Authorize".to_owned(),
                    url: "https://example.com/authorize".to_owned(),
                    elicitation_id: "e-1".to_owned(),
                };
                match context.peer.create_elicitation(params).await {
                    Ok(result) => Ok(text(serde_json::to_string(&result).unwrap())),
                    Err(error) => Ok(text(format!("elicitation failed: {error}"))),
                }
            }
            "env" => {
                let key = arg(&arguments, "name").and_then(Value::as_str).unwrap_or("PATH");
                Ok(text(std::env::var(key).unwrap_or_else(|_| "<unset>".to_owned())))
            }
            other => Ok(text(format!("called {other}"))),
        }
    }

    async fn slow(
        &self,
        arguments: &JsonObject,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let steps = arg(arguments, "steps").and_then(Value::as_u64).unwrap_or(1);
        let delay = arg(arguments, "delay_ms").and_then(Value::as_u64).unwrap_or(200);
        let token = context.meta.get_progress_token();
        for step in 1..=steps {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some(token) = token.clone() {
                let mut params = ProgressNotificationParam::new(token, step as f64);
                params.total = arg(arguments, "no_total").is_none().then_some(steps as f64);
                params.message = arg(arguments, "message").and_then(Value::as_str).map(str::to_owned);
                context.peer.notify_progress(params).await.unwrap();
            }
        }
        Ok(text(if token.is_some() {
            "done with token"
        } else {
            "done without token"
        }))
    }
}

impl ServerHandler for TestServer {
    fn get_info(&self) -> ServerInfo {
        let capabilities = if self.advertise_prompts {
            ServerCapabilities::builder()
                .enable_logging()
                .enable_prompts()
                .enable_resources()
                .enable_tools()
                .enable_tool_list_changed()
                .build()
        } else {
            ServerCapabilities::builder()
                .enable_logging()
                .enable_tools()
                .enable_tool_list_changed()
                .build()
        };
        ServerInfo::new(capabilities)
            .with_server_info(Implementation::new("test-server", "1.0.0"))
            .with_instructions("Use the echo tool")
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let (tools, delay, fail) = {
            let mut state = self.state.lock().unwrap();
            state.lists += 1;
            let fail = state.failing_lists > 0;
            state.failing_lists = state.failing_lists.saturating_sub(1);
            (state.tools.clone(), state.list_delay, fail)
        };
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        if fail {
            return Err(ErrorData::internal_error("server disconnected", None));
        }
        let cursor = request.and_then(|request| request.cursor);
        let (tools, next) = self.page(&tools, cursor.as_deref());
        let mut result = ListToolsResult::with_all_items(tools);
        result.next_cursor = next;
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.state.lock().unwrap().calls.push(request.name.to_string());
        let arguments = request.arguments.unwrap_or_default();
        self.run_tool(&request.name, arguments, context).await.map(Into::into)
    }

    async fn list_prompts(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, ErrorData> {
        let prompts = vec![
            Prompt::new("greet", Some("Greets someone"), None),
            Prompt::new("farewell", Some("Says goodbye"), None),
        ];
        let cursor = request.and_then(|request| request.cursor);
        let (prompts, next) = self.page(&prompts, cursor.as_deref());
        let mut result = ListPromptsResult::with_all_items(prompts);
        result.next_cursor = next;
        Ok(result)
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, ErrorData> {
        let name = request
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("world")
            .to_owned();
        let message = PromptMessage::new_text(Role::User, format!("{}: hello {name}", request.name));
        Ok(GetPromptResult::new(vec![message]).into())
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        let resources = vec![Resource::new("file:///a.txt", "a"), Resource::new("file:///b.txt", "b")];
        let cursor = request.and_then(|request| request.cursor);
        let (resources, next) = self.page(&resources, cursor.as_deref());
        let mut result = ListResourcesResult::with_all_items(resources);
        result.next_cursor = next;
        Ok(result)
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        let contents = ResourceContents::text(format!("contents of {}", request.uri), request.uri);
        Ok(ReadResourceResult::new(vec![contents]).into())
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, ErrorData> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            ResourceTemplate::new("file:///{path}", "files"),
        ]))
    }
}

/// Serves `server` over one end of an in-memory duplex stream and returns the other end.
pub fn serve_duplex(server: TestServer) -> tokio::io::DuplexStream {
    let (client, server_end) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        if let Ok(running) = server.serve(server_end).await {
            let _ = running.waiting().await;
        }
    });
    client
}

/// Serves `server` over this process's stdin and stdout until stdin closes.
pub async fn serve_stdio(server: TestServer) {
    let running = server.serve(rmcp::transport::stdio()).await.unwrap();
    let _ = running.waiting().await;
}

type RecordedRequest = (String, HashMap<String, String>);

/// What an HTTP test server saw.
#[derive(Clone, Default)]
pub struct Recorded {
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl Recorded {
    /// The value of `header` on every request to `path`.
    pub fn header(&self, path: &str, header: &str) -> Vec<Option<String>> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(request_path, _)| request_path == path)
            .map(|(_, headers)| headers.get(header).cloned())
            .collect()
    }

    /// The paths requested, in order.
    pub fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|(path, _)| path.clone())
            .collect()
    }

    fn record(&self, request: &hyper::Request<hyper::body::Incoming>) {
        let headers = request
            .headers()
            .iter()
            .map(|(name, value)| (name.as_str().to_owned(), value.to_str().unwrap_or_default().to_owned()))
            .collect();
        self.requests
            .lock()
            .unwrap()
            .push((request.uri().path().to_owned(), headers));
    }
}

type Body = http_body_util::combinators::BoxBody<Bytes, Infallible>;

fn full(status: u16, content_type: &str, body: impl Into<Bytes>) -> hyper::Response<Body> {
    hyper::Response::builder()
        .status(status)
        .header("content-type", content_type)
        .body(Full::new(body.into()).boxed())
        .unwrap()
}

/// A running localhost HTTP test server. Dropping it stops accepting connections.
pub struct HttpServer {
    pub base: String,
    pub recorded: Recorded,
    task: tokio::task::JoinHandle<()>,
}

impl HttpServer {
    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// How a localhost HTTP test server behaves.
#[derive(Clone, Debug)]
pub struct HttpOptions {
    /// With a token, `/mcp` requires `Authorization: Bearer <token>`.
    pub bearer: Option<String>,
    /// The `expires_in` of issued tokens, in seconds.
    pub token_expires_in: u64,
    /// Ends every legacy SSE stream after this many message events; a reopened stream resumes
    /// the session named by `Last-Event-ID` and announces `/messages2` as the endpoint.
    pub sse_messages_per_stream: Option<usize>,
}

impl Default for HttpOptions {
    fn default() -> Self {
        Self {
            bearer: None,
            token_expires_in: 3600,
            sse_messages_per_stream: None,
        }
    }
}

type Outbound = Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<rmcp::model::ServerJsonRpcMessage>>>;

#[derive(Clone)]
struct SseSession {
    inbound: mpsc::UnboundedSender<rmcp::model::ClientJsonRpcMessage>,
    outbound: Outbound,
    sent: Arc<AtomicUsize>,
}

type SseSessions = Arc<Mutex<HashMap<String, SseSession>>>;

#[derive(Clone)]
struct Routes {
    server: TestServer,
    mcp: Arc<StreamableHttpService<TestServer, LocalSessionManager>>,
    sse: SseSessions,
    recorded: Recorded,
    options: HttpOptions,
    base: Arc<Mutex<String>>,
}

impl Routes {
    async fn handle(self, request: hyper::Request<hyper::body::Incoming>) -> Result<hyper::Response<Body>, Infallible> {
        self.recorded.record(&request);
        let path = request.uri().path().to_owned();
        let base = self.base.lock().unwrap().clone();
        let response = match (request.method().as_str(), path.as_str()) {
            ("GET", "/.well-known/oauth-protected-resource" | "/.well-known/oauth-protected-resource/mcp") => full(
                200,
                "application/json",
                json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]}).to_string(),
            ),
            ("GET", "/.well-known/oauth-authorization-server" | "/.well-known/openid-configuration") => full(
                200,
                "application/json",
                json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/authorize"),
                    "token_endpoint": format!("{base}/token"),
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["client_credentials"],
                    "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]
                })
                .to_string(),
            ),
            ("POST", "/token") => full(
                200,
                "application/json",
                json!({"access_token": "token-123", "token_type": "Bearer", "expires_in": self.options.token_expires_in})
                    .to_string(),
            ),
            ("GET", "/sse") => self.open_sse(&request),
            ("POST", "/messages" | "/messages2") => self.post_sse(request).await,
            (_, "/mcp") => self.mcp(request, &base).await,
            _ => full(404, "text/plain", "not found"),
        };
        Ok(response)
    }

    async fn mcp(&self, request: hyper::Request<hyper::body::Incoming>, base: &str) -> hyper::Response<Body> {
        if let Some(bearer) = &self.options.bearer {
            let authorization = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok());
            if authorization != Some(&format!("Bearer {bearer}")) {
                return hyper::Response::builder()
                    .status(401)
                    .header(
                        "www-authenticate",
                        format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\""),
                    )
                    .body(Full::new(Bytes::new()).boxed())
                    .unwrap();
            }
        }
        self.mcp.handle(request).await
    }

    /// The session a reopened stream resumes: `Last-Event-ID` is `<session>:<n>`.
    fn resumed(&self, request: &hyper::Request<hyper::body::Incoming>) -> Option<(String, SseSession)> {
        let last = request.headers().get("last-event-id")?.to_str().ok()?;
        let session = last.split(':').next()?.to_owned();
        let found = self.sse.lock().unwrap().get(&session).cloned()?;
        Some((session, found))
    }

    fn new_sse_session(&self) -> (String, SseSession) {
        let session = uuid::Uuid::new_v4().simple().to_string();
        let (inbound_tx, inbound_rx) = mpsc::unbounded::<rmcp::model::ClientJsonRpcMessage>();
        let (outbound_tx, outbound_rx) = mpsc::unbounded::<rmcp::model::ServerJsonRpcMessage>();
        let state = SseSession {
            inbound: inbound_tx,
            outbound: Arc::new(tokio::sync::Mutex::new(outbound_rx)),
            sent: Arc::default(),
        };
        self.sse.lock().unwrap().insert(session.clone(), state.clone());
        let server = self.server.clone();
        tokio::spawn(async move {
            if let Ok(running) = server.serve((outbound_tx, inbound_rx)).await {
                let _ = running.waiting().await;
            }
        });
        (session, state)
    }

    fn open_sse(&self, request: &hyper::Request<hyper::body::Incoming>) -> hyper::Response<Body> {
        let (session, state, path) = match self.resumed(request) {
            Some((session, state)) => (session, state, "/messages2"),
            None => {
                let (session, state) = self.new_sse_session();
                (session, state, "/messages")
            }
        };
        let retry = if self.options.sse_messages_per_stream.is_some() {
            "retry: 10\n"
        } else {
            ""
        };
        let endpoint = format!("event: endpoint\n{retry}data: {path}?sessionId={session}\n\n");
        let limit = self.options.sse_messages_per_stream.unwrap_or(usize::MAX);
        let messages =
            futures::stream::unfold((state, session, 0usize), move |(state, session, streamed)| async move {
                if streamed >= limit {
                    return None;
                }
                let message = state.outbound.lock().await.next().await?;
                let id = state.sent.fetch_add(1, Ordering::SeqCst) + 1;
                let event = format!(
                    "id: {session}:{id}\nevent: message\ndata: {}\n\n",
                    serde_json::to_string(&message).unwrap()
                );
                Some((event, (state, session, streamed + 1)))
            });
        let events = futures::stream::once(async move { endpoint }).chain(messages);
        let body = StreamBody::new(events.map(|chunk| Ok::<_, Infallible>(Frame::data(Bytes::from(chunk)))));
        hyper::Response::builder()
            .status(200)
            .header("content-type", "text/event-stream")
            .body(BodyExt::boxed(body))
            .unwrap()
    }

    async fn post_sse(&self, request: hyper::Request<hyper::body::Incoming>) -> hyper::Response<Body> {
        let session = request
            .uri()
            .query()
            .and_then(|query| query.split('&').find_map(|pair| pair.strip_prefix("sessionId=")))
            .unwrap_or_default()
            .to_owned();
        let body = request.into_body().collect().await.unwrap().to_bytes();
        let Ok(message) = serde_json::from_slice(&body) else {
            return full(400, "text/plain", "bad message");
        };
        let sender = self
            .sse
            .lock()
            .unwrap()
            .get(&session)
            .map(|state| state.inbound.clone());
        match sender {
            Some(sender) if sender.unbounded_send(message).is_ok() => full(202, "text/plain", "Accepted"),
            _ => full(404, "text/plain", "unknown session"),
        }
    }
}

/// Serves `server` on localhost: streamable HTTP at `/mcp`, legacy SSE at `/sse` and
/// `/messages`, and OAuth metadata and a token endpoint. With `bearer`, `/mcp` requires
/// `Authorization: Bearer <bearer>`.
pub async fn serve_http(server: TestServer, bearer: Option<&str>) -> HttpServer {
    let options = HttpOptions {
        bearer: bearer.map(str::to_owned),
        ..HttpOptions::default()
    };
    serve_http_with(server, options).await
}

/// [`serve_http`] with every option.
pub async fn serve_http_with(server: TestServer, options: HttpOptions) -> HttpServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let factory_server = server.clone();
    let mcp = StreamableHttpService::new(
        move || Ok(factory_server.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let recorded = Recorded::default();
    let routes = Routes {
        server,
        mcp: Arc::new(mcp),
        sse: Arc::default(),
        recorded: recorded.clone(),
        options,
        base: Arc::new(Mutex::new(base.clone())),
    };
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let routes = routes.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |request| routes.clone().handle(request));
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    HttpServer { base, recorded, task }
}
