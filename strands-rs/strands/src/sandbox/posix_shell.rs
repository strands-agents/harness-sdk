//! A sandbox built on a POSIX shell.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::stream;

use crate::error::{Error, Result, SandboxIsADirectoryError, SandboxPathNotFoundError, SandboxPermissionError};
use crate::sandbox::base::{ExecuteOptions, ExecutionStream, Sandbox, final_result};
use crate::sandbox::constants::{is_valid_env_key, is_valid_language, shell_quote};
use crate::sandbox::types::FileInfo;
use crate::tools::Tool;

const MISSING_EXIT_CODE: i32 = 77;
const DIRECTORY_EXIT_CODE: i32 = 78;
const PERMISSION_EXIT_CODE: i32 = 79;

/// Checks environment variable names against
/// [`ENV_KEY_PATTERN`](crate::sandbox::ENV_KEY_PATTERN).
///
/// Backends that set the environment through process flags call this before passing the values
/// on.
///
/// # Errors
///
/// `Invalid environment variable name: <key>` for the first invalid name.
pub fn validate_env_keys(env: &[(String, String)]) -> Result<()> {
    match env.iter().map(|(key, _)| key).find(|key| !is_valid_env_key(key)) {
        Some(key) => Err(Error::other(format!("Invalid environment variable name: {key}"))),
        None => Ok(()),
    }
}

/// Builds the `export KEY='value' && ` prefix that applies `env` to a shell command, or `""`
/// when there is none.
///
/// `export` (rather than an `env KEY=value` wrapper) sets the variables in the shell itself, so
/// every stage of a pipeline inherits them, including the interpreter of
/// [`execute_code_streaming`](Sandbox::execute_code_streaming). Values are
/// [`shell_quote`](crate::sandbox::shell_quote)d; the trailing `&&` keeps a surrounding
/// `cd ... && <prefix><command>` chain fail-fast.
///
/// ```
/// use strands::sandbox::build_shell_env_prefix;
///
/// let env = [("FOO".to_owned(), "bar".to_owned())];
/// assert_eq!(build_shell_env_prefix(Some(&env[..]))?, "export FOO='bar' && ");
/// assert_eq!(build_shell_env_prefix(None)?, "");
/// # Ok::<_, strands::Error>(())
/// ```
///
/// # Errors
///
/// As [`validate_env_keys`].
pub fn build_shell_env_prefix(env: Option<&[(String, String)]>) -> Result<String> {
    let Some(env) = env.filter(|env| !env.is_empty()) else {
        return Ok(String::new());
    };
    validate_env_keys(env)?;
    let assignments: Vec<String> = env
        .iter()
        .map(|(key, value)| format!("{key}={}", shell_quote(value)))
        .collect();
    Ok(format!("export {} && ", assignments.join(" ")))
}

/// A sandbox where only a POSIX shell is available, such as a container, an SSH connection or a
/// cloud runtime (`PosixShellSandbox`).
///
/// Implementors supply [`execute_streaming`](PosixShellSandbox::execute_streaming); code
/// execution and the file operations run as shell commands through it. Override any of them
/// with a native implementation where the backend has one. Every `PosixShellSandbox` is a
/// [`Sandbox`].
///
/// `execute_streaming` must apply `options.env`: backends that build a shell command prepend
/// [`build_shell_env_prefix`]; backends that pass the environment through process flags call
/// [`validate_env_keys`] and pass the values on.
///
/// Call the operations through [`Sandbox`] (or a `dyn Sandbox`); with both traits in scope a
/// method call on the implementing type is ambiguous.
///
/// ```no_run
/// use std::process::Stdio;
///
/// use strands::sandbox::{
///     ExecuteOptions, ExecutionResult, ExecutionStream, ExecutionStreamItem, PosixShellSandbox,
///     Sandbox, build_shell_env_prefix, shell_quote,
/// };
/// use strands::Error;
///
/// /// Runs commands in a running container through `docker exec`.
/// struct Container {
///     name: String,
/// }
///
/// impl PosixShellSandbox for Container {
///     fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
///         let prefix = build_shell_env_prefix(options.env.as_deref());
///         let cwd = options.cwd.unwrap_or_else(|| "/".to_owned());
///         let name = self.name.clone();
///         let command = command.to_owned();
///         Box::pin(futures::stream::once(async move {
///             let script = format!("cd {} && {}{command}", shell_quote(&cwd), prefix?);
///             let output = tokio::process::Command::new("docker")
///                 .args(["exec", &name, "sh", "-c", &script])
///                 .stdin(Stdio::null())
///                 .output()
///                 .await?;
///             let result = ExecutionResult::new(
///                 output.status.code().unwrap_or(1),
///                 String::from_utf8_lossy(&output.stdout),
///                 String::from_utf8_lossy(&output.stderr),
///             );
///             Ok::<_, Error>(ExecutionStreamItem::from(result))
///         }))
///     }
/// }
///
/// # async fn demo() -> strands::Result<()> {
/// let sandbox = Container { name: "dev".to_owned() };
/// let _hostname = Sandbox::read_text(&sandbox, "/etc/hostname").await?;
/// # Ok(())
/// # }
/// ```
#[async_trait]
pub trait PosixShellSandbox: Send + Sync + 'static {
    /// Runs a shell command, streaming its output. See [`Sandbox::execute_streaming`].
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream;

    /// Pipes base64-encoded `code` into the interpreter through
    /// [`execute_streaming`](PosixShellSandbox::execute_streaming). See
    /// [`Sandbox::execute_code_streaming`].
    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        if !is_valid_language(language) {
            return error_stream(invalid_language(language));
        }
        let eof = heredoc_delimiter();
        let encoded = STANDARD.encode(code);
        let command = format!("base64 -d << '{eof}' | {language}\n{encoded}\n{eof}");
        self.execute_streaming(&command, options)
    }

    /// Reads a file through `base64`, with exit codes that tell a missing path, a directory and
    /// a permission failure apart. See [`Sandbox::read_file`].
    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let quoted = shell_quote(path);
        // Locale-independent exit codes: 77 = missing, 78 = directory, 79 = permission denied.
        // `test -e` is also false under an unsearchable ancestor, so the deepest existing one is
        // checked. The braces keep a backend's `cd ... &&` prefix out of the `||`.
        let command = format!(
            "{{ test -e {quoted} || {{ p={quoted}; while p=$(dirname -- \"$p\"); ! test -d \"$p\"; do :; done; \
             test -x \"$p\" || exit 79; exit 77; }}; \
             test -r {quoted} || exit 79; test -d {quoted} && exit 78; base64 < {quoted}; }}"
        );
        let result = run(self, &command).await?;
        match result.exit_code {
            0 => decode_base64(&result.stdout),
            MISSING_EXIT_CODE => Err(SandboxPathNotFoundError::new(path).into()),
            DIRECTORY_EXIT_CODE => Err(SandboxIsADirectoryError::new(path).into()),
            PERMISSION_EXIT_CODE => Err(SandboxPermissionError::new(path).into()),
            _ => Err(failure(result.stderr, format!("Failed to read file: {path}"))),
        }
    }

    /// Writes a file through `base64 -d`, creating parent directories with `mkdir -p`. See
    /// [`Sandbox::write_file`].
    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        let quoted = shell_quote(path);
        let eof = heredoc_delimiter();
        let encoded = STANDARD.encode(content);
        let command = format!("mkdir -p \"$(dirname {quoted})\" && base64 -d << '{eof}' > {quoted}\n{encoded}\n{eof}");
        let result = run(self, &command).await?;
        if result.exit_code != 0 {
            return Err(failure(result.stderr, format!("Failed to write file: {path}")));
        }
        Ok(())
    }

    /// Removes a file with `rm`. See [`Sandbox::remove_file`].
    async fn remove_file(&self, path: &str) -> Result<()> {
        let result = run(self, &format!("rm {}", shell_quote(path))).await?;
        if result.exit_code != 0 {
            return Err(failure(result.stderr, format!("Failed to remove file: {path}")));
        }
        Ok(())
    }

    /// Lists a directory by parsing `ls -1ap`. Entries carry `is_dir` but no size. See
    /// [`Sandbox::list_files`].
    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
        let quoted = shell_quote(path);
        // Exit 77 tells a missing directory apart from ls's own failures, independent of locale.
        let command = format!("test -d {quoted} || exit 77; env QUOTING_STYLE=literal ls -1ap {quoted}");
        let result = run(self, &command).await?;
        if result.exit_code == MISSING_EXIT_CODE {
            return Err(SandboxPathNotFoundError::new(path).into());
        }
        if result.exit_code != 0 {
            return Err(failure(result.stderr, format!("Failed to list directory: {path}")));
        }
        Ok(result.stdout.split('\n').filter_map(parse_ls_line).collect())
    }

    /// Tools this sandbox vends to an agent. See [`Sandbox::get_tools`].
    fn get_tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }
}

#[async_trait]
impl<T: PosixShellSandbox + ?Sized> Sandbox for T {
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
        PosixShellSandbox::execute_streaming(self, command, options)
    }

    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        PosixShellSandbox::execute_code_streaming(self, code, language, options)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        PosixShellSandbox::read_file(self, path).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        PosixShellSandbox::write_file(self, path, content).await
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        PosixShellSandbox::remove_file(self, path).await
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
        PosixShellSandbox::list_files(self, path).await
    }

    fn get_tools(&self) -> Vec<Arc<dyn Tool>> {
        PosixShellSandbox::get_tools(self)
    }
}

async fn run<S: PosixShellSandbox + ?Sized>(
    sandbox: &S,
    command: &str,
) -> Result<crate::sandbox::types::ExecutionResult> {
    final_result(
        PosixShellSandbox::execute_streaming(sandbox, command, ExecuteOptions::default()),
        "execute_streaming",
    )
    .await
}

/// A here-document delimiter that cannot occur in base64 text (`STRANDS_EOF_` and 16 characters
/// of a random UUID).
pub(crate) fn heredoc_delimiter() -> String {
    let id: String = uuid::Uuid::new_v4().to_string().chars().take(16).collect();
    format!("STRANDS_EOF_{id}")
}

pub(crate) fn invalid_language(language: &str) -> Error {
    Error::other(format!("language parameter contains invalid characters: {language}"))
}

pub(crate) fn error_stream(error: Error) -> ExecutionStream {
    Box::pin(stream::iter([Err(error)]))
}

fn failure(stderr: String, fallback: String) -> Error {
    Error::other(if stderr.is_empty() { fallback } else { stderr })
}

fn decode_base64(text: &str) -> Result<Vec<u8>> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(compact).map_err(Error::other)
}

fn parse_ls_line(raw: &str) -> Option<FileInfo> {
    let line = raw.strip_suffix('\r').unwrap_or(raw);
    if line.is_empty() || line == "./" || line == "../" {
        return None;
    }
    let (name, is_dir) = match line.strip_suffix('/') {
        Some(name) => (name, true),
        None => (line, false),
    };
    (!name.is_empty()).then(|| FileInfo::new(name).with_is_dir(is_dir))
}

#[cfg(test)]
mod tests;
