//! A model retry strategy attached to an agent.

use std::sync::{Arc, LazyLock, Mutex, PoisonError, RwLock, Weak};

use async_trait::async_trait;

use super::model_retry_strategy::{ModelAttempt, ModelRetryStrategy, Sleeper, retry_model};
use super::retry_strategy::RetryStrategy;
use crate::agent::LocalAgent;
use crate::error::{Error, Result};
use crate::hooks::{AfterModelCallEvent, HookRegistry};
use crate::plugins::Plugin;

/// The sleeper retries wait on; the agent can swap it (tests use a recording one).
pub(crate) type SleeperSlot = Arc<RwLock<Arc<dyn Sleeper>>>;

struct Attachment {
    strategy: Weak<dyn ModelRetryStrategy>,
    agent: Weak<HookRegistry>,
}

/// Which agent each live strategy instance belongs to; an instance serves one agent.
static ATTACHMENTS: LazyLock<Mutex<Vec<Attachment>>> = LazyLock::new(Mutex::default);

fn attach(strategy: &Arc<dyn ModelRetryStrategy>, agent: &Arc<HookRegistry>) -> Result<()> {
    let mut attachments = ATTACHMENTS.lock().unwrap_or_else(PoisonError::into_inner);
    attachments.retain(|entry| entry.strategy.strong_count() > 0 && entry.agent.strong_count() > 0);
    let strategy_weak = Arc::downgrade(strategy);
    let agent_weak = Arc::downgrade(agent);
    let other_agent = attachments
        .iter()
        .any(|entry| entry.strategy.ptr_eq(&strategy_weak) && !entry.agent.ptr_eq(&agent_weak));
    if other_agent {
        return Err(Error::other(format!(
            "{}: instance is already attached to another agent. Create a separate instance per agent.",
            strategy.type_name()
        )));
    }
    attachments.push(Attachment {
        strategy: strategy_weak,
        agent: agent_weak,
    });
    Ok(())
}

/// Logs a warning for each strategy that shares its name with an earlier one.
pub(crate) fn warn_on_duplicate_retry_strategy_types(strategies: &[RetryStrategy]) {
    let mut seen: Vec<&str> = Vec::new();
    for strategy in strategies {
        let name = strategy.type_name();
        if seen.contains(&name) {
            tracing::warn!("retry_strategy_type=<{name}> | multiple instances provided; only the first will be used");
        } else {
            seen.push(name);
        }
    }
}

/// Registers a strategy's `AfterModelCallEvent` hook on the agent.
pub(crate) struct ModelRetryPlugin {
    strategy: Arc<dyn ModelRetryStrategy>,
    sleeper: SleeperSlot,
}

impl ModelRetryPlugin {
    pub(crate) fn new(strategy: RetryStrategy, sleeper: SleeperSlot) -> Self {
        let RetryStrategy::Model(strategy) = strategy;
        Self { strategy, sleeper }
    }
}

#[async_trait]
impl Plugin for ModelRetryPlugin {
    fn name(&self) -> &str {
        self.strategy.name()
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        attach(&self.strategy, agent.hooks())?;
        let strategy = self.strategy.clone();
        let sleeper = self.sleeper.clone();
        agent.add_async_hook::<AfterModelCallEvent<'_>>(move |event| {
            let strategy = strategy.clone();
            let sleeper = sleeper.read().unwrap_or_else(PoisonError::into_inner).clone();
            Box::pin(async move {
                let cancel_signal = event.agent().cancel_signal();
                let attempt = ModelAttempt {
                    error: event.error(),
                    attempt_count: event.attempt_count(),
                    retry: event.retry(),
                    cancel_signal: Some(&cancel_signal),
                };
                let retry = retry_model(strategy.as_ref(), attempt, sleeper.as_ref()).await?;
                event.set_retry(retry);
                Ok::<(), crate::Error>(())
            })
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use super::*;
    use crate::agent::InvocationState;
    use crate::error::ModelThrottledError;
    use crate::retry::{
        ConstantBackoff, ConstantBackoffOptions, DefaultModelRetryStrategy, DefaultModelRetryStrategyOptions,
    };
    use crate::test_support::{capture_logs, local_agent};
    use crate::testing::MockModel;

    #[derive(Default)]
    struct RecordingSleeper(Mutex<Vec<Duration>>);

    #[async_trait]
    impl Sleeper for RecordingSleeper {
        async fn sleep(&self, duration: Duration) {
            self.0.lock().unwrap().push(duration);
        }
    }

    fn slot(sleeper: Arc<dyn Sleeper>) -> SleeperSlot {
        Arc::new(RwLock::new(sleeper))
    }

    fn strategy(delay: Duration) -> RetryStrategy {
        let options = DefaultModelRetryStrategyOptions {
            max_attempts: 3,
            backoff: Some(Arc::new(ConstantBackoff::new(ConstantBackoffOptions { delay }))),
            ..DefaultModelRetryStrategyOptions::default()
        };
        RetryStrategy::model(DefaultModelRetryStrategy::new(options).unwrap())
    }

    #[tokio::test]
    async fn registers_an_after_model_call_event_hook() {
        let mut agent = local_agent();
        let plugin = ModelRetryPlugin::new(
            strategy(Duration::from_millis(1)),
            slot(Arc::new(RecordingSleeper::default())),
        );
        plugin.init_agent(&mut agent).await.unwrap();
        assert_eq!(agent.hooks().len(), 1);
        assert_eq!(plugin.name(), "strands:default-model-retry-strategy");
    }

    #[tokio::test]
    async fn the_hook_sleeps_through_the_agent_sleeper_and_sets_retry() {
        let mut agent = local_agent();
        let sleeper = Arc::new(RecordingSleeper::default());
        let plugin = ModelRetryPlugin::new(strategy(Duration::from_millis(500)), slot(sleeper.clone()));
        plugin.init_agent(&mut agent).await.unwrap();
        let hooks = agent.hooks().clone();
        let model: Arc<dyn crate::models::Model> = Arc::new(MockModel::new());
        let mut event = AfterModelCallEvent::new(&mut agent, InvocationState::new(), model, 1)
            .with_error(ModelThrottledError::new("rate limited").into());
        hooks.invoke(&mut event).await.unwrap();
        assert!(event.retry());
        assert_eq!(*sleeper.0.lock().unwrap(), [Duration::from_millis(500)]);
    }

    #[tokio::test]
    async fn rejects_an_instance_attached_to_another_agent() {
        let shared: Arc<dyn ModelRetryStrategy> = Arc::new(DefaultModelRetryStrategy::default());
        let sleeper: Arc<dyn Sleeper> = Arc::new(RecordingSleeper::default());
        let (mut first, mut second) = (local_agent(), local_agent());
        ModelRetryPlugin::new(shared.clone().into(), slot(sleeper.clone()))
            .init_agent(&mut first)
            .await
            .unwrap();
        ModelRetryPlugin::new(shared.clone().into(), slot(sleeper.clone()))
            .init_agent(&mut first)
            .await
            .unwrap();
        let error = ModelRetryPlugin::new(shared.into(), slot(sleeper))
            .init_agent(&mut second)
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "DefaultModelRetryStrategy: instance is already attached to another agent. Create a separate instance per agent."
        );
    }

    #[test]
    fn warns_once_per_repeated_strategy_name() {
        let strategies = vec![
            RetryStrategy::model(DefaultModelRetryStrategy::default()),
            strategy(Duration::from_millis(1)),
            RetryStrategy::model(DefaultModelRetryStrategy::default()),
        ];
        let ((), logs) = capture_logs(|| warn_on_duplicate_retry_strategy_types(&strategies));
        let warning = "retry_strategy_type=<DefaultModelRetryStrategy> | multiple instances provided; only the first will be used";
        assert_eq!(logs.matches(warning).count(), 2, "{logs}");
        assert!(logs.contains("WARN"), "{logs}");
    }
}
