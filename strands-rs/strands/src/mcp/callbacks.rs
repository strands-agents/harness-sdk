//! The callbacks an [`McpClient`](super::McpClient) takes: progress, server logs, elicitation
//! and tool-list changes.
use std::fmt;
use std::future::Future;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use rmcp::model::{ElicitRequestParams, ElicitResult};
use serde::{Deserialize, Serialize};

use super::mcp_tool::McpTool;
use crate::cancel::CancelSignal;
use crate::error::BoxError;
use crate::types::JsonValue;

/// A progress update an MCP server reports during a tool call (`McpProgress`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[non_exhaustive]
pub struct McpProgress {
    /// Work completed so far. Increases even when the total is unknown.
    pub progress: f64,
    /// Total work, when the server reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
    /// A description of the current progress, when the server provides one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl McpProgress {
    /// A progress update.
    #[must_use]
    pub fn new(progress: f64, total: Option<f64>, message: Option<String>) -> Self {
        Self {
            progress,
            total,
            message,
        }
    }
}

type ProgressFn = dyn Fn(McpProgress) -> BoxFuture<'static, Result<(), BoxError>> + Send + Sync;

/// Receives progress notifications during a tool call (`McpProgressCallback`). A failure is
/// logged as a warning.
///
/// Build one from a plain closure with `.into()`, or from an async, fallible one with
/// [`new`](Self::new).
#[derive(Clone)]
pub struct McpProgressCallback(Arc<ProgressFn>);

impl McpProgressCallback {
    /// A callback that awaits `callback` for each update.
    pub fn new<F, Fut>(callback: F) -> Self
    where
        F: Fn(McpProgress) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), BoxError>> + Send + 'static,
    {
        Self(Arc::new(move |progress| callback(progress).boxed()))
    }

    pub(crate) async fn call(&self, progress: McpProgress) -> Result<(), BoxError> {
        (self.0)(progress).await
    }
}

impl<F: Fn(McpProgress) + Send + Sync + 'static> From<F> for McpProgressCallback {
    fn from(callback: F) -> Self {
        Self(Arc::new(move |progress| {
            callback(progress);
            futures::future::ready(Ok(())).boxed()
        }))
    }
}

impl fmt::Debug for McpProgressCallback {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("McpProgressCallback")
    }
}

/// The severity of an MCP server log message (`LoggingLevel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum McpLogLevel {
    /// `debug`.
    Debug,
    /// `info`.
    Info,
    /// `notice`.
    Notice,
    /// `warning`.
    Warning,
    /// `error`.
    Error,
    /// `critical`.
    Critical,
    /// `alert`.
    Alert,
    /// `emergency`.
    Emergency,
}

/// A log message an MCP server emits (`LoggingMessageNotificationParams`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct McpLogMessage {
    /// The severity.
    pub level: McpLogLevel,
    /// The name of the logger that emitted the message, when the server gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logger: Option<String>,
    /// The message: any JSON value.
    pub data: JsonValue,
}

impl McpLogMessage {
    /// A message at `level` without a logger name.
    #[must_use]
    pub fn new(level: McpLogLevel, data: JsonValue) -> Self {
        Self {
            level,
            logger: None,
            data,
        }
    }

    /// Sets the logger name.
    #[must_use]
    pub fn with_logger(mut self, logger: impl Into<String>) -> Self {
        self.logger = Some(logger.into());
        self
    }
}

crate::callback::callback! {
    /// Receives the log messages an MCP server emits.
    ///
    /// ```
    /// use strands::mcp::{McpClientOptions, McpLogHandler};
    ///
    /// let handler = McpLogHandler::new(|message| println!("{:?} {}", message.level, message.data));
    /// let options = McpClientOptions::builder().log_handler(handler).build();
    /// assert!(options.log_handler.is_some());
    /// ```
    pub struct McpLogHandler(Fn(&McpLogMessage));
}

crate::callback::callback! {
    /// Called when the server's tool list changes, with the previously registered tool names and
    /// the refreshed tools.
    pub struct ToolsChangedCallback(Fn(Vec<String>, Vec<McpTool>));
}

/// What an [`ElicitationCallback`] receives besides the request (`ElicitationContext`).
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ElicitationContext {
    request_id: JsonValue,
    cancel_signal: CancelSignal,
}

impl ElicitationContext {
    pub(crate) fn new(request_id: JsonValue, cancel_signal: CancelSignal) -> Self {
        Self {
            request_id,
            cancel_signal,
        }
    }

    /// The JSON-RPC id of the server's request (`mcpReq.id`).
    #[must_use]
    pub fn request_id(&self) -> &JsonValue {
        &self.request_id
    }

    /// Fires when the server cancels the request (`mcpReq.signal`).
    #[must_use]
    pub fn cancel_signal(&self) -> &CancelSignal {
        &self.cancel_signal
    }
}

/// Handles a server's request for user input during a tool call (`ElicitationCallback`).
///
/// Any async closure taking the context and the request implements it. A failure is returned to
/// the server as a JSON-RPC error.
///
/// ```
/// use strands::mcp::rmcp::model::{ElicitResult, ElicitationAction};
/// use strands::mcp::{ElicitationCallback, McpClientOptions};
/// use std::sync::Arc;
///
/// let callback: Arc<dyn ElicitationCallback> = Arc::new(|_context, _params| async {
///     Ok(ElicitResult::new(ElicitationAction::Decline))
/// });
/// let options = McpClientOptions::builder().elicitation_callback(callback).build();
/// assert!(options.elicitation_callback.is_some());
/// ```
#[async_trait]
pub trait ElicitationCallback: Send + Sync + 'static {
    /// Returns the user's answer: accept (with content), decline or cancel.
    async fn elicit(&self, context: ElicitationContext, params: ElicitRequestParams) -> Result<ElicitResult, BoxError>;
}

#[async_trait]
impl<F, Fut> ElicitationCallback for F
where
    F: Fn(ElicitationContext, ElicitRequestParams) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<ElicitResult, BoxError>> + Send + 'static,
{
    async fn elicit(&self, context: ElicitationContext, params: ElicitRequestParams) -> Result<ElicitResult, BoxError> {
        self(context, params).await
    }
}
