//! The sandbox-routed `shell` tool.
//!
//! Each call runs in a fresh shell of the sandbox (`sh` locally and in containers, the login
//! shell over SSH), so state such as variables and the working directory does not persist. The
//! persistent host shell is [`bash`](super::bash).

use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use super::input::InputReader;
use super::{js_number, resolve_sandbox, seconds, tool_error};
use crate::cancel::CancelSignal;
use crate::error::{Error, Result};
use crate::sandbox::{ExecuteOptions, Sandbox};
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

const DEFAULT_TIMEOUT: f64 = 120.0;

/// The description of the `shell` tool shown to the model (`SANDBOX_SHELL_DESCRIPTION`).
pub const SANDBOX_SHELL_DESCRIPTION: &str = concat!(
    "Executes shell commands and returns output (stdout), error (stderr), and exit_code (non-zero means the ",
    "command failed). Each call runs in a fresh shell; ",
    "state such as variables and the working directory does not persist across calls."
);

/// What a shell command produced (`ShellOutput`): the tool's result, and the partial output of a
/// timed-out command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct ShellOutput {
    /// Standard output.
    pub output: String,
    /// Standard error; empty when there was none.
    pub error: String,
    /// The exit code; non-zero means the command failed, and 124 that it timed out.
    pub exit_code: i32,
}

impl ShellOutput {
    /// Creates an output.
    pub fn new(output: impl Into<String>, error: impl Into<String>, exit_code: i32) -> Self {
        Self {
            output: output.into(),
            error: error.into(),
            exit_code,
        }
    }
}

/// A shell command exceeded its timeout (`ShellTimeoutError`).
///
/// The message is the sandbox's timeout message followed by the partial output as JSON with exit
/// code 124 (the `timeout(1)` convention), because the model sees only the message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct ShellTimeoutError {
    message: String,
    /// The output captured before the command was killed.
    pub partial: Option<ShellOutput>,
}

impl ShellTimeoutError {
    /// The error class name.
    pub const NAME: &'static str = "ShellTimeoutError";

    /// An error with `message` and the captured output.
    pub fn new(message: impl Into<String>, partial: Option<ShellOutput>) -> Self {
        Self {
            message: message.into(),
            partial,
        }
    }

    /// What failed.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

tool_error!(
    /// The sandbox failed to run a shell command (`ShellExecutionError`).
    ShellExecutionError
);

/// Options for [`make_shell`] (`MakeShellOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeShellOptions {
    /// The sandbox to run in. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// The tool name; `shell` when absent.
    pub name: Option<String>,
    /// The tool description; [`SANDBOX_SHELL_DESCRIPTION`] when absent.
    pub description: Option<String>,
    /// The input schema shown to the model; the input is still read as `command` and `timeout`.
    pub input_schema: Option<JsonSchema>,
    /// The timeout in seconds when the model omits `timeout`; 120 when absent.
    pub default_timeout: Option<f64>,
}

impl std::fmt::Debug for MakeShellOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakeShellOptions")
            .field("sandbox", &self.sandbox.is_some())
            .field("name", &self.name)
            .field("default_timeout", &self.default_timeout)
            .finish_non_exhaustive()
    }
}

fn input_schema(default_timeout: f64) -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The shell command to execute."},
            "timeout": {
                "default": js_number(default_timeout),
                "description": "Optional per-execution timeout in seconds.",
                "type": "number",
                "exclusiveMinimum": 0
            }
        },
        "required": ["command"],
        "additionalProperties": false
    })
}

/// Creates a sandbox shell tool: it runs `command` with the sandbox's
/// [`execute`](Sandbox::execute) and returns a [`ShellOutput`] as JSON.
///
/// A non-zero exit code is a result; a timeout fails with a [`ShellTimeoutError`] that carries
/// the partial output, cancellation of the call stops the command and fails with the sandbox's
/// [`SandboxAbortError`](crate::SandboxAbortError) with the partial output appended to its
/// message as JSON with exit code 130, and any other sandbox failure with a
/// [`ShellExecutionError`].
///
/// ```
/// use strands::vended_tools::shell::{MakeShellOptions, make_shell};
///
/// let shell = make_shell(MakeShellOptions::builder().default_timeout(30.0).build())?;
/// let agent = strands::Agent::builder().tools([shell]).printer(false).build()?;
/// assert!(agent.tool_registry().get("shell").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `default_timeout` is not a positive finite number.
pub fn make_shell(options: MakeShellOptions) -> Result<FunctionTool> {
    let default_timeout = options.default_timeout.unwrap_or(DEFAULT_TIMEOUT);
    if !default_timeout.is_finite() || default_timeout <= 0.0 {
        return Err(Error::other(format!(
            "defaultTimeout must be a positive finite number, got {}",
            super::js_number_text(default_timeout)
        )));
    }
    let schema = options.input_schema.unwrap_or_else(|| input_schema(default_timeout));
    let name = options.name.unwrap_or_else(|| "shell".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| SANDBOX_SHELL_DESCRIPTION.to_owned());
    let bound = options.sandbox;
    Ok(FunctionTool::builder(name, description)
        .input_schema(schema)
        .callback(move |input, context| {
            let sandbox = resolve_sandbox(bound.as_ref(), &context);
            let signal = context.cancel_signal().clone();
            async move { run(sandbox.as_ref(), &input, default_timeout, signal).await }
        }))
}

async fn run(
    sandbox: &dyn Sandbox,
    input: &JsonValue,
    default_timeout: f64,
    signal: CancelSignal,
) -> std::result::Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let command = reader.string("command");
    let timeout = reader.optional_positive("timeout", |_| "Too small: expected number to be >0".to_owned());
    reader.finish()?;
    let command = command.unwrap_or_default();
    let options = ExecuteOptions {
        timeout: seconds(timeout.unwrap_or(default_timeout)),
        signal: Some(signal),
        ..ExecuteOptions::default()
    };
    match sandbox.execute(command, options).await {
        Ok(result) => Ok(serde_json::to_value(ShellOutput::new(
            result.stdout,
            result.stderr,
            result.exit_code,
        ))?),
        Err(Error::SandboxTimeout(timeout)) => {
            let partial = ShellOutput::new(timeout.stdout.clone(), timeout.stderr.clone(), 124);
            let message = format!("{timeout}\n{}", serde_json::to_string(&partial)?);
            Err(ToolError::new(ShellTimeoutError::new(message, Some(partial))))
        }
        // Not a shell failure: the abort itself, with the partial output and the interrupt
        // convention's exit code 130 appended.
        Err(Error::SandboxAbort(abort)) => {
            let partial = ShellOutput::new(abort.stdout.clone(), abort.stderr.clone(), 130);
            let detail = serde_json::to_string(&partial)?;
            Err(Error::from(abort.with_detail(&detail)).into())
        }
        Err(error) => Err(ToolError::new(ShellExecutionError::new(error.to_string()))),
    }
}

#[cfg(test)]
mod tests;
