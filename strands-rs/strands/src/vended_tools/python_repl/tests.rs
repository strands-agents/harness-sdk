use std::sync::Mutex;

use async_trait::async_trait;
use futures::stream;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::sandbox::{ExecutionResult, ExecutionStream, FileInfo, NotASandboxLocalEnvironment};
use crate::tools::Tool;
use crate::vended_tools::test_support::{
    agent, agent_with_sandbox, error_text, ok_json, run as run_tool, run_with_signal,
};

type Call = (String, String, Option<f64>, bool);

/// Records `execute_code` calls and answers with a scripted result.
struct Scripted {
    calls: Mutex<Vec<Call>>,
    answer: fn() -> Result<ExecutionResult>,
}

impl Scripted {
    fn new(answer: fn() -> Result<ExecutionResult>) -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
            answer,
        })
    }

    fn hi() -> Arc<Self> {
        Self::new(|| Ok(ExecutionResult::new(0, "hi\n", "")))
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl Sandbox for Scripted {
    fn execute_streaming(&self, _command: &str, _options: ExecuteOptions) -> ExecutionStream {
        Box::pin(stream::iter([Err(Error::other("not scripted"))]))
    }

    fn execute_code_streaming(&self, code: &str, language: &str, options: ExecuteOptions) -> ExecutionStream {
        let timeout = options.timeout.map(|timeout| timeout.as_secs_f64());
        self.calls
            .lock()
            .unwrap()
            .push((code.to_owned(), language.to_owned(), timeout, options.signal.is_some()));
        Box::pin(stream::iter([(self.answer)().map(Into::into)]))
    }

    async fn read_file(&self, _path: &str) -> Result<Vec<u8>> {
        Err(Error::other("not scripted"))
    }

    async fn write_file(&self, _path: &str, _content: &[u8]) -> Result<()> {
        Err(Error::other("not scripted"))
    }

    async fn remove_file(&self, _path: &str) -> Result<()> {
        Err(Error::other("not scripted"))
    }

    async fn list_files(&self, _path: &str) -> Result<Vec<FileInfo>> {
        Err(Error::other("not scripted"))
    }
}

fn has_python() -> bool {
    let found = std::process::Command::new("python3").arg("--version").output().is_ok();
    if !found {
        eprintln!("skipping: python3 is not installed");
    }
    found
}

#[tokio::test]
async fn uses_the_agent_sandbox_and_defaults() {
    let sandbox = Scripted::hi();
    let output = ok_json(
        &python_repl(),
        json!({"code": "print('hi')"}),
        &agent_with_sandbox(sandbox.clone()),
    )
    .await;
    assert_eq!(
        sandbox.calls(),
        [("print('hi')".to_owned(), "python3".to_owned(), Some(120.0), true)]
    );
    assert_eq!(output, json!({"output": "hi\n", "error": "", "exit_code": 0}));
}

#[tokio::test]
async fn prefers_a_bound_sandbox_and_forwards_language_and_timeout() {
    let bound = Scripted::hi();
    let agent_sandbox = Scripted::hi();
    let tool = make_python_repl(MakePythonReplOptions {
        sandbox: Some(bound.clone()),
        language: Some("python3.12".to_owned()),
        ..MakePythonReplOptions::default()
    })
    .unwrap();
    ok_json(
        &tool,
        json!({"code": "pass", "timeout": 7}),
        &agent_with_sandbox(agent_sandbox.clone()),
    )
    .await;
    assert_eq!(
        bound.calls(),
        [("pass".to_owned(), "python3.12".to_owned(), Some(7.0), true)]
    );
    assert!(agent_sandbox.calls().is_empty());
}

#[tokio::test]
async fn rejects_a_non_positive_timeout() {
    let sandbox = Scripted::hi();
    let message = error_text(
        &python_repl(),
        json!({"code": "pass", "timeout": 0}),
        &agent_with_sandbox(sandbox.clone()),
    )
    .await;
    assert!(
        message.contains("timeout must be a positive number of seconds, got 0"),
        "{message}"
    );
    assert!(sandbox.calls().is_empty());
}

#[tokio::test]
async fn wraps_sandbox_error_as_python_repl_error() {
    let sandbox = Scripted::new(|| Err(Error::other("container gone")));
    let result = run_tool(&python_repl(), json!({"code": "pass"}), &agent_with_sandbox(sandbox)).await;
    let error = result.error.as_ref().unwrap();
    assert_eq!(
        error.downcast_ref::<PythonReplError>().unwrap().message(),
        "container gone"
    );
}

#[tokio::test]
async fn reports_failure_via_error_and_non_zero_exit() {
    if !has_python() || cfg!(windows) {
        return;
    }
    for (code, expected) in [("raise ValueError('bad')", "ValueError: bad"), ("input()", "EOFError")] {
        let output = ok_json(&python_repl(), json!({"code": code}), &agent()).await;
        assert_ne!(output["exit_code"], 0);
        assert!(output["error"].as_str().unwrap().contains(expected), "{output}");
    }
}

#[tokio::test]
async fn does_not_persist_state_across_calls_but_files_do() {
    if !has_python() || cfg!(windows) {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let path = serde_json::to_string(&dir.path().join("state.json")).unwrap();
    let code = format!("import json; x = 42; json.dump({{'x': x}}, open({path}, 'w'))");
    ok_json(&python_repl(), json!({"code": code}), &agent()).await;
    let missing = ok_json(&python_repl(), json!({"code": "print(x)"}), &agent()).await;
    assert!(missing["error"].as_str().unwrap().contains("NameError"));
    let code = format!("import json; print(json.load(open({path}))['x'])");
    let restored = ok_json(&python_repl(), json!({"code": code}), &agent()).await;
    assert_eq!(restored, json!({"output": "42\n", "error": "", "exit_code": 0}));
}

#[tokio::test]
async fn timeout_carries_partial_output_with_the_success_field_names() {
    if !has_python() || cfg!(windows) {
        return;
    }
    let input = json!({"code": "print('partial', flush=True)\nimport time; time.sleep(10)", "timeout": 1});
    let result = run_tool(&python_repl(), input, &agent()).await;
    let error = result.error.as_ref().unwrap();
    let timeout = error.downcast_ref::<PythonReplTimeoutError>().unwrap();
    assert_eq!(timeout.timeout().seconds, 1.0);
    let payload: JsonValue = serde_json::from_str(timeout.message().split('\n').nth(1).unwrap()).unwrap();
    assert_eq!(payload, json!({"output": "partial\n", "error": "", "exit_code": 124}));
}

#[tokio::test]
async fn cancellation_stops_the_call_and_propagates_unwrapped() {
    let handle = CancelHandle::new();
    handle.cancel(CancelOptions::default());
    let input = json!({"code": "import time; time.sleep(10)"});
    let result = run_with_signal(&python_repl(), input, &agent(), handle.signal()).await;
    let error = result.error.as_ref().unwrap();
    assert!(
        matches!(error.downcast_ref::<Error>(), Some(Error::SandboxAbort(_))),
        "{error}"
    );
}

#[test]
fn rejects_invalid_arguments() {
    let empty_name = make_python_repl(MakePythonReplOptions::builder().name("").build()).unwrap_err();
    assert!(empty_name.to_string().contains("name"));
    let language =
        make_python_repl(MakePythonReplOptions::builder().language("python3; rm -rf /").build()).unwrap_err();
    assert!(language.to_string().contains("language"));
}

#[test]
fn has_the_default_tool_spec_and_exports() {
    let tool = python_repl();
    assert_eq!(tool.name(), "python_repl");
    assert_eq!(tool.description(), PYTHON_REPL_DESCRIPTION);
    let schema = tool.tool_spec().input_schema.unwrap();
    let keys: Vec<&String> = schema["properties"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["code", "timeout"]);
    assert_eq!(schema["required"], json!(["code"]));
}

#[test]
fn resolves_both_overloads_and_applies_a_custom_name_and_description() {
    let tool = make_python_repl(
        MakePythonReplOptions::builder()
            .name("run_python")
            .description("custom")
            .build(),
    )
    .unwrap();
    assert_eq!(tool.name(), "run_python");
    assert_eq!(tool.description(), "custom");
    let bound = make_python_repl(MakePythonReplOptions {
        sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
        ..MakePythonReplOptions::default()
    })
    .unwrap();
    assert_eq!(bound.name(), "python_repl");
}

/// The sandbox kills the interpreter's whole process group on timeout, so a process the code
/// started ends with it (https://github.com/strands-agents/harness-sdk/issues/5044).
#[cfg(unix)]
#[tokio::test]
async fn kills_the_processes_the_code_started_on_timeout() {
    use crate::sandbox::process_group::test_support::{cleanup, ends, ps_available, read_pid};

    if !has_python() || !ps_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let code = format!(
        "import subprocess, time\np = subprocess.Popen(['sleep', '30'])\nopen({:?}, 'w').write(f'{{p.pid}}\\n')\ntime.sleep(30)\n",
        pidfile.display().to_string()
    );
    let tool = make_python_repl(MakePythonReplOptions {
        sandbox: Some(Arc::new(NotASandboxLocalEnvironment::new())),
        ..MakePythonReplOptions::default()
    })
    .unwrap();
    let result = run_tool(&tool, json!({"code": code, "timeout": 2}), &agent()).await;
    assert!(result.error.is_some(), "{result:?}");
    let pid = read_pid(&pidfile).await;
    let ended = ends(&pid).await;
    cleanup(&pid);
    assert!(ended, "process {pid} survived");
}
