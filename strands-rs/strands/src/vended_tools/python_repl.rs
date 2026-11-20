//! The sandbox-routed `python_repl` tool.
//!
//! Each call pipes the code to a fresh interpreter in the sandbox, so variables, imports and
//! definitions do not persist across calls; files written to the sandbox do.

use std::sync::Arc;

use serde::Serialize;
use serde_json::json;

use super::input::InputReader;
use super::{js_number_text, resolve_sandbox, seconds, tool_error};
use crate::cancel::CancelSignal;
use crate::error::{Error, Result, SandboxTimeoutError};
use crate::sandbox::{ExecuteOptions, Sandbox, is_valid_language};
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonSchema, JsonValue};

const DEFAULT_LANGUAGE: &str = "python3";
const DEFAULT_TIMEOUT: f64 = 120.0;

/// The description of the `python_repl` tool shown to the model (`PYTHON_REPL_DESCRIPTION`).
pub const PYTHON_REPL_DESCRIPTION: &str = concat!(
    "Executes Python code and returns output (stdout), error (stderr), and exit_code (non-zero means the ",
    "code failed). Each call runs in a fresh interpreter; variables, imports, and definitions do not persist ",
    "across calls. Files written to the working directory persist while the sandbox is alive, so save ",
    "intermediate results to files when later calls need them. stdin is not available (input() fails). ",
    "Use print() to surface values."
);

tool_error!(
    /// The sandbox failed to run the code (`PythonReplError`), for example an unreachable
    /// container. Errors in the code itself are results with `error` and a non-zero
    /// `exit_code`.
    PythonReplError
);

/// What the interpreter produced (`PythonReplOutput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct PythonReplOutput {
    /// Standard output.
    pub output: String,
    /// Standard error, including tracebacks; empty when there was none.
    pub error: String,
    /// The interpreter's exit code; non-zero means the code failed, and 124 that it timed out.
    pub exit_code: i32,
}

impl PythonReplOutput {
    /// Creates an output.
    pub fn new(output: impl Into<String>, error: impl Into<String>, exit_code: i32) -> Self {
        Self {
            output: output.into(),
            error: error.into(),
            exit_code,
        }
    }
}

/// The code exceeded its timeout: the sandbox's [`SandboxTimeoutError`] (the
/// [`source`](std::error::Error::source)) with the partial output appended to the message as
/// JSON with exit code 124, because the model sees only the message.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct PythonReplTimeoutError {
    message: String,
    /// The output captured before the interpreter was killed.
    pub partial: PythonReplOutput,
    #[source]
    timeout: SandboxTimeoutError,
}

impl PythonReplTimeoutError {
    fn new(timeout: SandboxTimeoutError) -> Result<Self> {
        let partial = PythonReplOutput::new(timeout.stdout.clone(), timeout.stderr.clone(), 124);
        let message = format!("{timeout}\n{}", serde_json::to_string(&partial)?);
        Ok(Self {
            message,
            partial,
            timeout,
        })
    }

    /// What failed.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The sandbox's timeout error.
    #[must_use]
    pub fn timeout(&self) -> &SandboxTimeoutError {
        &self.timeout
    }
}

/// Options for [`make_python_repl`] (`MakePythonReplOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakePythonReplOptions {
    /// The sandbox to run in. `None` uses the calling agent's
    /// [`sandbox`](crate::ToolAgent::sandbox).
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// The tool name; `python_repl` when absent.
    pub name: Option<String>,
    /// The tool description; [`PYTHON_REPL_DESCRIPTION`] when absent.
    pub description: Option<String>,
    /// The interpreter that runs the code; `python3` when absent.
    pub language: Option<String>,
}

impl std::fmt::Debug for MakePythonReplOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MakePythonReplOptions")
            .field("sandbox", &self.sandbox.is_some())
            .field("name", &self.name)
            .field("language", &self.language)
            .finish_non_exhaustive()
    }
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Python source to execute."},
            "timeout": {
                "description": "Timeout in seconds (default: 120). Must be positive.",
                "type": "number",
                "exclusiveMinimum": 0
            }
        },
        "required": ["code"],
        "additionalProperties": false
    })
}

/// The default `python_repl` tool, running in the calling agent's sandbox.
#[must_use]
pub fn python_repl() -> FunctionTool {
    build(
        None,
        "python_repl".to_owned(),
        PYTHON_REPL_DESCRIPTION.to_owned(),
        DEFAULT_LANGUAGE.to_owned(),
    )
}

/// Creates a sandbox-routed Python tool: it runs `code` with the sandbox's
/// [`execute_code`](Sandbox::execute_code) and returns a [`PythonReplOutput`] as JSON.
///
/// A timeout fails with a [`PythonReplTimeoutError`], cancellation with the sandbox's
/// [`SandboxAbortError`](crate::SandboxAbortError) unchanged, and any other sandbox failure with
/// a [`PythonReplError`].
///
/// ```
/// use strands::vended_tools::python_repl::{MakePythonReplOptions, make_python_repl};
///
/// let tool = make_python_repl(MakePythonReplOptions::builder().language("python3.12").build())?;
/// assert_eq!(strands::Tool::name(&tool), "python_repl");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `name` is empty or `language` does not match
/// [`LANGUAGE_PATTERN`](crate::sandbox::LANGUAGE_PATTERN).
pub fn make_python_repl(options: MakePythonReplOptions) -> Result<FunctionTool> {
    let name = options.name.unwrap_or_else(|| "python_repl".to_owned());
    let language = options.language.unwrap_or_else(|| DEFAULT_LANGUAGE.to_owned());
    if name.is_empty() {
        return Err(Error::other("name must be a non-empty string"));
    }
    if !is_valid_language(&language) {
        return Err(Error::other(format!(
            "language contains invalid characters: {language}"
        )));
    }
    let description = options
        .description
        .unwrap_or_else(|| PYTHON_REPL_DESCRIPTION.to_owned());
    Ok(build(options.sandbox, name, description, language))
}

fn build(bound: Option<Arc<dyn Sandbox>>, name: String, description: String, language: String) -> FunctionTool {
    let language = Arc::new(language);
    FunctionTool::builder(name, description)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let sandbox = resolve_sandbox(bound.as_ref(), &context);
            let signal = context.cancel_signal().clone();
            let language = language.clone();
            async move { run(sandbox.as_ref(), &input, &language, signal).await }
        })
}

async fn run(
    sandbox: &dyn Sandbox,
    input: &JsonValue,
    language: &str,
    signal: CancelSignal,
) -> std::result::Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let code = reader.string("code");
    let timeout = reader.optional_positive("timeout", |value| {
        format!(
            "timeout must be a positive number of seconds, got {}",
            js_number_text(value)
        )
    });
    reader.finish()?;
    let options = ExecuteOptions {
        timeout: seconds(timeout.unwrap_or(DEFAULT_TIMEOUT)),
        signal: Some(signal),
        ..ExecuteOptions::default()
    };
    match sandbox.execute_code(code.unwrap_or_default(), language, options).await {
        Ok(result) => Ok(serde_json::to_value(PythonReplOutput::new(
            result.stdout,
            result.stderr,
            result.exit_code,
        ))?),
        Err(error @ Error::SandboxAbort(_)) => Err(error.into()),
        Err(Error::SandboxTimeout(timeout)) => Err(PythonReplTimeoutError::new(timeout)?.into()),
        Err(error) => Err(ToolError::new(PythonReplError::new(error.to_string()))),
    }
}

#[cfg(test)]
mod tests;
