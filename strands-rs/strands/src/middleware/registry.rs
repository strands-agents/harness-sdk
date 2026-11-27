//! The middleware registry: handlers per stage, composed into a chain around the stage's terminal.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, PoisonError, RwLock, Weak};

use super::stages::{ExecuteToolStage, InvokeModelStage};
use super::types::{Handler, Middleware, MiddlewareCleanup, MiddlewareNext, MiddlewareStage, StageStream, TerminalFn};

struct Entry<S: MiddlewareStage> {
    id: u64,
    handler: Handler<S>,
}

/// The handlers registered for one stage, in registration order.
#[doc(hidden)]
pub struct StageRegistry<S: MiddlewareStage> {
    entries: Arc<RwLock<Vec<Entry<S>>>>,
}

impl<S: MiddlewareStage> Default for StageRegistry<S> {
    fn default() -> Self {
        Self {
            entries: Arc::default(),
        }
    }
}

impl<S: MiddlewareStage> StageRegistry<S> {
    pub(crate) fn add(&self, id: u64, middleware: Middleware<S>) -> MiddlewareCleanup {
        self.entries
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Entry {
                id,
                handler: middleware.handler,
            });
        let entries: Weak<RwLock<Vec<Entry<S>>>> = Arc::downgrade(&self.entries);
        MiddlewareCleanup::new(move || {
            let Some(entries) = entries.upgrade() else {
                return;
            };
            entries
                .write()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|entry| entry.id != id);
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.read().unwrap_or_else(PoisonError::into_inner).len()
    }

    /// The handlers in chain order: stable by phase (Input, Output, Wrap), registration order
    /// within a phase; the first is outermost.
    fn compose(&self) -> Arc<[Handler<S>]> {
        let entries = self.entries.read().unwrap_or_else(PoisonError::into_inner);
        let mut handlers: Vec<Handler<S>> = entries.iter().map(|entry| entry.handler.clone()).collect();
        handlers.sort_by_key(Handler::phase);
        Arc::from(handlers)
    }

    /// Runs the chain around `terminal` (`invoke`). The handlers are those registered now;
    /// registrations made while the chain runs apply to the next call.
    pub(crate) fn invoke(&self, context: S::Context, terminal: TerminalFn<S>) -> StageStream<S> {
        MiddlewareNext::new(self.compose(), terminal).call(context)
    }
}

/// Middleware handlers for every stage (`MiddlewareRegistry`). Cheap to share through an `Arc`;
/// registration and removal lock briefly.
#[doc(hidden)]
#[derive(Default)]
pub struct MiddlewareRegistry {
    next_id: AtomicU64,
    invoke_model: StageRegistry<InvokeModelStage>,
    execute_tool: StageRegistry<ExecuteToolStage>,
    #[cfg(test)]
    test_stage: StageRegistry<super::registry_tests::TestStage>,
}

impl MiddlewareRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Registers a handler for its stage and phase.
    pub(crate) fn add<S: MiddlewareStage>(&self, middleware: Middleware<S>) -> MiddlewareCleanup {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        S::slot(self).add(id, middleware)
    }

    /// Runs the stage's chain around `terminal`.
    pub(crate) fn invoke<S: MiddlewareStage>(&self, context: S::Context, terminal: TerminalFn<S>) -> StageStream<S> {
        S::slot(self).invoke(context, terminal)
    }

    /// How many handlers are registered for the stage.
    #[cfg(test)]
    pub(crate) fn len<S: MiddlewareStage>(&self) -> usize {
        S::slot(self).len()
    }

    /// The phase of each handler registered for the stage, in registration order.
    #[cfg(test)]
    pub(crate) fn phases<S: MiddlewareStage>(&self) -> Vec<super::types::MiddlewarePhase> {
        S::slot(self)
            .entries
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|entry| entry.handler.phase())
            .collect()
    }

    pub(crate) fn invoke_model(&self) -> &StageRegistry<InvokeModelStage> {
        &self.invoke_model
    }

    pub(crate) fn execute_tool(&self) -> &StageRegistry<ExecuteToolStage> {
        &self.execute_tool
    }

    #[cfg(test)]
    pub(crate) fn test_stage(&self) -> &StageRegistry<super::registry_tests::TestStage> {
        &self.test_stage
    }
}

impl std::fmt::Debug for MiddlewareRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MiddlewareRegistry")
            .field("invoke_model", &self.invoke_model.len())
            .field("execute_tool", &self.execute_tool.len())
            .finish()
    }
}
