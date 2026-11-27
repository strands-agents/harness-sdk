//! Hook registration options and handles.

use std::fmt;
use std::sync::Arc;

/// Presets for hook execution order (`HookOrder`). Lower values run first.
///
/// Any `i32` is a valid order; the presets are reference points. [`SDK_FIRST`](Self::SDK_FIRST)
/// and [`SDK_LAST`](Self::SDK_LAST) mark where the SDK's own hooks run, so hooks can be placed
/// around them: `HookOrder::SDK_FIRST - 1` runs before the SDK's earliest hooks.
#[derive(Debug)]
#[non_exhaustive]
pub enum HookOrder {}

impl HookOrder {
    /// Where the SDK's earliest hooks run.
    pub const SDK_FIRST: i32 = -100;
    /// Where output interventions run.
    pub const INTERVENTION_OUTPUT: i32 = -90;
    /// The order of hooks registered without options.
    pub const DEFAULT: i32 = 0;
    /// Where model routing runs.
    pub const MODEL_ROUTING: i32 = 50;
    /// Where input interventions run.
    pub const INTERVENTION_INPUT: i32 = 90;
    /// Where the SDK's latest hooks run.
    pub const SDK_LAST: i32 = 100;
}

/// Options for registering a hook (`HookCallbackOptions`).
///
/// ```
/// use strands::hooks::{HookCallbackOptions, HookOrder};
///
/// let options = HookCallbackOptions { order: HookOrder::SDK_FIRST - 1 };
/// assert_eq!(HookCallbackOptions::default().order, HookOrder::DEFAULT);
/// # let _ = options;
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct HookCallbackOptions {
    /// Execution order; lower runs first. Defaults to [`HookOrder::DEFAULT`].
    #[builder(default)]
    pub order: i32,
}

/// Removes a registered hook (`HookCleanup`).
///
/// [`remove`](Self::remove) is idempotent and does not affect other registrations, including other
/// registrations of the same callback. Dropping the handle keeps the hook registered.
#[derive(Clone)]
pub struct HookCleanup {
    remove: Arc<dyn Fn() + Send + Sync>,
}

impl HookCleanup {
    pub(crate) fn new(remove: impl Fn() + Send + Sync + 'static) -> Self {
        Self {
            remove: Arc::new(remove),
        }
    }

    /// Unregisters the hook. Calling it again does nothing.
    pub fn remove(&self) {
        (self.remove)();
    }
}

impl fmt::Debug for HookCleanup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HookCleanup").finish_non_exhaustive()
    }
}
