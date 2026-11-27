//! Shared retry primitives.

use std::sync::Arc;
use std::time::Duration;

use super::model_retry_strategy::ModelRetryStrategy;

/// Whether to retry a failed operation, and how long to wait first (`RetryDecision`).
///
/// Shared by every retry kind, so all strategies speak the same decision shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetryDecision {
    /// Do not retry; the error propagates to the caller (`{ retry: false }`).
    NoRetry,
    /// Retry after waiting (`{ retry: true, waitMs }`). Build it with [`RetryDecision::retry`].
    #[non_exhaustive]
    Retry {
        /// How long to wait before the next attempt.
        wait: Duration,
    },
}

impl RetryDecision {
    /// A decision to retry after `wait`.
    pub fn retry(wait: Duration) -> Self {
        Self::Retry { wait }
    }

    /// Whether this decision retries.
    #[must_use]
    pub fn is_retry(&self) -> bool {
        matches!(self, Self::Retry { .. })
    }
}

/// Any retry strategy the agent accepts (`RetryStrategy`).
///
/// Only model retries exist today; other retry kinds, such as tool retries, become further
/// variants.
#[derive(Clone)]
#[non_exhaustive]
pub enum RetryStrategy {
    /// A strategy that retries failed model calls.
    Model(Arc<dyn ModelRetryStrategy>),
}

impl RetryStrategy {
    /// Wraps a model retry strategy.
    pub fn model(strategy: impl ModelRetryStrategy) -> Self {
        Self::Model(Arc::new(strategy))
    }

    /// The strategy's stable name.
    #[must_use]
    pub fn name(&self) -> &str {
        match self {
            Self::Model(strategy) => strategy.name(),
        }
    }

    /// The strategy's type name.
    pub(crate) fn type_name(&self) -> &'static str {
        match self {
            Self::Model(strategy) => strategy.type_name(),
        }
    }
}

impl std::fmt::Debug for RetryStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Model(strategy) => f.debug_tuple("Model").field(&strategy.name()).finish(),
        }
    }
}

impl From<Arc<dyn ModelRetryStrategy>> for RetryStrategy {
    fn from(strategy: Arc<dyn ModelRetryStrategy>) -> Self {
        Self::Model(strategy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retry::DefaultModelRetryStrategy;

    #[test]
    fn a_model_strategy_converts_into_a_retry_strategy() {
        let strategy = RetryStrategy::model(DefaultModelRetryStrategy::default());
        assert_eq!(strategy.name(), "strands:default-model-retry-strategy");
        let shared: Arc<dyn ModelRetryStrategy> = Arc::new(DefaultModelRetryStrategy::default());
        assert!(matches!(RetryStrategy::from(shared), RetryStrategy::Model(_)));
    }

    #[test]
    fn decisions_report_whether_they_retry() {
        assert!(RetryDecision::retry(Duration::from_millis(5)).is_retry());
        assert!(!RetryDecision::NoRetry.is_retry());
    }
}
