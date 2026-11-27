//! The process environment, injectable so tests never mutate the real one.

use std::fmt;
use std::sync::Arc;

/// Reads environment variables; empty values read as unset.
#[derive(Clone)]
pub(crate) struct Env(Arc<Read>);

type Read = dyn Fn(&str) -> Option<String> + Send + Sync;

impl Env {
    pub(crate) fn new(read: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }

    /// The real process environment.
    pub(crate) fn process() -> Self {
        Self::new(|name| std::env::var(name).ok())
    }

    pub(crate) fn get(&self, name: &str) -> Option<String> {
        self.raw(name).filter(|value| !value.is_empty())
    }

    /// The variable as set, empty included.
    pub(crate) fn raw(&self, name: &str) -> Option<String> {
        (self.0)(name)
    }
}

impl fmt::Debug for Env {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Env")
    }
}
