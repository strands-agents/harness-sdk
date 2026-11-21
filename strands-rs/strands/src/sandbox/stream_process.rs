//! Spawns a process and streams its stdout and stderr.

use std::ffi::OsString;
use std::future::pending;
use std::pin::pin;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};

use crate::cancel::CancelSignal;
use crate::error::{Error, SandboxAbortError, SandboxTimeoutError};
use crate::sandbox::base::ExecutionStream;
use crate::sandbox::process_group::{self, KillGroupOnDrop, ProcessGroup};
use crate::sandbox::types::{ExecutionResult, ExecutionStreamItem, StreamChunk, StreamType};

/// Exit code reported for a binary that does not exist, as a shell reports a missing command.
const NOT_FOUND_EXIT_CODE: i32 = 127;

/// The signals reported as `128 + n`; any other signal is reported as `129`.
#[cfg(unix)]
const SIGNAL_CODES: [i32; 8] = [1, 2, 3, 6, 9, 11, 13, 15];

const READ_BUFFER_SIZE: usize = 8192;

/// Options for [`stream_process`] (`StreamProcessOptions`).
#[derive(Debug, Clone, Default)]
pub(crate) struct StreamProcessOptions {
    /// Maximum execution time.
    pub(crate) timeout: Option<Duration>,
    /// Kills the process when it fires.
    pub(crate) signal: Option<CancelSignal>,
    /// Reported as stderr of an exit-127 result when the binary does not exist.
    pub(crate) enoent_message: Option<String>,
    /// Working directory of the child.
    pub(crate) cwd: Option<String>,
    /// Environment of the child; replaces the inherited one.
    pub(crate) env: Option<Vec<(OsString, OsString)>>,
    /// Written to the child's stdin, which is then closed. Without it stdin stays open.
    pub(crate) input: Option<String>,
}

/// Spawns `command` with `args` and streams its output.
///
/// Chunks are yielded as the process writes them; the final item is the [`ExecutionResult`] once
/// the process has exited and closed both pipes. The process and, on unix, its process group
/// (every process it started that did not leave the group) are killed on timeout, on the cancel
/// signal, and when the stream is dropped before it finishes.
pub(crate) fn stream_process(command: &str, args: Vec<String>, options: StreamProcessOptions) -> ExecutionStream {
    let mut cmd = Command::new(command);
    process_group::isolate(&mut cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        cmd.env_clear().envs(env.iter().cloned());
    }
    Box::pin(run(cmd, options))
}

fn run(
    mut cmd: Command,
    options: StreamProcessOptions,
) -> impl futures::Stream<Item = crate::Result<ExecutionStreamItem>> {
    async_stream::stream! {
        if options.signal.as_ref().is_some_and(CancelSignal::is_cancelled) {
            yield Err(SandboxAbortError::new().into());
            return;
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                yield spawn_failure(error, options.enoent_message);
                return;
            }
        };
        let group = ProcessGroup::of(&child);
        let mut guard = KillGroupOnDrop::new(group);
        let mut stdout = Pipe::new(child.stdout.take(), StreamType::Stdout);
        let mut stderr = Pipe::new(child.stderr.take(), StreamType::Stderr);
        let mut feed = pin!(feed_stdin(child.stdin.take(), options.input));
        let mut cancelled = pin!(cancelled(options.signal));
        let mut deadline = pin!(deadline(options.timeout));
        let mut status: Option<ExitStatus> = None;

        while status.is_none() || !stdout.closed || !stderr.closed {
            tokio::select! {
                () = &mut cancelled => {
                    group.kill(&mut child);
                    yield Err(SandboxAbortError::new().with_output(stdout.text.clone(), stderr.text.clone()).into());
                    return;
                }
                () = &mut deadline => {
                    group.kill(&mut child);
                    let seconds = options.timeout.unwrap_or_default().as_secs_f64();
                    yield Err(SandboxTimeoutError::new(seconds).with_output(stdout.text.clone(), stderr.text.clone()).into());
                    return;
                }
                () = &mut feed => {}
                chunk = stdout.read(), if !stdout.closed => {
                    if let Some(chunk) = chunk {
                        yield Ok(chunk.into());
                    }
                }
                chunk = stderr.read(), if !stderr.closed => {
                    if let Some(chunk) = chunk {
                        yield Ok(chunk.into());
                    }
                }
                exited = child.wait(), if status.is_none() => match exited {
                    Ok(exited) => status = Some(exited),
                    Err(error) => {
                        group.kill(&mut child);
                        yield Err(error.into());
                        return;
                    }
                },
            }
        }
        guard.disarm();
        let exit_code = status.map_or(1, exit_code);
        yield Ok(ExecutionResult::new(exit_code, stdout.text, stderr.text).into());
    }
}

fn spawn_failure(error: std::io::Error, enoent_message: Option<String>) -> crate::Result<ExecutionStreamItem> {
    match enoent_message {
        Some(message) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ExecutionResult::new(NOT_FOUND_EXIT_CODE, "", message).into())
        }
        _ => Err(Error::from(error)),
    }
}

/// Writes `input` and closes stdin, or holds stdin open without input. Never completes.
async fn feed_stdin(stdin: Option<ChildStdin>, input: Option<String>) {
    let Some(mut stdin) = stdin else {
        return pending().await;
    };
    let Some(input) = input else {
        pending::<()>().await;
        drop(stdin);
        return;
    };
    // The child may exit without reading its input; the broken pipe is not a failure.
    let _ = stdin.write_all(input.as_bytes()).await;
    drop(stdin);
    pending::<()>().await;
}

async fn cancelled(signal: Option<CancelSignal>) {
    match signal {
        Some(signal) => signal.cancelled().await,
        None => pending().await,
    }
}

async fn deadline(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => pending().await,
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status.code().unwrap_or_else(|| signal_exit_code(status))
}

#[cfg(unix)]
fn signal_exit_code(status: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;

    match status.signal() {
        Some(signal) if SIGNAL_CODES.contains(&signal) => 128 + signal,
        Some(_) => 129,
        None => 1,
    }
}

#[cfg(not(unix))]
fn signal_exit_code(_status: ExitStatus) -> i32 {
    1
}

/// One output pipe: its reader, its decoder and everything decoded so far.
struct Pipe<R> {
    reader: Option<R>,
    stream_type: StreamType,
    decoder: Utf8Decoder,
    buffer: Box<[u8]>,
    text: String,
    closed: bool,
}

impl<R: AsyncRead + Unpin> Pipe<R> {
    fn new(reader: Option<R>, stream_type: StreamType) -> Self {
        Self {
            closed: reader.is_none(),
            reader,
            stream_type,
            decoder: Utf8Decoder::default(),
            buffer: vec![0; READ_BUFFER_SIZE].into_boxed_slice(),
            text: String::new(),
        }
    }

    /// Reads once. Returns the decoded chunk, if any; marks the pipe closed at end of file.
    async fn read(&mut self) -> Option<StreamChunk> {
        let Some(reader) = self.reader.as_mut() else {
            self.closed = true;
            return None;
        };
        let decoded = match reader.read(&mut self.buffer).await {
            Ok(0) | Err(_) => {
                self.closed = true;
                self.reader = None;
                self.decoder.finish()
            }
            Ok(read) => self.decoder.decode(self.buffer.get(..read).unwrap_or_default()),
        };
        if decoded.is_empty() {
            return None;
        }
        self.text.push_str(&decoded);
        Some(StreamChunk::new(decoded, self.stream_type))
    }
}

/// Incremental UTF-8 decoding that holds a multibyte sequence split across reads until its last
/// byte arrives. Invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub(crate) struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    /// Decodes `bytes` after any held bytes, holding back an incomplete trailing sequence.
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut decoded = String::new();
        loop {
            let error = match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    decoded.push_str(text);
                    self.pending.clear();
                    return decoded;
                }
                Err(error) => error,
            };
            let valid = error.valid_up_to();
            decoded.push_str(&String::from_utf8_lossy(self.pending.get(..valid).unwrap_or_default()));
            let Some(invalid) = error.error_len() else {
                self.pending.drain(..valid);
                return decoded;
            };
            decoded.push('\u{FFFD}');
            self.pending.drain(..valid + invalid);
        }
    }

    /// Flushes held bytes at end of input; an incomplete sequence becomes U+FFFD.
    pub(crate) fn finish(&mut self) -> String {
        let decoded = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        decoded
    }
}

/// Includes the streaming edge cases of the POSIX shell sandbox.
#[cfg(test)]
mod tests;

#[cfg(test)]
mod decoder_tests {
    use super::*;

    #[test]
    fn holds_a_sequence_split_across_reads() {
        let bytes = "café☕".as_bytes();
        let mut decoder = Utf8Decoder::default();
        let first = decoder.decode(&bytes[..4]);
        let second = decoder.decode(&bytes[4..]);
        assert_eq!(first, "caf");
        assert_eq!(second, "é☕");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_going() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.decode(b"ok\xFF\xFEok"), "ok\u{FFFD}\u{FFFD}ok");
    }

    #[test]
    fn flushes_an_incomplete_sequence_at_the_end() {
        let mut decoder = Utf8Decoder::default();
        assert_eq!(decoder.decode(b"caf\xC3"), "caf");
        assert_eq!(decoder.finish(), "\u{FFFD}");
    }

    #[test]
    fn decodes_one_byte_at_a_time() {
        let mut decoder = Utf8Decoder::default();
        let decoded: String = "日本語 🚀".bytes().map(|byte| decoder.decode(&[byte])).collect();
        assert_eq!(decoded, "日本語 🚀");
    }
}
