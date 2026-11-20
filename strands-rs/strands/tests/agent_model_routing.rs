//! Model routing through the agent.
//!
//! A `ModelRouter` is not a `Plugin`, so passing one in `plugins` is a compile error. The
//! agent-metadata case is in the crate's router tests, because nothing public sets the agent's session id yet.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test helpers report failures by panicking"
)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use strands::hooks::{AfterModelCallEvent, BeforeModelCallEvent, HookCallbackOptions, HookOrder};
use strands::middleware::InvokeModelStage;
use strands::models::routing::{ModelRouter, ModelRouterOptions, RoutingCandidate, RoutingContext, RoutingStrategy};
use strands::testing::{MockModel, MockTurn};
use strands::{
    Agent, BoxError, ConstantBackoff, ConstantBackoffOptions, ContentBlock, DefaultModelRetryStrategy,
    DefaultModelRetryStrategyOptions, Error, InvocationState, InvokeOptions, Model, RetryStrategy, async_trait,
};

#[derive(Clone, Default)]
struct Indexed {
    indexes: Arc<Mutex<Vec<usize>>>,
    asks: Arc<Mutex<usize>>,
}

impl Indexed {
    fn new(indexes: &[usize]) -> Self {
        Self {
            indexes: Arc::new(Mutex::new(indexes.to_vec())),
            asks: Arc::default(),
        }
    }

    fn asks(&self) -> usize {
        *self.asks.lock().unwrap()
    }
}

#[async_trait]
impl RoutingStrategy for Indexed {
    async fn select(&self, context: &RoutingContext) -> Result<Option<RoutingCandidate>, BoxError> {
        *self.asks.lock().unwrap() += 1;
        let mut indexes = self.indexes.lock().unwrap();
        if indexes.is_empty() {
            return Ok(None);
        }
        Ok(context.candidates.get(indexes.remove(0)).cloned())
    }
}

fn response(text: &str) -> MockModel {
    MockModel::new().with_turn(text)
}

fn failing(message: &'static str) -> MockModel {
    MockModel::new().with_turn(MockTurn::error(move || Error::other(message)))
}

fn shared(model: &MockModel) -> Arc<dyn Model> {
    Arc::new(model.clone())
}

fn same(a: &Arc<dyn Model>, b: &Arc<dyn Model>) -> bool {
    std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b))
}

fn router(models: Vec<Arc<dyn Model>>, strategy: Option<Indexed>, max_switches: Option<u32>) -> ModelRouter {
    ModelRouter::new(
        models,
        ModelRouterOptions {
            strategy: strategy.map(|strategy| Arc::new(strategy) as Arc<dyn RoutingStrategy>),
            max_switches,
        },
    )
    .unwrap()
}

fn agent(router: ModelRouter) -> Agent {
    Agent::builder()
        .model(router)
        .retry_strategy(Vec::new())
        .printer(false)
        .build()
        .unwrap()
}

type Models = Arc<Mutex<Vec<Arc<dyn Model>>>>;
type Attempts = Arc<Mutex<Vec<(Arc<dyn Model>, u32, bool)>>>;

#[tokio::test]
async fn invokes_the_opening_selection_while_retaining_the_default_model() {
    let (first, second) = (response("first"), response("second"));
    let (first_model, second_model) = (shared(&first), shared(&second));
    let mut agent = agent(router(
        vec![first_model.clone(), second_model.clone()],
        Some(Indexed::new(&[1])),
        None,
    ));
    let before: Models = Arc::default();
    let after: Models = Arc::default();
    let before_log = before.clone();
    agent.add_hook(move |event: &mut BeforeModelCallEvent<'_>| before_log.lock().unwrap().push(event.model().clone()));
    let after_log = after.clone();
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| after_log.lock().unwrap().push(event.model().clone()));

    let result = agent.invoke("hello").await.unwrap();

    assert!(same(agent.model(), &first_model));
    assert_eq!(result.last_message().content[0], ContentBlock::text("second"));
    assert_eq!((first.requests().len(), second.requests().len()), (0, 1));
    assert!(same(&before.lock().unwrap()[0], &first_model));
    assert!(same(&after.lock().unwrap()[0], &second_model));
}

#[tokio::test]
async fn falls_back_after_a_non_retryable_failure_and_resets_the_attempt_count() {
    let (first, second) = (shared(&failing("primary down")), shared(&response("recovered")));
    let mut agent = agent(router(vec![first.clone(), second.clone()], None, None));
    let attempts: Attempts = Arc::default();
    let log = attempts.clone();
    agent.add_hook_with(
        move |event: &mut AfterModelCallEvent<'_>| {
            log.lock()
                .unwrap()
                .push((event.model().clone(), event.attempt_count(), event.retry()));
        },
        HookCallbackOptions {
            order: HookOrder::SDK_LAST,
        },
    );

    let result = agent.invoke("hello").await.unwrap();

    assert_eq!(result.last_message().content[0], ContentBlock::text("recovered"));
    let attempts = attempts.lock().unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(same(&attempts[0].0, &first) && attempts[0].1 == 1 && attempts[0].2);
    assert!(same(&attempts[1].0, &second) && attempts[1].1 == 1 && !attempts[1].2);
}

#[tokio::test(start_paused = true)]
async fn lets_the_normal_retry_strategy_retry_before_routing() {
    let primary = MockModel::new()
        .with_turn(MockTurn::throttled("try again"))
        .with_turn("primary recovered");
    let backup = response("backup");
    let retry = DefaultModelRetryStrategy::new(DefaultModelRetryStrategyOptions {
        max_attempts: 2,
        backoff: Some(Arc::new(ConstantBackoff::new(ConstantBackoffOptions {
            delay: Duration::from_millis(1),
        }))),
        ..DefaultModelRetryStrategyOptions::default()
    })
    .unwrap();
    let mut agent = Agent::builder()
        .model(router(vec![shared(&primary), shared(&backup)], None, None))
        .retry_strategy(vec![RetryStrategy::model(retry)])
        .printer(false)
        .build()
        .unwrap();

    let result = agent.invoke("hello").await.unwrap();

    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("primary recovered")
    );
    assert_eq!((primary.requests().len(), backup.requests().len()), (2, 0));
}

fn replace_model(replacement: Arc<dyn Model>) -> strands::middleware::Middleware<InvokeModelStage> {
    InvokeModelStage::wrap(move |mut context, next| {
        context.model = replacement.clone();
        next.call(context)
    })
}

fn failed_model_log(agent: &mut Agent) -> Arc<Mutex<Option<Arc<dyn Model>>>> {
    let failed: Arc<Mutex<Option<Arc<dyn Model>>>> = Arc::default();
    let log = failed.clone();
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| {
        if event.error().is_some() {
            *log.lock().unwrap() = Some(event.model().clone());
        }
    });
    failed
}

#[tokio::test]
async fn reports_a_downstream_middleware_model_on_failure() {
    let replacement = shared(&failing("middleware model failed"));
    let mut agent = agent(router(vec![shared(&response("selected"))], None, Some(0)));
    agent.add_middleware(replace_model(replacement.clone()));
    let failed = failed_model_log(&mut agent);

    let error = agent.invoke("hello").await.err().unwrap();

    assert_eq!(error.to_string(), "middleware model failed");
    assert!(same(failed.lock().unwrap().as_ref().unwrap(), &replacement));
}

#[tokio::test]
async fn reports_a_routed_model_when_later_input_middleware_fails_before_invocation() {
    let (first, selected) = (response("first"), response("selected"));
    let selected_model = shared(&selected);
    let mut agent = agent(router(
        vec![shared(&first), selected_model.clone()],
        Some(Indexed::new(&[1])),
        None,
    ));
    let expected = selected_model.clone();
    agent.add_middleware(InvokeModelStage::input(move |context| {
        let routed = same(&context.model, &expected);
        async move {
            assert!(routed);
            Err(Error::other("input middleware failed").into())
        }
    }));
    let failed = failed_model_log(&mut agent);

    let error = agent.invoke("hello").await.err().unwrap();

    assert_eq!(error.to_string(), "input middleware failed");
    assert!(same(failed.lock().unwrap().as_ref().unwrap(), &selected_model));
    assert_eq!((first.requests().len(), selected.requests().len()), (0, 0));
}

#[tokio::test]
async fn increments_attempt_counts_when_middleware_changes_the_model_without_a_route_switch() {
    let replacement = MockModel::new()
        .with_turn(MockTurn::error(|| Error::other("first failure")))
        .with_turn(MockTurn::error(|| Error::other("second failure")))
        .with_turn("replacement recovered");
    let mut agent = agent(router(vec![shared(&response("selected"))], None, None));
    agent.add_middleware(replace_model(shared(&replacement)));
    let counts: Arc<Mutex<Vec<u32>>> = Arc::default();
    let log = counts.clone();
    agent.add_hook(move |event: &mut AfterModelCallEvent<'_>| {
        log.lock().unwrap().push(event.attempt_count());
        if event.error().is_some() {
            event.set_retry(true);
        }
    });

    let result = agent.invoke("hello").await.unwrap();

    assert_eq!(
        result.last_message().content[0],
        ContentBlock::text("replacement recovered")
    );
    assert_eq!(*counts.lock().unwrap(), [1, 2, 3]);
}

#[tokio::test]
async fn clears_routing_state_between_invocations_that_reuse_the_same_state_object() {
    let strategy = Indexed::new(&[0, 1]);
    let mut agent = agent(router(
        vec![shared(&response("first")), shared(&response("second"))],
        Some(strategy.clone()),
        None,
    ));
    let state = InvocationState::new();
    let options = || InvokeOptions {
        invocation_state: Some(state.clone()),
        ..Default::default()
    };

    let first = agent.invoke_with("one", options()).await.unwrap();
    let second = agent.invoke_with("two", options()).await.unwrap();

    assert_eq!(first.last_message().content[0], ContentBlock::text("first"));
    assert_eq!(second.last_message().content[0], ContentBlock::text("second"));
    assert_eq!(strategy.asks(), 2);
}

#[tokio::test]
async fn treats_a_nested_router_as_one_opaque_candidate_during_fallback() {
    let (inner_failure, inner_spare, outer_backup) =
        (failing("inner down"), response("inner spare"), response("outer backup"));
    let inner = router(vec![shared(&inner_failure), shared(&inner_spare)], None, None);
    let mut agent = agent(
        ModelRouter::new(
            [
                RoutingCandidate::from(inner),
                RoutingCandidate::from(shared(&outer_backup)),
            ],
            ModelRouterOptions::default(),
        )
        .unwrap(),
    );

    let result = agent.invoke("hello").await.unwrap();

    assert_eq!(result.last_message().content[0], ContentBlock::text("outer backup"));
    assert_eq!(
        (
            inner_failure.requests().len(),
            inner_spare.requests().len(),
            outer_backup.requests().len()
        ),
        (1, 0, 1)
    );
}

/// The plugin-rejection half is a compile error: `ModelRouter` is not a `Plugin`.
#[tokio::test]
async fn honors_max_switches_zero_and_rejects_plugin_attachment() {
    let mut agent = agent(router(
        vec![shared(&failing("primary down")), shared(&response("backup"))],
        None,
        Some(0),
    ));

    let error = agent.invoke("hello").await.err().unwrap();

    assert_eq!(error.to_string(), "primary down");
}

#[test]
fn aux_model_rejects_a_router() {
    let error = Agent::builder()
        .model(response("main"))
        .aux_model(router(vec![shared(&response("aux"))], None, None))
        .printer(false)
        .build()
        .err()
        .unwrap();
    assert_eq!(
        error.to_string(),
        "auxModel must be a Model or a Bedrock model id, not a ModelRouter"
    );
}

#[test]
fn set_model_rejects_a_router() {
    let mut agent = Agent::builder().model(response("main")).printer(false).build().unwrap();
    let error = agent
        .set_model(router(vec![shared(&response("other"))], None, None))
        .err()
        .unwrap();
    assert_eq!(
        error.to_string(),
        "a ModelRouter is accepted only as the agent's configured model, not by set_model"
    );
}
