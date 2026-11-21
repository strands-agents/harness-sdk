//! Experimental APIs. They may change in a minor release.
//!
//! The main context manager items are re-exported here, plus [`ContextManagerStrategy`], the form
//! [`AgentConfig::context_manager`](crate::AgentConfig::context_manager) takes; the rest of the
//! context manager API is in [`context_manager`].

pub mod context_manager;

pub use context_manager::{
    ConditionValue, ContextManager, ContextManagerConfig, ContextManagerStrategy, ContextState, ContextStrategy,
    Offload, OffloadConditions, OffloadTarget, StashConfig, SummarizeConfig, TruncateConfig,
};
