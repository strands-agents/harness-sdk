//! The host as a sandbox, with no isolation.

use std::cmp::Ordering;
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::error::{Error, Result, SandboxIsADirectoryError, SandboxPathNotFoundError, SandboxPermissionError};
use crate::sandbox::base::{ExecuteOptions, ExecutionStream, Sandbox};
use crate::sandbox::constants::{is_valid_language, shell_quote};
use crate::sandbox::posix_shell::{
    build_shell_env_prefix, error_stream, heredoc_delimiter, invalid_language, validate_env_keys,
};
use crate::sandbox::stream_process::{StreamProcessOptions, stream_process};
use crate::sandbox::types::FileInfo;

const POWERSHELL: &str = "powershell.exe";
const POWERSHELL_NOT_FOUND: &str = "PowerShell not found: powershell.exe is required to run commands on Windows";

/// Runs commands and file operations directly on the host, with no isolation
/// (`NotASandboxLocalEnvironment`). The agent's default when no sandbox is configured.
///
/// Commands run in `sh -c` on POSIX systems and in Windows PowerShell on Windows. Relative paths
/// resolve against the process's current directory, and so does a command without a `cwd`.
///
/// ```no_run
/// use strands::sandbox::{ExecuteOptions, NotASandboxLocalEnvironment, Sandbox};
///
/// # async fn demo() -> strands::Result<()> {
/// let host = NotASandboxLocalEnvironment::new();
/// let result = host.execute("echo hello", ExecuteOptions::default()).await?;
/// assert_eq!(result.stdout.trim(), "hello");
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct NotASandboxLocalEnvironment {}

impl NotASandboxLocalEnvironment {
    /// Creates the local environment.
    #[must_use]
    pub fn new() -> Self {
        Self {}
    }
}

#[async_trait]
impl Sandbox for NotASandboxLocalEnvironment {
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
        let cwd = match resolve_cwd(options.cwd) {
            Ok(cwd) => cwd,
            Err(error) => return error_stream(error),
        };
        if cfg!(windows) {
            // No `sh` on Windows: cwd and env go through the spawn, not a shell prefix.
            let env = match windows_env(options.env.as_deref()) {
                Ok(env) => env,
                Err(error) => return error_stream(error),
            };
            let process_options = StreamProcessOptions {
                timeout: options.timeout,
                signal: options.signal,
                enoent_message: Some(POWERSHELL_NOT_FOUND.to_owned()),
                cwd: Some(cwd),
                env: Some(env),
                input: None,
            };
            return stream_process(POWERSHELL, powershell_args(command), process_options);
        }
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

    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        if !is_valid_language(language) {
            return error_stream(invalid_language(language));
        }
        let cwd = match resolve_cwd(options.cwd) {
            Ok(cwd) => cwd,
            Err(error) => return error_stream(error),
        };
        let enoent_message = Some(format!("Language interpreter not found: {language}"));
        if cfg!(windows) {
            // No shell involved: the interpreter is spawned directly and reads the code from stdin.
            let env = match windows_env(options.env.as_deref()) {
                Ok(env) => env,
                Err(error) => return error_stream(error),
            };
            let process_options = StreamProcessOptions {
                timeout: options.timeout,
                signal: options.signal,
                enoent_message,
                cwd: Some(cwd),
                env: Some(env),
                input: Some(code.to_owned()),
            };
            return stream_process(language, Vec::new(), process_options);
        }
        let prefix = match build_shell_env_prefix(options.env.as_deref()) {
            Ok(prefix) => prefix,
            Err(error) => return error_stream(error),
        };
        let eof = heredoc_delimiter();
        let encoded = STANDARD.encode(code);
        let script = format!(
            "cd {} && {prefix}base64 -d << '{eof}' | {language}\n{encoded}\n{eof}",
            shell_quote(&cwd)
        );
        let process_options = StreamProcessOptions {
            timeout: options.timeout,
            signal: options.signal,
            enoent_message,
            ..StreamProcessOptions::default()
        };
        stream_process("sh", vec!["-c".to_owned(), script], process_options)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let full_path = resolve_path(path)?;
        match tokio::fs::read(&full_path).await {
            Ok(content) => Ok(content),
            Err(error) if cfg!(windows) && is_directory(&full_path).await => {
                Err(SandboxIsADirectoryError::new(path).with_source(error).into())
            }
            Err(error) => Err(read_error(path, error)),
        }
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        let full_path = resolve_path(path)?;
        if let Some(parent) = full_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(&full_path, content).await?;
        Ok(())
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        tokio::fs::remove_file(resolve_path(path)?).await?;
        Ok(())
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
        let full_path = resolve_path(path)?;
        let mut entries = tokio::fs::read_dir(&full_path)
            .await
            .map_err(|error| list_error(path, error))?;
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        names.sort_by(|a, b| locale_compare(a, b));
        let mut results = Vec::with_capacity(names.len());
        for name in names {
            results.push(file_info(&full_path, name).await);
        }
        Ok(results)
    }
}

async fn file_info(directory: &Path, name: String) -> FileInfo {
    match tokio::fs::metadata(directory.join(&name)).await {
        Ok(metadata) => FileInfo::new(name)
            .with_is_dir(metadata.is_dir())
            .with_size(metadata.len()),
        Err(_) => FileInfo::new(name),
    }
}

/// Whether a failed read hit a directory. Windows reports that as access denied, or as not found
/// when the path ends in a separator.
async fn is_directory(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|metadata| metadata.is_dir())
}

fn resolve_path(path: &str) -> Result<PathBuf> {
    let path = Path::new(path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }
    Ok(std::env::current_dir()?.join(path))
}

fn resolve_cwd(cwd: Option<String>) -> Result<String> {
    match cwd {
        Some(cwd) => Ok(cwd),
        None => Ok(std::env::current_dir()?.to_string_lossy().into_owned()),
    }
}

/// A missing entry or a file where a directory was expected.
fn is_missing_path(error: &std::io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

fn read_error(path: &str, error: std::io::Error) -> Error {
    if is_missing_path(&error) {
        return SandboxPathNotFoundError::new(path).with_source(error).into();
    }
    match error.kind() {
        ErrorKind::IsADirectory => SandboxIsADirectoryError::new(path).with_source(error).into(),
        ErrorKind::PermissionDenied => SandboxPermissionError::new(path).with_source(error).into(),
        _ => error.into(),
    }
}

fn list_error(path: &str, error: std::io::Error) -> Error {
    if is_missing_path(&error) {
        return SandboxPathNotFoundError::new(path).with_source(error).into();
    }
    error.into()
}

/// Orders names the way a locale-aware comparison usually does: letters case-insensitively first,
/// then lowercase before uppercase.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// The argv that runs `command` in Windows PowerShell.
///
/// `-EncodedCommand` (base64 of UTF-16LE) carries the script without command-line quoting; it
/// inflates the text 2.67x against Windows' 32,767-character limit, so commands over about 12 KB
/// fail to spawn. The wrapper makes output UTF-8 (5.1 defaults to the OEM code page) and mirrors
/// `sh -c`'s exit code: the last statement's success, or the failing native command's own code.
/// `$ErrorActionPreference` is left alone because `Stop` turns native stderr output into a
/// terminating error.
pub(crate) fn powershell_args(command: &str) -> Vec<String> {
    let script = [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        command,
        "$ok = $?",
        "if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }",
    ]
    .join("\n");
    vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-EncodedCommand".to_owned(),
        encode_utf16le_base64(&script),
    ]
}

pub(crate) fn encode_utf16le_base64(text: &str) -> String {
    let bytes: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(bytes)
}

fn windows_env(extra: Option<&[(String, String)]>) -> Result<Vec<(OsString, OsString)>> {
    if let Some(extra) = extra {
        validate_env_keys(extra)?;
    }
    Ok(env_with(std::env::vars_os(), extra))
}

/// `host` with `extra` applied. Windows names are case-insensitive, so `PATH` replaces `Path`.
pub(crate) fn env_with(
    host: impl IntoIterator<Item = (OsString, OsString)>,
    extra: Option<&[(String, String)]>,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = host.into_iter().collect();
    for (key, value) in extra.into_iter().flatten() {
        let lowered = key.to_lowercase();
        env.retain(|(existing, _)| existing.to_string_lossy().to_lowercase() != lowered);
        env.push((key.into(), value.into()));
    }
    env
}

#[cfg(test)]
mod tests;
