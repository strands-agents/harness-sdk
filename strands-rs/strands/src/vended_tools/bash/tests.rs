#![cfg(unix)]
//! Unix only. A session stops when its agent or the tool is dropped.

use std::time::Duration;

use super::*;
use crate::agent::ToolAgent;
use crate::sandbox::process_group::test_support::{background_sleep, cleanup, ends, ps_available, read_pid};
use crate::tools::Tool;
use crate::types::ToolResultStatus;
use crate::vended_tools::test_support::{agent, error_text, ok_json, ok_text, run as run_tool};

async fn execute(tool: &FunctionTool, agent: &ToolAgent, command: &str) -> JsonValue {
    ok_json(tool, json!({"mode": "execute", "command": command}), agent).await
}

async fn restart(tool: &FunctionTool, agent: &ToolAgent) -> String {
    ok_text(tool, json!({"mode": "restart"}), agent).await
}

fn output(value: &JsonValue) -> &str {
    value["output"].as_str().unwrap()
}

#[tokio::test]
async fn accepts_valid_execute_and_restart_commands() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(output(&execute(&tool, &agent, "echo test").await), "test");
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
}

#[tokio::test]
async fn rejects_invalid_input() {
    let (tool, agent) = (bash(), agent());
    error_text(&tool, json!({"mode": "invalid"}), &agent).await;
    error_text(
        &tool,
        json!({"mode": "execute", "command": "echo test", "timeout": -1}),
        &agent,
    )
    .await;
    let ok = ok_json(
        &tool,
        json!({"mode": "execute", "command": "echo test", "timeout": 30}),
        &agent,
    )
    .await;
    assert_eq!(output(&ok), "test");
}

#[tokio::test]
async fn validates_command_is_required_for_execute_mode() {
    let (tool, agent) = (bash(), agent());
    for input in [json!({"mode": "execute"}), json!({"mode": "execute", "command": ""})] {
        assert_eq!(
            error_text(&tool, input, &agent).await,
            "command is required when mode is \"execute\""
        );
    }
}

#[tokio::test]
async fn creates_new_session_after_restart() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "TEST_VAR=exists").await;
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    let after = execute(&tool, &agent, "echo ${TEST_VAR:-empty}").await;
    assert_eq!(output(&after), "empty");
}

#[tokio::test]
async fn creates_session_on_first_execute() {
    let (tool, agent) = (bash(), agent());
    assert!(output(&execute(&tool, &agent, "echo \"test\"").await).contains("test"));
}

#[tokio::test]
async fn restarts_existing_session_when_restart_is_called() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "TEST_VAR=\"initial\"").await;
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert_eq!(
        output(&execute(&tool, &agent, "echo \"${TEST_VAR:-empty}\"").await),
        "empty"
    );
}

#[tokio::test]
async fn uses_default_timeout_of_120_seconds() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(output(&execute(&tool, &agent, "echo \"quick\"").await), "quick");
}

#[tokio::test]
async fn respects_custom_timeout_for_new_session() {
    let (tool, agent) = (bash(), agent());
    let result = ok_json(
        &tool,
        json!({"mode": "execute", "command": "echo \"custom\"", "timeout": 60}),
        &agent,
    )
    .await;
    assert_eq!(output(&result), "custom");
}

#[tokio::test]
async fn handles_command_execution_in_a_session_without_proper_initialization() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "echo \"init\"").await;
    restart(&tool, &agent).await;
    assert!(output(&execute(&tool, &agent, "echo \"after restart\"").await).contains("after restart"));
}

#[tokio::test]
async fn creates_new_session_when_none_exists() {
    let (tool, agent) = (bash(), agent());
    assert!(output(&execute(&tool, &agent, "echo \"first\"").await).contains("first"));
}

#[tokio::test]
async fn handles_restart_when_no_session_exists() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
}

#[tokio::test]
async fn properly_cleans_up_session_on_restart() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "CLEANUP_TEST=\"should_be_gone\"").await;
    restart(&tool, &agent).await;
    assert_eq!(
        output(&execute(&tool, &agent, "echo \"${CLEANUP_TEST:-empty}\"").await),
        "empty"
    );
}

#[tokio::test]
async fn handles_multiple_restarts_in_sequence() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert!(output(&execute(&tool, &agent, "echo \"still works\"").await).contains("still works"));
}

#[tokio::test]
async fn creates_session_with_default_timeout_when_not_specified() {
    let (tool, agent) = (bash(), agent());
    assert!(output(&execute(&tool, &agent, "echo \"default\"").await).contains("default"));
}

#[tokio::test]
async fn persists_environment_variables_between_calls() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "export MY_VAR=persistent_value").await;
    assert_eq!(
        output(&execute(&tool, &agent, "echo $MY_VAR").await),
        "persistent_value"
    );
}

#[tokio::test]
async fn persists_working_directory_between_calls() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "cd /tmp").await;
    let pwd = execute(&tool, &agent, "pwd").await;
    assert_eq!(
        std::fs::canonicalize(output(&pwd)).unwrap(),
        std::fs::canonicalize("/tmp").unwrap()
    );
}

#[tokio::test]
async fn provides_isolated_sessions_for_different_agents() {
    let tool = bash();
    let (first, second) = (agent(), agent());
    execute(&tool, &first, "AGENT_VAR=\"agent1\"").await;
    assert!(!output(&execute(&tool, &second, "echo $AGENT_VAR").await).contains("agent1"));
}

#[tokio::test]
async fn handles_session_restart_with_no_existing_session_gracefully() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert_eq!(output(&execute(&tool, &agent, "echo works").await), "works");
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert_eq!(restart(&tool, &agent).await, "Bash session restarted");
    assert_eq!(output(&execute(&tool, &agent, "echo still works").await), "still works");
}

#[tokio::test]
async fn executes_command_and_returns_output() {
    let (tool, agent) = (bash(), agent());
    let result = execute(&tool, &agent, "echo \"Hello World\"").await;
    assert_eq!(result, json!({"output": "Hello World", "error": ""}));
}

#[tokio::test]
async fn captures_stderr_on_command_error() {
    let (tool, agent) = (bash(), agent());
    let result = execute(&tool, &agent, "nonexistent_command_xyz").await;
    assert!(result["error"].as_str().unwrap().contains("not found"), "{result}");
}

#[tokio::test]
async fn completes_command_before_timeout() {
    let (tool, agent) = (bash(), agent());
    let result = ok_json(
        &tool,
        json!({"mode": "execute", "command": "echo fast", "timeout": 5}),
        &agent,
    )
    .await;
    assert_eq!(output(&result), "fast");
}

#[tokio::test]
async fn throws_bash_timeout_error_when_command_times_out() {
    let (tool, agent) = (bash(), agent());
    let result = run_tool(
        &tool,
        json!({"mode": "execute", "command": "sleep 10", "timeout": 0.1}),
        &agent,
    )
    .await;
    assert_eq!(result.status, ToolResultStatus::Error);
    let error = result.error.as_ref().unwrap();
    assert_eq!(
        error.downcast_ref::<BashTimeoutError>().unwrap().message(),
        "Command timed out after 0.1 seconds"
    );
    let recovered = ok_json(
        &tool,
        json!({"mode": "execute", "command": "echo recovered", "timeout": 5}),
        &agent,
    )
    .await;
    assert_eq!(output(&recovered), "recovered");
}

#[tokio::test]
async fn handles_timeout_during_command_with_large_output() {
    let (tool, agent) = (bash(), agent());
    let input = json!({"mode": "execute", "command": "for i in $(seq 1 1000); do echo line $i; done; sleep 10", "timeout": 0.5});
    let result = run_tool(&tool, input, &agent).await;
    assert!(
        result
            .error
            .as_ref()
            .unwrap()
            .downcast_ref::<BashTimeoutError>()
            .is_some()
    );
}

#[tokio::test]
async fn handles_command_with_empty_or_whitespace_output() {
    let (tool, agent) = (bash(), agent());
    assert_eq!(execute(&tool, &agent, "true").await, json!({"output": "", "error": ""}));
    assert_eq!(output(&execute(&tool, &agent, "echo '   '").await), "");
}

#[tokio::test]
async fn handles_very_long_command_output() {
    let (tool, agent) = (bash(), agent());
    let result = execute(
        &tool,
        &agent,
        "for i in $(seq 1 100); do echo \"Line $i of output\"; done",
    )
    .await;
    assert!(output(&result).contains("Line 1 of output"));
    assert!(output(&result).contains("Line 100 of output"));
}

#[tokio::test]
async fn starts_in_the_process_working_directory() {
    let (tool, agent) = (bash(), agent());
    let pwd = execute(&tool, &agent, "pwd").await;
    assert_eq!(
        std::fs::canonicalize(output(&pwd)).unwrap(),
        std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap()
    );
}

#[test]
fn has_the_tool_name_description_and_spec() {
    let tool = bash();
    assert_eq!(tool.name(), "bash");
    assert_eq!(tool.description(), BASH_DESCRIPTION);
    assert_eq!(tool.tool_spec().name, "bash");
}

#[test]
fn error_classes_have_correct_properties() {
    let timeout = BashTimeoutError::new("timeout message");
    assert_eq!(BashTimeoutError::NAME, "BashTimeoutError");
    assert_eq!(timeout.to_string(), "timeout message");
    let session = BashSessionError::new("session error message");
    assert_eq!(BashSessionError::NAME, "BashSessionError");
    assert_eq!(session.message(), "session error message");
}

#[tokio::test]
async fn handles_process_close_during_command_execution() {
    let (tool, agent) = (bash(), agent());
    execute(&tool, &agent, "echo init").await;
    let result = run_tool(&tool, json!({"mode": "execute", "command": "exit 0"}), &agent).await;
    let error = result.error.as_ref().unwrap();
    assert_eq!(
        error.downcast_ref::<BashSessionError>().unwrap().message(),
        "Bash process exited unexpectedly with code 0"
    );
    assert_eq!(output(&execute(&tool, &agent, "echo new session").await), "new session");
}

/// A timeout kills the session's whole process group, so a command the script started ends with
/// it (https://github.com/strands-agents/harness-sdk/issues/5044).
#[tokio::test]
async fn kills_the_commands_of_a_timed_out_call() {
    if !ps_available() {
        return;
    }
    let (tool, agent) = (bash(), agent());
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let input = json!({"mode": "execute", "command": format!("{} wait", background_sleep(&pidfile)), "timeout": 1});
    let result = run_tool(&tool, input, &agent).await;
    assert!(
        result
            .error
            .as_ref()
            .unwrap()
            .downcast_ref::<BashTimeoutError>()
            .is_some()
    );
    let pid = read_pid(&pidfile).await;
    let ended = ends(&pid).await;
    cleanup(&pid);
    assert!(ended, "process {pid} survived");
}

/// Rust-only: a call whose future is dropped mid-command stops the session, so the next call
/// neither reads the dropped command's output nor runs in its state.
#[tokio::test]
async fn stops_the_session_when_a_call_is_dropped_mid_command() {
    let (tool, agent) = (bash(), agent());
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    execute(&tool, &agent, "MARK=kept").await;
    let command = format!("{} wait; echo first", background_sleep(&pidfile));
    let dropped = tokio::time::timeout(
        Duration::from_millis(500),
        run_tool(&tool, json!({"mode": "execute", "command": command}), &agent),
    )
    .await;
    assert!(dropped.is_err());
    let pid = read_pid(&pidfile).await;
    let next = execute(&tool, &agent, "echo second ${MARK:-gone}").await;
    assert_eq!(output(&next), "second gone");
    if ps_available() {
        let ended = ends(&pid).await;
        cleanup(&pid);
        assert!(ended, "process {pid} survived");
    }
}
