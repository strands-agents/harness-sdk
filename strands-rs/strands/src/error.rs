//! The SDK's error types.
//!
//! Each error is a struct with its own message text. [`Error`] wraps them, one variant per type, so
//! callers can branch with `match` and still reach the type's fields.

use std::error::Error as StdError;

use crate::interrupt::InterruptError;
use crate::types::Message;

/// A boxed, thread-safe error used as the `source` of wrapping errors.
pub type BoxError = Box<dyn StdError + Send + Sync + 'static>;

/// `Result` with [`Error`] as the default error type.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Every error the SDK returns.
///
/// Display and [`source`](StdError::source) delegate to the wrapped error, so its message and cause
/// chain are preserved.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// A model provider failed (`ModelError`).
    #[error(transparent)]
    Model(#[from] ModelError),
    /// The input exceeded the model's context window (`ContextWindowOverflowError`).
    #[error(transparent)]
    ContextWindowOverflow(#[from] ContextWindowOverflowError),
    /// The model stopped at its output token limit (`MaxTokensError`).
    #[error(transparent)]
    MaxTokens(#[from] MaxTokensError),
    /// The provider throttled the request (`ModelThrottledError`).
    #[error(transparent)]
    ModelThrottled(#[from] ModelThrottledError),
    /// The network connection to the provider failed (`ModelNetworkError`).
    #[error(transparent)]
    ModelNetwork(#[from] ModelNetworkError),
    /// A value could not be serialized to JSON (`JsonValidationError`).
    #[error(transparent)]
    JsonValidation(#[from] JsonValidationError),
    /// A tool failed validation during registration (`ToolValidationError`).
    #[error(transparent)]
    ToolValidation(#[from] ToolValidationError),
    /// No tool is registered under the requested name (`ToolNotFoundError`).
    #[error(transparent)]
    ToolNotFound(#[from] ToolNotFoundError),
    /// The model did not produce structured output (`StructuredOutputError`).
    #[error(transparent)]
    StructuredOutput(#[from] StructuredOutputError),
    /// A default was read before one was configured (`DefaultNotConfiguredError`).
    #[error(transparent)]
    DefaultNotConfigured(#[from] DefaultNotConfiguredError),
    /// A storage operation failed (`StorageError`).
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// A session operation failed (`SessionError`).
    #[error(transparent)]
    Session(#[from] SessionError),
    /// Sandbox execution timed out (`SandboxTimeoutError`).
    #[error(transparent)]
    SandboxTimeout(#[from] SandboxTimeoutError),
    /// Sandbox execution was aborted (`SandboxAbortError`).
    #[error(transparent)]
    SandboxAbort(#[from] SandboxAbortError),
    /// A sandbox path does not exist (`SandboxPathNotFoundError`).
    #[error(transparent)]
    SandboxPathNotFound(#[from] SandboxPathNotFoundError),
    /// A sandbox path is a directory (`SandboxIsADirectoryError`).
    #[error(transparent)]
    SandboxIsADirectory(#[from] SandboxIsADirectoryError),
    /// A sandbox path is not accessible (`SandboxPermissionError`).
    #[error(transparent)]
    SandboxPermission(#[from] SandboxPermissionError),
    /// An MCP client failed (`ProtocolError`, `SdkError` or a plain MCP client error).
    #[cfg(feature = "mcp")]
    #[error(transparent)]
    Mcp(crate::mcp::McpError),
    /// A hook raised interrupts outside the events that stop for them (`InterruptError`).
    #[error(transparent)]
    Interrupt(#[from] InterruptError),
    /// Any other failure, such as I/O or JSON decoding.
    #[error(transparent)]
    Other(BoxError),
}

impl Error {
    /// Wraps any error as [`Error::Other`].
    pub fn other(error: impl Into<BoxError>) -> Self {
        Self::Other(error.into())
    }

    /// Recovers the typed error behind a boxed one: a boxed [`Error`] is unwrapped and an
    /// [`InterruptError`] becomes [`Error::Interrupt`]; anything else is [`Error::Other`].
    #[must_use]
    pub fn from_boxed(error: BoxError) -> Self {
        let error = match error.downcast::<Self>() {
            Ok(error) => return *error,
            Err(error) => error,
        };
        match error.downcast::<InterruptError>() {
            Ok(interrupts) => Self::Interrupt(*interrupts),
            Err(error) => Self::Other(error),
        }
    }

    /// The wrapped error's type name, for example `"ContextWindowOverflowError"`.
    ///
    /// [`Error::Other`] reports `"Error"`.
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Model(_) => ModelError::NAME,
            Self::ContextWindowOverflow(_) => ContextWindowOverflowError::NAME,
            Self::MaxTokens(_) => MaxTokensError::NAME,
            Self::ModelThrottled(_) => ModelThrottledError::NAME,
            Self::ModelNetwork(_) => ModelNetworkError::NAME,
            Self::JsonValidation(_) => JsonValidationError::NAME,
            Self::ToolValidation(_) => ToolValidationError::NAME,
            Self::ToolNotFound(_) => ToolNotFoundError::NAME,
            Self::StructuredOutput(_) => StructuredOutputError::NAME,
            Self::DefaultNotConfigured(_) => DefaultNotConfiguredError::NAME,
            Self::Storage(_) => StorageError::NAME,
            Self::Session(_) => SessionError::NAME,
            Self::SandboxTimeout(_) => SandboxTimeoutError::NAME,
            Self::SandboxAbort(_) => SandboxAbortError::NAME,
            Self::SandboxPathNotFound(_) => SandboxPathNotFoundError::NAME,
            Self::SandboxIsADirectory(_) => SandboxIsADirectoryError::NAME,
            Self::SandboxPermission(_) => SandboxPermissionError::NAME,
            #[cfg(feature = "mcp")]
            Self::Mcp(error) => error.name(),
            Self::Interrupt(_) => "InterruptError",
            Self::Other(_) => "Error",
        }
    }

    /// Whether this is a model error: `ModelError` or one of the more specific model errors.
    #[must_use]
    pub fn is_model_error(&self) -> bool {
        matches!(
            self,
            Self::Model(_)
                | Self::ContextWindowOverflow(_)
                | Self::MaxTokens(_)
                | Self::ModelThrottled(_)
                | Self::ModelNetwork(_)
        )
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Other(Box::new(error))
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Other(Box::new(error))
    }
}

macro_rules! message_error {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
        #[error("{message}")]
        #[non_exhaustive]
        pub struct $name {
            /// The error message.
            pub message: String,
        }

        impl $name {
            /// The type name [`Error::name`] reports.
            pub const NAME: &'static str = stringify!($name);

            /// Creates the error with a message.
            pub fn new(message: impl Into<String>) -> Self {
                Self { message: message.into() }
            }
        }
    };
}

macro_rules! source_error {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, thiserror::Error)]
        #[error("{message}")]
        #[non_exhaustive]
        pub struct $name {
            /// The error message.
            pub message: String,
            /// The underlying cause.
            #[source]
            pub source: Option<BoxError>,
        }

        impl $name {
            /// The type name [`Error::name`] reports.
            pub const NAME: &'static str = stringify!($name);

            /// Creates the error with a message and no cause.
            pub fn new(message: impl Into<String>) -> Self {
                Self { message: message.into(), source: None }
            }

            /// Sets the underlying cause.
            #[must_use]
            pub fn with_source(mut self, source: impl Into<BoxError>) -> Self {
                self.source = Some(source.into());
                self
            }
        }
    };
}

source_error!(
    /// A model provider failed (`ModelError`), the base of the model error family.
    ModelError
);

message_error!(
    /// The combined input exceeded the model's context window (`ContextWindowOverflowError`).
    ContextWindowOverflowError
);

/// The model stopped because it reached its output token limit (`MaxTokensError`).
///
/// Carries the partial assistant message generated before the limit.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct MaxTokensError {
    /// The error message.
    pub message: String,
    /// The partial assistant message generated before the token limit.
    pub partial_message: Box<Message>,
}

impl MaxTokensError {
    /// The type name [`Error::name`] reports.
    pub const NAME: &'static str = "MaxTokensError";

    /// Creates the error with a message and the partial message.
    pub fn new(message: impl Into<String>, partial_message: Message) -> Self {
        Self {
            message: message.into(),
            partial_message: Box::new(partial_message),
        }
    }
}

source_error!(
    /// The provider throttled or rate limited the request (`ModelThrottledError`).
    ModelThrottledError
);

source_error!(
    /// The network connection to the model provider failed (`ModelNetworkError`).
    ///
    /// Retrying the same request may succeed.
    ModelNetworkError
);

message_error!(
    /// A value contains data that cannot be serialized to JSON (`JsonValidationError`).
    JsonValidationError
);

message_error!(
    /// A tool failed validation during registration (`ToolValidationError`).
    ToolValidationError
);

/// No registered tool matches the requested name (`ToolNotFoundError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Tool '{tool_name}' not found")]
#[non_exhaustive]
pub struct ToolNotFoundError {
    /// The tool name that was requested but not found.
    pub tool_name: String,
}

impl ToolNotFoundError {
    /// The type name [`Error::name`] reports.
    pub const NAME: &'static str = "ToolNotFoundError";

    /// Creates the error for a tool name.
    pub fn new(tool_name: impl Into<String>) -> Self {
        Self {
            tool_name: tool_name.into(),
        }
    }
}

message_error!(
    /// The model failed to produce structured output (`StructuredOutputError`).
    StructuredOutputError
);

message_error!(
    /// A default value was read before one was configured (`DefaultNotConfiguredError`).
    DefaultNotConfiguredError
);

source_error!(
    /// A storage operation failed (`StorageError`), whatever the backend.
    StorageError
);

source_error!(
    /// A session operation failed (`SessionError`), such as reading or restoring session data.
    SessionError
);

/// Sandbox execution exceeded its timeout (`SandboxTimeoutError`).
///
/// `stdout` and `stderr` hold what the process wrote before it was killed.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("Execution timed out after {seconds} seconds")]
#[non_exhaustive]
pub struct SandboxTimeoutError {
    /// The timeout that elapsed, in seconds.
    pub seconds: f64,
    /// Output written before the timeout.
    pub stdout: String,
    /// Error output written before the timeout.
    pub stderr: String,
}

impl SandboxTimeoutError {
    /// The type name [`Error::name`] reports.
    pub const NAME: &'static str = "SandboxTimeoutError";

    /// Creates the error for a timeout in seconds, with empty output.
    pub fn new(seconds: f64) -> Self {
        Self {
            seconds,
            stdout: String::new(),
            stderr: String::new(),
        }
    }

    /// Sets the output captured before the timeout.
    #[must_use]
    pub fn with_output(mut self, stdout: impl Into<String>, stderr: impl Into<String>) -> Self {
        self.stdout = stdout.into();
        self.stderr = stderr.into();
        self
    }
}

/// Sandbox execution was aborted through its cancel signal (`SandboxAbortError`).
///
/// `stdout` and `stderr` hold what the process wrote before it was killed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
#[non_exhaustive]
pub struct SandboxAbortError {
    /// Output written before the abort.
    pub stdout: String,
    /// Error output written before the abort.
    pub stderr: String,
    message: String,
}

impl SandboxAbortError {
    /// The type name [`Error::name`] reports.
    pub const NAME: &'static str = "SandboxAbortError";

    /// Creates the error, with empty output.
    pub fn new() -> Self {
        Self {
            stdout: String::new(),
            stderr: String::new(),
            message: "Execution aborted".to_owned(),
        }
    }

    /// Sets the output captured before the abort.
    #[must_use]
    pub fn with_output(mut self, stdout: impl Into<String>, stderr: impl Into<String>) -> Self {
        self.stdout = stdout.into();
        self.stderr = stderr.into();
        self
    }

    /// Appends `detail` to the message on its own line; a tool's caller sees only the message.
    #[must_use]
    pub(crate) fn with_detail(mut self, detail: &str) -> Self {
        self.message = format!("{}\n{detail}", self.message);
        self
    }
}

impl Default for SandboxAbortError {
    fn default() -> Self {
        Self::new()
    }
}

macro_rules! sandbox_path_error {
    ($(#[$doc:meta])* $name:ident, $prefix:literal, $code:literal) => {
        $(#[$doc])*
        #[derive(Debug, thiserror::Error)]
        #[error("{}: {path}", $prefix)]
        #[non_exhaustive]
        pub struct $name {
            /// The path the operation failed on.
            pub path: String,
            /// The underlying cause.
            #[source]
            pub source: Option<BoxError>,
        }

        impl $name {
            /// The type name [`Error::name`] reports.
            pub const NAME: &'static str = stringify!($name);

            /// The POSIX errno name this error matches.
            pub const CODE: &'static str = $code;

            /// Creates the error for a path.
            pub fn new(path: impl Into<String>) -> Self {
                Self { path: path.into(), source: None }
            }

            /// Sets the underlying cause.
            #[must_use]
            pub fn with_source(mut self, source: impl Into<BoxError>) -> Self {
                self.source = Some(source.into());
                self
            }

            /// The POSIX errno name this error matches.
            #[must_use]
            pub fn code(&self) -> &'static str {
                Self::CODE
            }
        }
    };
}

sandbox_path_error!(
    /// A sandbox path does not exist (`SandboxPathNotFoundError`, code `ENOENT`).
    SandboxPathNotFoundError,
    "Path not found",
    "ENOENT"
);

sandbox_path_error!(
    /// A sandbox path is a directory where a file was expected (`SandboxIsADirectoryError`, code `EISDIR`).
    SandboxIsADirectoryError,
    "Is a directory",
    "EISDIR"
);

sandbox_path_error!(
    /// A sandbox file, or a directory above it, is not accessible (`SandboxPermissionError`, code `EACCES`).
    SandboxPermissionError,
    "Permission denied",
    "EACCES"
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Message, Role, TextBlock};

    fn partial_message() -> Message {
        Message::new(Role::Assistant, vec![TextBlock::new("partial response").into()])
    }

    #[test]
    fn model_error_creates_an_error_with_the_correct_message() {
        let error = ModelError::new("Model error occurred");
        assert_eq!(error.to_string(), "Model error occurred");
    }

    #[test]
    fn model_error_has_the_correct_error_name() {
        assert_eq!(Error::from(ModelError::new("test")).name(), "ModelError");
    }

    #[test]
    fn model_error_is_an_instance_of_error() {
        let error: &dyn StdError = &ModelError::new("test");
        assert_eq!(error.to_string(), "test");
    }

    #[test]
    fn model_error_stores_the_cause_error() {
        let error = ModelError::new("wrapped error").with_source(std::io::Error::other("original error"));
        assert_eq!(error.to_string(), "wrapped error");
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("original error")
        );
    }

    #[test]
    fn context_window_overflow_error_creates_an_error_with_the_correct_message() {
        let error = ContextWindowOverflowError::new("Context window overflow occurred");
        assert_eq!(error.to_string(), "Context window overflow occurred");
    }

    #[test]
    fn context_window_overflow_error_has_the_correct_error_name() {
        let error = Error::from(ContextWindowOverflowError::new("test"));
        assert_eq!(error.name(), "ContextWindowOverflowError");
    }

    #[test]
    fn context_window_overflow_error_is_an_instance_of_model_error() {
        assert!(Error::from(ContextWindowOverflowError::new("test")).is_model_error());
    }

    #[test]
    fn max_tokens_error_creates_an_error_with_the_correct_message() {
        let error = MaxTokensError::new("Max tokens reached", partial_message());
        assert_eq!(error.to_string(), "Max tokens reached");
    }

    #[test]
    fn max_tokens_error_has_the_correct_error_name() {
        let error = Error::from(MaxTokensError::new("test", partial_message()));
        assert_eq!(error.name(), "MaxTokensError");
    }

    #[test]
    fn max_tokens_error_stores_the_partial_message() {
        let partial = partial_message();
        let error = MaxTokensError::new("Max tokens reached", partial.clone());
        assert_eq!(*error.partial_message, partial);
    }

    #[test]
    fn max_tokens_error_is_an_instance_of_model_error() {
        assert!(Error::from(MaxTokensError::new("test", partial_message())).is_model_error());
    }

    #[test]
    fn model_throttled_error_creates_an_error_with_the_correct_message() {
        assert_eq!(
            ModelThrottledError::new("Rate limit exceeded").to_string(),
            "Rate limit exceeded"
        );
    }

    #[test]
    fn model_throttled_error_has_the_correct_error_name() {
        assert_eq!(
            Error::from(ModelThrottledError::new("test")).name(),
            "ModelThrottledError"
        );
    }

    #[test]
    fn model_throttled_error_is_an_instance_of_model_error() {
        assert!(Error::from(ModelThrottledError::new("test")).is_model_error());
    }

    #[test]
    fn preserves_the_original_error_as_cause() {
        let error = Error::from(
            ModelThrottledError::new("Rate limit exceeded")
                .with_source(std::io::Error::other("Original rate limit error")),
        );
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("Original rate limit error")
        );
    }

    #[test]
    fn has_undefined_cause_when_not_provided() {
        assert!(ModelThrottledError::new("Rate limit exceeded").source().is_none());
    }

    #[test]
    fn is_a_model_error_with_its_own_name_that_preserves_the_cause() {
        let error = Error::from(
            ModelNetworkError::new("Language model stream error: Failed to fetch")
                .with_source(std::io::Error::other("Failed to fetch")),
        );
        assert!(error.is_model_error());
        assert_eq!(error.name(), "ModelNetworkError");
        assert_eq!(error.to_string(), "Language model stream error: Failed to fetch");
        assert_eq!(
            error.source().map(ToString::to_string).as_deref(),
            Some("Failed to fetch")
        );
    }

    #[test]
    fn non_model_errors_are_not_model_errors() {
        assert!(!Error::from(ToolValidationError::new("bad")).is_model_error());
        assert!(!Error::other(std::io::Error::other("io")).is_model_error());
    }

    #[test]
    fn tool_not_found_error_message_and_name() {
        let error = Error::from(ToolNotFoundError::new("calculator"));
        assert_eq!(error.to_string(), "Tool 'calculator' not found");
        assert_eq!(error.name(), "ToolNotFoundError");
    }

    #[test]
    fn message_classes_keep_their_message_and_name() {
        let cases = [
            (Error::from(JsonValidationError::new("a")), "JsonValidationError"),
            (Error::from(ToolValidationError::new("b")), "ToolValidationError"),
            (Error::from(StructuredOutputError::new("c")), "StructuredOutputError"),
            (
                Error::from(DefaultNotConfiguredError::new("d")),
                "DefaultNotConfiguredError",
            ),
            (Error::from(StorageError::new("e")), "StorageError"),
            (Error::from(SessionError::new("f")), "SessionError"),
        ];
        for ((error, name), message) in cases.iter().zip(["a", "b", "c", "d", "e", "f"]) {
            assert_eq!(error.name(), *name);
            assert_eq!(error.to_string(), message);
        }
    }

    #[test]
    fn storage_error_keeps_its_cause_through_error() {
        let error = Error::from(StorageError::new("Failed to write").with_source(std::io::Error::other("disk full")));
        assert_eq!(error.source().map(ToString::to_string).as_deref(), Some("disk full"));
    }

    #[test]
    fn sandbox_errors_use_the_ts_messages_and_codes() {
        assert_eq!(
            SandboxTimeoutError::new(5.0).to_string(),
            "Execution timed out after 5 seconds"
        );
        assert_eq!(
            SandboxTimeoutError::new(0.5).to_string(),
            "Execution timed out after 0.5 seconds"
        );
        assert_eq!(SandboxAbortError::new().to_string(), "Execution aborted");
        let not_found = SandboxPathNotFoundError::new("/tmp/missing");
        assert_eq!(not_found.to_string(), "Path not found: /tmp/missing");
        assert_eq!(not_found.code(), "ENOENT");
        let directory = SandboxIsADirectoryError::new("/tmp");
        assert_eq!(directory.to_string(), "Is a directory: /tmp");
        assert_eq!(directory.code(), "EISDIR");
        let permission = SandboxPermissionError::new("/root/secret");
        assert_eq!(permission.to_string(), "Permission denied: /root/secret");
        assert_eq!(permission.code(), "EACCES");
        assert_eq!(Error::from(permission).name(), "SandboxPermissionError");
    }

    #[test]
    fn sandbox_timeout_keeps_partial_output() {
        let error = SandboxTimeoutError::new(1.0).with_output("out", "err");
        assert_eq!((error.stdout.as_str(), error.stderr.as_str()), ("out", "err"));
    }

    #[test]
    fn other_wraps_any_error_with_its_source_message() {
        let error = Error::from(serde_json::from_str::<serde_json::Value>("{").unwrap_err());
        assert_eq!(error.name(), "Error");
        assert!(error.to_string().contains("EOF"));
    }
}
