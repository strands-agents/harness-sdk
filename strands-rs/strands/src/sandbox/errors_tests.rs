use std::error::Error as StdError;

use crate::error::{
    Error, SandboxAbortError, SandboxIsADirectoryError, SandboxPathNotFoundError, SandboxPermissionError,
    SandboxTimeoutError,
};

#[test]
fn sandbox_timeout_error_builds_a_message_from_the_timeout_duration() {
    assert_eq!(
        SandboxTimeoutError::new(30.0).to_string(),
        "Execution timed out after 30 seconds"
    );
}

#[test]
fn sandbox_timeout_error_has_the_correct_error_name() {
    assert_eq!(
        Error::from(SandboxTimeoutError::new(30.0)).name(),
        "SandboxTimeoutError"
    );
}

#[test]
fn sandbox_timeout_error_is_an_instance_of_error() {
    let error: &dyn StdError = &SandboxTimeoutError::new(30.0);
    assert!(error.source().is_none());
}

#[test]
fn carries_the_partial_output_captured_before_the_kill() {
    let error = SandboxTimeoutError::new(30.0).with_output("so far", "warn");
    assert_eq!((error.stdout.as_str(), error.stderr.as_str()), ("so far", "warn"));
}

#[test]
fn defaults_to_empty_output_when_no_partial_output_is_given() {
    let error = SandboxTimeoutError::new(30.0);
    assert_eq!((error.stdout.as_str(), error.stderr.as_str()), ("", ""));
}

#[test]
fn sandbox_abort_error_has_a_fixed_message() {
    assert_eq!(SandboxAbortError::new().to_string(), "Execution aborted");
}

#[test]
fn sandbox_abort_error_has_the_correct_error_name() {
    assert_eq!(Error::from(SandboxAbortError::new()).name(), "SandboxAbortError");
}

#[test]
fn sandbox_abort_error_is_an_instance_of_error() {
    let error: &dyn StdError = &SandboxAbortError::new();
    assert!(error.source().is_none());
}

#[test]
fn carries_the_path_in_its_message_and_a_node_fs_style_code() {
    let cases = [
        (
            Error::from(SandboxPathNotFoundError::new("a.txt")),
            "SandboxPathNotFoundError",
            "Path not found: a.txt",
            SandboxPathNotFoundError::new("a.txt").code(),
            "ENOENT",
        ),
        (
            Error::from(SandboxIsADirectoryError::new("a.txt")),
            "SandboxIsADirectoryError",
            "Is a directory: a.txt",
            SandboxIsADirectoryError::new("a.txt").code(),
            "EISDIR",
        ),
        (
            Error::from(SandboxPermissionError::new("a.txt")),
            "SandboxPermissionError",
            "Permission denied: a.txt",
            SandboxPermissionError::new("a.txt").code(),
            "EACCES",
        ),
    ];
    for (error, name, message, code, expected_code) in cases {
        assert_eq!(error.name(), name);
        assert_eq!(error.to_string(), message);
        assert_eq!(code, expected_code);
    }
}
