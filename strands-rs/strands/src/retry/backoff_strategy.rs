//! Backoff strategies: the delay between retry attempts.
//!
//! A [`BackoffStrategy`] is pure delay math: given a [`BackoffContext`], it returns how long to wait
//! before the next attempt. Whether to retry, attempt limits and time budgets belong to the retry
//! strategy.

use std::fmt;
use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::Duration;

type RandomSource = Arc<dyn Fn() -> f64 + Send + Sync>;

fn default_random() -> RandomSource {
    Arc::new(rand::random::<f64>)
}

/// Context passed to a [`BackoffStrategy`] for each retry decision (`BackoffContext`).
///
/// Fields may be added over time; existing fields are not removed or repurposed.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BackoffContext {
    /// 1-based index of the attempt that just failed.
    pub attempt: NonZeroU32,
    /// Time elapsed since the first failure of the current retry budget.
    pub elapsed: Duration,
    /// The previously computed delay, absent before the first retry.
    pub last_delay: Option<Duration>,
}

impl BackoffContext {
    /// Context for `attempt`, with no elapsed time and no previous delay.
    pub fn new(attempt: NonZeroU32) -> Self {
        Self {
            attempt,
            elapsed: Duration::ZERO,
            last_delay: None,
        }
    }

    /// Sets the elapsed time.
    #[must_use]
    pub fn with_elapsed(mut self, elapsed: Duration) -> Self {
        self.elapsed = elapsed;
        self
    }

    /// Sets the previous delay.
    #[must_use]
    pub fn with_last_delay(mut self, last_delay: Duration) -> Self {
        self.last_delay = Some(last_delay);
        self
    }
}

/// Computes the delay before the next retry attempt (`BackoffStrategy`).
pub trait BackoffStrategy: Send + Sync + 'static {
    /// The delay before the next attempt.
    fn next_delay(&self, context: &BackoffContext) -> Duration;
}

/// Jitter applied to the raw delay (`JitterKind`). For other jitter, implement [`BackoffStrategy`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum JitterKind {
    /// The raw delay, unchanged.
    None,
    /// Uniform in `[0, raw]`.
    #[default]
    Full,
    /// `raw / 2 + uniform(0, raw / 2)`: half fixed, half random.
    Equal,
    /// `uniform(base, min(max, last_delay * 3))`; full jitter on the first retry, when there is no
    /// previous delay.
    Decorrelated,
}

fn nanos(duration: Duration) -> f64 {
    duration.as_nanos() as f64
}

/// A duration from a count of nanoseconds, rounded; zero for negative or NaN input, saturating.
fn from_nanos(nanos: f64) -> Duration {
    if nanos.is_nan() || nanos <= 0.0 {
        return Duration::ZERO;
    }
    Duration::from_nanos(nanos.round() as u64)
}

struct JitterInput {
    raw: Duration,
    kind: JitterKind,
    base: Duration,
    max: Duration,
    last_delay: Option<Duration>,
}

fn jitter(input: &JitterInput, random: f64) -> Duration {
    let raw = nanos(input.raw);
    let full = || from_nanos(random * raw);
    match input.kind {
        JitterKind::None => input.raw,
        JitterKind::Full => full(),
        JitterKind::Equal => from_nanos(raw / 2.0 + random * (raw / 2.0)),
        JitterKind::Decorrelated => {
            let Some(last_delay) = input.last_delay else {
                return full();
            };
            // The max() guards against max < base, which would otherwise invert the range.
            let base = nanos(input.base);
            let upper = base.max(nanos(input.max).min(nanos(last_delay) * 3.0));
            from_nanos(base + random * (upper - base))
        }
    }
}

/// Options for [`ConstantBackoff`] (`ConstantBackoffOptions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, bon::Builder)]
pub struct ConstantBackoffOptions {
    /// Delay returned for every retry. Default 1 s.
    #[builder(default = Duration::from_secs(1))]
    pub delay: Duration,
}

impl Default for ConstantBackoffOptions {
    fn default() -> Self {
        Self::builder().build()
    }
}

/// Constant backoff: the same delay for every retry (`ConstantBackoff`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConstantBackoff {
    options: ConstantBackoffOptions,
}

impl ConstantBackoff {
    /// Creates the strategy.
    pub fn new(options: ConstantBackoffOptions) -> Self {
        Self { options }
    }
}

impl BackoffStrategy for ConstantBackoff {
    fn next_delay(&self, _context: &BackoffContext) -> Duration {
        self.options.delay
    }
}

/// Options for [`LinearBackoff`] (`LinearBackoffOptions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, bon::Builder)]
pub struct LinearBackoffOptions {
    /// Base delay; the delay grows as `base * attempt`. Default 1 s.
    #[builder(default = Duration::from_secs(1))]
    pub base: Duration,
    /// Upper bound applied before jitter. Default 30 s.
    #[builder(default = Duration::from_secs(30))]
    pub max: Duration,
    /// Jitter mode. Default [`JitterKind::Full`].
    #[builder(default)]
    pub jitter: JitterKind,
}

impl Default for LinearBackoffOptions {
    fn default() -> Self {
        Self::builder().build()
    }
}

/// Linear backoff: `base * attempt`, capped at `max`, then jittered (`LinearBackoff`).
#[derive(Clone)]
pub struct LinearBackoff {
    options: LinearBackoffOptions,
    random: RandomSource,
}

impl LinearBackoff {
    /// Creates the strategy.
    pub fn new(options: LinearBackoffOptions) -> Self {
        Self {
            options,
            random: default_random(),
        }
    }

    /// Replaces the source of uniform `[0, 1)` samples used for jitter, for deterministic tests.
    #[must_use]
    pub fn with_random(mut self, random: impl Fn() -> f64 + Send + Sync + 'static) -> Self {
        self.random = Arc::new(random);
        self
    }
}

impl Default for LinearBackoff {
    fn default() -> Self {
        Self::new(LinearBackoffOptions::default())
    }
}

impl fmt::Debug for LinearBackoff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LinearBackoff")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl BackoffStrategy for LinearBackoff {
    fn next_delay(&self, context: &BackoffContext) -> Duration {
        let options = &self.options;
        let raw = from_nanos(nanos(options.base) * f64::from(context.attempt.get())).min(options.max);
        let input = JitterInput {
            raw,
            kind: options.jitter,
            base: options.base,
            max: options.max,
            last_delay: context.last_delay,
        };
        jitter(&input, (self.random)())
    }
}

/// Options for [`ExponentialBackoff`] (`ExponentialBackoffOptions`).
#[derive(Debug, Clone, Copy, PartialEq, bon::Builder)]
pub struct ExponentialBackoffOptions {
    /// Base delay; the delay grows as `base * multiplier^(attempt - 1)`. Default 1 s.
    #[builder(default = Duration::from_secs(1))]
    pub base: Duration,
    /// Upper bound applied before jitter. Default 30 s.
    #[builder(default = Duration::from_secs(30))]
    pub max: Duration,
    /// Growth factor per attempt. Default 2.
    #[builder(default = 2.0)]
    pub multiplier: f64,
    /// Jitter mode. Default [`JitterKind::Full`].
    #[builder(default)]
    pub jitter: JitterKind,
}

impl Default for ExponentialBackoffOptions {
    fn default() -> Self {
        Self::builder().build()
    }
}

/// Exponential backoff: `base * multiplier^(attempt - 1)`, capped at `max`, then jittered
/// (`ExponentialBackoff`).
#[derive(Clone)]
pub struct ExponentialBackoff {
    options: ExponentialBackoffOptions,
    random: RandomSource,
}

impl ExponentialBackoff {
    /// Creates the strategy.
    pub fn new(options: ExponentialBackoffOptions) -> Self {
        Self {
            options,
            random: default_random(),
        }
    }

    /// Replaces the source of uniform `[0, 1)` samples used for jitter, for deterministic tests.
    #[must_use]
    pub fn with_random(mut self, random: impl Fn() -> f64 + Send + Sync + 'static) -> Self {
        self.random = Arc::new(random);
        self
    }
}

impl Default for ExponentialBackoff {
    fn default() -> Self {
        Self::new(ExponentialBackoffOptions::default())
    }
}

impl fmt::Debug for ExponentialBackoff {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExponentialBackoff")
            .field("options", &self.options)
            .finish_non_exhaustive()
    }
}

impl BackoffStrategy for ExponentialBackoff {
    fn next_delay(&self, context: &BackoffContext) -> Duration {
        let options = &self.options;
        let exponent = i32::try_from(context.attempt.get() - 1).unwrap_or(i32::MAX);
        let raw = from_nanos(nanos(options.base) * options.multiplier.powi(exponent)).min(options.max);
        let input = JitterInput {
            raw,
            kind: options.jitter,
            base: options.base,
            max: options.max,
            last_delay: context.last_delay,
        };
        jitter(&input, (self.random)())
    }
}

/// Jitter draws a fixed sample of 0.5. Attempt validation needs no tests: `attempt` is a `NonZeroU32`.
#[cfg(test)]
mod tests {
    use super::*;

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    fn ctx(attempt: u32) -> BackoffContext {
        BackoffContext::new(NonZeroU32::new(attempt).unwrap())
    }

    fn linear(options: LinearBackoffOptions) -> LinearBackoff {
        LinearBackoff::new(options).with_random(|| 0.5)
    }

    fn exponential(options: ExponentialBackoffOptions) -> ExponentialBackoff {
        ExponentialBackoff::new(options).with_random(|| 0.5)
    }

    #[test]
    fn returns_the_configured_delay_regardless_of_attempt() {
        let backoff = ConstantBackoff::new(ConstantBackoffOptions { delay: ms(250) });
        assert_eq!(backoff.next_delay(&ctx(1)), ms(250));
        assert_eq!(backoff.next_delay(&ctx(5)), ms(250));
    }

    #[test]
    fn defaults_delay_ms_to_1000() {
        assert_eq!(ConstantBackoff::default().next_delay(&ctx(1)), ms(1000));
    }

    #[test]
    fn grows_as_base_ms_times_attempt() {
        let backoff = linear(
            LinearBackoffOptions::builder()
                .base(ms(100))
                .jitter(JitterKind::None)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(1)), ms(100));
        assert_eq!(backoff.next_delay(&ctx(2)), ms(200));
        assert_eq!(backoff.next_delay(&ctx(3)), ms(300));
    }

    #[test]
    fn clamps_to_max_ms_before_jitter() {
        let backoff = linear(
            LinearBackoffOptions::builder()
                .base(ms(1000))
                .max(ms(2500))
                .jitter(JitterKind::None)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(10)), ms(2500));
    }

    #[test]
    fn applies_full_jitter_by_default_math_random_times_raw() {
        let backoff = linear(LinearBackoffOptions::builder().base(ms(100)).build());
        assert_eq!(backoff.next_delay(&ctx(4)), ms(200));
    }

    #[test]
    fn grows_as_base_ms_times_multiplier_to_the_attempt_minus_1() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .jitter(JitterKind::None)
                .build(),
        );
        let delays: Vec<_> = (1..=4).map(|attempt| backoff.next_delay(&ctx(attempt))).collect();
        assert_eq!(delays, [ms(100), ms(200), ms(400), ms(800)]);
    }

    #[test]
    fn honors_custom_multiplier() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .multiplier(3.0)
                .jitter(JitterKind::None)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(3)), ms(900));
    }

    #[test]
    fn clamps_to_max_ms() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .max(ms(500))
                .jitter(JitterKind::None)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(10)), ms(500));
    }

    #[test]
    fn applies_full_jitter_by_default() {
        let backoff = exponential(ExponentialBackoffOptions::builder().base(ms(100)).build());
        assert_eq!(backoff.next_delay(&ctx(3)), ms(200));
    }

    #[test]
    fn applies_equal_jitter_as_raw_half_plus_random_times_raw_half() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .jitter(JitterKind::Equal)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(2)), ms(150));
    }

    #[test]
    fn applies_no_jitter_when_set_to_none() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .jitter(JitterKind::None)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(3)), ms(400));
    }

    #[test]
    fn falls_back_to_full_jitter_for_decorrelated_when_last_delay_ms_missing() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .jitter(JitterKind::Decorrelated)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(3)), ms(200));
    }

    #[test]
    fn applies_decorrelated_jitter_as_uniform_base_ms_to_min_max_ms_last_delay_ms_times_3() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .max(ms(10_000))
                .jitter(JitterKind::Decorrelated)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(2).with_last_delay(ms(200))), ms(350));
    }

    #[test]
    fn caps_decorrelated_upper_at_max_ms() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .max(ms(500))
                .jitter(JitterKind::Decorrelated)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(2).with_last_delay(ms(1000))), ms(300));
    }

    #[test]
    fn floors_decorrelated_upper_at_base_ms_when_last_delay_times_3_is_below_base_ms() {
        let backoff = exponential(
            ExponentialBackoffOptions::builder()
                .base(ms(100))
                .max(ms(500))
                .jitter(JitterKind::Decorrelated)
                .build(),
        );
        assert_eq!(backoff.next_delay(&ctx(2).with_last_delay(ms(10))), ms(100));
    }

    #[test]
    fn saturates_instead_of_overflowing_for_huge_attempts() {
        let backoff = exponential(ExponentialBackoffOptions::builder().jitter(JitterKind::None).build());
        assert_eq!(backoff.next_delay(&ctx(u32::MAX)), Duration::from_secs(30));
    }

    #[test]
    fn default_jitter_stays_within_the_raw_delay() {
        let backoff = ExponentialBackoff::default();
        for attempt in 1..=10 {
            assert!(backoff.next_delay(&ctx(attempt)) <= Duration::from_secs(30));
        }
    }
}
