//! The harness's warn-once helper. Messages go through `tracing`; configure their output with a
//! `tracing` subscriber.

use std::collections::HashSet;
#[cfg(not(test))]
use std::sync::{LazyLock, Mutex, PoisonError};

#[cfg(not(test))]
static WARNED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

#[cfg(test)]
thread_local! {
    // Per test thread, so a test sees its own first warning whatever ran before it.
    static WARNED: std::cell::RefCell<HashSet<String>> = std::cell::RefCell::default();
}

fn first_time(message: &str) -> bool {
    #[cfg(not(test))]
    {
        WARNED
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(message.to_owned())
    }
    #[cfg(test)]
    {
        WARNED.with(|warned| warned.borrow_mut().insert(message.to_owned()))
    }
}

/// Logs `message` as a warning at most once per process; the message is the dedupe key.
pub(crate) fn warn_once(message: &str) {
    if first_time(message) {
        tracing::warn!("{message}");
    }
}
