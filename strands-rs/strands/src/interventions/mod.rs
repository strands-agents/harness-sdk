//! Interventions: policies that inspect and gate the agent's lifecycle.
//!
//! An [`InterventionHandler`] returns an [`InterventionAction`] at each lifecycle point it
//! overrides: proceed, deny, guide, confirm (ask a human) or transform. Pass handlers to
//! [`AgentConfig::interventions`](crate::AgentConfig::interventions); they run in registration
//! order, after the agent's other hooks on `Before*` events and before them on `After*` events.
//! Ready-made handlers are in [`vended_interventions`](crate::vended_interventions).

mod actions;
mod handler;
mod registry;

pub use actions::{Confirm, Deny, Evaluate, Guide, InterventionAction, Proceed, Transform, default_evaluate};
pub use handler::{InterventionHandler, InterventionResult, OnError};
pub(crate) use registry::InterventionRegistry;
