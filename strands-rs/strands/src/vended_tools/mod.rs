//! Ready-made tools.
//!
//! Each module holds a vended tool: a `make_*` factory that takes options (name,
//! description, limits, and for the sandbox-routed tools an optional bound
//! [`Sandbox`]), and for most tools a function returning the default
//! instance. The tool specs, descriptions and result texts are shared with the other Strands SDKs.
//!
//! - Sandbox-routed: [`shell`], [`read`], [`write`](mod@write), [`edit`], [`file_editor`] and
//!   [`python_repl`] run through the bound sandbox, or the calling agent's
//!   [`sandbox`](crate::ToolAgent::sandbox).
//! - Host: [`bash`] keeps a persistent `bash` process per agent; [`http_request`] and
//!   [`web_fetch`] make HTTP requests.
//! - Agent loop: [`sleep`], [`stop`], [`handoff_to_user`], [`notebook`] and [`subagent`].
//! - `mcp_router` (feature `mcp`): connects to allowlisted MCP servers at runtime.

pub mod bash;
pub mod edit;
pub mod file_editor;
pub mod handoff_to_user;
pub mod http_request;
mod input;
#[cfg(feature = "mcp")]
pub mod mcp_router;
pub mod notebook;
pub mod paths;
pub mod python_repl;
pub mod read;
pub mod shell;
pub mod sleep;
pub mod stop;
pub mod subagent;
pub mod web_fetch;
pub mod write;

#[cfg(test)]
mod conformance_tests;
#[cfg(test)]
pub(crate) mod test_support;

use std::sync::Arc;
use std::time::Duration;

use crate::sandbox::Sandbox;
use crate::tools::ToolContext;
use crate::types::JsonValue;

/// Declares a vended tool's error type: a message, displayed as is, and the error class name.
macro_rules! tool_error {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
        #[error("{message}")]
        #[non_exhaustive]
        pub struct $name {
            message: String,
        }

        impl $name {
            /// The error class name.
            pub const NAME: &'static str = stringify!($name);

            /// An error with `message`.
            pub fn new(message: impl Into<String>) -> Self {
                Self { message: message.into() }
            }

            /// What failed.
            #[must_use]
            pub fn message(&self) -> &str {
                &self.message
            }
        }
    };
}
pub(crate) use tool_error;

/// The bound sandbox, or the calling agent's.
fn resolve_sandbox(bound: Option<&Arc<dyn Sandbox>>, context: &ToolContext) -> Arc<dyn Sandbox> {
    bound.unwrap_or_else(|| context.agent().sandbox()).clone()
}

/// A number as JSON, with whole numbers written without a fraction.
fn js_number(value: f64) -> JsonValue {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation, reason = "whole and within the safe integer range")]
        return JsonValue::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number)
}

/// A number as text, with whole numbers written without a fraction.
fn js_number_text(value: f64) -> String {
    match js_number(value) {
        JsonValue::Number(number) => number.to_string(),
        _ => value.to_string(),
    }
}

/// A timeout in seconds; one too large for a [`Duration`] is no timeout.
fn seconds(value: f64) -> Option<Duration> {
    Duration::try_from_secs_f64(value).ok()
}
