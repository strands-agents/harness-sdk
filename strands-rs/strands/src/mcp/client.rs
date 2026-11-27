//! [`McpClient`]: lazy connection with `continue_on_error`, tool listing with prefixes and filters,
//! tool calls with progress, prompts and resources, and list-changed refreshes.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use rmcp::RoleClient;
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, ClientRequest, GetPromptRequestParams, GetPromptResult, Implementation,
    ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult, PaginatedRequestParams,
    ProgressToken, ReadResourceRequestParams, ReadResourceResult, RequestId, ServerCapabilities, ServerResult,
};
use rmcp::service::{
    ClientLifecycleMode, Peer, PeerRequestOptions, RunningService, ServiceError, serve_client_with_lifecycle,
};
use serde::Serialize;

use super::callbacks::{ElicitationCallback, McpLogHandler, McpProgressCallback, ToolsChangedCallback};
use super::error::{McpError, McpSdkErrorCode};
use super::filters::McpToolFilters;
use super::handler::Handler;
use super::http::{self, HttpAuth, McpAuthProvider, McpClientCredentials};
use super::mcp_tool::{McpTool, McpToolConfig};
use super::progress::{ProgressRoute, ProgressRouter, RoutedTransport};
use super::trace::{TraceCarrierFn, current_trace_carrier, inject_trace_context};
use super::transport::{McpTransport, WithoutProgressToken};
use crate::cancel::CancelSignal;
use crate::error::{Error, Result, ToolValidationError};
use crate::types::{JsonObject, JsonValue};

/// The client name sent in the MCP handshake unless `application_name` overrides it.
pub const DEFAULT_CLIENT_NAME: &str = "strands-agents-rs-sdk";

const NOT_CONNECTED: &str = "MCP server failed to connect. Call connect(true) to retry.";
const MAX_TOOL_NAME_LENGTH: usize = 64;
const DEFAULT_LIST_MAX_PAGES: u32 = 64;
const LIST_CHANGED_DEBOUNCE: Duration = Duration::from_millis(300);
const MAX_TIMER_DELAY_MS: u128 = 2_147_483_647;
const INVALID_REQUEST: i32 = -32600;
const INVALID_PARAMS: i32 = -32602;

/// Connection state of an MCP client (`McpConnectionState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum McpConnectionState {
    /// Not connected yet, or disconnected.
    Disconnected,
    /// Connected.
    Connected,
    /// A connect attempt failed under `continue_on_error`; `connect(true)` retries.
    Failed,
}

/// Behaviour shared by every MCP client configuration (`McpClientOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct McpClientOptions {
    /// The client name sent in the MCP handshake; [`DEFAULT_CLIENT_NAME`] when absent.
    pub application_name: Option<String>,
    /// The client version sent in the MCP handshake; the crate version when absent.
    pub application_version: Option<String>,
    /// Sends no W3C trace context in tool call arguments.
    #[builder(default)]
    pub disable_mcp_instrumentation: bool,
    /// Prefix for agent-facing tool names, applied as `<prefix>_<toolName>`.
    pub prefix: Option<String>,
    /// Filters controlling which tools this client exposes.
    pub tool_filters: Option<McpToolFilters>,
    /// Page cap for the list methods that aggregate every page; 0 disables it. Defaults to 64.
    pub list_max_pages: Option<u32>,
    /// Receives progress notifications during tool calls, including the agent's. A per-call
    /// callback takes precedence.
    pub progress_callback: Option<McpProgressCallback>,
    /// Handles server elicitation requests. When set, the client advertises elicitation
    /// support (form and URL modes).
    pub elicitation_callback: Option<Arc<dyn ElicitationCallback>>,
    /// Skips connection failures and overlong prefixed tool names with warnings.
    #[builder(default)]
    pub continue_on_error: bool,
    /// Receives the server's log messages; they go to `tracing` when absent.
    #[builder(into)]
    pub log_handler: Option<McpLogHandler>,
}

impl fmt::Debug for McpClientOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClientOptions")
            .field("application_name", &self.application_name)
            .field("application_version", &self.application_version)
            .field("disable_mcp_instrumentation", &self.disable_mcp_instrumentation)
            .field("prefix", &self.prefix)
            .field("tool_filters", &self.tool_filters)
            .field("list_max_pages", &self.list_max_pages)
            .field("progress_callback", &self.progress_callback.is_some())
            .field("elicitation_callback", &self.elicitation_callback.is_some())
            .field("continue_on_error", &self.continue_on_error)
            .field("log_handler", &self.log_handler.is_some())
            .finish()
    }
}

/// How to reach the server, plus the client's behaviour (`McpClientConfig`).
///
/// Give either a [`transport`](Self::transport) or a [`url`](Self::url) for streamable HTTP.
/// `auth`, `auth_provider` and `headers` require `url`.
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct McpClientConfig {
    /// A transport. Mutually exclusive with `url`.
    pub transport: Option<McpTransport>,
    /// The server URL; the client builds a streamable HTTP transport on every connect.
    pub url: Option<String>,
    /// OAuth client credentials for machine-to-machine auth. Requires `url`.
    pub auth: Option<McpClientCredentials>,
    /// Supplies bearer tokens. Requires `url`; mutually exclusive with `auth`.
    pub auth_provider: Option<Arc<dyn McpAuthProvider>>,
    /// Headers sent with every request. Requires `url`.
    pub headers: Option<BTreeMap<String, String>>,
    /// The client's behaviour.
    #[builder(default)]
    pub options: McpClientOptions,
}

impl fmt::Debug for McpClientConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClientConfig")
            .field("transport", &self.transport)
            .field("url", &self.url)
            .field("auth", &self.auth)
            .field("auth_provider", &self.auth_provider.is_some())
            .field("headers", &self.headers.as_ref().map(BTreeMap::len))
            .field("options", &self.options)
            .finish()
    }
}

/// Options for the paginated list methods (`McpListOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct McpListOptions {
    /// Fetches a single page starting at this token. Without it every page is aggregated.
    pub pagination_token: Option<String>,
}

/// Per-call overrides for [`McpClient::list_tools_with`] (`McpListToolsOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct McpListToolsOptions {
    /// Prefix for agent-facing names. An empty string disables a prefix set on the client.
    pub prefix: Option<String>,
    /// Tool filters. Empty filters disable filters set on the client.
    pub tool_filters: Option<McpToolFilters>,
}

/// Options for one tool call (`McpCallToolOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct McpCallToolOptions {
    /// Cancels the request.
    pub cancel_signal: Option<CancelSignal>,
    /// Time limit for the call; progress notifications reset it.
    pub timeout: Option<Duration>,
    /// Receives progress for this call, in place of the client's callback.
    pub progress_callback: Option<McpProgressCallback>,
}

struct Settings {
    name: String,
    version: String,
    prefix: Option<String>,
    tool_filters: Option<McpToolFilters>,
    list_max_pages: u32,
    progress_callback: Option<McpProgressCallback>,
    elicitation_callback: Option<Arc<dyn ElicitationCallback>>,
    continue_on_error: bool,
    log_handler: Option<McpLogHandler>,
    disable_mcp_instrumentation: bool,
    trace_carrier: TraceCarrierFn,
}

type Attempt = Shared<BoxFuture<'static, std::result::Result<(), McpError>>>;

struct Conn {
    state: McpConnectionState,
    generation: u64,
    service: Option<RunningService<RoleClient, Handler>>,
    peer: Option<Peer<RoleClient>>,
    router: Option<Arc<ProgressRouter>>,
    attempt: Option<(u64, Attempt)>,
    attempts: u64,
}

#[derive(Default)]
struct ToolsState {
    registered_names: Vec<String>,
    on_tools_changed: Option<ToolsChangedCallback>,
    refreshing: bool,
    pending_refresh: bool,
    debounce: u64,
}

/// A listed tool's compiled `outputSchema`, or why it does not compile.
enum OutputSchema {
    Valid(jsonschema::Validator),
    Invalid(String),
}

pub(crate) struct Inner {
    settings: Settings,
    transport: McpTransport,
    conn: Mutex<Conn>,
    tools: Mutex<ToolsState>,
    output_schemas: Mutex<HashMap<String, Arc<OutputSchema>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    pub(crate) fn name(&self) -> &str {
        &self.settings.name
    }

    pub(crate) fn version(&self) -> &str {
        &self.settings.version
    }

    pub(crate) fn elicitation_callback(&self) -> Option<&Arc<dyn ElicitationCallback>> {
        self.settings.elicitation_callback.as_ref()
    }

    pub(crate) fn log_handler(&self) -> Option<&McpLogHandler> {
        self.settings.log_handler.as_ref()
    }
}

/// A client for one MCP server (`McpClient`).
///
/// Cloning shares the connection. The client connects lazily on first use; pass it to an agent
/// with `.tools([client])` and the agent lists its tools when it initializes. Dropping the last
/// clone ends the transport; [`disconnect`](Self::disconnect) ends it and waits.
///
/// ```no_run
/// use strands::mcp::{McpClient, McpTransport, StdioServerParameters};
/// use strands::Agent;
///
/// # async fn run() -> strands::Result<()> {
/// let client = McpClient::with_transport(McpTransport::stdio(StdioServerParameters::new(
///     "uvx",
///     ["mcp-server-fetch"],
/// )));
/// let mut agent = Agent::builder().tools([client.clone()]).build()?;
/// agent.invoke("Fetch https://strandsagents.com").await?;
/// client.disconnect().await?;
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct McpClient {
    inner: Arc<Inner>,
}

fn config_error(message: &str) -> Error {
    McpError::other(message).into()
}

fn resolve_transport(config: &McpClientConfig) -> Result<McpTransport> {
    if config.transport.is_some() && config.url.is_some() {
        return Err(config_error(
            "McpClientConfig: provide either \"transport\" or \"url\", not both",
        ));
    }
    if let Some(transport) = &config.transport {
        if config.auth.is_some() || config.auth_provider.is_some() || config.headers.is_some() {
            return Err(config_error(
                "McpClientConfig: \"auth\", \"authProvider\", and \"headers\" require \"url\" (not compatible with \"transport\")",
            ));
        }
        return Ok(transport.clone());
    }
    let Some(url) = &config.url else {
        return Err(config_error(
            "McpClientConfig: either \"transport\" or \"url\" must be provided",
        ));
    };
    let auth = match (&config.auth, &config.auth_provider) {
        (Some(_), Some(_)) => {
            return Err(config_error(
                "McpClientConfig: provide either \"auth\" or \"authProvider\", not both",
            ));
        }
        (Some(credentials), None) => HttpAuth::Credentials(credentials.clone()),
        (None, Some(provider)) => HttpAuth::Provider(provider.clone()),
        (None, None) => HttpAuth::None,
    };
    let headers = config.headers.clone().unwrap_or_default();
    Ok(http::streamable_http(url, &headers, auth)?)
}

fn aborted(signal: &CancelSignal) -> McpError {
    McpError::other(
        signal
            .reason()
            .unwrap_or_else(|| "The operation was aborted".to_owned()),
    )
}

async fn race<T>(
    future: impl Future<Output = std::result::Result<T, McpError>>,
    signal: Option<&CancelSignal>,
) -> std::result::Result<T, McpError> {
    let Some(signal) = signal else {
        return future.await;
    };
    tokio::select! {
        biased;
        () = signal.cancelled() => Err(aborted(signal)),
        result = future => result,
    }
}

fn validate_timeout(timeout: Option<Duration>) -> std::result::Result<(), McpError> {
    let Some(timeout) = timeout else {
        return Ok(());
    };
    let millis = timeout.as_millis();
    if millis == 0 || millis > MAX_TIMER_DELAY_MS || timeout.subsec_nanos() % 1_000_000 != 0 {
        return Err(McpError::other(format!(
            "MCP call timeout must be a positive safe integer no greater than {MAX_TIMER_DELAY_MS}"
        )));
    }
    Ok(())
}

fn js_type_name(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Array(_) => "Array",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Null | JsonValue::Object(_) => "object",
    }
}

trait Paged: Serialize {
    type Item: Serialize;
    fn items(&mut self) -> &mut Vec<Self::Item>;
    fn cursor(&mut self) -> &mut Option<String>;
}

impl Paged for ListToolsResult {
    type Item = rmcp::model::Tool;
    fn items(&mut self) -> &mut Vec<Self::Item> {
        &mut self.tools
    }
    fn cursor(&mut self) -> &mut Option<String> {
        &mut self.next_cursor
    }
}

impl Paged for ListPromptsResult {
    type Item = rmcp::model::Prompt;
    fn items(&mut self) -> &mut Vec<Self::Item> {
        &mut self.prompts
    }
    fn cursor(&mut self) -> &mut Option<String> {
        &mut self.next_cursor
    }
}

impl Paged for ListResourcesResult {
    type Item = rmcp::model::Resource;
    fn items(&mut self) -> &mut Vec<Self::Item> {
        &mut self.resources
    }
    fn cursor(&mut self) -> &mut Option<String> {
        &mut self.next_cursor
    }
}

impl Paged for ListResourceTemplatesResult {
    type Item = rmcp::model::ResourceTemplate;
    fn items(&mut self) -> &mut Vec<Self::Item> {
        &mut self.resource_templates
    }
    fn cursor(&mut self) -> &mut Option<String> {
        &mut self.next_cursor
    }
}

fn page_params(cursor: Option<String>) -> Option<PaginatedRequestParams> {
    cursor.map(|cursor| PaginatedRequestParams::default().with_cursor(Some(cursor)))
}

/// Fetches every page into the first one: a page repeating the previous items and cursor ends the
/// walk, and passing `max_pages` fails.
async fn list_all_pages<R, F, Fut>(method: &str, max_pages: u32, fetch: F) -> std::result::Result<R, McpError>
where
    R: Paged,
    F: Fn(Option<String>) -> Fut,
    Fut: Future<Output = std::result::Result<R, ServiceError>>,
{
    let mut accumulated = fetch(None).await?;
    let mut cursor = accumulated.cursor().clone();
    let mut previous_items = serde_json::to_value(accumulated.items()).unwrap_or_default();
    let mut pages = 1;
    while let Some(current) = cursor {
        if max_pages != 0 && pages >= max_pages {
            return Err(McpError::sdk(
                McpSdkErrorCode::ListPaginationExceeded,
                format!("{method}: exceeded listMaxPages ({max_pages}); server pagination did not terminate"),
            ));
        }
        let mut page = fetch(Some(current.clone())).await?;
        let items = serde_json::to_value(page.items()).unwrap_or_default();
        let next = page.cursor().clone();
        if next.as_deref() == Some(current.as_str()) && items == previous_items {
            break;
        }
        accumulated.items().append(page.items());
        previous_items = items;
        cursor = next;
        pages += 1;
    }
    *accumulated.cursor() = None;
    Ok(accumulated)
}

struct ProgressRegistration {
    router: Arc<ProgressRouter>,
    token: ProgressToken,
}

impl Drop for ProgressRegistration {
    fn drop(&mut self) {
        self.router.remove(&self.token);
    }
}

struct CancelOnDrop {
    peer: Peer<RoleClient>,
    id: Option<RequestId>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else {
            return;
        };
        let peer = self.peer.clone();
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        runtime.spawn(async move {
            let params =
                rmcp::model::CancelledNotificationParam::new(Some(id), Some("The operation was aborted".to_owned()));
            let _ = peer.notify_cancelled(params).await;
        });
    }
}

impl McpClient {
    /// Creates a client (`new McpClient(config)`); it connects on first use.
    ///
    /// # Errors
    ///
    /// Both or neither of `transport` and `url`; `auth`, `auth_provider` or `headers` without
    /// `url`; both `auth` and `auth_provider`; an invalid URL or header.
    pub fn new(config: McpClientConfig) -> Result<Self> {
        Self::with_trace_carrier(config, current_trace_carrier)
    }

    /// Creates a client over `transport` with default options.
    #[must_use]
    pub fn with_transport(transport: McpTransport) -> Self {
        Self::from_parts(transport, McpClientOptions::default(), current_trace_carrier)
    }

    pub(crate) fn with_trace_carrier(config: McpClientConfig, trace_carrier: TraceCarrierFn) -> Result<Self> {
        let transport = resolve_transport(&config)?;
        Ok(Self::from_parts(transport, config.options, trace_carrier))
    }

    fn from_parts(transport: McpTransport, options: McpClientOptions, trace_carrier: TraceCarrierFn) -> Self {
        let settings = Settings {
            name: options
                .application_name
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| DEFAULT_CLIENT_NAME.to_owned()),
            version: options
                .application_version
                .filter(|version| !version.is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned()),
            prefix: options.prefix,
            tool_filters: options.tool_filters,
            list_max_pages: options.list_max_pages.unwrap_or(DEFAULT_LIST_MAX_PAGES),
            progress_callback: options.progress_callback,
            elicitation_callback: options.elicitation_callback,
            continue_on_error: options.continue_on_error,
            log_handler: options.log_handler,
            disable_mcp_instrumentation: options.disable_mcp_instrumentation,
            trace_carrier,
        };
        Self {
            inner: Arc::new(Inner {
                settings,
                transport,
                conn: Mutex::new(Conn {
                    state: McpConnectionState::Disconnected,
                    generation: 0,
                    service: None,
                    peer: None,
                    router: None,
                    attempt: None,
                    attempts: 0,
                }),
                tools: Mutex::new(ToolsState::default()),
                output_schemas: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn from_inner(inner: Arc<Inner>) -> Self {
        Self { inner }
    }

    /// A weak handle on the shared state, to observe when the last clone is gone.
    #[cfg(test)]
    pub(crate) fn downgrade(&self) -> Weak<Inner> {
        Arc::downgrade(&self.inner)
    }

    /// The connection state.
    #[must_use]
    pub fn connection_state(&self) -> McpConnectionState {
        lock(&self.inner.conn).state
    }

    /// The client name sent in the handshake.
    #[must_use]
    pub fn client_name(&self) -> &str {
        &self.inner.settings.name
    }

    /// Whether connection failures are skipped with a warning (`continueOnError`).
    #[must_use]
    pub fn continue_on_error(&self) -> bool {
        self.inner.settings.continue_on_error
    }

    /// The `rmcp` peer of the live connection (`client`).
    #[must_use]
    pub fn client(&self) -> Option<Peer<RoleClient>> {
        lock(&self.inner.conn).peer.clone()
    }

    fn server_info(&self) -> Option<Arc<rmcp::model::ServerPeerInfo>> {
        self.client()?.peer_info()
    }

    /// The capabilities the server announced, once connected.
    #[must_use]
    pub fn server_capabilities(&self) -> Option<ServerCapabilities> {
        self.server_info().map(|info| info.capabilities.clone())
    }

    /// The server's name and version, once connected.
    #[must_use]
    pub fn server_version(&self) -> Option<Implementation> {
        self.server_info().and_then(|info| info.server_info.clone())
    }

    /// The server's usage instructions, once connected.
    #[must_use]
    pub fn server_instructions(&self) -> Option<String> {
        self.server_info().and_then(|info| info.instructions.clone())
    }

    /// Connects to the server (`connect`). Operations call it lazily.
    ///
    /// Concurrent callers share one attempt. Under `continue_on_error` a failure is logged, the
    /// client enters [`McpConnectionState::Failed`], and later calls do nothing until
    /// `connect(true)` retries. `reconnect` forces a new connection even when connected or
    /// failed; built-in transports and [`McpTransport::from_fn`] start afresh.
    ///
    /// # Errors
    ///
    /// The connection failure (without `continue_on_error`), or `MCP client disconnected` when
    /// [`disconnect`](Self::disconnect) ran meanwhile.
    pub async fn connect(&self, reconnect: bool) -> Result<()> {
        self.connect_with(reconnect, None).await
    }

    /// [`connect`](Self::connect) that stops waiting when `cancel_signal` fires. The attempt
    /// itself continues for other callers.
    ///
    /// # Errors
    ///
    /// As [`connect`](Self::connect), or the cancellation.
    pub async fn connect_with(&self, reconnect: bool, cancel_signal: Option<&CancelSignal>) -> Result<()> {
        if let Some(signal) = cancel_signal
            && signal.is_cancelled()
        {
            return Err(aborted(signal).into());
        }
        let (generation, existing) = {
            let conn = lock(&self.inner.conn);
            (
                conn.generation,
                conn.attempt.as_ref().map(|(_, attempt)| attempt.clone()),
            )
        };
        if let Some(existing) = existing {
            let outcome = race(existing, cancel_signal).await;
            if let Err(error) = outcome
                && (!reconnect || cancel_signal.is_some_and(CancelSignal::is_cancelled))
            {
                return Err(error.into());
            }
            self.assert_current(generation)?;
            if !reconnect {
                return Ok(());
            }
        }
        let attempt = {
            let mut conn = lock(&self.inner.conn);
            if conn.state != McpConnectionState::Disconnected && !reconnect {
                return Ok(());
            }
            self.start_attempt(&mut conn, reconnect)
        };
        race(attempt, cancel_signal).await?;
        self.assert_current(generation)?;
        Ok(())
    }

    fn start_attempt(&self, conn: &mut Conn, reconnect: bool) -> Attempt {
        conn.attempts += 1;
        let id = conn.attempts;
        let inner = self.inner.clone();
        let task = tokio::spawn(async move {
            let result = run_connect(&inner, reconnect).await;
            let mut conn = lock(&inner.conn);
            if conn.attempt.as_ref().is_some_and(|(current, _)| *current == id) {
                conn.attempt = None;
            }
            result
        });
        let attempt = async move {
            task.await
                .unwrap_or_else(|error| Err(McpError::other(format!("MCP connect task failed: {error}"))))
        }
        .boxed()
        .shared();
        conn.attempt = Some((id, attempt.clone()));
        attempt
    }

    fn assert_current(&self, generation: u64) -> std::result::Result<(), McpError> {
        if lock(&self.inner.conn).generation == generation {
            Ok(())
        } else {
            Err(McpError::disconnected())
        }
    }

    async fn connect_or_throw(&self, cancel_signal: Option<&CancelSignal>) -> Result<Peer<RoleClient>> {
        Ok(self.live_connection(cancel_signal).await?.0)
    }

    async fn live_connection(
        &self,
        cancel_signal: Option<&CancelSignal>,
    ) -> Result<(Peer<RoleClient>, Option<Arc<ProgressRouter>>)> {
        self.connect_with(false, cancel_signal).await?;
        let conn = lock(&self.inner.conn);
        if conn.state == McpConnectionState::Failed {
            return Err(McpError::other(NOT_CONNECTED).into());
        }
        let peer = conn
            .peer
            .clone()
            .ok_or_else(|| McpError::sdk(McpSdkErrorCode::NotConnected, "Not connected"))?;
        Ok((peer, conn.router.clone()))
    }

    /// Disconnects and ends the transport (`disconnect`). Pending operations fail with
    /// `MCP client disconnected`; a later operation connects again.
    ///
    /// # Errors
    ///
    /// None today; the signature leaves room for transport close failures.
    pub async fn disconnect(&self) -> Result<()> {
        cancel_tools_changed(&self.inner);
        let service = {
            let mut conn = lock(&self.inner.conn);
            conn.generation += 1;
            conn.state = McpConnectionState::Disconnected;
            conn.peer = None;
            conn.router = None;
            conn.attempt = None;
            conn.service.take()
        };
        if let Some(service) = service {
            let _ = service.cancel().await;
        }
        Ok(())
    }

    /// Lists the server's tools as [`McpTool`]s with the client's prefix and filters. A failed
    /// connection under `continue_on_error` lists none.
    ///
    /// # Errors
    ///
    /// A connection or protocol failure, or [`ToolValidationError`] when a prefixed name exceeds
    /// 64 characters without `continue_on_error`.
    pub async fn list_tools(&self) -> Result<Vec<McpTool>> {
        self.list_tools_with(McpListToolsOptions::default()).await
    }

    /// [`list_tools`](Self::list_tools) with per-call overrides. A prefix renames tools for the
    /// agent only: they are invoked, and matched by name and regex filters, under their
    /// server-side names.
    ///
    /// # Errors
    ///
    /// As [`list_tools`](Self::list_tools).
    pub async fn list_tools_with(&self, options: McpListToolsOptions) -> Result<Vec<McpTool>> {
        self.connect(false).await?;
        let peer = {
            let conn = lock(&self.inner.conn);
            if conn.state == McpConnectionState::Failed {
                return Ok(Vec::new());
            }
            conn.peer.clone()
        };
        let Some(peer) = peer else {
            return Err(McpError::sdk(McpSdkErrorCode::NotConnected, "Not connected").into());
        };
        let settings = &self.inner.settings;
        let prefix = options.prefix.as_ref().or(settings.prefix.as_ref());
        let filters = options.tool_filters.as_ref().or(settings.tool_filters.as_ref());
        let listed: ListToolsResult = list_all_pages("tools/list", settings.list_max_pages, |cursor| {
            let peer = peer.clone();
            async move { peer.list_tools(page_params(cursor)).await }
        })
        .await?;
        self.cache_output_schemas(&listed.tools);

        let mut tools = Vec::new();
        for spec in &listed.tools {
            if let Some(tool) = self.listed_tool(spec, prefix.map(String::as_str), filters)? {
                tools.push(tool);
            }
        }
        if options.prefix.is_none() && options.tool_filters.is_none() {
            lock(&self.inner.tools).registered_names = tools
                .iter()
                .map(|tool| crate::tools::Tool::name(tool).to_owned())
                .collect();
        }
        Ok(tools)
    }

    /// Compiles the listed tools' output schemas for [`call_tool`](Self::call_tool), from the last
    /// aggregated `tools/list`.
    fn cache_output_schemas(&self, tools: &[rmcp::model::Tool]) {
        let schemas = tools
            .iter()
            .filter_map(|tool| {
                let schema = JsonValue::Object(tool.output_schema.as_ref()?.as_ref().clone());
                let compiled = match jsonschema::validator_for(&schema) {
                    Ok(validator) => OutputSchema::Valid(validator),
                    Err(error) => OutputSchema::Invalid(error.to_string().chars().take(200).collect()),
                };
                Some((tool.name.to_string(), Arc::new(compiled)))
            })
            .collect();
        *lock(&self.inner.output_schemas) = schemas;
    }

    fn listed_tool(
        &self,
        spec: &rmcp::model::Tool,
        prefix: Option<&str>,
        filters: Option<&McpToolFilters>,
    ) -> Result<Option<McpTool>> {
        let server_name = spec.name.to_string();
        let prefix = prefix.filter(|prefix| !prefix.is_empty());
        let tool_name = match prefix {
            Some(prefix) => {
                let renamed = format!("{prefix}_{server_name}");
                tracing::debug!("tool_rename=<{server_name}->{renamed}> | renamed tool");
                renamed
            }
            None => server_name.clone(),
        };
        let description = spec
            .description
            .as_deref()
            .filter(|description| !description.is_empty())
            .map_or_else(|| format!("Tool which performs {server_name}"), ToOwned::to_owned);
        let annotations = spec
            .annotations
            .as_ref()
            .and_then(|annotations| serde_json::to_value(annotations).ok())
            .and_then(|value| match value {
                JsonValue::Object(map) if !map.is_empty() => Some(map),
                _ => None,
            });
        let config = McpToolConfig {
            name: tool_name.clone(),
            description,
            input_schema: JsonValue::Object(spec.input_schema.as_ref().clone()),
            output_schema: spec
                .output_schema
                .as_ref()
                .map(|schema| JsonValue::Object(schema.as_ref().clone())),
            annotations,
            client: self.clone(),
        };
        let tool = McpTool::listed(config, server_name.clone());
        if filters.is_some_and(|filters| !filters.includes(&tool, &server_name)) {
            return Ok(None);
        }
        if prefix.is_none() || tool_name.len() <= MAX_TOOL_NAME_LENGTH {
            return Ok(Some(tool));
        }
        let server = self
            .server_version()
            .map_or_else(|| "unknown".to_owned(), |version| version.name);
        let message = format!(
            "server=<{server}>, tool=<{server_name}>, name=<{tool_name}>, length=<{}>, limit=<{MAX_TOOL_NAME_LENGTH}> | tool name exceeds registry limit | use a shorter prefix or tool name",
            tool_name.len()
        );
        if !self.inner.settings.continue_on_error {
            return Err(ToolValidationError::new(message).into());
        }
        tracing::warn!("{message} | skipping tool (continueOnError)");
        Ok(None)
    }

    /// Sets the callback run when the server's tool list changes, or removes
    /// it with `None`. It receives the previously registered names and the refreshed tools.
    pub fn set_on_tools_changed(&self, callback: Option<ToolsChangedCallback>) {
        lock(&self.inner.tools).on_tools_changed = callback;
    }

    /// Schedules a refresh after a `notifications/tools/list_changed`, debounced by 300 ms.
    /// Disconnecting or reconnecting cancels a pending refresh.
    pub(crate) fn notify_tools_changed(&self) {
        let debounce = {
            let mut tools = lock(&self.inner.tools);
            tools.debounce += 1;
            tools.debounce
        };
        let connection = lock(&self.inner.conn).generation;
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            tokio::time::sleep(LIST_CHANGED_DEBOUNCE).await;
            let Some(inner) = Weak::upgrade(&weak) else {
                return;
            };
            if lock(&inner.tools).debounce != debounce {
                return;
            }
            {
                let conn = lock(&inner.conn);
                if conn.generation != connection || conn.state != McpConnectionState::Connected {
                    return;
                }
            }
            Self { inner }.handle_tools_changed().await;
        });
    }

    pub(crate) async fn handle_tools_changed(&self) {
        {
            let mut tools = lock(&self.inner.tools);
            if tools.refreshing {
                tools.pending_refresh = true;
                return;
            }
            tools.refreshing = true;
        }
        loop {
            let old_names = {
                let mut tools = lock(&self.inner.tools);
                tools.pending_refresh = false;
                tools.registered_names.clone()
            };
            match self.list_tools().await {
                Ok(new_tools) => {
                    let callback = lock(&self.inner.tools).on_tools_changed.clone();
                    if let Some(callback) = callback {
                        callback(old_names, new_tools);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        "client=<{}>, error=<{error}> | failed to refresh tools after toolsChanged notification",
                        self.inner.settings.name
                    );
                    break;
                }
            }
            if !lock(&self.inner.tools).pending_refresh {
                break;
            }
        }
        lock(&self.inner.tools).refreshing = false;
    }

    fn capabilities_lack(&self, has: impl Fn(&ServerCapabilities) -> bool) -> bool {
        self.server_capabilities()
            .is_some_and(|capabilities| !has(&capabilities))
    }

    /// Lists the server's prompts. Without a pagination token every page is
    /// aggregated (failing past `list_max_pages`); with one, a single page is fetched.
    ///
    /// # Errors
    ///
    /// `MCP server failed to connect. Call connect(true) to retry.` after a failed connection
    /// under `continue_on_error`; a connection or protocol failure.
    pub async fn list_prompts(&self, options: McpListOptions) -> Result<ListPromptsResult> {
        let peer = self.connect_or_throw(None).await?;
        if self.capabilities_lack(|capabilities| capabilities.prompts.is_some()) {
            return Ok(empty_list(ListPromptsResult::with_all_items(Vec::new())));
        }
        self.paged("prompts/list", options, move |cursor| {
            let peer = peer.clone();
            async move { peer.list_prompts(page_params(cursor)).await }
        })
        .await
    }

    /// Gets a prompt by name, with arguments for its template.
    ///
    /// # Errors
    ///
    /// As [`list_prompts`](Self::list_prompts).
    pub async fn get_prompt(&self, prompt_id: &str, args: Option<JsonObject>) -> Result<GetPromptResult> {
        let peer = self.connect_or_throw(None).await?;
        let mut params = GetPromptRequestParams::new(prompt_id);
        params.arguments = args;
        Ok(peer.get_prompt(params).await.map_err(McpError::from)?)
    }

    /// Lists the server's resources, paginated as
    /// [`list_prompts`](Self::list_prompts).
    ///
    /// # Errors
    ///
    /// As [`list_prompts`](Self::list_prompts).
    pub async fn list_resources(&self, options: McpListOptions) -> Result<ListResourcesResult> {
        let peer = self.connect_or_throw(None).await?;
        if self.capabilities_lack(|capabilities| capabilities.resources.is_some()) {
            return Ok(empty_list(ListResourcesResult::with_all_items(Vec::new())));
        }
        self.paged("resources/list", options, move |cursor| {
            let peer = peer.clone();
            async move { peer.list_resources(page_params(cursor)).await }
        })
        .await
    }

    /// Reads a resource.
    ///
    /// # Errors
    ///
    /// As [`list_prompts`](Self::list_prompts).
    pub async fn read_resource(&self, uri: impl AsRef<str>) -> Result<ReadResourceResult> {
        let peer = self.connect_or_throw(None).await?;
        let params = ReadResourceRequestParams::new(uri.as_ref());
        Ok(peer.read_resource(params).await.map_err(McpError::from)?)
    }

    /// Lists the server's resource templates, paginated as
    /// [`list_prompts`](Self::list_prompts).
    ///
    /// # Errors
    ///
    /// As [`list_prompts`](Self::list_prompts).
    pub async fn list_resource_templates(&self, options: McpListOptions) -> Result<ListResourceTemplatesResult> {
        let peer = self.connect_or_throw(None).await?;
        if self.capabilities_lack(|capabilities| capabilities.resources.is_some()) {
            return Ok(empty_list(ListResourceTemplatesResult::with_all_items(Vec::new())));
        }
        self.paged("resources/templates/list", options, move |cursor| {
            let peer = peer.clone();
            async move { peer.list_resource_templates(page_params(cursor)).await }
        })
        .await
    }

    async fn paged<R, F, Fut>(&self, method: &str, options: McpListOptions, fetch: F) -> Result<R>
    where
        R: Paged,
        F: Fn(Option<String>) -> Fut,
        Fut: Future<Output = std::result::Result<R, ServiceError>>,
    {
        if let Some(token) = options.pagination_token {
            return Ok(fetch(Some(token)).await.map_err(McpError::from)?);
        }
        Ok(list_all_pages(method, self.inner.settings.list_max_pages, fetch).await?)
    }

    /// Calls `tool` on the server with `args` and returns the raw `tools/call` result.
    ///
    /// # Errors
    ///
    /// Arguments that are not a JSON object, an invalid timeout, a failed connection, a
    /// protocol error from the server, a timeout or the cancellation.
    pub async fn call_tool(&self, tool: &McpTool, args: JsonValue, options: McpCallToolOptions) -> Result<JsonValue> {
        validate_timeout(options.timeout)?;
        let signal = options.cancel_signal.as_ref();
        let (peer, router) = self.live_connection(signal).await?;
        let params = self.prepare_tool_call(tool, args)?;
        let output_schema = self.output_schema(tool.server_tool_name())?;
        let callback = options
            .progress_callback
            .or_else(|| self.inner.settings.progress_callback.clone());

        let mut request = CallToolRequest::new(params);
        match (&callback, &router) {
            (Some(callback), Some(_)) => {
                request.extensions.insert(ProgressRoute(callback.clone()));
            }
            _ if options.timeout.is_none() => {
                request.extensions.insert(WithoutProgressToken);
            }
            _ => {}
        }
        let mut request_options = PeerRequestOptions::no_options();
        request_options.timeout = options.timeout;
        request_options.reset_timeout_on_progress = options.timeout.is_some();
        request_options.max_total_timeout = options.timeout;
        let handle = peer
            .send_request_with_option(ClientRequest::CallToolRequest(request), request_options)
            .await
            .map_err(McpError::from)?;
        let registration = router
            .filter(|_| callback.is_some())
            .map(|router| ProgressRegistration {
                router,
                token: handle.progress_token.clone(),
            });
        let mut guard = CancelOnDrop {
            peer,
            id: Some(handle.id.clone()),
        };
        let response = race(async { handle.await_response().await.map_err(McpError::from) }, signal).await;
        if !(response.is_err() && signal.is_some_and(CancelSignal::is_cancelled)) {
            guard.id = None;
        }
        if let Some(registration) = &registration
            && response.is_ok()
        {
            registration.router.flush().await;
        }
        let raw = match response? {
            ServerResult::CallToolResult(result) => serde_json::to_value(result)?,
            ServerResult::CustomResult(custom) => custom.0,
            _ => return Err(McpError::sdk(McpSdkErrorCode::InvalidResult, "Unexpected response type").into()),
        };
        if let Some(schema) = output_schema {
            validate_output(tool.server_tool_name(), &schema, &raw)?;
        }
        Ok(raw)
    }

    /// The compiled output schema of a listed tool; an invalid one fails the call before it is
    /// sent.
    fn output_schema(&self, server_tool_name: &str) -> std::result::Result<Option<Arc<OutputSchema>>, McpError> {
        let Some(schema) = lock(&self.inner.output_schemas).get(server_tool_name).cloned() else {
            return Ok(None);
        };
        if let OutputSchema::Invalid(message) = schema.as_ref() {
            return Err(McpError::protocol(
                INVALID_PARAMS,
                format!("Tool '{server_tool_name}' has an invalid outputSchema: {message}"),
                None,
            ));
        }
        Ok(Some(schema))
    }

    fn prepare_tool_call(&self, tool: &McpTool, args: JsonValue) -> Result<CallToolRequestParams> {
        let args = match args {
            JsonValue::Null => JsonObject::new(),
            JsonValue::Object(map) => map,
            other => {
                return Err(McpError::other(format!(
                    "MCP Protocol Error: Tool arguments must be a JSON Object (named parameters). Received: {}",
                    js_type_name(&other)
                ))
                .into());
            }
        };
        let settings = &self.inner.settings;
        let args = if settings.disable_mcp_instrumentation {
            args
        } else {
            inject_trace_context(args, settings.trace_carrier)
        };
        let mut params = CallToolRequestParams::new(tool.server_tool_name().to_owned());
        params.arguments = Some(args);
        Ok(params)
    }
}

/// Checks a `tools/call` result against the tool's output schema.
fn validate_output(
    server_tool_name: &str,
    schema: &OutputSchema,
    raw: &JsonValue,
) -> std::result::Result<(), McpError> {
    let OutputSchema::Valid(validator) = schema else {
        return Ok(());
    };
    if raw.get("isError").is_some_and(|value| value.as_bool() == Some(true)) {
        return Ok(());
    }
    let Some(structured) = raw.get("structuredContent") else {
        return Err(McpError::protocol(
            INVALID_REQUEST,
            format!("Tool {server_tool_name} has an output schema but did not return structured content"),
            None,
        ));
    };
    let issues: Vec<String> = validator
        .iter_errors(structured)
        .map(|error| {
            let path = error.instance_path().as_str();
            if path.is_empty() {
                error.to_string()
            } else {
                format!("{path}: {error}")
            }
        })
        .collect();
    if issues.is_empty() {
        return Ok(());
    }
    Err(McpError::protocol(
        INVALID_PARAMS,
        format!(
            "Structured content does not match the tool's output schema: {}",
            issues.join("; ")
        ),
        None,
    ))
}

fn empty_list<R: Paged + EmptyResultType>(mut result: R) -> R {
    result.clear_result_type();
    result
}

trait EmptyResultType {
    fn clear_result_type(&mut self);
}

macro_rules! clear_result_type {
    ($($result:ty),*) => {
        $(impl EmptyResultType for $result {
            fn clear_result_type(&mut self) {
                self.result_type = None;
            }
        })*
    };
}

clear_result_type!(ListPromptsResult, ListResourcesResult, ListResourceTemplatesResult);

/// Cancels a pending list-changed refresh.
fn cancel_tools_changed(inner: &Inner) {
    lock(&inner.tools).debounce += 1;
}

async fn close_previous(inner: &Inner, generation: u64) -> std::result::Result<(), McpError> {
    cancel_tools_changed(inner);
    let previous = {
        let mut conn = lock(&inner.conn);
        if conn.state == McpConnectionState::Connected {
            conn.peer = None;
            conn.router = None;
            conn.service.take()
        } else {
            None
        }
    };
    if let Some(service) = previous {
        let _ = service.cancel().await;
    }
    let mut conn = lock(&inner.conn);
    if conn.generation != generation {
        return Err(McpError::disconnected());
    }
    if conn.state == McpConnectionState::Connected {
        conn.state = McpConnectionState::Disconnected;
    }
    Ok(())
}

/// Stores a new connection unless `disconnect` ran meanwhile; returns the stale one to close.
fn store_connection(
    inner: &Inner,
    generation: u64,
    established: std::result::Result<Established, McpError>,
) -> (
    std::result::Result<(), McpError>,
    Option<RunningService<RoleClient, Handler>>,
) {
    let mut conn = lock(&inner.conn);
    if conn.generation != generation {
        return (
            Err(McpError::disconnected()),
            established.ok().map(|(service, _)| service),
        );
    }
    match established {
        Ok((service, router)) => {
            conn.peer = Some(service.peer().clone());
            conn.router = Some(router);
            conn.service = Some(service);
            conn.state = McpConnectionState::Connected;
            (Ok(()), None)
        }
        Err(error) if inner.settings.continue_on_error => {
            conn.state = McpConnectionState::Failed;
            tracing::warn!(
                "client=<{}>, error=<{error}> | MCP server failed to connect, continuing (continueOnError)",
                inner.settings.name
            );
            (Ok(()), None)
        }
        Err(error) => (Err(error), None),
    }
}

async fn run_connect(inner: &Arc<Inner>, reconnect: bool) -> std::result::Result<(), McpError> {
    let generation = lock(&inner.conn).generation;
    if reconnect {
        close_previous(inner, generation).await?;
    }
    let established = establish(inner).await;
    let (result, stale) = store_connection(inner, generation, established);
    if let Some(service) = stale {
        let _ = service.cancel().await;
    }
    result
}

type Established = (RunningService<RoleClient, Handler>, Arc<ProgressRouter>);

async fn establish(inner: &Arc<Inner>) -> std::result::Result<Established, McpError> {
    let transport = inner.transport.start().await?;
    let router = ProgressRouter::new(inner.settings.name.clone());
    let transport = RoutedTransport::new(transport, router.clone());
    let handler = Handler::new(Arc::downgrade(inner), inner);
    let service = serve_client_with_lifecycle(handler, transport, ClientLifecycleMode::Initialize)
        .await
        .map_err(McpError::transport)?;
    Ok((service, router))
}

impl fmt::Debug for McpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClient")
            .field("client_name", &self.inner.settings.name)
            .field("transport", &self.inner.transport)
            .field("connection_state", &self.connection_state())
            .finish_non_exhaustive()
    }
}
