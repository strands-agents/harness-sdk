use std::error::Error as StdError;

use tempfile::TempDir;

use super::*;
use crate::cancel::CancelHandle;
use crate::sandbox::ExecutionResult;

const WINDOWS: bool = cfg!(windows);
// Commands run in `sh` on POSIX and in PowerShell on Windows; each pair means the same thing.
const PRINT_CWD: &str = if WINDOWS { "(Get-Location).Path" } else { "pwd" };
const FAIL_WITH_STDERR: &str = if WINDOWS {
    "[Console]::Error.WriteLine('oops'); exit 3"
} else {
    "echo oops >&2; exit 3"
};
const PRINT_GREETING: &str = if WINDOWS {
    "echo $env:GREETING"
} else {
    "echo \"$GREETING\""
};
const INTERPRETER: &str = "node";
// PowerShell ends lines with \r\n.
const EOL: &str = if WINDOWS { "\r\n" } else { "\n" };

fn test_dir() -> TempDir {
    tempfile::Builder::new()
        .prefix("strands-test-not-a-sandbox")
        .tempdir()
        .unwrap()
}

fn path_in(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

fn has_program(name: &str) -> bool {
    let found = std::process::Command::new(name).arg("--version").output().is_ok();
    if !found {
        eprintln!("skipping: {name} is not installed");
    }
    found
}

async fn execute(command: &str, options: ExecuteOptions) -> Result<ExecutionResult> {
    NotASandboxLocalEnvironment::new().execute(command, options).await
}

fn greeting_env() -> Option<Vec<(String, String)>> {
    Some(vec![("GREETING".to_owned(), "hi".to_owned())])
}

// execute

#[tokio::test]
async fn runs_a_command_on_the_host() {
    let result = execute("echo hello", ExecuteOptions::default()).await.unwrap();
    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, format!("hello{EOL}"));
}

#[tokio::test]
async fn respects_the_cwd_option() {
    let dir = test_dir();
    let options = ExecuteOptions {
        cwd: Some(dir.path().to_string_lossy().into_owned()),
        ..Default::default()
    };
    let result = execute(PRINT_CWD, options).await.unwrap();
    assert_eq!(
        std::fs::canonicalize(result.stdout.trim()).unwrap(),
        std::fs::canonicalize(dir.path()).unwrap()
    );
}

#[tokio::test]
async fn reports_a_non_zero_exit_code_and_stderr_from_a_failing_command() {
    let result = execute(FAIL_WITH_STDERR, ExecuteOptions::default()).await.unwrap();
    assert_eq!(result.exit_code, 3);
    assert_eq!(result.stderr, format!("oops{EOL}"));
}

#[tokio::test]
async fn execute_applies_the_env_option() {
    let options = ExecuteOptions {
        env: greeting_env(),
        ..Default::default()
    };
    let result = execute(PRINT_GREETING, options).await.unwrap();
    assert_eq!(result.stdout, format!("hi{EOL}"));
}

// execute_code

#[tokio::test]
async fn runs_code_through_the_named_interpreter() {
    if !has_program(INTERPRETER) {
        return;
    }
    let dir = test_dir();
    let options = ExecuteOptions {
        cwd: Some(dir.path().to_string_lossy().into_owned()),
        ..Default::default()
    };
    let result = NotASandboxLocalEnvironment::new()
        .execute_code("console.log(String(2 + 2))", INTERPRETER, options)
        .await
        .unwrap();
    assert_eq!((result.exit_code, result.stdout.trim()), (0, "4"));
}

#[tokio::test]
async fn rejects_a_language_with_invalid_characters() {
    let error = NotASandboxLocalEnvironment::new()
        .execute_code("x", "../../bin/sh", ExecuteOptions::default())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("invalid characters"), "{error}");
}

#[tokio::test]
async fn execute_code_applies_the_env_option() {
    if !has_program(INTERPRETER) {
        return;
    }
    let options = ExecuteOptions {
        env: greeting_env(),
        ..Default::default()
    };
    let result = NotASandboxLocalEnvironment::new()
        .execute_code("console.log(process.env.GREETING)", INTERPRETER, options)
        .await
        .unwrap();
    assert_eq!(result.stdout.trim(), "hi");
}

#[tokio::test]
async fn reports_a_missing_interpreter_as_exit_127() {
    // `sh` says "command not found"; the direct spawn on Windows says "Language interpreter not found".
    let result = NotASandboxLocalEnvironment::new()
        .execute_code("x", "strands-definitely-not-an-interpreter", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.exit_code, 127);
    assert!(result.stderr.contains("not found"), "{}", result.stderr);
}

// execute on Windows (PowerShell): native exit codes propagate, stderr output alone is not a
// failure, a failing cmdlet is, a multi-KB command runs, and UTF-8 survives.

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn propagates_a_native_command_exit_code() {
    let result = execute(r#"cmd /c "exit 3""#, ExecuteOptions::default()).await.unwrap();
    assert_eq!(result.exit_code, 3);
}

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn does_not_treat_stderr_output_from_a_successful_native_command_as_failure() {
    let result = execute(r#"cmd /c "echo warn 1>&2""#, ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(result.stderr.contains("warn"), "{}", result.stderr);
}

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn reports_a_failing_cmdlet_as_exit_1_and_keeps_going_after_it() {
    let failed = execute(r"Get-Item C:\strands-definitely-missing", ExecuteOptions::default())
        .await
        .unwrap();
    assert_eq!(failed.exit_code, 1);
    assert!(!failed.stderr.is_empty());
    let continued = execute(
        r"Get-Item C:\strands-definitely-missing; Write-Output after",
        ExecuteOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(continued.exit_code, 0);
    assert!(continued.stdout.contains("after"), "{}", continued.stdout);
}

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn runs_an_8_kb_command() {
    let command = format!("Write-Output '{}'", "x".repeat(8_000));
    let result = execute(&command, ExecuteOptions::default()).await.unwrap();
    assert_eq!(result.stdout.trim().len(), 8_000);
}

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn round_trips_utf8_output() {
    let result = execute(r#"Write-Output "€""#, ExecuteOptions::default()).await.unwrap();
    assert!(result.stdout.contains('€'), "{}", result.stdout);
}

#[tokio::test]
#[cfg_attr(not(windows), ignore = "PowerShell only")]
async fn overrides_a_host_variable_whose_name_differs_only_by_case() {
    let probe = (OsString::from("Strands_Case_Probe"), OsString::from("host"));
    let extra = vec![("STRANDS_CASE_PROBE".to_owned(), "override".to_owned())];
    let env = env_with(std::env::vars_os().chain([probe]), Some(&extra));
    let options = StreamProcessOptions {
        env: Some(env),
        ..StreamProcessOptions::default()
    };
    let stream = stream_process(POWERSHELL, powershell_args("echo $env:STRANDS_CASE_PROBE"), options);
    let result = crate::sandbox::base::final_result(stream, "stream_process")
        .await
        .unwrap();
    assert_eq!(result.stdout.trim(), "override");
}

// execute on POSIX: stdin stays an open pipe, so a command that reads it waits rather than
// seeing end of file.

#[tokio::test]
#[cfg_attr(windows, ignore = "POSIX only")]
async fn keeps_stdin_open_when_no_input_is_given() {
    let options = ExecuteOptions {
        timeout: Some(std::time::Duration::from_millis(500)),
        ..Default::default()
    };
    let error = execute("cat", options).await.unwrap_err();
    assert!(error.to_string().contains("timed out"), "{error}");
}

#[tokio::test]
async fn kills_the_command_when_the_signal_fires() {
    let handle = CancelHandle::new();
    handle.cancel(crate::cancel::CancelOptions::default());
    let options = ExecuteOptions {
        signal: Some(handle.signal()),
        ..Default::default()
    };
    let error = execute("echo never", options).await.unwrap_err();
    assert_eq!(error.name(), "SandboxAbortError");
}

// read/write (native fs)

#[tokio::test]
async fn text_file_roundtrip_via_absolute_path() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let file = path_in(&dir, "note.txt");
    sandbox.write_text(&file, "hello host").await.unwrap();
    assert_eq!(sandbox.read_text(&file).await.unwrap(), "hello host");
}

#[tokio::test]
async fn binary_roundtrip_preserves_all_byte_values() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let file = path_in(&dir, "all-bytes.bin");
    let bytes: Vec<u8> = (0..=255).collect();
    sandbox.write_file(&file, &bytes).await.unwrap();
    assert_eq!(sandbox.read_file(&file).await.unwrap(), bytes);
}

#[tokio::test]
async fn creates_missing_parent_directories_on_write() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let file = path_in(&dir, "deep/nested/file.txt");
    sandbox.write_text(&file, "deep").await.unwrap();
    assert_eq!(sandbox.read_text(&file).await.unwrap(), "deep");
}

#[tokio::test]
async fn keeps_the_original_fs_error_as_the_cause_of_a_typed_read_error() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let cases = [
        ("nope.txt", "SandboxPathNotFoundError", ErrorKind::NotFound),
        ("", "SandboxIsADirectoryError", ErrorKind::IsADirectory),
    ];
    for (name, error_name, kind) in cases {
        let error = sandbox.read_file(&path_in(&dir, name)).await.unwrap_err();
        assert_eq!(error.name(), error_name);
        let cause = error.source().and_then(|cause| cause.downcast_ref::<std::io::Error>());
        let Some(cause) = cause else {
            panic!("{error_name} has no io cause");
        };
        // Windows reports a directory opened for reading as access denied.
        if !WINDOWS || kind == ErrorKind::NotFound {
            assert_eq!(cause.kind(), kind, "{error_name}");
        }
    }
}

#[tokio::test]
#[cfg_attr(windows, ignore = "POSIX only")]
async fn treats_a_backslash_in_a_filename_as_a_literal_character() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let file = path_in(&dir, r"weird\name.txt");
    sandbox.write_text(&file, "ok").await.unwrap();
    assert_eq!(sandbox.read_text(&file).await.unwrap(), "ok");
    let entries = sandbox.list_files(&dir.path().to_string_lossy()).await.unwrap();
    assert!(
        entries.iter().any(|entry| entry.name == r"weird\name.txt"),
        "{entries:?}"
    );
}

// remove_file

#[tokio::test]
async fn removes_a_file() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    let file = path_in(&dir, "delete-me.txt");
    sandbox.write_text(&file, "bye").await.unwrap();
    sandbox.remove_file(&file).await.unwrap();
    assert!(sandbox.read_file(&file).await.is_err());
}

#[tokio::test]
async fn throws_on_a_nonexistent_file() {
    let dir = test_dir();
    let result = NotASandboxLocalEnvironment::new()
        .remove_file(&path_in(&dir, "nope.txt"))
        .await;
    assert!(result.is_err());
}

// list_files

#[tokio::test]
async fn returns_entries_sorted_by_name_with_is_dir_and_size_metadata() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    sandbox.write_text(&path_in(&dir, "c.txt"), "cc").await.unwrap();
    sandbox.write_text(&path_in(&dir, "a.txt"), "a").await.unwrap();
    sandbox.write_text(&path_in(&dir, "b.txt"), "bbb").await.unwrap();
    std::fs::create_dir(dir.path().join("sub")).unwrap();

    let files = sandbox.list_files(&dir.path().to_string_lossy()).await.unwrap();
    let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
    assert_eq!(names, ["a.txt", "b.txt", "c.txt", "sub"]);
    assert_eq!(files[0], FileInfo::new("a.txt").with_is_dir(false).with_size(1));
    assert_eq!(files[3].is_dir, Some(true));
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_on_a_nonexistent_directory() {
    let dir = test_dir();
    let error = NotASandboxLocalEnvironment::new()
        .list_files(&path_in(&dir, "no-such-dir"))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::SandboxPathNotFound(_)), "{error}");
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_when_a_path_component_is_a_file() {
    let dir = test_dir();
    let sandbox = NotASandboxLocalEnvironment::new();
    sandbox.write_text(&path_in(&dir, "file.txt"), "x").await.unwrap();
    let nested = dir.path().join("file.txt").join("nested");
    let error = sandbox.list_files(&nested.to_string_lossy()).await.unwrap_err();
    assert!(matches!(error, Error::SandboxPathNotFound(_)), "{error}");
}

#[test]
fn sorts_names_case_insensitively_with_lowercase_first() {
    let mut names = vec!["b", "B", "a", "C", "A"];
    names.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(names, ["a", "A", "b", "B", "C"]);
}

// resolve_path (relative vs absolute)

#[tokio::test]
async fn writes_absolute_paths_as_is() {
    let dir = test_dir();
    let file = path_in(&dir, "abs.txt");
    NotASandboxLocalEnvironment::new()
        .write_text(&file, "absolute")
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "absolute");
}

#[tokio::test]
async fn resolves_relative_paths_against_the_current_directory() {
    let name = format!("strands-not-a-sandbox-rel-probe-{}.txt", uuid::Uuid::new_v4());
    let absolute = std::env::current_dir().unwrap().join(&name);
    NotASandboxLocalEnvironment::new()
        .write_text(&name, "relative")
        .await
        .unwrap();
    let written = std::fs::read_to_string(&absolute);
    std::fs::remove_file(&absolute).unwrap();
    assert_eq!(written.unwrap(), "relative");
}

// Windows command encoding, checked on every platform.

#[test]
fn encodes_utf16le_as_base64() {
    assert_eq!(encode_utf16le_base64("ab"), "YQBiAA==");
    assert_eq!(encode_utf16le_base64("€"), "rCA=");
    assert_eq!(encode_utf16le_base64("🚀"), "PdiA3g==");
}

#[test]
fn wraps_the_command_in_a_utf8_script_that_mirrors_sh_exit_codes() {
    let args = powershell_args("Write-Output 'hi'");
    assert_eq!(&args[..3], ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    let bytes = STANDARD.decode(&args[3]).unwrap();
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    assert_eq!(
        String::from_utf16(&units).unwrap(),
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\
         $OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n\
         Write-Output 'hi'\n\
         $ok = $?\n\
         if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }"
    );
}

#[test]
fn applies_extra_env_over_host_names_that_differ_only_by_case() {
    let host = [
        (OsString::from("Path"), OsString::from("C:\\host")),
        (OsString::from("HOME"), OsString::from("C:\\Users\\me")),
    ];
    let extra = vec![("PATH".to_owned(), "C:\\override".to_owned())];
    assert_eq!(
        env_with(host.clone(), Some(&extra)),
        [
            (OsString::from("HOME"), OsString::from("C:\\Users\\me")),
            (OsString::from("PATH"), OsString::from("C:\\override")),
        ]
    );
    assert_eq!(env_with(host.clone(), None), host);
}

/// Hostile env values, env keys, working directories and languages are passed as data and
/// never evaluated by the shell.
#[cfg(unix)]
#[tokio::test]
async fn never_evaluates_hostile_env_values_keys_cwd_or_language() {
    let dir = test_dir();
    let marker = |name: &str| dir.path().join(name);
    let quote_break = format!("'; touch '{}'; echo '", marker("value").display());
    let substitution = format!(
        "$(touch '{}')`touch '{}'`\n;id",
        marker("subst").display(),
        marker("tick").display()
    );
    let env = vec![
        ("FOO".to_owned(), quote_break.clone()),
        ("BAR".to_owned(), substitution.clone()),
    ];
    let options = ExecuteOptions {
        env: Some(env),
        ..ExecuteOptions::default()
    };
    let result = execute("printf '%s|%s' \"$FOO\" \"$BAR\"", options).await.unwrap();
    assert_eq!(result.stdout, format!("{quote_break}|{substitution}"));

    let bad_key = vec![(format!("A;touch '{}'", marker("key").display()), "x".to_owned())];
    let options = ExecuteOptions {
        env: Some(bad_key),
        ..ExecuteOptions::default()
    };
    assert!(execute("true", options).await.is_err());

    let cwd = dir
        .path()
        .join(format!("it's $(touch '{}') dir", marker("cwd").display()));
    std::fs::create_dir_all(&cwd).unwrap();
    let options = ExecuteOptions {
        cwd: Some(cwd.to_string_lossy().into_owned()),
        ..ExecuteOptions::default()
    };
    let result = execute("pwd", options).await.unwrap();
    assert_eq!(
        std::fs::canonicalize(result.stdout.trim()).unwrap(),
        std::fs::canonicalize(&cwd).unwrap()
    );

    let language = format!("sh;touch '{}'", marker("lang").display());
    let host = NotASandboxLocalEnvironment::new();
    assert!(
        host.execute_code("echo ran", &language, ExecuteOptions::default())
            .await
            .is_err()
    );

    for name in ["value", "subst", "tick", "key", "cwd", "lang"] {
        assert!(!marker(name).exists(), "{name} was evaluated");
    }
}
