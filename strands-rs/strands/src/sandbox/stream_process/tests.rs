#![cfg(unix)]

use futures::StreamExt;

use super::*;
use crate::sandbox::base::final_result;

async fn run_to_result(command: &str, args: &[&str], options: StreamProcessOptions) -> crate::Result<ExecutionResult> {
    let args = args.iter().map(ToString::to_string).collect();
    final_result(stream_process(command, args, options), "stream_process").await
}

async fn collect(command: &str, args: &[&str], options: StreamProcessOptions) -> Vec<ExecutionStreamItem> {
    let args = args.iter().map(ToString::to_string).collect();
    stream_process(command, args, options)
        .map(Result::unwrap)
        .collect()
        .await
}

#[tokio::test]
async fn runs_the_child_in_cwd() {
    let dir = tempfile::tempdir().unwrap();
    let options = StreamProcessOptions {
        cwd: Some(dir.path().to_string_lossy().into_owned()),
        ..Default::default()
    };
    let result = run_to_result("sh", &["-c", "pwd"], options).await.unwrap();
    assert_eq!(
        std::fs::canonicalize(result.stdout.trim()).unwrap(),
        std::fs::canonicalize(dir.path()).unwrap()
    );
}

#[tokio::test]
async fn replaces_the_environment_with_env() {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let options = StreamProcessOptions {
        env: Some(vec![("GREETING".into(), "hi".into()), ("PATH".into(), path)]),
        ..Default::default()
    };
    let result = run_to_result("sh", &["-c", "echo \"$GREETING:$HOME\""], options)
        .await
        .unwrap();
    assert_eq!(result.stdout, "hi:\n");
}

#[tokio::test]
async fn feeds_input_to_stdin_and_closes_it() {
    let options = StreamProcessOptions {
        input: Some("hello from stdin".to_owned()),
        ..Default::default()
    };
    let result = run_to_result("cat", &[], options).await.unwrap();
    assert_eq!((result.exit_code, result.stdout.as_str()), (0, "hello from stdin"));
}

#[tokio::test]
async fn does_not_fail_when_the_child_exits_without_reading_its_input() {
    let options = StreamProcessOptions {
        input: Some("x".repeat(1_000_000)),
        ..Default::default()
    };
    let result = run_to_result("sh", &["-c", "exit 0"], options).await.unwrap();
    assert_eq!(result.exit_code, 0);
}

#[tokio::test]
async fn leaves_stdin_open_when_no_input_is_given() {
    let options = StreamProcessOptions {
        timeout: Some(Duration::from_millis(500)),
        ..Default::default()
    };
    let error = run_to_result("cat", &[], options).await.unwrap_err();
    assert!(matches!(error, Error::SandboxTimeout(_)), "{error}");
    assert!(error.to_string().contains("timed out"));
}

#[tokio::test]
async fn decodes_a_character_split_between_two_writes() {
    // `café☕` written as two writes split inside `é` (bytes 0..4 and 4..).
    let script = r"printf 'caf\303'; sleep 0.05; printf '\251\342\230\225'";
    let items = collect("sh", &["-c", script], StreamProcessOptions::default()).await;
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
async fn fails_when_the_binary_does_not_exist_without_an_enoent_message() {
    let error = run_to_result("nonexistent_binary_xyz_12345", &[], StreamProcessOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.name(), "Error");
}

#[tokio::test]
async fn maps_an_unlisted_signal_to_129() {
    let unlisted = run_to_result("sh", &["-c", "kill -USR1 $$"], StreamProcessOptions::default())
        .await
        .unwrap();
    assert_eq!(unlisted.exit_code, 129);
}

#[tokio::test]
async fn yields_chunks_for_both_streams_before_the_result() {
    let items = collect("sh", &["-c", "echo out; echo err >&2"], StreamProcessOptions::default()).await;
    let (last, chunks) = items.split_last().unwrap();
    assert!(chunks.contains(&StreamChunk::new("out\n", StreamType::Stdout).into()));
    assert!(chunks.contains(&StreamChunk::new("err\n", StreamType::Stderr).into()));
    assert_eq!(last, &ExecutionResult::new(0, "out\n", "err\n").into());
}

#[tokio::test]
async fn kills_the_process_when_the_stream_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("survived");
    let script = format!("echo started; sleep 0.3; touch '{}'", marker.display());
    let mut stream = stream_process("sh", vec!["-c".into(), script], StreamProcessOptions::default());
    assert_eq!(
        stream.next().await.unwrap().unwrap(),
        StreamChunk::new("started\n", StreamType::Stdout).into()
    );
    drop(stream);
    let result = run_to_result("sh", &["-c", "sleep 0.8"], StreamProcessOptions::default())
        .await
        .unwrap();
    assert_eq!(result.exit_code, 0);
    assert!(!marker.exists());
}

/// A command whose backgrounded child creates `marker` after 0.5 s, unless the child is killed
/// first.
fn backgrounded_child(marker: &std::path::Path) -> String {
    format!("(sleep 0.5; touch '{}') & echo started; wait", marker.display())
}

/// A command that ignores SIGTERM and creates `marker` after 1.5 s unless it is killed.
fn ignoring_sigterm(marker: &std::path::Path) -> String {
    format!("trap '' TERM; echo started; sleep 1.5; touch '{}'", marker.display())
}

async fn was_killed(marker: &std::path::Path, wait: std::time::Duration) -> bool {
    tokio::time::sleep(wait).await;
    !marker.exists()
}

#[tokio::test]
async fn kills_the_whole_process_tree_on_abort() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let handle = crate::cancel::CancelHandle::new();
    let options = StreamProcessOptions {
        signal: Some(handle.signal()),
        ..StreamProcessOptions::default()
    };
    let mut stream = stream_process("sh", vec!["-c".into(), backgrounded_child(&marker)], options);
    let mut error = None;
    while let Some(item) = stream.next().await {
        match item {
            Ok(_) => handle.cancel(crate::cancel::CancelOptions::default()),
            Err(failure) => error = Some(failure),
        }
    }
    let Some(Error::SandboxAbort(abort)) = error else {
        panic!("expected an abort, got {error:?}");
    };
    assert_eq!((abort.stdout.as_str(), abort.stderr.as_str()), ("started\n", ""));
    assert!(was_killed(&marker, std::time::Duration::from_millis(800)).await);
}

#[tokio::test]
async fn kills_the_whole_process_tree_on_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let options = StreamProcessOptions {
        timeout: Some(std::time::Duration::from_millis(100)),
        ..StreamProcessOptions::default()
    };
    let error = run_to_result("sh", &["-c", &backgrounded_child(&marker)], options)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::SandboxTimeout(_)), "{error:?}");
    assert!(was_killed(&marker, std::time::Duration::from_millis(800)).await);
}

#[tokio::test]
async fn kills_the_whole_process_tree_when_the_consumer_stops_early() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let mut stream = stream_process(
        "sh",
        vec!["-c".into(), backgrounded_child(&marker)],
        StreamProcessOptions::default(),
    );
    stream.next().await.unwrap().unwrap();
    drop(stream);
    assert!(was_killed(&marker, std::time::Duration::from_millis(800)).await);
}

#[tokio::test]
async fn a_command_that_ignores_sigterm_is_killed_after_a_timeout() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let options = StreamProcessOptions {
        timeout: Some(std::time::Duration::from_millis(100)),
        ..StreamProcessOptions::default()
    };
    let error = run_to_result("sh", &["-c", &ignoring_sigterm(&marker)], options)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::SandboxTimeout(_)), "{error:?}");
    assert!(was_killed(&marker, std::time::Duration::from_secs(2)).await);
}

#[tokio::test]
async fn a_command_that_ignores_sigterm_is_killed_when_the_consumer_stops_early() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let mut stream = stream_process(
        "sh",
        vec!["-c".into(), ignoring_sigterm(&marker)],
        StreamProcessOptions::default(),
    );
    stream.next().await.unwrap().unwrap();
    drop(stream);
    assert!(was_killed(&marker, std::time::Duration::from_secs(2)).await);
}

#[tokio::test]
async fn does_not_spawn_when_the_signal_is_already_aborted() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("ran");
    let handle = crate::cancel::CancelHandle::new();
    handle.cancel(crate::cancel::CancelOptions::default());
    let options = StreamProcessOptions {
        signal: Some(handle.signal()),
        ..StreamProcessOptions::default()
    };
    let script = format!("touch '{}'", marker.display());
    let error = run_to_result("sh", &["-c", &script], options).await.unwrap_err();
    let Error::SandboxAbort(abort) = error else {
        panic!("expected an abort, got {error:?}");
    };
    assert_eq!((abort.stdout.as_str(), abort.stderr.as_str()), ("", ""));
    assert!(was_killed(&marker, std::time::Duration::from_millis(200)).await);
}

#[tokio::test]
async fn fails_without_signalling_when_the_binary_is_missing_and_the_call_is_aborted() {
    let handle = crate::cancel::CancelHandle::new();
    let options = StreamProcessOptions {
        signal: Some(handle.signal()),
        ..StreamProcessOptions::default()
    };
    let mut stream = stream_process("strands-definitely-not-a-binary", Vec::new(), options);
    let next = stream.next();
    handle.cancel(crate::cancel::CancelOptions::default());
    assert!(next.await.unwrap().is_err());
}
