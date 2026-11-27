//! [`McpTransport`], how an [`McpClient`](super::McpClient) reaches its server, and the stdio
//! transport.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt;
use futures::future::BoxFuture;
use rmcp::RoleClient;
use rmcp::model::{ClientJsonRpcMessage, ClientRequest, GetExtensions, RequestMetaObject};
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::{IntoTransport, TokioChildProcess, Transport};

use super::error::McpError;
use crate::error::BoxError;

/// Marks a `tools/call` request that must go out without a progress token, because no progress
/// callback or timeout needs one.
#[derive(Debug, Clone, Copy)]
pub(crate) struct WithoutProgressToken;

trait ErasedTransport: Send {
    fn send(&mut self, item: TxJsonRpcMessage<RoleClient>) -> BoxFuture<'static, Result<(), BoxError>>;
    fn receive(&mut self) -> BoxFuture<'_, Option<RxJsonRpcMessage<RoleClient>>>;
    fn close(&mut self) -> BoxFuture<'_, Result<(), BoxError>>;
}

impl<T: Transport<RoleClient> + 'static> ErasedTransport for T {
    fn send(&mut self, item: TxJsonRpcMessage<RoleClient>) -> BoxFuture<'static, Result<(), BoxError>> {
        Transport::send(self, item)
            .map(|result| result.map_err(|error| Box::new(error) as BoxError))
            .boxed()
    }

    fn receive(&mut self) -> BoxFuture<'_, Option<RxJsonRpcMessage<RoleClient>>> {
        Transport::receive(self).boxed()
    }

    fn close(&mut self) -> BoxFuture<'_, Result<(), BoxError>> {
        Transport::close(self)
            .map(|result| result.map_err(|error| Box::new(error) as BoxError))
            .boxed()
    }
}

/// A transport error, carrying the underlying transport's error.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct TransportError(BoxError);

/// A started transport of any type.
pub(crate) struct BoxedTransport(Box<dyn ErasedTransport>);

impl BoxedTransport {
    pub(crate) fn new<T, E, A>(transport: T) -> Self
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        Self(Box::new(transport.into_transport()))
    }
}

fn strip_progress_token(item: &mut TxJsonRpcMessage<RoleClient>) {
    let ClientJsonRpcMessage::Request(request) = item else {
        return;
    };
    let ClientRequest::CallToolRequest(call) = &mut request.request else {
        return;
    };
    if call.extensions().get::<WithoutProgressToken>().is_none() {
        return;
    }
    if let Some(meta) = call.extensions_mut().get_mut::<RequestMetaObject>() {
        meta.remove("progressToken");
    }
    if let Some(meta) = &mut call.params.meta {
        meta.remove("progressToken");
    }
}

impl Transport<RoleClient> for BoxedTransport {
    type Error = TransportError;

    fn send(
        &mut self,
        mut item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        strip_progress_token(&mut item);
        self.0.send(item).map(|result| result.map_err(TransportError))
    }

    fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send {
        self.0.receive()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.0.close().map(|result| result.map_err(TransportError))
    }
}

type Factory = Arc<dyn Fn() -> BoxFuture<'static, Result<BoxedTransport, McpError>> + Send + Sync>;

#[derive(Clone)]
enum Source {
    Factory(Factory),
    Once(Arc<Mutex<Option<BoxedTransport>>>),
}

/// How an [`McpClient`](super::McpClient) reaches its server (`McpTransport`).
///
/// Built-in transports ([`stdio`](Self::stdio), [`sse`](Self::sse)) start afresh on every connect,
/// so a client can reconnect. A transport passed to [`new`](Self::new) starts once; use
/// [`from_fn`](Self::from_fn) to build a fresh one on every connect. A streamable HTTP client is
/// configured with [`McpClientConfig::url`](super::McpClientConfig::url) instead.
#[derive(Clone)]
pub struct McpTransport {
    source: Source,
    kind: &'static str,
}

impl McpTransport {
    /// Wraps any `rmcp` client transport, such as one end of an in-memory duplex stream. It can
    /// start only once; a reconnect fails.
    pub fn new<T, E, A>(transport: T) -> Self
    where
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Source::Once(Arc::new(Mutex::new(Some(BoxedTransport::new(transport))))),
            kind: "custom",
        }
    }

    /// Builds a fresh `rmcp` client transport on every connect.
    pub fn from_fn<F, Fut, T, E, A>(factory: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<T, BoxError>> + Send + 'static,
        T: IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let factory: Factory = Arc::new(move || {
            factory()
                .map(|result| result.map(BoxedTransport::new).map_err(McpError::transport))
                .boxed()
        });
        Self {
            source: Source::Factory(factory),
            kind: "custom",
        }
    }

    /// Spawns the server as a child process and talks to it over stdin and stdout.
    #[must_use]
    pub fn stdio(params: StdioServerParameters) -> Self {
        let params = Arc::new(params);
        let factory: Factory = Arc::new(move || {
            let params = params.clone();
            async move { spawn_stdio(&params).map_err(McpError::transport) }.boxed()
        });
        Self {
            source: Source::Factory(factory),
            kind: "stdio",
        }
    }

    pub(crate) fn from_factory(kind: &'static str, factory: Factory) -> Self {
        Self {
            source: Source::Factory(factory),
            kind,
        }
    }

    /// Starts the transport for one connect attempt.
    pub(crate) async fn start(&self) -> Result<BoxedTransport, McpError> {
        match &self.source {
            Source::Factory(factory) => factory().await,
            Source::Once(slot) => slot
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
                .ok_or_else(|| {
                    McpError::sdk(
                        super::McpSdkErrorCode::SendFailed,
                        "MCP transport already started and cannot start again; construct a new McpClient or use McpTransport::from_fn",
                    )
                }),
        }
    }
}

impl fmt::Debug for McpTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("McpTransport").field(&self.kind).finish()
    }
}

/// How to spawn a stdio MCP server (`StdioServerParameters`).
#[derive(Debug, Clone, Default, PartialEq, Eq, bon::Builder)]
#[builder(on(String, into))]
pub struct StdioServerParameters {
    /// The executable to run.
    pub command: String,
    /// Its arguments.
    #[builder(default)]
    pub args: Vec<String>,
    /// Variables set over the [`default_environment`].
    pub env: Option<BTreeMap<String, String>>,
    /// The working directory; the current one when absent.
    #[builder(into)]
    pub cwd: Option<PathBuf>,
}

impl StdioServerParameters {
    /// Parameters that run `command` with `args`.
    pub fn new(command: impl Into<String>, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: None,
            cwd: None,
        }
    }
}

#[cfg(windows)]
const DEFAULT_INHERITED_ENV_VARS: &[&str] = &[
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
];

#[cfg(not(windows))]
const DEFAULT_INHERITED_ENV_VARS: &[&str] = &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/// The variables a stdio server inherits: only those deemed safe, and
/// none whose value starts with `()` (an exported shell function).
#[must_use]
pub fn default_environment() -> BTreeMap<String, String> {
    DEFAULT_INHERITED_ENV_VARS
        .iter()
        .filter_map(|key| {
            let value = std::env::var(key).ok()?;
            (!value.starts_with("()")).then(|| ((*key).to_owned(), value))
        })
        .collect()
}

fn spawn_stdio(params: &StdioServerParameters) -> std::io::Result<BoxedTransport> {
    let mut command = tokio::process::Command::new(&params.command);
    command.args(&params.args).env_clear().envs(default_environment());
    if let Some(env) = &params.env {
        command.envs(env);
    }
    if let Some(cwd) = &params.cwd {
        command.current_dir(cwd);
    }
    let (transport, _) = TokioChildProcess::builder(command).stderr(Stdio::inherit()).spawn()?;
    Ok(BoxedTransport::new(transport))
}
