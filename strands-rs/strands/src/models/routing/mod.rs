//! Strategy-based model routing.
//!
//! A [`ModelRouter`] passed as the agent's model asks its [`RoutingStrategy`] for a candidate
//! before the first model call and after each failure no retry strategy claimed. The default
//! [`FallbackStrategy`] fails over to the healthiest untried candidate; [`ClassifierStrategy`]
//! asks a classifier model which candidate fits the request. The API is provisional.

mod classifier_strategy;
mod fallback_strategy;
mod router;
mod strategy;

pub use classifier_strategy::{ClassifierStrategy, ClassifierStrategyOptions};
pub use fallback_strategy::FallbackStrategy;
pub use router::{CandidateModel, ModelRouter, ModelRouterOptions, RoutingCandidate, RoutingCandidateOptions};
pub(crate) use router::{ModelRouterPlugin, RouterAttachment, same_model};
pub use strategy::{RoutingAttempt, RoutingContext, RoutingFailure, RoutingStrategy};
