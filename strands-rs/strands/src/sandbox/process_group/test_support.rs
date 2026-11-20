#![cfg(unix)]
//! Checks, by `ps`, that the processes a command started have ended. Process exit and reaping
//! happen in the OS, so these wait in real time, bounded by a deadline.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

const POLLS: usize = 100;
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Whether `ps` works here; the process tests skip when it does not.
pub(crate) fn ps_available() -> bool {
    let available = Command::new("ps")
        .args(["-o", "stat=", "-p", &std::process::id().to_string()])
        .output()
        .is_ok_and(|output| output.status.success());
    if !available {
        eprintln!("skipping: ps is unavailable");
    }
    available
}

/// Shell script text that starts `sleep 30` in the background, as a grandchild of the spawned
/// shell, with its pid written to `pidfile`. Ends in `&`, so a command can follow.
pub(crate) fn background_sleep(pidfile: &Path) -> String {
    format!("sh -c 'echo $$ > \"$0\"; exec sleep 30' '{}' &", pidfile.display())
}

/// The pid written to `pidfile`, once it is there.
pub(crate) async fn read_pid(pidfile: &Path) -> String {
    for _ in 0..POLLS {
        let pid = std::fs::read_to_string(pidfile).unwrap_or_default();
        if pid.ends_with('\n') {
            return pid.trim().to_owned();
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    panic!("no pid in {}", pidfile.display());
}

fn state(pid: &str) -> String {
    let output = Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Whether `pid` ends (is gone or a zombie) before the deadline.
pub(crate) async fn ends(pid: &str) -> bool {
    for _ in 0..POLLS {
        let state = state(pid);
        if state.is_empty() || state.starts_with('Z') {
            return true;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    false
}

/// Kills `pid` so a failing test leaves nothing behind.
pub(crate) fn cleanup(pid: &str) {
    let _ = Command::new("kill").args(["-9", pid]).status();
}
