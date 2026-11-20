//! The model retry strategy trait and the retry orchestration around it.

use std::time::Duration;

use async_trait::async_trait;
use futures::future::{Either, select};

use super::retry_strategy::RetryDecision;
use crate::cancel::CancelSignal;
use crate::error::{Error, Result};

/// What a [`ModelRetryStrategy`] sees of a failed model call.
///
/// The SDK builds it; fields may be added.
#[derive(Debug, Clone, Copy)]
#[non_exhaustive]
pub struct ModelRetryContext<'a> {
    /// The error the call failed with.
    pub error: &'a Error,
    /// The 1-based number of the attempt that failed, within the current retry budget.
    pub attempt_count: u32,
}

impl<'a> ModelRetryContext<'a> {
    /// Creates the context, for example to test a strategy.
    pub fn new(error: &'a Error, attempt_count: u32) -> Self {
        Self { error, attempt_count }
    }
}

/// A policy for retrying failed model calls (`ModelRetryStrategy`).
///
/// An implementation answers whether to retry and how long to wait; the agent handles the rest:
/// it skips the strategy when another hook already asked for a retry or the call succeeded, calls
/// [`on_first_model_attempt`](ModelRetryStrategy::on_first_model_attempt) when a fresh retry
/// budget starts, waits for the returned delay (ending early on cancellation) and then retries.
///
/// Instances usually carry per-budget state, so one instance belongs to one agent.
#[async_trait]
pub trait ModelRetryStrategy: Send + Sync + 'static {
    /// A stable identifier for the strategy (`name`).
    fn name(&self) -> &str;

    /// The implementing type's name, such as `DefaultModelRetryStrategy`, which messages use. Provided;
    /// implementors keep the default.
    fn type_name(&self) -> &'static str {
        short_type_name(std::any::type_name::<Self>())
    }

    /// Decides whether to retry the failed model call and how long to wait first.
    ///
    /// Called only for failed calls no other hook has already marked for retry.
    ///
    /// # Errors
    ///
    /// An error ends the invocation with it.
    async fn compute_retry_decision(&self, context: &ModelRetryContext<'_>) -> Result<RetryDecision>;

    /// Called when `attempt_count` is 1, at the start of a fresh retry budget: a new turn, or a
    /// model router switching candidates. Strategies with per-budget state
    /// clear it here; the default does nothing.
    fn on_first_model_attempt(&self) {}
}

/// Waits between retry attempts.
#[async_trait]
pub(crate) trait Sleeper: Send + Sync {
    /// Waits for `duration`.
    async fn sleep(&self, duration: Duration);
}

/// The default [`Sleeper`], on the tokio timer.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TokioSleeper;

#[async_trait]
impl Sleeper for TokioSleeper {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// The outcome of one model attempt, as the retry orchestration sees it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ModelAttempt<'a> {
    /// The error the call failed with; `None` on success.
    pub(crate) error: Option<&'a Error>,
    /// The 1-based number of this attempt within the current retry budget.
    pub(crate) attempt_count: u32,
    /// Whether another hook already asked for a retry.
    pub(crate) retry: bool,
    /// The invocation's cancel signal; cancellation ends the wait early.
    pub(crate) cancel_signal: Option<&'a CancelSignal>,
}

/// Runs `strategy` for one model attempt and returns whether to retry.
///
/// Resets per-budget state on the first attempt before any short-circuit, leaves an existing retry
/// request and successes alone, and waits for the decided delay before answering `true`.
pub(crate) async fn retry_model(
    strategy: &dyn ModelRetryStrategy,
    attempt: ModelAttempt<'_>,
    sleeper: &dyn Sleeper,
) -> Result<bool> {
    if attempt.attempt_count == 1 {
        strategy.on_first_model_attempt();
    }
    if attempt.retry {
        return Ok(true);
    }
    let Some(error) = attempt.error else {
        return Ok(false);
    };
    let context = ModelRetryContext::new(error, attempt.attempt_count);
    let RetryDecision::Retry { wait, .. } = strategy.compute_retry_decision(&context).await? else {
        return Ok(false);
    };
    sleep(sleeper, wait, attempt.cancel_signal).await;
    Ok(true)
}

/// Waits for `duration`, or until `cancel_signal` fires, so the loop can recheck cancellation
/// before another attempt.
async fn sleep(sleeper: &dyn Sleeper, duration: Duration, cancel_signal: Option<&CancelSignal>) {
    let Some(signal) = cancel_signal else {
        sleeper.sleep(duration).await;
        return;
    };
    if signal.is_cancelled() {
        return;
    }
    let wait = sleeper.sleep(duration);
    let cancelled = signal.cancelled();
    futures::pin_mut!(cancelled);
    if let Either::Right(((), _)) = select(wait, cancelled).await {
        tracing::debug!("retry wait ended early | cancellation requested");
    }
}

/// The last path segment of a type name, without generic arguments.
fn short_type_name(full: &'static str) -> &'static str {
    let base = full.split('<').next().unwrap_or(full);
    base.rsplit("::").next().unwrap_or(base)
}

#[cfg(test)]
mod tests {
    #[test]
    fn type_names_drop_the_module_path_and_generics() {
        assert_eq!(
            super::short_type_name("strands::retry::DefaultModelRetryStrategy"),
            "DefaultModelRetryStrategy"
        );
        assert_eq!(super::short_type_name("a::Wrap<b::Inner>"), "Wrap");
    }

    use super::*;

    #[tokio::test(start_paused = true)]
    async fn the_tokio_sleeper_waits_on_the_tokio_timer() {
        let started = tokio::time::Instant::now();
        TokioSleeper.sleep(Duration::from_secs(30)).await;
        assert!(started.elapsed() >= Duration::from_secs(30));
    }
}
