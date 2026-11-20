//! Crate-internal test helpers.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, LazyLock, Mutex};

use tracing::subscriber::DefaultGuard;

use crate::env::Env;

#[derive(Clone, Default)]
pub(crate) struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    pub(crate) fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }

    /// The captured lines at `level` (`"WARN"`, `"INFO"`).
    pub(crate) fn lines(&self, level: &str) -> Vec<String> {
        self.text()
            .lines()
            .filter(|line| line.trim_start().starts_with(level))
            .map(str::to_owned)
            .collect()
    }
}

impl io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A dispatcher that is never anyone's default, so callsite interest is asked per thread (see
/// the SDK's `test_support`).
static KEEP_INTEREST: LazyLock<tracing::Dispatch> =
    LazyLock::new(|| tracing::Dispatch::new(tracing_subscriber::registry()));

/// Records log lines on the current thread until the guard drops; for single-threaded tests.
pub(crate) fn record_logs() -> (Captured, DefaultGuard) {
    LazyLock::force(&KEEP_INTEREST);
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .without_time()
        .with_max_level(tracing::Level::TRACE)
        .with_target(false)
        .finish();
    let guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    (captured, guard)
}

/// An environment with only these variables set.
pub(crate) fn env(vars: &[(&str, &str)]) -> Env {
    let vars: HashMap<String, String> = vars
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    Env::new(move |name| vars.get(name).cloned())
}

/// An environment with fake provider keys, so provider models build without the network.
pub(crate) fn offline_env() -> Env {
    env(&[
        ("ANTHROPIC_API_KEY", "test-key"),
        ("OPENAI_API_KEY", "test-key"),
        ("AWS_REGION", "us-east-1"),
    ])
}
