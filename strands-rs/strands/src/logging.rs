//! Logging helpers.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex, PoisonError};

static WARNED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

/// Logs `message` as a warning at most once per process. The message is the dedupe
/// key, so repeated nudges such as "using default modelId" do not flood the logs.
pub(crate) fn warn_once(message: &str) {
    let first = WARNED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(message.to_owned());
    if first {
        tracing::warn!("{message}");
    }
}

/// Forgets that `message` was logged, so a test can see `warn_once` emit it again.
#[cfg(test)]
pub(crate) fn forget_warning(message: &str) {
    WARNED.lock().unwrap_or_else(PoisonError::into_inner).remove(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::capture_logs;

    fn warnings(logs: &str) -> Vec<&str> {
        logs.lines().filter(|line| line.contains("WARN")).collect()
    }

    #[test]
    fn emits_a_warning_the_first_time_a_message_is_seen() {
        let (_, logs) = capture_logs(|| warn_once("warn_once test | first-seen-msg"));
        let warnings = warnings(&logs);
        assert_eq!(warnings.len(), 1, "{logs}");
        assert!(warnings[0].ends_with("warn_once test | first-seen-msg"), "{logs}");
    }

    #[test]
    fn does_not_emit_repeated_warnings_for_the_same_message() {
        let (_, logs) = capture_logs(|| {
            warn_once("warn_once test | repeated-msg");
            warn_once("warn_once test | repeated-msg");
            warn_once("warn_once test | repeated-msg");
        });
        assert_eq!(warnings(&logs).len(), 1, "{logs}");
    }

    #[test]
    fn emits_distinct_messages_independently() {
        let (_, logs) = capture_logs(|| {
            warn_once("warn_once test | distinct-alpha-msg");
            warn_once("warn_once test | distinct-beta-msg");
            warn_once("warn_once test | distinct-alpha-msg");
        });
        let warnings = warnings(&logs);
        assert_eq!(warnings.len(), 2, "{logs}");
        assert!(warnings[0].ends_with("distinct-alpha-msg"), "{logs}");
        assert!(warnings[1].ends_with("distinct-beta-msg"), "{logs}");
    }
}
