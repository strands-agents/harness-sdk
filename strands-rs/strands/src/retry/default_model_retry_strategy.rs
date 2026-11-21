//! The default retry strategy for model calls.

use std::fmt;
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use super::backoff_strategy::{BackoffContext, BackoffStrategy, ExponentialBackoff, ExponentialBackoffOptions};
use super::model_retry_strategy::{ModelRetryContext, ModelRetryStrategy};
use super::retry_strategy::RetryDecision;
use crate::error::{Error, Result};

const DEFAULT_MAX_ATTEMPTS: u32 = 6;
const DEFAULT_BACKOFF_BASE: Duration = Duration::from_secs(4);
const DEFAULT_BACKOFF_MAX: Duration = Duration::from_secs(240);

fn default_backoff() -> Arc<dyn BackoffStrategy> {
    Arc::new(ExponentialBackoff::new(
        ExponentialBackoffOptions::builder()
            .base(DEFAULT_BACKOFF_BASE)
            .max(DEFAULT_BACKOFF_MAX)
            .build(),
    ))
}

crate::callback::callback! {
    /// Classifies which errors a [`DefaultModelRetryStrategy`] retries.
    pub struct IsRetryable(Fn(&Error) -> bool);
}

/// Options for [`DefaultModelRetryStrategy`] (`DefaultModelRetryStrategyOptions`).
#[derive(Clone, bon::Builder)]
pub struct DefaultModelRetryStrategyOptions {
    /// Total model attempts before giving up and returning the error. Must be at least 1.
    /// Default 6.
    #[builder(default = DEFAULT_MAX_ATTEMPTS)]
    pub max_attempts: u32,
    /// Backoff between retries. Default: exponential from 4 s, capped at 240 s, with full jitter.
    pub backoff: Option<Arc<dyn BackoffStrategy>>,
    /// Replaces the classifier of retryable errors. Call
    /// [`DefaultModelRetryStrategy::is_default_retryable`] inside it to extend the default set.
    #[builder(into)]
    pub is_retryable: Option<IsRetryable>,
}

impl Default for DefaultModelRetryStrategyOptions {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl fmt::Debug for DefaultModelRetryStrategyOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DefaultModelRetryStrategyOptions")
            .field("max_attempts", &self.max_attempts)
            .field("backoff", &self.backoff.as_ref().map(|_| "BackoffStrategy"))
            .field("is_retryable", &self.is_retryable.as_ref().map(|_| "Fn"))
            .finish()
    }
}

#[derive(Debug, Default)]
struct BudgetState {
    last_delay: Option<Duration>,
    first_failure_at: Option<Instant>,
}

/// Retries model calls that fail with an error the SDK classifies as retryable
/// (`DefaultModelRetryStrategy`).
///
/// [`ModelThrottledError`](crate::ModelThrottledError) and
/// [`ModelNetworkError`](crate::ModelNetworkError) are retryable; set
/// [`DefaultModelRetryStrategyOptions::is_retryable`] to change the set. Backoff state belongs to
/// a retry budget and resets on each budget's first attempt. One instance tracks its own state, so
/// give each agent its own instance.
///
/// ```
/// use strands::{DefaultModelRetryStrategy, DefaultModelRetryStrategyOptions};
///
/// let strategy = DefaultModelRetryStrategy::new(
///     DefaultModelRetryStrategyOptions::builder().max_attempts(4).build(),
/// )
/// .unwrap();
/// assert_eq!(strategy.max_attempts(), 4);
/// ```
pub struct DefaultModelRetryStrategy {
    max_attempts: u32,
    backoff: Arc<dyn BackoffStrategy>,
    is_retryable: Option<IsRetryable>,
    state: Mutex<BudgetState>,
}

impl DefaultModelRetryStrategy {
    /// The strategy's name (`name`).
    pub const NAME: &'static str = "strands:default-model-retry-strategy";

    /// Creates the strategy.
    ///
    /// # Errors
    ///
    /// Returns an error when `max_attempts` is below 1.
    pub fn new(options: DefaultModelRetryStrategyOptions) -> Result<Self> {
        if options.max_attempts < 1 {
            return Err(Error::other(format!(
                "DefaultModelRetryStrategy: maxAttempts must be an integer >= 1 (got {})",
                options.max_attempts
            )));
        }
        Ok(Self {
            max_attempts: options.max_attempts,
            backoff: options.backoff.unwrap_or_else(default_backoff),
            is_retryable: options.is_retryable,
            state: Mutex::default(),
        })
    }

    /// Total model attempts before giving up.
    #[must_use]
    pub fn max_attempts(&self) -> u32 {
        self.max_attempts
    }

    /// Whether the default classifier retries `error`: a throttle or a network failure.
    #[must_use]
    pub fn is_default_retryable(error: &Error) -> bool {
        matches!(error, Error::ModelThrottled(_) | Error::ModelNetwork(_))
    }

    /// Whether `error` is retried: the configured classifier, or the default one.
    #[must_use]
    pub fn is_retryable(&self, error: &Error) -> bool {
        self.is_retryable
            .as_ref()
            .map_or_else(|| Self::is_default_retryable(error), |classify| classify(error))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BudgetState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn context(&self, attempt_count: u32) -> BackoffContext {
        let mut state = self.lock();
        let first_failure_at = *state.first_failure_at.get_or_insert_with(Instant::now);
        let attempt = NonZeroU32::new(attempt_count).unwrap_or(NonZeroU32::MIN);
        let mut context = BackoffContext::new(attempt).with_elapsed(first_failure_at.elapsed());
        context.last_delay = state.last_delay;
        context
    }
}

impl Default for DefaultModelRetryStrategy {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            backoff: default_backoff(),
            is_retryable: None,
            state: Mutex::default(),
        }
    }
}

impl fmt::Debug for DefaultModelRetryStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DefaultModelRetryStrategy")
            .field("max_attempts", &self.max_attempts)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl ModelRetryStrategy for DefaultModelRetryStrategy {
    fn name(&self) -> &str {
        Self::NAME
    }

    async fn compute_retry_decision(&self, context: &ModelRetryContext<'_>) -> Result<RetryDecision> {
        let attempt_count = context.attempt_count;
        if !self.is_retryable(context.error) {
            return Ok(RetryDecision::NoRetry);
        }
        if attempt_count >= self.max_attempts {
            tracing::debug!(
                "attempt_count=<{attempt_count}> max_attempts=<{}> | max retry attempts reached",
                self.max_attempts
            );
            return Ok(RetryDecision::NoRetry);
        }
        let wait = self.backoff.next_delay(&self.context(attempt_count));
        tracing::debug!(
            "retry_delay_ms=<{}> attempt_count=<{attempt_count}> max_attempts=<{}> | retryable model error, delaying before retry",
            wait.as_secs_f64() * 1000.0,
            self.max_attempts
        );
        self.lock().last_delay = Some(wait);
        Ok(RetryDecision::retry(wait))
    }

    fn on_first_model_attempt(&self) {
        *self.lock() = BudgetState::default();
    }
}

/// These call the retry orchestration (`retry_model`) directly, with a recording sleeper in place of
/// real sleeps. The agent hook wiring is tested in `plugin.rs`.
#[cfg(test)]
mod tests {
    use std::future::pending;

    use super::*;
    use crate::cancel::{CancelHandle, CancelOptions};
    use crate::error::{ModelNetworkError, ModelThrottledError};
    use crate::retry::backoff_strategy::{ConstantBackoff, ConstantBackoffOptions};
    use crate::retry::model_retry_strategy::{ModelAttempt, Sleeper, retry_model};

    #[derive(Default)]
    struct RecordingSleeper(Mutex<Vec<Duration>>);

    impl RecordingSleeper {
        fn calls(&self) -> Vec<Duration> {
            self.0.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Sleeper for RecordingSleeper {
        async fn sleep(&self, duration: Duration) {
            self.0.lock().unwrap().push(duration);
        }
    }

    struct NeverSleeper;

    #[async_trait]
    impl Sleeper for NeverSleeper {
        async fn sleep(&self, _duration: Duration) {
            pending::<()>().await;
        }
    }

    #[derive(Default)]
    struct RecordingBackoff(Mutex<Vec<BackoffContext>>);

    impl BackoffStrategy for RecordingBackoff {
        fn next_delay(&self, context: &BackoffContext) -> Duration {
            self.0.lock().unwrap().push(context.clone());
            Duration::from_millis(5)
        }
    }

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    fn constant(max_attempts: u32, delay: Duration) -> DefaultModelRetryStrategy {
        DefaultModelRetryStrategy::new(
            DefaultModelRetryStrategyOptions::builder()
                .max_attempts(max_attempts)
                .backoff(Arc::new(ConstantBackoff::new(ConstantBackoffOptions { delay })))
                .build(),
        )
        .unwrap()
    }

    fn throttled(message: &str) -> Error {
        ModelThrottledError::new(message).into()
    }

    fn failed(error: &Error, attempt_count: u32) -> ModelAttempt<'_> {
        ModelAttempt {
            error: Some(error),
            attempt_count,
            retry: false,
            cancel_signal: None,
        }
    }

    async fn run(strategy: &dyn ModelRetryStrategy, attempt: ModelAttempt<'_>, sleeper: &RecordingSleeper) -> bool {
        retry_model(strategy, attempt, sleeper).await.unwrap()
    }

    fn contexts(backoff: &RecordingBackoff) -> Vec<(u32, Option<Duration>)> {
        backoff
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|context| (context.attempt.get(), context.last_delay))
            .collect()
    }

    fn recording(max_attempts: u32) -> (Arc<RecordingBackoff>, DefaultModelRetryStrategy) {
        let backoff = Arc::new(RecordingBackoff::default());
        let strategy = DefaultModelRetryStrategy::new(
            DefaultModelRetryStrategyOptions::builder()
                .max_attempts(max_attempts)
                .backoff(Arc::clone(&backoff) as Arc<dyn BackoffStrategy>)
                .build(),
        )
        .unwrap();
        (backoff, strategy)
    }

    #[test]
    fn exposes_the_plugin_name() {
        assert_eq!(
            DefaultModelRetryStrategy::default().name(),
            "strands:default-model-retry-strategy"
        );
    }

    #[test]
    fn is_a_model_retry_strategy() {
        let strategy: Arc<dyn ModelRetryStrategy> = Arc::new(DefaultModelRetryStrategy::default());
        assert_eq!(strategy.name(), DefaultModelRetryStrategy::NAME);
    }

    #[test]
    fn rejects_max_attempts_below_1() {
        let error = DefaultModelRetryStrategy::new(DefaultModelRetryStrategyOptions::builder().max_attempts(0).build())
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "DefaultModelRetryStrategy: maxAttempts must be an integer >= 1 (got 0)"
        );
    }

    #[test]
    fn defaults_to_six_attempts() {
        assert_eq!(DefaultModelRetryStrategy::default().max_attempts(), 6);
        assert_eq!(
            DefaultModelRetryStrategy::new(DefaultModelRetryStrategyOptions::default())
                .unwrap()
                .max_attempts(),
            6
        );
    }

    #[tokio::test]
    async fn sets_retry_true_on_model_throttled_error_and_sleeps_for_the_configured_delay() {
        let strategy = constant(3, ms(500));
        let sleeper = RecordingSleeper::default();
        let error = throttled("rate limited");
        assert!(run(&strategy, failed(&error, 1), &sleeper).await);
        assert_eq!(sleeper.calls(), [ms(500)]);
    }

    #[tokio::test]
    async fn sets_retry_true_on_model_network_error() {
        let strategy = constant(3, ms(500));
        let sleeper = RecordingSleeper::default();
        let error = ModelNetworkError::new("connection dropped").into();
        assert!(run(&strategy, failed(&error, 1), &sleeper).await);
        assert_eq!(sleeper.calls(), [ms(500)]);
    }

    #[tokio::test]
    async fn does_not_schedule_a_backoff_timer_when_cancellation_was_already_requested() {
        let strategy = constant(3, ms(500));
        let sleeper = RecordingSleeper::default();
        let handle = CancelHandle::new();
        handle.cancel(CancelOptions::default());
        let signal = handle.signal();
        let error = throttled("rate limited");
        let attempt = ModelAttempt {
            cancel_signal: Some(&signal),
            ..failed(&error, 1)
        };
        assert!(run(&strategy, attempt, &sleeper).await);
        assert!(sleeper.calls().is_empty());
    }

    #[tokio::test]
    async fn ends_the_wait_early_when_cancellation_fires() {
        let strategy = constant(3, ms(500));
        let handle = CancelHandle::new();
        let signal = handle.signal();
        let error = throttled("rate limited");
        let attempt = ModelAttempt {
            cancel_signal: Some(&signal),
            ..failed(&error, 1)
        };
        let retry = retry_model(&strategy, attempt, &NeverSleeper);
        let cancel = async {
            tokio::task::yield_now().await;
            handle.cancel(CancelOptions::default());
        };
        let (retry, ()) = tokio::join!(retry, cancel);
        assert!(retry.unwrap());
    }

    #[tokio::test]
    async fn does_not_retry_non_retryable_errors() {
        let strategy = constant(6, ms(10));
        let sleeper = RecordingSleeper::default();
        let error = Error::other("boom");
        assert!(!run(&strategy, failed(&error, 1), &sleeper).await);
        assert!(sleeper.calls().is_empty());
    }

    #[tokio::test]
    async fn does_nothing_for_a_successful_call() {
        let strategy = constant(6, ms(10));
        let sleeper = RecordingSleeper::default();
        let attempt = ModelAttempt {
            error: None,
            attempt_count: 1,
            retry: false,
            cancel_signal: None,
        };
        assert!(!run(&strategy, attempt, &sleeper).await);
    }

    #[tokio::test]
    async fn stops_retrying_once_max_attempts_is_reached() {
        let strategy = constant(3, ms(1));
        let sleeper = RecordingSleeper::default();
        let error = throttled("x");
        assert!(run(&strategy, failed(&error, 1), &sleeper).await);
        assert!(run(&strategy, failed(&error, 2), &sleeper).await);
        assert!(!run(&strategy, failed(&error, 3), &sleeper).await);
        assert_eq!(sleeper.calls().len(), 2);
    }

    #[tokio::test]
    async fn skips_work_if_another_hook_already_requested_retry() {
        let (backoff, strategy) = recording(5);
        let sleeper = RecordingSleeper::default();
        let error = throttled("x");
        let attempt = ModelAttempt {
            retry: true,
            ..failed(&error, 1)
        };
        assert!(run(&strategy, attempt, &sleeper).await);
        assert!(sleeper.calls().is_empty());
        assert!(contexts(&backoff).is_empty());
    }

    #[tokio::test]
    async fn clears_backoff_state_at_the_start_of_each_new_turn() {
        let (backoff, strategy) = recording(5);
        let sleeper = RecordingSleeper::default();
        let error = throttled("x");
        run(&strategy, failed(&error, 1), &sleeper).await;
        run(&strategy, failed(&error, 1), &sleeper).await;
        assert_eq!(contexts(&backoff)[1], (1, None));
    }

    #[tokio::test]
    async fn passes_backoff_context_with_attempt_and_last_delay_ms_to_the_backoff_strategy() {
        let (backoff, strategy) = recording(5);
        let sleeper = RecordingSleeper::default();
        let error = throttled("x");
        run(&strategy, failed(&error, 1), &sleeper).await;
        assert_eq!(contexts(&backoff), [(1, None)]);
        run(&strategy, failed(&error, 2), &sleeper).await;
        assert_eq!(contexts(&backoff), [(1, None), (2, Some(ms(5)))]);
    }

    #[tokio::test]
    async fn clears_per_turn_state_on_attempt_1_even_when_a_prior_hook_already_set_event_retry() {
        let (backoff, strategy) = recording(5);
        let sleeper = RecordingSleeper::default();
        let error = throttled("x");
        run(&strategy, failed(&error, 1), &sleeper).await;
        let already = ModelAttempt {
            retry: true,
            ..failed(&error, 1)
        };
        run(&strategy, already, &sleeper).await;
        run(&strategy, failed(&error, 2), &sleeper).await;
        assert_eq!(contexts(&backoff)[1], (2, None));
    }

    #[tokio::test]
    async fn lets_the_retryable_classifier_expand_the_retryable_set() {
        let classify: IsRetryable = IsRetryable::new(|error: &Error| {
            DefaultModelRetryStrategy::is_default_retryable(error) || error.to_string() == "custom"
        });
        let strategy = DefaultModelRetryStrategy::new(
            DefaultModelRetryStrategyOptions::builder()
                .max_attempts(3)
                .backoff(Arc::new(ConstantBackoff::new(ConstantBackoffOptions { delay: ms(10) })))
                .is_retryable(classify)
                .build(),
        )
        .unwrap();
        let sleeper = RecordingSleeper::default();
        let error = Error::other("custom");
        assert!(run(&strategy, failed(&error, 1), &sleeper).await);
        let throttle = throttled("x");
        assert!(run(&strategy, failed(&throttle, 1), &sleeper).await);
    }

    struct PickyStrategy(DefaultModelRetryStrategy);

    #[async_trait]
    impl ModelRetryStrategy for PickyStrategy {
        fn name(&self) -> &str {
            "test:picky"
        }

        async fn compute_retry_decision(&self, context: &ModelRetryContext<'_>) -> Result<RetryDecision> {
            if context.error.to_string() == "skip" {
                return Ok(RetryDecision::NoRetry);
            }
            self.0.compute_retry_decision(context).await
        }

        fn on_first_model_attempt(&self) {
            self.0.on_first_model_attempt();
        }
    }

    #[tokio::test]
    async fn short_circuits_without_retry_when_compute_retry_decision_returns_retry_false_for_a_non_max_reason() {
        let strategy = PickyStrategy(constant(5, ms(10)));
        let sleeper = RecordingSleeper::default();
        let skip = throttled("skip");
        assert!(!run(&strategy, failed(&skip, 1), &sleeper).await);
        let other = throttled("other");
        assert!(run(&strategy, failed(&other, 1), &sleeper).await);
    }

    #[tokio::test]
    async fn the_default_backoff_grows_from_four_seconds() {
        let strategy = DefaultModelRetryStrategy::default();
        let error = throttled("x");
        let context = ModelRetryContext::new(&error, 1);
        let RetryDecision::Retry { wait, .. } = strategy.compute_retry_decision(&context).await.unwrap() else {
            panic!("expected a retry");
        };
        assert!(wait <= Duration::from_secs(4));
    }
}
