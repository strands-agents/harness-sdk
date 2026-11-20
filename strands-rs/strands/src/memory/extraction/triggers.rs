//! Extraction triggers.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{ExtractionTrigger, ExtractionTriggerContext};
use crate::error::{Error, Result};
use crate::hooks::{AfterInvocationEvent, HookCallbackOptions, HookOrder};

/// Runs after the SDK's own after-invocation hooks (such as session persistence), so extraction
/// sees the settled turn.
const LAST: HookCallbackOptions = HookCallbackOptions {
    order: HookOrder::SDK_LAST,
};

/// Runs extraction after every agent invocation (`InvocationTrigger`): nothing said in a turn is
/// missed, and with an extractor it costs a model call per turn.
#[derive(Debug, Clone, Copy, Default)]
#[non_exhaustive]
pub struct InvocationTrigger;

impl InvocationTrigger {
    /// Creates the trigger.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

impl ExtractionTrigger for InvocationTrigger {
    fn name(&self) -> &str {
        "invocation"
    }

    fn attach(&self, context: ExtractionTriggerContext<'_>) {
        let fire = context.fire;
        context.agent.add_hook_with(
            move |event: &mut AfterInvocationEvent<'_>| fire.fire(event.invocation_context().cloned()),
            LAST,
        );
    }
}

/// Options for [`IntervalTrigger`] (`IntervalTriggerOptions`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct IntervalTriggerOptions {
    /// Run extraction once every this many invocations; at least 1.
    pub turns: u64,
}

/// Runs extraction every N agent invocations (`IntervalTrigger`); the messages of the skipped
/// turns are saved when it fires.
#[derive(Debug, Clone, Copy)]
pub struct IntervalTrigger {
    turns: u64,
}

impl IntervalTrigger {
    /// Creates the trigger.
    ///
    /// # Errors
    ///
    /// `IntervalTrigger: turns must be a positive integer, got <turns>` when `turns` is 0.
    pub fn new(options: IntervalTriggerOptions) -> Result<Self> {
        if options.turns < 1 {
            return Err(Error::other(format!(
                "IntervalTrigger: turns must be a positive integer, got {}",
                options.turns
            )));
        }
        Ok(Self { turns: options.turns })
    }

    /// The interval.
    #[must_use]
    pub fn turns(&self) -> u64 {
        self.turns
    }
}

impl ExtractionTrigger for IntervalTrigger {
    fn name(&self) -> &str {
        "interval"
    }

    fn attach(&self, context: ExtractionTriggerContext<'_>) {
        // Each attach counts on its own, so two stores sharing one trigger fire independently.
        let count = Arc::new(AtomicU64::new(0));
        let turns = self.turns;
        let fire = context.fire;
        context.agent.add_hook_with(
            move |event: &mut AfterInvocationEvent<'_>| {
                let count = count.fetch_add(1, Ordering::SeqCst) + 1;
                if count.is_multiple_of(turns) {
                    fire.fire(event.invocation_context().cloned());
                }
            },
            LAST,
        );
    }
}
