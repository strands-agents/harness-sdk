//! The host `bash` tool: a persistent bash process per agent, so variables and the working
//! directory carry over between calls.
//!
//! The process runs on the host, not in the agent's sandbox, and has no isolation. The
//! sandbox-routed, stateless shell is [`shell`](super::shell).

use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError, RwLock, Weak};

use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

use super::input::InputReader;
use super::{js_number_text, seconds, tool_error};
use crate::sandbox::process_group::{self, ProcessGroup};
use crate::tools::{FunctionTool, ToolError};
use crate::types::{JsonObject, JsonSchema, JsonValue};

const DEFAULT_TIMEOUT: f64 = 120.0;
const READ_BUFFER_SIZE: usize = 8192;

/// The description of the `bash` tool shown to the model.
pub(crate) const BASH_DESCRIPTION: &str = concat!(
    "Executes bash shell commands in a persistent session. Supports execute and restart modes. ",
    "Commands persist state (variables, directory) within the session."
);

tool_error!(
    /// A bash command exceeded its timeout (`BashTimeoutError`); the session is stopped.
    BashTimeoutError
);

tool_error!(
    /// The bash session failed (`BashSessionError`), for example the process exited during a
    /// command. The next call starts a new session.
    BashSessionError
);

/// What a bash command wrote (`BashOutput`), each stream trimmed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct BashOutput {
    /// Standard output.
    pub output: String,
    /// Standard error; empty when there was none.
    pub error: String,
}

/// A running bash process. Dropping it kills the process and its process group, so every way a
/// call can end without a complete exchange (error, timeout, a dropped future) also ends the
/// session: a later call never reads the output of an earlier command.
struct Process {
    child: Child,
    group: ProcessGroup,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
}

impl Process {
    fn spawn() -> Result<Self, BashSessionError> {
        let cwd = std::env::current_dir()
            .map_err(|error| BashSessionError::new(format!("Failed to start bash session: {error}")))?;
        let mut command = Command::new("bash");
        let mut child = process_group::isolate(&mut command)
            .current_dir(cwd)
            .env("PS1", "")
            .env("PS2", "")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| BashSessionError::new(format!("Failed to start bash session: {error}")))?;
        let group = ProcessGroup::of(&child);
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            group.kill(&mut child);
            return Err(BashSessionError::new("Failed to create bash process streams"));
        };
        Ok(Self {
            child,
            group,
            stdin,
            stdout,
            stderr,
        })
    }

    fn is_running(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.group.kill(&mut self.child);
    }
}

/// One agent's bash process, started on first use (`BashSession`).
struct BashSession {
    timeout: f64,
    sentinel: String,
    process: Option<Process>,
}

impl BashSession {
    fn new(timeout: f64) -> Self {
        Self {
            timeout,
            sentinel: format!("__BASH_DONE_{}__", uuid::Uuid::new_v4().simple()),
            process: None,
        }
    }

    /// Takes the running process, or starts one. The caller puts it back only after a complete
    /// exchange.
    fn take_process(&mut self) -> Result<Process, BashSessionError> {
        if let Some(mut process) = self.process.take()
            && process.is_running()
        {
            return Ok(process);
        }
        Process::spawn()
    }

    fn stop(&mut self) {
        self.process = None;
    }

    async fn run(&mut self, command: &str, timeout: Option<f64>) -> Result<BashOutput, ToolError> {
        let effective = timeout.unwrap_or(self.timeout);
        let sentinel = self.sentinel.clone();
        let mut process = self.take_process()?;
        let outcome = match seconds(effective) {
            Some(limit) => tokio::time::timeout(limit, exchange(&mut process, command, &sentinel))
                .await
                .ok(),
            None => Some(exchange(&mut process, command, &sentinel).await),
        };
        match outcome {
            Some(Ok(output)) => {
                self.process = Some(process);
                Ok(output)
            }
            Some(Err(error)) => Err(error.into()),
            None => Err(BashTimeoutError::new(format!(
                "Command timed out after {} seconds",
                js_number_text(effective)
            ))
            .into()),
        }
    }
}

/// Sends `command` followed by a sentinel on both streams, and reads until both sentinels
/// arrive, so all of the command's output belongs to this call.
async fn exchange(process: &mut Process, command: &str, sentinel: &str) -> Result<BashOutput, BashSessionError> {
    let script = format!("{command}\necho \"{sentinel}\" >&2\necho \"{sentinel}\"\n");
    if let Err(error) = process.stdin.write_all(script.as_bytes()).await {
        return Err(BashSessionError::new(format!("Failed to write command: {error}")));
    }
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut out_buf = vec![0_u8; READ_BUFFER_SIZE];
    let mut err_buf = vec![0_u8; READ_BUFFER_SIZE];
    let marker = sentinel.as_bytes();
    while !contains(&stdout, marker) || !contains(&stderr, marker) {
        let read = tokio::select! {
            read = process.stdout.read(&mut out_buf), if !contains(&stdout, marker) => read.map(|n| (n, true)),
            read = process.stderr.read(&mut err_buf), if !contains(&stderr, marker) => read.map(|n| (n, false)),
        };
        match read {
            Ok((0, _)) | Err(_) => {
                let code = process
                    .child
                    .wait()
                    .await
                    .ok()
                    .and_then(|status| status.code())
                    .map_or_else(|| "unknown".to_owned(), |code| code.to_string());
                return Err(BashSessionError::new(format!(
                    "Bash process exited unexpectedly with code {code}"
                )));
            }
            Ok((n, true)) => stdout.extend_from_slice(&out_buf[..n]),
            Ok((n, false)) => stderr.extend_from_slice(&err_buf[..n]),
        }
    }
    Ok(BashOutput {
        output: strip(&stdout, sentinel),
        error: strip(&stderr, sentinel),
    })
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

fn strip(bytes: &[u8], sentinel: &str) -> String {
    String::from_utf8_lossy(bytes)
        .replacen(sentinel, "", 1)
        .trim()
        .to_owned()
}

type AgentKey = Weak<RwLock<JsonObject>>;
type SharedSession = Arc<tokio::sync::Mutex<BashSession>>;

/// The sessions of the agents that called one `bash` tool, keyed by their app state so a
/// dropped agent's process is stopped on the next call.
#[derive(Default)]
struct Sessions(Mutex<Vec<(AgentKey, SharedSession)>>);

impl Sessions {
    fn with<T>(&self, f: impl FnOnce(&mut Vec<(AgentKey, SharedSession)>) -> T) -> T {
        let mut sessions = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.retain(|(agent, _)| agent.strong_count() > 0);
        f(&mut sessions)
    }

    fn get(&self, key: &AgentKey) -> Option<SharedSession> {
        self.with(|sessions| {
            sessions
                .iter()
                .find(|(agent, _)| Weak::ptr_eq(agent, key))
                .map(|(_, session)| session.clone())
        })
    }

    fn get_or_create(&self, key: &AgentKey, timeout: f64) -> SharedSession {
        self.with(|sessions| {
            if let Some((_, session)) = sessions.iter().find(|(agent, _)| Weak::ptr_eq(agent, key)) {
                return session.clone();
            }
            let session = Arc::new(tokio::sync::Mutex::new(BashSession::new(timeout)));
            sessions.push((key.clone(), session.clone()));
            session
        })
    }

    fn replace(&self, key: &AgentKey) -> Option<SharedSession> {
        self.with(|sessions| {
            let previous = sessions
                .iter()
                .position(|(agent, _)| Weak::ptr_eq(agent, key))
                .map(|index| sessions.remove(index).1);
            let session = Arc::new(tokio::sync::Mutex::new(BashSession::new(DEFAULT_TIMEOUT)));
            sessions.push((key.clone(), session));
            previous
        })
    }
}

fn input_schema() -> JsonSchema {
    json!({
        "type": "object",
        "properties": {
            "mode": {
                "type": "string",
                "enum": ["execute", "restart"],
                "description": "Operation mode: \"execute\" to run a command, \"restart\" to restart the session"
            },
            "command": {
                "description": "The bash command to execute (required when mode is \"execute\")",
                "type": "string"
            },
            "timeout": {
                "description": "Timeout in seconds (default: 120, applies only to execute mode)",
                "type": "number",
                "exclusiveMinimum": 0
            }
        },
        "required": ["mode"],
        "additionalProperties": false
    })
}

/// Creates the `bash` tool (`bash`): `mode: "execute"` runs `command` in the calling agent's
/// session and returns a [`BashOutput`] as JSON; `mode: "restart"` replaces the session.
///
/// Each agent has its own session, created on first use with `timeout` (120 seconds when
/// absent) as its default. A timeout fails with a [`BashTimeoutError`] and stops the session;
/// the process exiting fails with a [`BashSessionError`]. Either way the next call starts a new
/// process. Sessions end when their agent is dropped and when the tool is dropped.
///
/// ```
/// let agent = strands::Agent::builder().tools([strands::vended_tools::bash::bash()]).printer(false).build()?;
/// assert!(agent.tool_registry().get("bash").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
#[must_use]
pub fn bash() -> FunctionTool {
    let sessions = Arc::new(Sessions::default());
    FunctionTool::builder("bash", BASH_DESCRIPTION)
        .input_schema(input_schema())
        .callback(move |input, context| {
            let sessions = sessions.clone();
            let key = context.agent().app_state().downgrade();
            async move { run(&sessions, &key, &input).await }
        })
}

async fn run(sessions: &Sessions, key: &AgentKey, input: &JsonValue) -> Result<JsonValue, ToolError> {
    let mut reader = InputReader::new(input);
    let mode = reader.one_of("mode", &["execute", "restart"]);
    let command = reader.optional_string("command");
    let timeout = reader.optional_positive("timeout", |_| "Too small: expected number to be >0".to_owned());
    reader.finish()?;
    if mode == Some("restart") {
        if let Some(previous) = sessions.replace(key) {
            previous.lock().await.stop();
        }
        return Ok("Bash session restarted".into());
    }
    let Some(command) = command.filter(|command| !command.is_empty()) else {
        return Err(ToolError::msg("command is required when mode is \"execute\""));
    };
    let session = match sessions.get(key) {
        Some(session) => session,
        None => sessions.get_or_create(key, timeout.unwrap_or(DEFAULT_TIMEOUT)),
    };
    let output = session.lock().await.run(command, timeout).await?;
    Ok(serde_json::to_value(output)?)
}

#[cfg(test)]
mod tests;
