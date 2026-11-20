//! The `rmcp` client handler behind an [`McpClient`](super::McpClient): elicitation requests,
//! progress, server logs and tool-list changes.
#![allow(
    deprecated,
    reason = "rmcp deprecates logging (SEP-2577), which the client still supports"
)]

use std::sync::Weak;

use rmcp::ClientHandler;
use rmcp::model::{
    ClientCapabilities, ClientConfig, ElicitRequestParams, ElicitResult, ElicitationCapability, ErrorData,
    FormElicitationCapability, Implementation, LoggingLevel, LoggingMessageNotificationParam, ProtocolVersion,
    UrlElicitationCapability,
};
use rmcp::service::{NotificationContext, RequestContext, RoleClient};

use super::callbacks::{ElicitationContext, McpLogLevel, McpLogMessage};
use super::client::{Inner, McpClient};
use crate::cancel::{CancelHandle, CancelOptions};

#[derive(Clone)]
pub(crate) struct Handler {
    inner: Weak<Inner>,
    info: ClientConfig,
}

impl Handler {
    pub(crate) fn new(weak: Weak<Inner>, inner: &Inner) -> Self {
        let mut capabilities = ClientCapabilities::default();
        if inner.elicitation_callback().is_some() {
            capabilities.elicitation = Some(
                ElicitationCapability::new()
                    .with_form(FormElicitationCapability::default())
                    .with_url(UrlElicitationCapability::default()),
            );
        }
        let info = ClientConfig::new(capabilities, Implementation::new(inner.name(), inner.version()))
            .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE);
        Self { inner: weak, info }
    }
}

fn log_level(level: LoggingLevel) -> McpLogLevel {
    match level {
        LoggingLevel::Debug => McpLogLevel::Debug,
        LoggingLevel::Info => McpLogLevel::Info,
        LoggingLevel::Notice => McpLogLevel::Notice,
        LoggingLevel::Warning => McpLogLevel::Warning,
        LoggingLevel::Error => McpLogLevel::Error,
        LoggingLevel::Critical => McpLogLevel::Critical,
        LoggingLevel::Alert => McpLogLevel::Alert,
        LoggingLevel::Emergency => McpLogLevel::Emergency,
    }
}

pub(crate) fn log_message(params: LoggingMessageNotificationParam) -> McpLogMessage {
    McpLogMessage {
        level: log_level(params.level),
        logger: params.logger,
        data: params.data,
    }
}

/// Routes a server log through `tracing`.
pub(crate) fn default_log_handler(log: &McpLogMessage) {
    let message = format!(
        "logger=<{}>, data=<{}> | MCP server log",
        log.logger.as_deref().unwrap_or("mcp"),
        log.data
    );
    match log.level {
        McpLogLevel::Debug => tracing::debug!("{message}"),
        McpLogLevel::Info | McpLogLevel::Notice => tracing::info!("{message}"),
        McpLogLevel::Warning => tracing::warn!("{message}"),
        _ => tracing::error!("{message}"),
    }
}

impl ClientHandler for Handler {
    fn get_info(&self) -> ClientConfig {
        self.info.clone()
    }

    async fn create_elicitation(
        &self,
        params: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let callback = self
            .inner
            .upgrade()
            .and_then(|inner| inner.elicitation_callback().cloned());
        let Some(callback) = callback else {
            return Err(ErrorData::method_not_found::<rmcp::model::ElicitationCreateRequestMethod>());
        };
        let handle = CancelHandle::new();
        let request_id = serde_json::to_value(&context.id).unwrap_or_default();
        let elicitation = ElicitationContext::new(request_id, handle.signal());
        let token = context.ct.clone();
        let watcher = tokio::spawn(async move {
            token.cancelled().await;
            handle.cancel(CancelOptions::default());
        });
        let result = callback.elicit(elicitation, params).await;
        watcher.abort();
        result.map_err(|error| ErrorData::internal_error(error.to_string(), None))
    }

    async fn on_logging_message(
        &self,
        params: LoggingMessageNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        let message = log_message(params);
        match inner.log_handler() {
            Some(handler) => handler(&message),
            None => default_log_handler(&message),
        }
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        if let Some(inner) = self.inner.upgrade() {
            McpClient::from_inner(inner).notify_tools_changed();
        }
    }
}

impl std::fmt::Debug for Handler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Handler").finish_non_exhaustive()
    }
}
