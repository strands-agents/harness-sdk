//! The retry strategies an agent installs and the `AfterModelCallEvent` hook they register. Time
//! is paused, so backoff waits advance the tokio clock instead of the wall clock.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use strands::hooks::AfterModelCallEvent;
use strands::testing::{MockModel, MockTurn};
use strands::{
    Agent, CancelHandle, CancelOptions, ConstantBackoff, ConstantBackoffOptions, ContentBlock,
    DefaultModelRetryStrategy, DefaultModelRetryStrategyOptions, Error, InvokeOptions, ModelNetworkError,
    ModelRetryContext, ModelRetryStrategy, RetryDecision, RetryStrategy, StopReason,
};

fn throttled(message: &'static str) -> MockTurn {
    MockTurn::throttled(message)
}

fn strategy(max_attempts: u32, delay: Duration) -> RetryStrategy {
    let options = DefaultModelRetryStrategyOptions {
        max_attempts,
        backoff: Some(Arc::new(ConstantBackoff::new(ConstantBackoffOptions { delay }))),
        ..DefaultModelRetryStrategyOptions::default()
    };
    RetryStrategy::model(DefaultModelRetryStrategy::new(options).unwrap())
}

fn agent(model: MockModel, retry_strategy: Option<Vec<RetryStrategy>>) -> Agent {
    let builder = Agent::builder().model(model).printer(false);
    match retry_strategy {
        Some(strategies) => builder.retry_strategy(strategies).build().unwrap(),
        None => builder.build().unwrap(),
    }
}

fn first_text(result: &strands::AgentResult) -> ContentBlock {
    result.last_message().content[0].clone()
}

#[tokio::test(start_paused = true)]
async fn retries_model_calls_that_throw_model_throttled_error() {
    let model = MockModel::new().with_turn(throttled("rate limited")).with_turn("ok");
    let mut agent = agent(model, Some(vec![strategy(3, Duration::from_millis(1))]));
    let result = agent.invoke("hi").await.unwrap();
    assert_eq!(first_text(&result), ContentBlock::text("ok"));
}

#[tokio::test(start_paused = true)]
async fn interrupts_retry_backoff_on_cancellation_without_another_model_call() {
    let model = MockModel::new()
        .with_turn(throttled("rate limited"))
        .with_turn("unexpected retry");
    let mut agent = agent(model.clone(), Some(vec![strategy(3, Duration::from_secs(5))]));
    let controller = CancelHandle::new();
    let options = InvokeOptions {
        cancel_signal: Some(controller.signal()),
        ..InvokeOptions::default()
    };
    let started = tokio::time::Instant::now();

    let (result, ()) = tokio::join!(agent.invoke_with("hi", options), async {
        tokio::time::sleep(Duration::from_millis(499)).await;
        assert_eq!(model.call_count(), 1);
        controller.cancel(CancelOptions::default());
    });

    let result = result.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Cancelled);
    assert_eq!(model.call_count(), 1);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn does_not_retry_non_throttling_errors() {
    let model = MockModel::new().with_turn(MockTurn::error(|| Error::other("boom")));
    let mut agent = agent(model.clone(), Some(vec![strategy(3, Duration::from_millis(1))]));
    let error = agent.invoke("hi").await.unwrap_err();
    assert_eq!(error.to_string(), "boom");
    assert_eq!(model.requests().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn installs_a_default_default_model_retry_strategy_when_none_is_provided() {
    let model = MockModel::new()
        .with_turn(throttled("throttled 1"))
        .with_turn(throttled("throttled 2"))
        .with_turn("ok");
    let mut agent = agent(model, None);
    let result = agent.invoke("hi").await.unwrap();
    assert_eq!(first_text(&result), ContentBlock::text("ok"));
}

#[tokio::test(start_paused = true)]
async fn retries_model_calls_that_throw_model_network_error_with_the_default_strategy() {
    let model = MockModel::new()
        .with_turn(MockTurn::error(|| {
            ModelNetworkError::new("Language model stream error: Failed to fetch").into()
        }))
        .with_turn("ok");
    let mut agent = agent(model, None);
    let result = agent.invoke("hi").await.unwrap();
    assert_eq!(first_text(&result), ContentBlock::text("ok"));
}

#[tokio::test(start_paused = true)]
async fn gives_up_once_max_attempts_is_exceeded() {
    let model = MockModel::new()
        .with_turn(throttled("throttled 1"))
        .with_turn(throttled("throttled 2"))
        .with_turn(throttled("throttled 3"));
    let mut agent = agent(model.clone(), Some(vec![strategy(2, Duration::from_millis(1))]));
    let error = agent.invoke("hi").await.unwrap_err();
    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    assert_eq!(model.call_count(), 2);
}

#[tokio::test(start_paused = true)]
async fn disables_retries_when_retry_strategy_is_null() {
    let model = MockModel::new().with_turn(throttled("throttled"));
    let mut agent = agent(model, Some(Vec::new()));
    let error = agent.invoke("hi").await.unwrap_err();
    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
}

#[tokio::test(start_paused = true)]
async fn disables_retries_when_retry_strategy_is_an_empty_array() {
    let model = MockModel::new()
        .with_turn(throttled("throttled"))
        .with_turn("unreachable");
    let mut agent = agent(model.clone(), Some(Vec::new()));
    let error = agent.invoke("hi").await.unwrap_err();
    assert!(matches!(error, Error::ModelThrottled(_)), "{error:?}");
    assert_eq!(model.call_count(), 1);
}

struct NoopRetryStrategy;

#[strands::async_trait]
impl ModelRetryStrategy for NoopRetryStrategy {
    fn name(&self) -> &str {
        "test:noop-retry-strategy"
    }

    async fn compute_retry_decision(&self, _context: &ModelRetryContext<'_>) -> strands::Result<RetryDecision> {
        Ok(RetryDecision::NoRetry)
    }
}

#[tokio::test(start_paused = true)]
async fn accepts_an_array_of_distinct_retry_strategy_types() {
    let model = MockModel::new().with_turn(throttled("throttled")).with_turn("ok");
    let strategies = vec![
        strategy(3, Duration::from_millis(1)),
        RetryStrategy::model(NoopRetryStrategy),
    ];
    let mut agent = agent(model, Some(strategies));
    let result = agent.invoke("hi").await.unwrap();
    assert_eq!(first_text(&result), ContentBlock::text("ok"));
}

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn warns_when_two_retry_strategies_of_the_same_type_are_provided() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    tracing::subscriber::with_default(subscriber, || {
        tracing::callsite::rebuild_interest_cache();
        let strategies = vec![
            RetryStrategy::model(DefaultModelRetryStrategy::default()),
            RetryStrategy::model(DefaultModelRetryStrategy::default()),
        ];
        agent(MockModel::new(), Some(strategies));
    });
    let logs = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(
        logs.contains(
            "retry_strategy_type=<DefaultModelRetryStrategy> | multiple instances provided; only the first will be used"
        ),
        "{logs}"
    );
}

#[tokio::test(start_paused = true)]
async fn respects_a_user_hook_that_already_set_retry_true_no_double_wait_no_double_increment() {
    let model = MockModel::new().with_turn(throttled("throttled")).with_turn("ok");
    let mut agent = agent(model.clone(), Some(vec![strategy(2, Duration::from_secs(10))]));
    agent.add_hook(|event: &mut AfterModelCallEvent<'_>| {
        if matches!(event.error(), Some(Error::ModelThrottled(_))) {
            event.set_retry(true);
        }
    });
    let result = agent.invoke("hi").await.unwrap();
    assert_eq!(first_text(&result), ContentBlock::text("ok"));
    assert_eq!(model.call_count(), 2);
}

#[tokio::test]
async fn throws_if_the_same_instance_is_attached_to_two_agents() {
    let shared: Arc<dyn ModelRetryStrategy> = Arc::new(DefaultModelRetryStrategy::default());
    let mut agent1 = agent(
        MockModel::from_turns(["ok"]),
        Some(vec![RetryStrategy::from(shared.clone())]),
    );
    agent1.invoke("hi").await.unwrap();

    let mut agent2 = agent(MockModel::from_turns(["ok"]), Some(vec![RetryStrategy::from(shared)]));
    let error = agent2.invoke("hi").await.unwrap_err();
    assert!(
        error.to_string().contains("already attached to another agent"),
        "{error}"
    );
    assert_eq!(
        error.to_string(),
        "DefaultModelRetryStrategy: instance is already attached to another agent. Create a separate instance per agent."
    );
}

#[tokio::test]
async fn an_instance_freed_by_its_dropped_agent_attaches_to_another() {
    let shared: Arc<dyn ModelRetryStrategy> = Arc::new(DefaultModelRetryStrategy::default());
    let mut agent1 = agent(
        MockModel::from_turns(["ok"]),
        Some(vec![RetryStrategy::from(shared.clone())]),
    );
    agent1.invoke("hi").await.unwrap();
    drop(agent1);

    let mut agent2 = agent(MockModel::from_turns(["ok"]), Some(vec![RetryStrategy::from(shared)]));
    agent2.invoke("hi").await.unwrap();
}
