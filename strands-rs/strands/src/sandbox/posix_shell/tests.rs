#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use futures::StreamExt;
use tempfile::TempDir;

use super::*;
use crate::cancel::{CancelHandle, CancelOptions};
use crate::sandbox::stream_process::{StreamProcessOptions, stream_process};
use crate::sandbox::test_sandbox::TestSandbox;
use crate::sandbox::{ExecutionResult, ExecutionStreamItem, StreamChunk, StreamType};

struct Fixture {
    dir: TempDir,
    sandbox: TestSandbox,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("strands-test-shell-sandbox")
            .tempdir()
            .unwrap();
        let sandbox = TestSandbox::new(dir.path().to_string_lossy());
        Self { dir, sandbox }
    }

    fn path(&self, name: &str) -> std::path::PathBuf {
        self.dir.path().join(name)
    }

    fn sandbox(&self) -> &dyn Sandbox {
        &self.sandbox
    }
}

fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn with_env(pairs: &[(&str, &str)]) -> ExecuteOptions {
    ExecuteOptions {
        env: Some(env(pairs)),
        ..Default::default()
    }
}

fn with_timeout(seconds: f64) -> ExecuteOptions {
    ExecuteOptions {
        timeout: Some(Duration::from_secs_f64(seconds)),
        ..Default::default()
    }
}

fn has_program(name: &str) -> bool {
    let found = std::process::Command::new(name).arg("--version").output().is_ok();
    if !found {
        eprintln!("skipping: {name} is not installed");
    }
    found
}

fn set_mode(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

/// Whether this process can read a file with no read permission (root can).
fn reads_without_permission(dir: &Path) -> bool {
    let probe = dir.join("probe");
    std::fs::write(&probe, "x").unwrap();
    set_mode(&probe, 0o200);
    let readable = std::fs::read(&probe).is_ok();
    std::fs::remove_file(&probe).unwrap();
    if readable {
        eprintln!("skipping: running with privileges that bypass file permissions");
    }
    readable
}

async fn run(sandbox: &dyn Sandbox, command: &str) -> ExecutionResult {
    sandbox.execute(command, ExecuteOptions::default()).await.unwrap()
}

// execute (via shell commands)

#[tokio::test]
async fn runs_a_command() {
    let fixture = Fixture::new();
    let result = run(fixture.sandbox(), "echo hello").await;
    assert_eq!((result.exit_code, result.stdout.as_str()), (0, "hello\n"));
}

#[tokio::test]
async fn runs_in_working_dir() {
    let fixture = Fixture::new();
    let result = run(fixture.sandbox(), "pwd").await;
    assert!(
        result.stdout.trim().contains("strands-test-shell-sandbox"),
        "{}",
        result.stdout
    );
}

#[tokio::test]
async fn respects_cwd_option() {
    let fixture = Fixture::new();
    let options = ExecuteOptions {
        cwd: Some("/tmp".to_owned()),
        ..Default::default()
    };
    let result = fixture.sandbox().execute("pwd", options).await.unwrap();
    assert!(result.stdout.trim().ends_with("/tmp"), "{}", result.stdout);
}

// env option (via build_shell_env_prefix)

#[tokio::test]
async fn passes_env_vars_to_the_command() {
    let fixture = Fixture::new();
    let options = with_env(&[("FOO", "hello"), ("BAR", "world")]);
    let result = fixture.sandbox().execute("printenv FOO", options).await.unwrap();
    assert_eq!(result.stdout.trim(), "hello");
}

#[tokio::test]
async fn shell_quotes_env_values_so_they_are_not_evaluated() {
    let fixture = Fixture::new();
    let options = with_env(&[("FOO", "$(whoami)")]);
    let result = fixture.sandbox().execute("printenv FOO", options).await.unwrap();
    assert_eq!(result.stdout.trim(), "$(whoami)");
}

#[tokio::test]
async fn rejects_invalid_env_var_names() {
    let fixture = Fixture::new();
    let error = fixture
        .sandbox()
        .execute("echo hi", with_env(&[("BAD-KEY", "v")]))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "Invalid environment variable name: BAD-KEY");
}

// build_shell_env_prefix

#[test]
fn returns_an_empty_string_when_there_are_no_env_vars() {
    assert_eq!(build_shell_env_prefix(None).unwrap(), "");
    assert_eq!(build_shell_env_prefix(Some(&[][..])).unwrap(), "");
}

#[test]
fn uses_export_so_vars_are_inherited_across_a_pipeline_with_a_fail_fast_and_separator() {
    let prefix = build_shell_env_prefix(Some(&env(&[("FOO", "bar"), ("BAZ", "qux")]))).unwrap();
    assert_eq!(prefix, "export FOO='bar' BAZ='qux' && ");
}

#[test]
fn shell_quotes_values_so_they_are_not_evaluated() {
    let prefix = build_shell_env_prefix(Some(&env(&[("FOO", "$(whoami)")]))).unwrap();
    assert_eq!(prefix, "export FOO='$(whoami)' && ");
}

#[test]
fn throws_on_invalid_env_var_names() {
    let error = build_shell_env_prefix(Some(&env(&[("BAD-KEY", "v")]))).unwrap_err();
    assert!(error.to_string().starts_with("Invalid environment variable name"));
    assert!(validate_env_keys(&env(&[("GOOD", "v"), ("1BAD", "v")])).is_err());
}

// execute_code (via shell quoting)

#[tokio::test]
async fn runs_python_code_through_shell() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let result = fixture
        .sandbox()
        .execute_code("print(2 + 2)", "python3", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!((result.exit_code, result.stdout.as_str()), (0, "4\n"));
}

#[tokio::test]
async fn handles_code_with_special_characters() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let result = fixture
        .sandbox()
        .execute_code(r#"print('hello "world"')"#, "python3", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.stdout, "hello \"world\"\n");
}

#[tokio::test]
async fn handles_code_with_single_quotes() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let result = fixture
        .sandbox()
        .execute_code(r#"print("it's working")"#, "python3", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.stdout, "it's working\n");
}

#[tokio::test]
async fn passes_env_vars_through_to_the_interpreter() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let code = r#"import os; print(os.environ["FOO"])"#;
    let result = fixture
        .sandbox()
        .execute_code(code, "python3", with_env(&[("FOO", "from-env")]))
        .await
        .unwrap();
    assert_eq!((result.exit_code, result.stdout.trim()), (0, "from-env"));
}

#[tokio::test]
async fn passes_env_values_to_the_interpreter_literally_without_shell_evaluation() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let code = r#"import os; print(os.environ["FOO"])"#;
    let result = fixture
        .sandbox()
        .execute_code(code, "python3", with_env(&[("FOO", "$(whoami)")]))
        .await
        .unwrap();
    assert_eq!((result.exit_code, result.stdout.trim()), (0, "$(whoami)"));
}

// language validation

async fn language_error(language: &str) -> String {
    let fixture = Fixture::new();
    let error = fixture
        .sandbox()
        .execute_code("x", language, ExecuteOptions::default())
        .await
        .unwrap_err();
    error.to_string()
}

#[tokio::test]
async fn rejects_path_traversal() {
    assert_eq!(
        language_error("../../../bin/sh").await,
        "language parameter contains invalid characters: ../../../bin/sh"
    );
}

#[tokio::test]
async fn rejects_shell_metacharacters() {
    assert!(language_error("python;rm -rf /").await.contains("invalid characters"));
}

#[tokio::test]
async fn rejects_spaces() {
    assert!(language_error("python -c").await.contains("invalid characters"));
}

#[tokio::test]
async fn allows_valid_interpreters() {
    let fixture = Fixture::new();
    if !has_program("python3") {
        return;
    }
    let result = fixture
        .sandbox()
        .execute_code(r#"print("safe")"#, "python3", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.exit_code, 0);
}

#[tokio::test]
async fn allows_dots_and_hyphens() {
    let fixture = Fixture::new();
    let result = fixture
        .sandbox()
        .execute_code("x", "fake-lang.99", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.exit_code, 127);
}

// read/write (via base64 encoding over shell)

#[tokio::test]
async fn text_file_roundtrip() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text("test.txt", "hello shell").await.unwrap();
    assert_eq!(sandbox.read_text("test.txt").await.unwrap(), "hello shell");
}

#[tokio::test]
async fn binary_file_roundtrip() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let bytes = [0, 1, 2, 127, 128, 254, 255];
    sandbox.write_file("binary.bin", &bytes).await.unwrap();
    assert_eq!(sandbox.read_file("binary.bin").await.unwrap(), bytes);
}

#[tokio::test]
async fn all_256_byte_values_roundtrip() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let bytes: Vec<u8> = (0..=255).collect();
    sandbox.write_file("all-bytes.bin", &bytes).await.unwrap();
    assert_eq!(sandbox.read_file("all-bytes.bin").await.unwrap(), bytes);
}

#[tokio::test]
async fn creates_parent_directories() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text("deep/nested/file.txt", "deep").await.unwrap();
    assert_eq!(sandbox.read_text("deep/nested/file.txt").await.unwrap(), "deep");
}

#[tokio::test]
async fn handles_unicode_content() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let content = "日本語 🚀 émojis";
    sandbox.write_text("unicode.txt", content).await.unwrap();
    assert_eq!(sandbox.read_text("unicode.txt").await.unwrap(), content);
}

#[tokio::test]
async fn handles_shell_metacharacters_in_content() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let content = "$(rm -rf /) `whoami` && || $HOME";
    sandbox.write_text("meta.txt", content).await.unwrap();
    assert_eq!(sandbox.read_text("meta.txt").await.unwrap(), content);
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_on_nonexistent_file() {
    let fixture = Fixture::new();
    let error = fixture.sandbox().read_file("nope.txt").await.unwrap_err();
    let Error::SandboxPathNotFound(not_found) = &error else {
        panic!("expected a missing path: {error}");
    };
    assert_eq!(
        (error.to_string().as_str(), not_found.code()),
        ("Path not found: nope.txt", "ENOENT")
    );
}

#[tokio::test]
async fn throws_sandbox_is_a_directory_error_not_sandbox_path_not_found_error_on_a_directory() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.path("subdir")).unwrap();
    let error = fixture.sandbox().read_file("subdir").await.unwrap_err();
    assert!(
        matches!(&error, Error::SandboxIsADirectory(e) if e.path == "subdir"),
        "{error}"
    );
}

#[tokio::test]
async fn throws_sandbox_permission_error_not_sandbox_path_not_found_error_for_a_file_under_an_unsearchable_directory() {
    let fixture = Fixture::new();
    if reads_without_permission(fixture.dir.path()) {
        return;
    }
    std::fs::create_dir(fixture.path("locked")).unwrap();
    std::fs::write(fixture.path("locked/secret.txt"), "x").unwrap();
    set_mode(&fixture.path("locked"), 0o600);
    let error = fixture.sandbox().read_file("locked/secret.txt").await.unwrap_err();
    set_mode(&fixture.path("locked"), 0o700);
    assert!(
        matches!(&error, Error::SandboxPermission(e) if e.path == "locked/secret.txt"),
        "{error}"
    );
}

#[tokio::test]
async fn throws_sandbox_permission_error_for_a_file_under_an_unsearchable_ancestor() {
    let fixture = Fixture::new();
    if reads_without_permission(fixture.dir.path()) {
        return;
    }
    std::fs::create_dir_all(fixture.path("locked/inner")).unwrap();
    std::fs::write(fixture.path("locked/inner/secret.txt"), "x").unwrap();
    set_mode(&fixture.path("locked"), 0o600);
    let error = fixture
        .sandbox()
        .read_file("locked/inner/secret.txt")
        .await
        .unwrap_err();
    set_mode(&fixture.path("locked"), 0o700);
    assert_eq!(error.to_string(), "Permission denied: locked/inner/secret.txt");
    assert_eq!(error.name(), "SandboxPermissionError");
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_when_an_ancestor_is_missing_or_a_file() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path("file.txt"), "x").unwrap();
    let absolute = fixture.path("missing/b.txt").to_string_lossy().into_owned();
    for path in ["missing/a/b.txt", "file.txt/b.txt", absolute.as_str()] {
        let error = fixture.sandbox().read_file(path).await.unwrap_err();
        assert!(matches!(error, Error::SandboxPathNotFound(_)), "{path}: {error}");
    }
}

#[tokio::test]
async fn throws_sandbox_permission_error_for_an_unreadable_file() {
    let fixture = Fixture::new();
    if reads_without_permission(fixture.dir.path()) {
        return;
    }
    std::fs::write(fixture.path("secret.txt"), "x").unwrap();
    set_mode(&fixture.path("secret.txt"), 0o200);
    let error = fixture.sandbox().read_file("secret.txt").await.unwrap_err();
    set_mode(&fixture.path("secret.txt"), 0o600);
    assert!(
        matches!(&error, Error::SandboxPermission(e) if e.path == "secret.txt"),
        "{error}"
    );
}

#[tokio::test]
async fn does_not_report_a_failed_cd_as_a_missing_file() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path("real.txt"), "x").unwrap();
    let bad_cwd = TestSandbox::new(fixture.path("missing-workdir").to_string_lossy());
    let real = fixture.path("real.txt").to_string_lossy().into_owned();
    let error = Sandbox::read_file(&bad_cwd, &real).await.unwrap_err();
    assert!(!matches!(error, Error::SandboxPathNotFound(_)), "{error}");
}

#[tokio::test]
async fn treats_a_backslash_in_a_filename_as_a_literal_character() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text(r"weird\name.txt", "ok").await.unwrap();
    assert_eq!(sandbox.read_text(r"weird\name.txt").await.unwrap(), "ok");
    let entries = sandbox.list_files(".").await.unwrap();
    assert!(
        entries.iter().any(|entry| entry.name == r"weird\name.txt"),
        "{entries:?}"
    );
}

// remove

#[tokio::test]
async fn removes_a_file() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text("delete-me.txt", "bye").await.unwrap();
    sandbox.remove_file("delete-me.txt").await.unwrap();
    assert!(sandbox.read_file("delete-me.txt").await.is_err());
}

#[tokio::test]
async fn throws_on_nonexistent_file() {
    let fixture = Fixture::new();
    assert!(fixture.sandbox().remove_file("nope.txt").await.is_err());
}

// list (via ls -1ap parsing)

#[tokio::test]
async fn lists_directory_contents() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text("a.txt", "a").await.unwrap();
    sandbox.write_text("b.txt", "b").await.unwrap();
    let names: Vec<String> = sandbox
        .list_files(".")
        .await
        .unwrap()
        .into_iter()
        .map(|file| file.name)
        .collect();
    assert!(
        names.contains(&"a.txt".to_owned()) && names.contains(&"b.txt".to_owned()),
        "{names:?}"
    );
}

#[tokio::test]
async fn identifies_directories() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    run(sandbox, "mkdir -p subdir").await;
    let files = sandbox.list_files(".").await.unwrap();
    let subdir = files.iter().find(|file| file.name == "subdir").unwrap();
    assert_eq!((subdir.is_dir, subdir.size), (Some(true), None));
}

#[tokio::test]
async fn excludes_dot_and_dot_dot_entries() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    sandbox.write_text("file.txt", "").await.unwrap();
    let files = sandbox.list_files(".").await.unwrap();
    assert!(
        files.iter().all(|file| file.name != "." && file.name != ".."),
        "{files:?}"
    );
    assert!(files.iter().any(|file| file.name == "file.txt"));
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_on_nonexistent_directory() {
    let fixture = Fixture::new();
    let error = fixture
        .sandbox()
        .list_files("/tmp/nonexistent-dir-xyz")
        .await
        .unwrap_err();
    assert!(matches!(error, Error::SandboxPathNotFound(_)), "{error}");
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_when_path_is_a_file_not_a_directory() {
    let fixture = Fixture::new();
    fixture.sandbox().write_text("not-a-dir.txt", "hello").await.unwrap();
    let error = fixture.sandbox().list_files("not-a-dir.txt").await.unwrap_err();
    assert!(matches!(error, Error::SandboxPathNotFound(_)), "{error}");
}

#[test]
fn parses_ls_lines_into_entries() {
    assert_eq!(parse_ls_line("./"), None);
    assert_eq!(parse_ls_line("../"), None);
    assert_eq!(parse_ls_line(""), None);
    assert_eq!(parse_ls_line("/"), None);
    assert_eq!(parse_ls_line("dir/\r"), Some(FileInfo::new("dir").with_is_dir(true)));
    assert_eq!(parse_ls_line("a.txt"), Some(FileInfo::new("a.txt").with_is_dir(false)));
}

// shell_quote

#[tokio::test]
async fn handles_paths_with_spaces() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    run(sandbox, r#"mkdir -p "with spaces""#).await;
    sandbox.write_text("with spaces/file.txt", "spaced").await.unwrap();
    assert_eq!(sandbox.read_text("with spaces/file.txt").await.unwrap(), "spaced");
}

#[tokio::test]
async fn handles_paths_with_single_quotes() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    run(sandbox, r#"mkdir -p "it's""#).await;
    sandbox.write_text("it's/file.txt", "quoted").await.unwrap();
    assert_eq!(sandbox.read_text("it's/file.txt").await.unwrap(), "quoted");
}

// timeout

#[tokio::test]
async fn kills_process_on_timeout() {
    let fixture = Fixture::new();
    let start = Instant::now();
    let error = fixture
        .sandbox()
        .execute("sleep 60", with_timeout(0.2))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn reports_the_output_captured_before_the_kill_on_timeout() {
    let fixture = Fixture::new();
    let error = fixture
        .sandbox()
        .execute("echo partial; echo warn >&2; sleep 5", with_timeout(1.0))
        .await
        .unwrap_err();
    let Error::SandboxTimeout(timeout) = error else {
        panic!("expected a timeout: {error}");
    };
    assert_eq!(
        (timeout.stdout.as_str(), timeout.stderr.as_str()),
        ("partial\n", "warn\n")
    );
    assert_eq!(timeout.to_string(), "Execution timed out after 1 seconds");
}

#[tokio::test]
async fn does_not_timeout_fast_commands() {
    let fixture = Fixture::new();
    let result = fixture.sandbox().execute("echo fast", with_timeout(5.0)).await.unwrap();
    assert_eq!((result.exit_code, result.stdout.as_str()), (0, "fast\n"));
}

// abort signal

#[tokio::test]
async fn kills_process_when_signal_is_aborted() {
    let fixture = Fixture::new();
    let handle = CancelHandle::new();
    let options = ExecuteOptions {
        signal: Some(handle.signal()),
        ..Default::default()
    };
    let mut stream = fixture.sandbox().execute_streaming("echo started; sleep 60", options);
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        StreamChunk::new("started\n", StreamType::Stdout).into()
    );
    handle.cancel(CancelOptions::default());
    let error = stream.next().await.unwrap().unwrap_err();
    assert_eq!(error.to_string(), "Execution aborted");
    assert!(stream.next().await.is_none());
}

#[tokio::test]
async fn rejects_immediately_if_signal_is_already_aborted() {
    let fixture = Fixture::new();
    let handle = CancelHandle::new();
    handle.cancel(CancelOptions::default());
    let options = ExecuteOptions {
        signal: Some(handle.signal()),
        ..Default::default()
    };
    let error = fixture.sandbox().execute("sleep 60", options).await.unwrap_err();
    assert!(matches!(error, Error::SandboxAbort(_)), "{error}");
}

// concurrent execution

#[tokio::test]
async fn handles_multiple_concurrent_commands() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let (one, two, three) = tokio::join!(
        run(sandbox, "echo one"),
        run(sandbox, "echo two"),
        run(sandbox, "echo three")
    );
    let mut outputs = [one.stdout, two.stdout, three.stdout];
    outputs.sort();
    assert_eq!(outputs, ["one\n", "three\n", "two\n"]);
}

#[tokio::test]
async fn handles_concurrent_file_writes_to_different_files() {
    let fixture = Fixture::new();
    let sandbox = fixture.sandbox();
    let (a, b, c) = tokio::join!(
        sandbox.write_text("a.txt", "aaa"),
        sandbox.write_text("b.txt", "bbb"),
        sandbox.write_text("c.txt", "ccc")
    );
    a.unwrap();
    b.unwrap();
    c.unwrap();
    let (a, b, c) = tokio::join!(
        sandbox.read_text("a.txt"),
        sandbox.read_text("b.txt"),
        sandbox.read_text("c.txt")
    );
    assert_eq!(
        (a.unwrap(), b.unwrap(), c.unwrap()),
        ("aaa".into(), "bbb".into(), "ccc".into())
    );
}

// streaming

#[tokio::test]
async fn yields_stream_chunks_then_execution_result() {
    let fixture = Fixture::new();
    let items: Vec<ExecutionStreamItem> = fixture
        .sandbox()
        .execute_streaming("echo hello", ExecuteOptions::default())
        .map(Result::unwrap)
        .collect()
        .await;
    let chunks = items
        .iter()
        .filter(|item| matches!(item, ExecutionStreamItem::StreamChunk(_)))
        .count();
    let results = items
        .iter()
        .filter(|item| matches!(item, ExecutionStreamItem::ExecutionResult(_)))
        .count();
    assert!(chunks > 0);
    assert_eq!(results, 1);
    assert!(matches!(items.last(), Some(ExecutionStreamItem::ExecutionResult(_))));
}

// stream_process edge cases

#[tokio::test]
async fn returns_exit_code_127_when_command_is_not_found() {
    let fixture = Fixture::new();
    let result = run(fixture.sandbox(), "nonexistent_binary_xyz_12345").await;
    assert_eq!(result.exit_code, 127);
    assert!(result.stderr.contains("not found"), "{}", result.stderr);
}

#[tokio::test]
async fn maps_signal_termination_to_128_plus_signal_number() {
    let fixture = Fixture::new();
    let result = run(fixture.sandbox(), "sh -c 'kill -9 $$'").await;
    assert_eq!(result.exit_code, 137);
}

#[tokio::test]
async fn decodes_multibyte_utf8_sequences_split_across_chunk_boundaries() {
    if !has_program("node") {
        return;
    }
    let script = "const b=Buffer.from('café☕','utf8');\
                  process.stdout.write(b.subarray(0,4));\
                  setTimeout(()=>process.stdout.write(b.subarray(4)),20)";
    let items: Vec<ExecutionStreamItem> = stream_process(
        "node",
        vec!["-e".to_owned(), script.to_owned()],
        StreamProcessOptions::default(),
    )
    .map(Result::unwrap)
    .collect()
    .await;
    let streamed: String = items
        .iter()
        .filter_map(|item| match item {
            ExecutionStreamItem::StreamChunk(chunk) if chunk.stream_type == StreamType::Stdout => {
                Some(chunk.data.as_str())
            }
            _ => None,
        })
        .collect();
    assert_eq!(streamed, "café☕");
    let Some(ExecutionStreamItem::ExecutionResult(result)) = items.last() else {
        panic!("no result: {items:?}");
    };
    assert_eq!(result.stdout, "café☕");
}

#[tokio::test]
async fn returns_enoent_message_when_spawned_binary_does_not_exist() {
    let options = StreamProcessOptions {
        enoent_message: Some("binary not found".to_owned()),
        ..Default::default()
    };
    let items: Vec<ExecutionStreamItem> = stream_process("nonexistent_binary_xyz_12345", Vec::new(), options)
        .map(Result::unwrap)
        .collect()
        .await;
    assert_eq!(items, [ExecutionResult::new(127, "", "binary not found").into()]);
}
