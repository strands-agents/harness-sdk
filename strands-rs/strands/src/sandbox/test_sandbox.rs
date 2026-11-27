//! A [`PosixShellSandbox`] over the local `sh` with a fixed working directory.

use crate::sandbox::constants::shell_quote;
use crate::sandbox::posix_shell::{build_shell_env_prefix, error_stream};
use crate::sandbox::stream_process::{StreamProcessOptions, stream_process};
use crate::sandbox::{ExecuteOptions, ExecutionStream, PosixShellSandbox};

/// Runs every command as `cd <working_dir> && <env prefix><command>` in `sh -c`, so the shell
/// defaults of [`PosixShellSandbox`] are exercised the way remote backends use them.
pub(crate) struct TestSandbox {
    pub(crate) working_dir: String,
}

impl TestSandbox {
    pub(crate) fn new(working_dir: impl Into<String>) -> Self {
        Self {
            working_dir: working_dir.into(),
        }
    }
}

impl PosixShellSandbox for TestSandbox {
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
        let cwd = options.cwd.unwrap_or_else(|| self.working_dir.clone());
        let prefix = match build_shell_env_prefix(options.env.as_deref()) {
            Ok(prefix) => prefix,
            Err(error) => return error_stream(error),
        };
        let script = format!("cd {} && {prefix}{command}", shell_quote(&cwd));
        let process_options = StreamProcessOptions {
            timeout: options.timeout,
            signal: options.signal,
            ..StreamProcessOptions::default()
        };
        stream_process("sh", vec!["-c".to_owned(), script], process_options)
    }
}
