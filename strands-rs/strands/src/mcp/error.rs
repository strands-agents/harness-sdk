//! [`McpError`], the failures of an MCP client: protocol errors, MCP SDK errors and the plain
//! errors `McpClient` throws.

use rmcp::ServiceError;
use rmcp::model::ErrorData;

use crate::types::JsonValue;

/// The JSON-RPC code a server uses when a request needs URL elicitation first
/// (`ProtocolErrorCode.UrlElicitationRequired`).
pub const URL_ELICITATION_REQUIRED: i32 = -32042;

/// Why an MCP SDK operation failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum McpSdkErrorCode {
    /// The connection closed, or the client disconnected while the operation waited
    /// (`ConnectionClosed`).
    ConnectionClosed,
    /// The operation is not possible before connecting (`NotConnected`).
    NotConnected,
    /// The request did not complete in time (`RequestTimeout`).
    RequestTimeout,
    /// The server paged past the list cap (`ListPaginationExceeded`).
    ListPaginationExceeded,
    /// The transport failed to start, send or receive (`SendFailed`).
    SendFailed,
    /// The server sent a response of the wrong shape (`InvalidResult`).
    InvalidResult,
}

/// A failure of an MCP client operation.
///
/// [`McpError::name`] gives the error's class name.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum McpError {
    /// The server answered with a JSON-RPC error (`ProtocolError`).
    #[error("{message}")]
    #[non_exhaustive]
    Protocol {
        /// The JSON-RPC error code.
        code: i32,
        /// The server's message.
        message: String,
        /// The server's error data.
        data: Option<JsonValue>,
    },
    /// The MCP SDK failed (`SdkError`).
    #[error("{message}")]
    #[non_exhaustive]
    Sdk {
        /// What failed.
        code: McpSdkErrorCode,
        /// What happened.
        message: String,
    },
    /// Any other failure.
    #[error("{0}")]
    Other(String),
}

impl McpError {
    /// A protocol error with the given code, message and data.
    pub fn protocol(code: i32, message: impl Into<String>, data: Option<JsonValue>) -> Self {
        Self::Protocol {
            code,
            message: message.into(),
            data,
        }
    }

    /// An MCP SDK error.
    pub fn sdk(code: McpSdkErrorCode, message: impl Into<String>) -> Self {
        Self::Sdk {
            code,
            message: message.into(),
        }
    }

    /// A plain error.
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other(message.into())
    }

    /// The error's class name: `"ProtocolError"`, `"SdkError"` or `"Error"`.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Protocol { .. } => "ProtocolError",
            Self::Sdk { .. } => "SdkError",
            Self::Other(_) => "Error",
        }
    }

    /// The `<name>: <message>` form.
    #[must_use]
    pub fn to_js_string(&self) -> String {
        format!("{}: {self}", self.name())
    }

    pub(crate) fn disconnected() -> Self {
        Self::sdk(McpSdkErrorCode::ConnectionClosed, "MCP client disconnected")
    }

    pub(crate) fn transport(error: impl std::fmt::Display) -> Self {
        Self::sdk(McpSdkErrorCode::SendFailed, error.to_string())
    }
}

impl From<ErrorData> for McpError {
    fn from(error: ErrorData) -> Self {
        Self::protocol(error.code.0, error.message.into_owned(), error.data)
    }
}

impl From<ServiceError> for McpError {
    fn from(error: ServiceError) -> Self {
        match error {
            ServiceError::McpError(data) => data.into(),
            ServiceError::TransportClosed => Self::sdk(McpSdkErrorCode::ConnectionClosed, "Connection closed"),
            ServiceError::Timeout { timeout } => Self::sdk(
                McpSdkErrorCode::RequestTimeout,
                format!("Request timed out after {}ms", timeout.as_millis()),
            ),
            ServiceError::UnexpectedResponse => Self::sdk(McpSdkErrorCode::InvalidResult, "Unexpected response type"),
            other => Self::transport(other),
        }
    }
}

impl From<McpError> for crate::Error {
    fn from(error: McpError) -> Self {
        Self::Mcp(error)
    }
}

/// Unit tests for the translation of `rmcp` service errors into MCP error codes and texts.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_a_closed_transport_to_connection_closed() {
        assert_eq!(
            McpError::from(ServiceError::TransportClosed),
            McpError::sdk(McpSdkErrorCode::ConnectionClosed, "Connection closed")
        );
    }

    #[test]
    fn reports_a_disconnect_during_an_operation_as_connection_closed() {
        let McpError::Sdk { code, message } = McpError::disconnected() else {
            panic!("expected an SDK error");
        };
        assert_eq!(
            (code, message.as_str()),
            (McpSdkErrorCode::ConnectionClosed, "MCP client disconnected")
        );
    }

    #[test]
    fn reports_a_transport_failure_as_send_failed() {
        let McpError::Sdk { code, .. } = McpError::transport("broken pipe") else {
            panic!("expected an SDK error");
        };
        assert_eq!(code, McpSdkErrorCode::SendFailed);
    }
}
