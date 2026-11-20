//! The [`Sandbox`] trait and its [`ExecuteOptions`].

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;

use crate::cancel::CancelSignal;
use crate::error::{Error, Result};
use crate::models::BoxStream;
use crate::sandbox::types::{ExecutionResult, ExecutionStreamItem, FileInfo};
use crate::tools::Tool;

/// The stream returned by [`Sandbox::execute_streaming`] and
/// [`Sandbox::execute_code_streaming`]: output chunks followed by one final
/// [`ExecutionResult`], or an error.
pub type ExecutionStream = BoxStream<'static, Result<ExecutionStreamItem>>;

/// Options for command and code execution (`ExecuteOptions`).
///
/// ```
/// use std::time::Duration;
///
/// use strands::sandbox::ExecuteOptions;
///
/// let options = ExecuteOptions::builder()
///     .timeout(Duration::from_secs(30))
///     .cwd("/tmp")
///     .env([("GREETING", "hi")])
///     .build();
/// assert_eq!(options.env.unwrap(), [("GREETING".to_owned(), "hi".to_owned())]);
/// ```
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct ExecuteOptions {
    /// Maximum execution time. `None` means no timeout. When it elapses the process is killed and
    /// execution fails with [`SandboxTimeoutError`](crate::SandboxTimeoutError).
    pub timeout: Option<Duration>,
    /// Working directory for execution. `None` means the sandbox default.
    #[builder(into)]
    pub cwd: Option<String>,
    /// Cancels execution: the process is killed when the signal fires and execution fails with
    /// [`SandboxAbortError`](crate::SandboxAbortError).
    pub signal: Option<CancelSignal>,
    /// Environment variables to set for this command, in order; for a repeated name the last
    /// value applies. The built-in sandboxes always apply them; a custom [`Sandbox`] must apply
    /// them itself or they have no effect.
    #[builder(with = |env: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>| {
        env.into_iter().map(|(key, value)| (key.into(), value.into())).collect()
    })]
    pub env: Option<Vec<(String, String)>>,
}

/// An execution environment: where tools run commands and code and read and write files
/// (`Sandbox`).
///
/// Several tools share one sandbox, so they see the same working directory and filesystem. The
/// streaming methods are the primitives; [`execute`](Sandbox::execute) and
/// [`execute_code`](Sandbox::execute_code) consume them and return the final result.
///
/// Implement [`PosixShellSandbox`](crate::sandbox::PosixShellSandbox) instead when the
/// environment only offers a POSIX shell: it supplies everything except
/// `execute_streaming`.
///
/// ```
/// use futures::stream;
/// use strands::sandbox::{ExecuteOptions, ExecutionResult, ExecutionStream, FileInfo, Sandbox};
/// use strands::{Error, Result, async_trait};
///
/// struct Echo;
///
/// #[async_trait]
/// impl Sandbox for Echo {
///     fn execute_streaming(&self, command: &str, _options: ExecuteOptions) -> ExecutionStream {
///         let result = ExecutionResult::new(0, format!("{command}\n"), "");
///         Box::pin(stream::iter([Ok(result.into())]))
///     }
///
///     fn execute_code_streaming(&self, code: &str, _language: &str, options: ExecuteOptions) -> ExecutionStream {
///         self.execute_streaming(code, options)
///     }
///
///     async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
///         Err(strands::SandboxPathNotFoundError::new(path).into())
///     }
///
///     async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<()> {
///         Err(Error::other("read-only"))
///     }
///
///     async fn remove_file(&self, _path: &str) -> Result<()> {
///         Err(Error::other("read-only"))
///     }
///
///     async fn list_files(&self, _path: &str) -> Result<Vec<FileInfo>> {
///         Ok(Vec::new())
///     }
/// }
///
/// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
/// let result = Echo.execute("hello", ExecuteOptions::default()).await?;
/// assert_eq!(result.stdout, "hello\n");
/// # Ok::<_, Error>(())
/// # }).unwrap();
/// ```
#[async_trait]
pub trait Sandbox: Send + Sync + 'static {
    /// Runs a shell command, streaming its output.
    ///
    /// Yields a [`StreamChunk`](crate::sandbox::StreamChunk) for each piece of stdout and
    /// stderr as it arrives, then one [`ExecutionResult`] with the exit code and the complete
    /// output. A non-zero exit code is a result, not an error.
    ///
    /// # Errors
    ///
    /// The stream ends with [`SandboxTimeoutError`](crate::SandboxTimeoutError) when
    /// `options.timeout` elapses, [`SandboxAbortError`](crate::SandboxAbortError) when
    /// `options.signal` fires, and another error when the command cannot be started or an
    /// environment variable name is invalid.
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream;

    /// Runs source code through a language interpreter such as `python3` or `node`, streaming
    /// its output.
    ///
    /// # Errors
    ///
    /// As [`execute_streaming`](Sandbox::execute_streaming); the stream also fails when
    /// `language` does not match [`LANGUAGE_PATTERN`](crate::sandbox::LANGUAGE_PATTERN). A
    /// missing interpreter is a result with exit code 127.
    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream;

    /// Reads a file as raw bytes. See [`read_text`](Sandbox::read_text) for text.
    ///
    /// # Errors
    ///
    /// [`SandboxPathNotFoundError`](crate::SandboxPathNotFoundError) when the path does not
    /// exist, [`SandboxIsADirectoryError`](crate::SandboxIsADirectoryError) when it is a
    /// directory, [`SandboxPermissionError`](crate::SandboxPermissionError) when it cannot be
    /// read, and another error for any other failure.
    async fn read_file(&self, path: &str) -> Result<Vec<u8>>;

    /// Writes raw bytes to a file, creating missing parent directories.
    ///
    /// # Errors
    ///
    /// When the file cannot be written.
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()>;

    /// Removes a file.
    ///
    /// # Errors
    ///
    /// When the file does not exist or cannot be removed.
    async fn remove_file(&self, path: &str) -> Result<()>;

    /// Lists a directory.
    ///
    /// # Errors
    ///
    /// [`SandboxPathNotFoundError`](crate::SandboxPathNotFoundError) when the directory does not
    /// exist or a path component is a file, and another error for any other failure.
    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>>;

    /// Tools this sandbox vends to an agent. The agent registers them at
    /// initialization, skipping any whose name the user already registered. None by default.
    fn get_tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    /// Runs a shell command and returns its result (`execute`), consuming
    /// [`execute_streaming`](Sandbox::execute_streaming).
    ///
    /// # Errors
    ///
    /// As [`execute_streaming`](Sandbox::execute_streaming), and when the stream ends without a
    /// result.
    async fn execute(&self, command: &str, options: ExecuteOptions) -> Result<ExecutionResult> {
        final_result(self.execute_streaming(command, options), "execute_streaming").await
    }

    /// Runs source code through an interpreter and returns its result,
    /// consuming [`execute_code_streaming`](Sandbox::execute_code_streaming).
    ///
    /// # Errors
    ///
    /// As [`execute_code_streaming`](Sandbox::execute_code_streaming), and when the stream ends
    /// without a result.
    async fn execute_code(&self, code: &str, language: &str, options: ExecuteOptions) -> Result<ExecutionResult> {
        final_result(
            self.execute_code_streaming(code, language, options),
            "execute_code_streaming",
        )
        .await
    }

    /// Reads a file as UTF-8 text, replacing invalid sequences with U+FFFD and
    /// dropping a leading byte order mark.
    ///
    /// # Errors
    ///
    /// As [`read_file`](Sandbox::read_file).
    async fn read_text(&self, path: &str) -> Result<String> {
        Ok(decode_text(&self.read_file(path).await?))
    }

    /// Writes text to a file as UTF-8.
    ///
    /// # Errors
    ///
    /// As [`write_file`](Sandbox::write_file).
    async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        self.write_file(path, content.as_bytes()).await
    }
}

/// What the builder's `sandbox(..)` setter takes: a sandbox by value, an `Arc` of one, or an
/// `Arc<dyn Sandbox>` (kept as is, so the agent's [`sandbox`](crate::Agent::sandbox) is the
/// same instance).
pub trait IntoSandbox {
    /// The sandbox, shared.
    fn into_sandbox(self) -> Arc<dyn Sandbox>;
}

impl<S: Sandbox> IntoSandbox for S {
    fn into_sandbox(self) -> Arc<dyn Sandbox> {
        Arc::new(self)
    }
}

impl<S: Sandbox> IntoSandbox for Arc<S> {
    fn into_sandbox(self) -> Arc<dyn Sandbox> {
        self
    }
}

impl IntoSandbox for Arc<dyn Sandbox> {
    fn into_sandbox(self) -> Arc<dyn Sandbox> {
        self
    }
}

/// Drains an execution stream up to its result.
pub(crate) async fn final_result(mut stream: ExecutionStream, method: &str) -> Result<ExecutionResult> {
    while let Some(item) = stream.next().await {
        if let ExecutionStreamItem::ExecutionResult(result) = item? {
            return Ok(result);
        }
    }
    Err(Error::other(format!("{method}() did not yield an ExecutionResult")))
}

fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(test)]
mod tests {
    use futures::stream;

    use super::*;
    use crate::sandbox::types::{StreamChunk, StreamType};

    struct Scripted(Vec<ExecutionStreamItem>);

    #[async_trait]
    impl Sandbox for Scripted {
        fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
            Box::pin(stream::iter(self.0.clone().into_iter().map(Ok)))
        }

        fn execute_code_streaming(&self, code: &str, _language: &str, options: ExecuteOptions) -> ExecutionStream {
            self.execute_streaming(code, options)
        }

        async fn read_file(&self, _path: &str) -> Result<Vec<u8>> {
            Ok(b"\xEF\xBB\xBFcaf\xC3\xA9 \xFF".to_vec())
        }

        async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<()> {
            Ok(())
        }

        async fn remove_file(&self, _path: &str) -> Result<()> {
            Ok(())
        }

        async fn list_files(&self, _path: &str) -> Result<Vec<FileInfo>> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn execute_returns_the_final_result_after_the_chunks() {
        let sandbox = Scripted(vec![
            StreamChunk::new("hi\n", StreamType::Stdout).into(),
            ExecutionResult::new(0, "hi\n", "").into(),
        ]);
        let result = sandbox.execute("echo hi", ExecuteOptions::default()).await.unwrap();
        assert_eq!(result, ExecutionResult::new(0, "hi\n", ""));
        let code = sandbox
            .execute_code("x", "sh", ExecuteOptions::default())
            .await
            .unwrap();
        assert_eq!(code.exit_code, 0);
    }

    #[tokio::test]
    async fn execute_fails_when_the_stream_ends_without_a_result() {
        let sandbox = Scripted(vec![StreamChunk::new("hi", StreamType::Stdout).into()]);
        let error = sandbox.execute("echo hi", ExecuteOptions::default()).await.unwrap_err();
        assert_eq!(
            error.to_string(),
            "execute_streaming() did not yield an ExecutionResult"
        );
        let error = sandbox
            .execute_code("x", "sh", ExecuteOptions::default())
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "execute_code_streaming() did not yield an ExecutionResult"
        );
    }

    #[tokio::test]
    async fn read_text_decodes_like_text_decoder() {
        let text = Scripted(Vec::new()).read_text("any").await.unwrap();
        assert_eq!(text, "café \u{FFFD}");
    }

    #[test]
    fn get_tools_is_empty_by_default() {
        assert!(Scripted(Vec::new()).get_tools().is_empty());
    }

    #[test]
    fn options_builder_keeps_env_order() {
        let options = ExecuteOptions::builder()
            .env([("FOO".to_owned(), "1".to_owned()), ("BAR".to_owned(), "2".to_owned())])
            .build();
        let keys: Vec<_> = options.env.unwrap().into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, ["FOO", "BAR"]);
    }
}
