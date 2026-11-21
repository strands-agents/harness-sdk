//! Retry strategies for failed model calls and the backoff math they use.

mod backoff_strategy;
mod default_model_retry_strategy;
mod model_retry_strategy;
mod plugin;
mod retry_strategy;

pub use backoff_strategy::{
    BackoffContext, BackoffStrategy, ConstantBackoff, ConstantBackoffOptions, ExponentialBackoff,
    ExponentialBackoffOptions, JitterKind, LinearBackoff, LinearBackoffOptions,
};
pub use default_model_retry_strategy::{DefaultModelRetryStrategy, DefaultModelRetryStrategyOptions, IsRetryable};
#[allow(unused_imports, reason = "tests swap the sleeper")]
pub(crate) use model_retry_strategy::Sleeper;
pub(crate) use model_retry_strategy::TokioSleeper;
pub use model_retry_strategy::{ModelRetryContext, ModelRetryStrategy};
pub(crate) use plugin::{ModelRetryPlugin, SleeperSlot, warn_on_duplicate_retry_strategy_types};
pub use retry_strategy::{RetryDecision, RetryStrategy};
