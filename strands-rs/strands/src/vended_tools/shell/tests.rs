#![cfg(unix)]

use std::sync::Mutex;

use async_trait::async_trait;

use super::*;
use crate::sandbox::process_group::test_support::{background_sleep, cleanup, ends, ps_available, read_pid};
use crate::sandbox::test_sandbox::TestSandbox;
use crate::sandbox::{ExecutionStream, FileInfo};
use crate::types::ToolResultStatus;
use crate::vended_tools::test_support::{agent, ok_json, run, text};

fn sandbox_shell() -> (FunctionTool, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let sandbox = Arc::new(TestSandbox::new(dir.path().to_string_lossy()));
    let shell = make_shell(MakeShellOptions {
        sandbox: Some(sandbox),
        ..MakeShellOptions::default()
    })
    .unwrap();
    (shell, dir)
}

fn timeout_error(result: &crate::types::ToolResultBlock) -> ShellTimeoutError {
    let error = result.error.as_ref().unwrap();
    error.downcast_ref::<ShellTimeoutError>().unwrap().clone()
}

#[tokio::test]
async fn executes_command_via_sandbox() {
    let (shell, _dir) = sandbox_shell();
    let output = ok_json(&shell, json!({"command": "echo \"hello sandbox\""}), &agent()).await;
    assert_eq!(
        output,
        json!({"output": "hello sandbox\n", "error": "", "exit_code": 0})
    );
}

#[tokio::test]
async fn reports_a_non_zero_exit_code() {
    let (shell, _dir) = sandbox_shell();
    let output = ok_json(&shell, json!({"command": "exit 42"}), &agent()).await;
    assert_eq!(output["exit_code"], 42);
}

#[tokio::test]
async fn captures_stderr_via_sandbox() {
    let (shell, _dir) = sandbox_shell();
    let output = ok_json(&shell, json!({"command": "echo \"oops\" >&2"}), &agent()).await;
    assert_eq!(output["error"], "oops\n");
    assert_eq!(output["exit_code"], 0);
}

#[tokio::test]
async fn does_not_persist_state_between_calls_stateless() {
    let (shell, _dir) = sandbox_shell();
    ok_json(&shell, json!({"command": "export MY_VAR=hello"}), &agent()).await;
    let output = ok_json(&shell, json!({"command": "echo \"${MY_VAR:-empty}\""}), &agent()).await;
    assert_eq!(output["output"], "empty\n");
}

#[tokio::test]
async fn respects_timeout() {
    let (shell, _dir) = sandbox_shell();
    let result = run(&shell, json!({"command": "sleep 10", "timeout": 0.1}), &agent()).await;
    assert_eq!(result.status, ToolResultStatus::Error);
}

#[tokio::test]
async fn throws_shell_timeout_error_on_timeout() {
    let (shell, _dir) = sandbox_shell();
    let result = run(&shell, json!({"command": "sleep 10", "timeout": 0.1}), &agent()).await;
    timeout_error(&result);
}

#[tokio::test]
async fn timeout_error_carries_the_partial_output_with_the_same_field_names_as_a_success_result() {
    let (shell, _dir) = sandbox_shell();
    let input = json!({"command": "echo partial; echo warn >&2; sleep 5", "timeout": 1});
    let error = timeout_error(&run(&shell, input, &agent()).await);
    assert_eq!(error.partial, Some(ShellOutput::new("partial\n", "warn\n", 124)));
    assert_eq!(
        error.message(),
        "Execution timed out after 1 seconds\n{\"output\":\"partial\\n\",\"error\":\"warn\\n\",\"exit_code\":124}"
    );
}

#[tokio::test]
async fn timeout_surfaces_as_a_failed_tool_result_that_still_includes_the_partial_output() {
    let (shell, _dir) = sandbox_shell();
    let input = json!({"command": "echo partial; sleep 5", "timeout": 1});
    let result = run(&shell, input, &agent()).await;
    assert_eq!(result.status, ToolResultStatus::Error);
    let text = text(&result);
    assert!(
        text.starts_with("Error: Execution timed out after 1 seconds\n"),
        "{text}"
    );
    let partial: JsonValue = serde_json::from_str(text.split('\n').nth(1).unwrap()).unwrap();
    assert_eq!(partial, json!({"output": "partial\n", "error": "", "exit_code": 124}));
}

struct RecordingSandbox {
    inner: TestSandbox,
    timeouts: Mutex<Vec<Option<f64>>>,
}

#[async_trait]
impl Sandbox for RecordingSandbox {
    fn execute_streaming(&self, command: &str, options: ExecuteOptions) -> ExecutionStream {
        let timeout = options.timeout.map(|timeout| timeout.as_secs_f64());
        self.timeouts.lock().unwrap().push(timeout);
        Sandbox::execute_streaming(&self.inner, command, options)
    }

    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        Sandbox::execute_code_streaming(&self.inner, code, language, options)
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        Sandbox::read_file(&self.inner, path).await
    }

    async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
        Sandbox::write_file(&self.inner, path, content).await
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        Sandbox::remove_file(&self.inner, path).await
    }

    async fn list_files(&self, path: &str) -> Result<Vec<FileInfo>> {
        Sandbox::list_files(&self.inner, path).await
    }
}

fn recording() -> (Arc<RecordingSandbox>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let sandbox = Arc::new(RecordingSandbox {
        inner: TestSandbox::new(dir.path().to_string_lossy()),
        timeouts: Mutex::new(Vec::new()),
    });
    (sandbox, dir)
}

#[test]
fn shows_the_model_the_default_in_the_schema() {
    for (default_timeout, expected) in [(None, json!(120)), (Some(300.0), json!(300))] {
        let options = MakeShellOptions {
            default_timeout,
            ..MakeShellOptions::default()
        };
        let spec = crate::tools::Tool::tool_spec(&make_shell(options).unwrap());
        let schema = spec.input_schema.unwrap();
        assert_eq!(schema["required"], json!(["command"]));
        assert_eq!(
            schema["properties"]["timeout"],
            json!({
                "type": "number",
                "exclusiveMinimum": 0,
                "default": expected,
                "description": "Optional per-execution timeout in seconds."
            })
        );
    }
}

#[tokio::test]
async fn reaches_the_sandbox_when_the_model_omits_timeout() {
    let (sandbox, _dir) = recording();
    let shell = make_shell(MakeShellOptions {
        sandbox: Some(sandbox.clone()),
        default_timeout: Some(300.0),
        ..MakeShellOptions::default()
    })
    .unwrap();
    ok_json(&shell, json!({"command": "true"}), &agent()).await;
    assert_eq!(*sandbox.timeouts.lock().unwrap(), [Some(300.0)]);
}

#[tokio::test]
async fn loses_to_an_explicit_timeout_from_the_model() {
    let (sandbox, _dir) = recording();
    let shell = make_shell(MakeShellOptions {
        sandbox: Some(sandbox.clone()),
        default_timeout: Some(300.0),
        ..MakeShellOptions::default()
    })
    .unwrap();
    ok_json(&shell, json!({"command": "true", "timeout": 7}), &agent()).await;
    assert_eq!(*sandbox.timeouts.lock().unwrap(), [Some(7.0)]);
}

#[test]
fn rejects_a_non_positive_or_non_finite_default_at_construction() {
    for value in [0.0, -1.0, f64::INFINITY, f64::NAN] {
        let options = MakeShellOptions {
            default_timeout: Some(value),
            ..MakeShellOptions::default()
        };
        let error = make_shell(options).unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("defaultTimeout must be a positive finite number"),
            "{error}"
        );
    }
}

#[tokio::test]
async fn uses_the_agent_sandbox_when_none_is_bound() {
    let shell = make_shell(MakeShellOptions::default()).unwrap();
    let output = ok_json(&shell, json!({"command": "echo agent"}), &agent()).await;
    assert_eq!(output["output"], "agent\n");
}

#[tokio::test]
async fn rejects_input_without_a_command() {
    let shell = make_shell(MakeShellOptions::default()).unwrap();
    let result = run(&shell, json!({"timeout": 0}), &agent()).await;
    assert_eq!(
        text(&result),
        "Error: Validation failed:\n- /command: Invalid input: expected string, received undefined\n- /timeout: Too small: expected number to be >0"
    );
}

/// The sandbox kills the shell's whole process group on timeout, so a command it started ends
/// with it (https://github.com/strands-agents/harness-sdk/issues/5044).
#[tokio::test]
async fn kills_the_commands_of_a_timed_out_command() {
    if !ps_available() {
        return;
    }
    let (shell, dir) = sandbox_shell();
    let pidfile = dir.path().join("pid");
    let result = run(
        &shell,
        json!({"command": format!("{} wait", background_sleep(&pidfile)), "timeout": 1}),
        &agent(),
    )
    .await;
    timeout_error(&result);
    let pid = read_pid(&pidfile).await;
    let ended = ends(&pid).await;
    cleanup(&pid);
    assert!(ended, "process {pid} survived");
}
