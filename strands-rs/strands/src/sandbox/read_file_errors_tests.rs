//! Both backends must fail with the same typed errors, whichever sandbox is configured.

#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::sandbox::test_sandbox::TestSandbox;
use crate::sandbox::{NotASandboxLocalEnvironment, Sandbox};

fn setup() -> (tempfile::TempDir, String) {
    let dir = tempfile::Builder::new()
        .prefix("strands-test-read-file-errors")
        .tempdir()
        .unwrap();
    std::fs::write(dir.path().join("file.txt"), "x").unwrap();
    let path = dir.path().to_string_lossy().into_owned();
    (dir, path)
}

fn backends(dir: &str) -> [(&'static str, Box<dyn Sandbox>); 2] {
    [
        (
            "NotASandboxLocalEnvironment",
            Box::new(NotASandboxLocalEnvironment::new()),
        ),
        ("PosixShellSandbox", Box::new(TestSandbox::new(dir))),
    ]
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
    set_mode(&probe, 0o600);
    if readable {
        eprintln!("skipping: running with privileges that bypass file permissions");
    }
    readable
}

/// The `(backend, error name, message)` each backend fails with.
async fn read_errors(dir: &str, target: &str) -> Vec<(&'static str, &'static str, String)> {
    let mut errors = Vec::new();
    for (backend, sandbox) in backends(dir) {
        let error = sandbox.read_file(target).await.unwrap_err();
        errors.push((backend, error.name(), error.to_string()));
    }
    errors
}

fn expected(name: &'static str, message: &str) -> Vec<(&'static str, &'static str, String)> {
    ["NotASandboxLocalEnvironment", "PosixShellSandbox"]
        .into_iter()
        .map(|backend| (backend, name, message.to_owned()))
        .collect()
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_for_a_missing_file() {
    let (_dir, dir) = setup();
    let target = format!("{dir}/nope.txt");
    let errors = read_errors(&dir, &target).await;
    assert_eq!(
        errors,
        expected("SandboxPathNotFoundError", &format!("Path not found: {target}"))
    );
}

#[tokio::test]
async fn throws_sandbox_path_not_found_error_when_an_ancestor_is_a_file() {
    let (_dir, dir) = setup();
    let target = format!("{dir}/file.txt/child.txt");
    let errors = read_errors(&dir, &target).await;
    assert_eq!(
        errors,
        expected("SandboxPathNotFoundError", &format!("Path not found: {target}"))
    );
}

#[tokio::test]
async fn throws_sandbox_is_a_directory_error_for_a_directory() {
    let (_dir, dir) = setup();
    let errors = read_errors(&dir, &dir).await;
    assert_eq!(
        errors,
        expected("SandboxIsADirectoryError", &format!("Is a directory: {dir}"))
    );
}

#[tokio::test]
async fn throws_sandbox_permission_error_for_an_unreadable_file() {
    let (temp, dir) = setup();
    if reads_without_permission(temp.path()) {
        return;
    }
    let target = format!("{dir}/file.txt");
    set_mode(Path::new(&target), 0o200);
    let errors = read_errors(&dir, &target).await;
    assert_eq!(
        errors,
        expected("SandboxPermissionError", &format!("Permission denied: {target}"))
    );
}

#[tokio::test]
async fn throws_sandbox_permission_error_for_an_unreadable_directory() {
    let (temp, dir) = setup();
    if reads_without_permission(temp.path()) {
        return;
    }
    let target = format!("{dir}/locked");
    std::fs::create_dir(&target).unwrap();
    set_mode(Path::new(&target), 0o000);
    let errors = read_errors(&dir, &target).await;
    set_mode(Path::new(&target), 0o700);
    assert_eq!(
        errors,
        expected("SandboxPermissionError", &format!("Permission denied: {target}"))
    );
}

#[tokio::test]
async fn throws_sandbox_permission_error_under_an_unsearchable_directory() {
    let (temp, dir) = setup();
    if reads_without_permission(temp.path()) {
        return;
    }
    std::fs::create_dir_all(format!("{dir}/locked/inner")).unwrap();
    std::fs::write(format!("{dir}/locked/inner/secret.txt"), "x").unwrap();
    set_mode(&temp.path().join("locked"), 0o600);
    let target = format!("{dir}/locked/inner/secret.txt");
    let errors = read_errors(&dir, &target).await;
    set_mode(&temp.path().join("locked"), 0o700);
    assert_eq!(
        errors,
        expected("SandboxPermissionError", &format!("Permission denied: {target}"))
    );
}
