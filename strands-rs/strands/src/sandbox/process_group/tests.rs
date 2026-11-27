#![cfg(unix)]
//! A timeout, a cancel or a dropped stream kills the whole process group, so the commands a shell
//! started end with it (https://github.com/strands-agents/harness-sdk/issues/5044).

use std::time::Duration;

use futures::StreamExt;

use super::test_support::{background_sleep, cleanup, ends, ps_available, read_pid};
use crate::cancel::{CancelHandle, CancelOptions};
use crate::error::Error;
use crate::sandbox::{ExecuteOptions, NotASandboxLocalEnvironment, Sandbox};

async fn assert_ends(pid: &str) {
    let ended = ends(pid).await;
    cleanup(pid);
    assert!(ended, "process {pid} survived");
}

#[tokio::test]
async fn kills_the_commands_a_shell_started_on_timeout() {
    if !ps_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let options = ExecuteOptions {
        timeout: Some(Duration::from_millis(500)),
        ..ExecuteOptions::default()
    };
    let result = NotASandboxLocalEnvironment::new()
        .execute(&format!("{} wait", background_sleep(&pidfile)), options)
        .await;
    assert!(matches!(result, Err(Error::SandboxTimeout(_))), "{result:?}");
    assert_ends(&read_pid(&pidfile).await).await;
}

#[tokio::test]
async fn kills_the_commands_a_shell_started_on_cancel() {
    if !ps_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let handle = CancelHandle::new();
    let options = ExecuteOptions {
        signal: Some(handle.signal()),
        ..ExecuteOptions::default()
    };
    let host = NotASandboxLocalEnvironment::new();
    let script = format!("{} wait", background_sleep(&pidfile));
    let execution = host.execute(&script, options);
    let canceller = async {
        let pid = read_pid(&pidfile).await;
        handle.cancel(CancelOptions::default());
        pid
    };
    let (result, pid) = tokio::join!(execution, canceller);
    assert!(matches!(result, Err(Error::SandboxAbort(_))), "{result:?}");
    assert_ends(&pid).await;
}

#[tokio::test]
async fn kills_the_commands_a_shell_started_when_the_stream_is_dropped() {
    if !ps_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let script = format!("{} echo started; wait", background_sleep(&pidfile));
    let mut stream = NotASandboxLocalEnvironment::new().execute_streaming(&script, ExecuteOptions::default());
    assert!(stream.next().await.unwrap().is_ok());
    let pid = read_pid(&pidfile).await;
    drop(stream);
    assert_ends(&pid).await;
}

#[tokio::test]
async fn times_out_and_kills_a_background_job_that_holds_the_pipes_after_the_shell_exits() {
    if !ps_available() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let pidfile = dir.path().join("pid");
    let script = format!("{} echo started", background_sleep(&pidfile));
    let options = ExecuteOptions {
        timeout: Some(Duration::from_millis(500)),
        ..ExecuteOptions::default()
    };
    let result = NotASandboxLocalEnvironment::new().execute(&script, options).await;
    let Err(Error::SandboxTimeout(error)) = result else {
        panic!("{result:?}");
    };
    assert_eq!(error.stdout, "started\n");
    assert_ends(&read_pid(&pidfile).await).await;
}
