//! Sandboxes: where tools run commands and code and read and write files.
//!
//! - [`Sandbox`]: the execution environment trait, with [`ExecuteOptions`] and the
//!   [`ExecutionStream`] of [`StreamChunk`]s ending in an [`ExecutionResult`].
//! - [`PosixShellSandbox`]: a sandbox that only needs a POSIX shell; code execution and file
//!   operations run as shell commands.
//! - [`NotASandboxLocalEnvironment`]: the host itself, with no isolation, and the agent's default.
//!
//! Sandbox failures are the [`SandboxTimeoutError`](crate::SandboxTimeoutError),
//! [`SandboxAbortError`](crate::SandboxAbortError),
//! [`SandboxPathNotFoundError`](crate::SandboxPathNotFoundError),
//! [`SandboxIsADirectoryError`](crate::SandboxIsADirectoryError) and
//! [`SandboxPermissionError`](crate::SandboxPermissionError) variants of [`Error`](crate::Error).

mod base;
mod constants;
mod default;
mod not_a_sandbox_local_environment;
mod posix_shell;
pub(crate) mod process_group;
mod stream_process;
mod types;

pub use base::{ExecuteOptions, ExecutionStream, IntoSandbox, Sandbox};
pub(crate) use constants::is_valid_language;
pub use constants::{ENV_KEY_PATTERN, LANGUAGE_PATTERN, shell_quote};
pub(crate) use default::default_sandbox;
pub use not_a_sandbox_local_environment::NotASandboxLocalEnvironment;
pub use posix_shell::{PosixShellSandbox, build_shell_env_prefix, validate_env_keys};
pub use types::{ExecutionResult, ExecutionStreamItem, FileInfo, OutputFile, StreamChunk, StreamType};

/// Tests for the sandbox errors, which live in [`crate::error`].
#[cfg(test)]
mod errors_tests;

#[cfg(test)]
mod read_file_errors_tests;

#[cfg(all(test, unix))]
pub(crate) mod test_sandbox;
