use std::sync::Mutex as StdMutex;

use serde_json::json;

use super::*;
use crate::agent::is_cancelled_error;
use crate::error::BoxError;
use crate::hooks::{HookRegistry, ModelStopResponse};
use crate::models::ModelCapabilities;
use crate::models::ModelInfo;
use crate::test_support::local_agent;
use crate::testing::MockModel;
use crate::types::{ContentBlock, Role, StopReason};

fn model(text: &str) -> Arc<dyn Model> {
    Arc::new(MockModel::new().with_turn(text))
}

fn router(models: Vec<RoutingCandidate>, strategy: impl RoutingStrategy) -> ModelRouter {
    ModelRouter::new(
        models,
        ModelRouterOptions {
            strategy: Some(Arc::new(strategy)),
            max_switches: None,
        },
    )
    .unwrap()
}

/// Returns the candidates at `indexes` in turn, then declines; records every context.
#[derive(Clone, Default)]
struct Recording {
    indexes: Arc<StdMutex<Vec<usize>>>,
    contexts: Arc<StdMutex<Vec<RoutingContext>>>,
}

impl Recording {
    fn new(indexes: &[usize]) -> Self {
        Self {
            indexes: Arc::new(StdMutex::new(indexes.to_vec())),
            contexts: Arc::default(),
        }
    }

    fn contexts(&self) -> Vec<RoutingContext> {
        self.contexts.lock().unwrap().clone()
    }
}

#[async_trait]
impl RoutingStrategy for Recording {
    async fn select(&self, context: &RoutingContext) -> std::result::Result<Option<RoutingCandidate>, BoxError> {
        self.contexts.lock().unwrap().push(context.clone());
        let mut indexes = self.indexes.lock().unwrap();
        if indexes.is_empty() {
            return Ok(None);
        }
        let index = indexes.remove(0);
        Ok(context.candidates.get(index).cloned())
    }
}

struct Failing;

#[async_trait]
impl RoutingStrategy for Failing {
    async fn select(&self, _context: &RoutingContext) -> std::result::Result<Option<RoutingCandidate>, BoxError> {
        Err("nested resolution failed".into())
    }
}

fn candidate(model: Arc<dyn Model>, name: &str) -> RoutingCandidate {
    RoutingCandidate::new(RoutingCandidateOptions {
        name: Some(name.to_owned()),
        ..RoutingCandidateOptions::new(model)
    })
}

fn context(agent: &LocalAgent, state: &InvocationState) -> InvokeModelContext {
    InvokeModelContext {
        agent: agent.tool_agent(),
        model: agent.model().clone(),
        messages: agent.messages().to_vec(),
        system_prompt: agent.system_prompt().cloned(),
        tool_specs: Vec::new(),
        tool_choice: None,
        invocation_state: state.clone(),
        projected_input_tokens: None,
        dynamic_trailing_blocks: None,
        structured_output_schema: None,
        deferred_tools: std::collections::HashSet::new(),
        invocation_context: None,
    }
}

fn agent_with_message() -> LocalAgent {
    let mut agent = local_agent();
    agent
        .messages_mut()
        .push(Message::new(Role::User, vec![ContentBlock::text("hello")]));
    agent
}

async fn open(attachment: &RouterAttachment, agent: &LocalAgent) -> Arc<dyn Model> {
    attachment
        .select(context(agent, &InvocationState::new()))
        .await
        .unwrap()
        .model
}

/// Fires a failed `AfterModelCallEvent` through the routing hook; returns whether it retried.
async fn fail(attachment: &RouterAttachment, agent: &mut LocalAgent, error: Error) -> bool {
    let model = attachment.routed_model().unwrap();
    let mut event = AfterModelCallEvent::new(agent, InvocationState::new(), model, 1).with_error(error);
    attachment.on_model_result(&mut event).await;
    event.retry()
}

async fn succeed(attachment: &RouterAttachment, agent: &mut LocalAgent) {
    let model = attachment.routed_model().unwrap();
    let message = Message::new(Role::Assistant, vec![ContentBlock::text("ok")]);
    let mut event = AfterModelCallEvent::new(agent, InvocationState::new(), model, 1)
        .with_stop_data(ModelStopResponse::new(message, StopReason::EndTurn));
    attachment.on_model_result(&mut event).await;
}

fn down() -> Error {
    Error::other("down")
}

fn routed_is(attachment: &RouterAttachment, model: &Arc<dyn Model>) -> bool {
    attachment
        .routed_model()
        .is_some_and(|routed| same_model(&routed, model))
}

#[test]
fn freezes_candidate_topology_while_preserving_model_and_candidate_identity() {
    let selected_model = model("ok");
    let selected = RoutingCandidate::new(RoutingCandidateOptions {
        name: Some("vision".into()),
        description: Some("Handles images".into()),
        ..RoutingCandidateOptions::new(selected_model.clone())
    });
    let router = ModelRouter::new([selected.clone()], ModelRouterOptions::default()).unwrap();
    assert_eq!(router.candidates(), std::slice::from_ref(&selected));
    assert!(matches!(selected.model(), CandidateModel::Model(model) if same_model(model, &selected_model)));
}

#[test]
fn preserves_caller_metadata_and_validates_that_it_is_a_json_serializable_object() {
    let mut metadata = JsonObject::new();
    metadata.insert("modelId".into(), json!("fast-v1"));
    metadata.insert("supportsToolUse".into(), json!(true));
    let candidate = RoutingCandidate::new(RoutingCandidateOptions {
        metadata: Some(metadata.clone()),
        ..RoutingCandidateOptions::new(model("ok"))
    });
    assert_eq!(candidate.metadata(), Some(&metadata));
}

#[test]
fn normalizes_models_and_exposes_stable_plugin_configuration() {
    let first = model("first");
    let nested_default = model("nested");
    let nested = ModelRouter::new([nested_default.clone()], ModelRouterOptions::default()).unwrap();
    let router = ModelRouter::new(
        [
            RoutingCandidate::from(first.clone()),
            RoutingCandidate::from(nested.clone()),
        ],
        ModelRouterOptions::default(),
    )
    .unwrap();
    assert_eq!(router.name(), "strands:model-router");
    assert_eq!(router.candidates().len(), 2);
    assert!(same_model(&router.default_model(), &first));
    let wrapped = ModelRouter::new([nested], ModelRouterOptions::default()).unwrap();
    assert!(same_model(&wrapped.default_model(), &nested_default));
}

#[test]
fn rejects_empty_models() {
    let error = ModelRouter::new(Vec::<RoutingCandidate>::new(), ModelRouterOptions::default())
        .err()
        .unwrap();
    assert_eq!(error.to_string(), "ModelRouter requires at least one candidate model");
}

#[test]
fn rejects_stateful_models_and_duplicate_topology() {
    let stateful = MockModel::new();
    stateful
        .update_config(crate::models::BaseModelConfig {
            model_info: Some(ModelInfo {
                capabilities: ModelCapabilities {
                    stateful: Some(true),
                    ..Default::default()
                },
                ..Default::default()
            }),
            ..stateful.get_config()
        })
        .unwrap();
    let error = |models: Vec<RoutingCandidate>| {
        ModelRouter::new(models, ModelRouterOptions::default())
            .err()
            .unwrap()
            .to_string()
    };
    assert_eq!(
        error(vec![stateful.into()]),
        "candidate=<test-model> is stateful; routing among stateful models is not supported"
    );
    let shared = model("ok");
    assert_eq!(
        error(vec![shared.clone().into(), shared.clone().into()]),
        "candidate=<test-model> repeats a model already routed to; construct a separate instance so each candidate has its own health"
    );
    let duplicate = candidate(model("ok"), "same");
    assert_eq!(
        error(vec![duplicate.clone(), duplicate]),
        "duplicate RoutingCandidate instance"
    );
    assert_eq!(
        error(vec![candidate(model("ok"), "same"), candidate(model("ok"), "same")]),
        "duplicate candidate name=<same>"
    );
    let nested = ModelRouter::new([shared.clone()], ModelRouterOptions::default()).unwrap();
    assert!(error(vec![shared.into(), nested.into()]).contains("repeats a model"));
}

#[tokio::test]
async fn selects_once_per_agent_and_invocation_while_supplying_fresh_isolated_request_copies() {
    let (first, second) = (model("first"), model("second"));
    let strategy = Recording::new(&[1, 0]);
    let router = router(vec![first.clone().into(), second.clone().into()], strategy.clone());
    let mut agent = agent_with_message();
    agent.set_system_prompt(Some("Be precise".into()));
    let attachment = RouterAttachment::attach(router.clone(), &agent);

    let selected = open(&attachment, &agent).await;
    let cached = open(&attachment, &agent).await;

    assert!(same_model(&selected, &second));
    assert!(same_model(&cached, &second));
    let contexts = strategy.contexts();
    assert_eq!(contexts.len(), 1);
    assert_eq!(contexts[0].system_prompt, Some("Be precise".into()));
    assert_eq!(contexts[0].messages[0].text(), "hello");
    assert_eq!(contexts[0].candidates[1], router.candidates()[1]);
}

#[tokio::test]
async fn keys_cached_state_by_router_and_agent_object_identity_rather_than_caller_id() {
    let first = model("first");
    let strategy = Recording::new(&[0, 0, 0]);
    let router_one = router(vec![first.clone().into()], strategy.clone());
    let router_two = router(vec![model("other").into()], strategy.clone());
    let (one, two) = (local_agent(), local_agent());
    let attachments = [
        RouterAttachment::attach(router_one.clone(), &one),
        RouterAttachment::attach(router_one, &two),
        RouterAttachment::attach(router_two, &one),
    ];
    for attachment in &attachments {
        open(attachment, &one).await;
    }
    assert_eq!(strategy.contexts().len(), 3);
}

#[tokio::test]
async fn registers_idempotent_middleware_routing_hook_and_scoped_boundary_cleanup() {
    let (first, second) = (model("first"), model("second"));
    let router = router(vec![first.into(), second.clone().into()], Recording::new(&[1]));
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    let hooks: Arc<HookRegistry> = agent.hooks().clone();
    assert_eq!(agent.middleware().len::<InvokeModelStage>(), 1);
    assert_eq!(
        hooks.orders::<AfterModelCallEvent<'static>>(),
        [HookOrder::MODEL_ROUTING]
    );

    let selected = open(&attachment, &agent).await;
    assert!(same_model(&selected, &second));

    let state = InvocationState::new();
    let mut before = BeforeInvocationEvent::new(&mut agent, state, Vec::new());
    hooks.invoke(&mut before).await.unwrap();
    assert!(attachment.routed_model().is_none());
}

#[tokio::test]
async fn ignores_cancellation_without_recording_a_failure_or_selecting_another_candidate() {
    let (first, second) = (model("first"), model("second"));
    let strategy = Recording::new(&[0, 1]);
    let router = router(vec![first.clone().into(), second.clone().into()], strategy.clone());
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router.clone(), &agent);
    open(&attachment, &agent).await;

    let cancelled = crate::agent::cancelled_error();
    assert!(is_cancelled_error(&cancelled));
    assert!(!fail(&attachment, &mut agent, cancelled).await);
    assert!(routed_is(&attachment, &first));
    assert_eq!(strategy.contexts().len(), 1);

    assert!(fail(&attachment, &mut agent, down()).await);
    let attempts = &strategy.contexts()[1].attempts;
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].candidate, router.candidates()[0]);
    assert_eq!(attempts[0].exception, Some(RoutingFailure::new("Error", "down")));
    assert!(routed_is(&attachment, &second));
}

#[tokio::test]
async fn records_complete_outcomes_switches_once_and_opens_a_new_round_after_success() {
    let (first, second) = (model("first"), model("second"));
    let strategy = Recording::new(&[0, 1, 0]);
    let router = router(vec![first.clone().into(), second.clone().into()], strategy.clone());
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router.clone(), &agent);
    open(&attachment, &agent).await;

    assert!(fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &second));
    succeed(&attachment, &mut agent).await;
    assert!(fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &first));

    let attempts: Vec<usize> = strategy
        .contexts()
        .iter()
        .map(|context| context.attempts.len())
        .collect();
    assert_eq!(attempts, [0, 1, 3]);
    assert_eq!(strategy.contexts()[1].attempts[0].candidate, router.candidates()[0]);
}

fn broken_nested() -> RoutingCandidate {
    let nested = ModelRouter::new(
        [model("nested")],
        ModelRouterOptions {
            strategy: Some(Arc::new(Failing)),
            max_switches: None,
        },
    )
    .unwrap();
    RoutingCandidate::new(RoutingCandidateOptions {
        name: Some("broken".into()),
        ..RoutingCandidateOptions::new(nested)
    })
}

#[tokio::test]
async fn consumes_an_unresolvable_nested_candidate_and_continues_to_a_healthy_candidate() {
    let (first, backup) = (model("first"), model("backup"));
    let strategy = Recording::new(&[0, 1, 2]);
    let router = router(
        vec![first.into(), broken_nested(), backup.clone().into()],
        strategy.clone(),
    );
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router.clone(), &agent);
    open(&attachment, &agent).await;

    assert!(fail(&attachment, &mut agent, down()).await);

    assert!(routed_is(&attachment, &backup));
    let attempts = &strategy.contexts()[2].attempts;
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].candidate, router.candidates()[0]);
    assert_eq!(attempts[1].candidate, router.candidates()[1]);
    assert_eq!(
        attempts[1].exception,
        Some(RoutingFailure::new("Error", "nested resolution failed"))
    );
}

#[tokio::test]
async fn stops_when_a_strategy_repeats_an_unresolvable_candidate_in_the_same_round() {
    let first = model("first");
    let strategy = Recording::new(&[0, 1, 1, 2]);
    let router = router(
        vec![first.clone().into(), broken_nested(), model("backup").into()],
        strategy.clone(),
    );
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    open(&attachment, &agent).await;

    assert!(!fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &first));
    assert_eq!(strategy.contexts().len(), 3);
}

#[tokio::test]
async fn does_not_replace_a_pending_model_error_when_strategy_selection_fails_or_repeats_a_used_candidate() {
    struct FailSecond(StdMutex<u32>);

    #[async_trait]
    impl RoutingStrategy for FailSecond {
        async fn select(&self, context: &RoutingContext) -> std::result::Result<Option<RoutingCandidate>, BoxError> {
            let mut calls = self.0.lock().unwrap();
            *calls += 1;
            if *calls == 2 {
                return Err("routing failure".into());
            }
            Ok(context.candidates.first().cloned())
        }
    }

    let router = router(
        vec![model("first").into(), model("backup").into()],
        FailSecond(StdMutex::new(0)),
    );
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router.clone(), &agent);
    open(&attachment, &agent).await;
    assert!(!fail(&attachment, &mut agent, Error::other("original model error")).await);

    let repeat = RouterAttachment::attach(router, &agent);
    open(&repeat, &agent).await;
    assert!(!fail(&repeat, &mut agent, down()).await);
}

fn capped(models: Vec<RoutingCandidate>, strategy: Recording, max_switches: u32) -> ModelRouter {
    ModelRouter::new(
        models,
        ModelRouterOptions {
            strategy: Some(Arc::new(strategy)),
            max_switches: Some(max_switches),
        },
    )
    .unwrap()
}

#[tokio::test]
async fn honors_max_switches_as_a_cap_on_successful_switches() {
    let first = model("first");
    let strategy = Recording::new(&[0, 1]);
    let router = capped(vec![first.clone().into(), model("second").into()], strategy.clone(), 0);
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    open(&attachment, &agent).await;

    assert!(!fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &first));
    assert_eq!(strategy.contexts().len(), 1);
}

#[tokio::test]
async fn allows_exactly_max_switches_successful_candidate_changes() {
    let (first, second, third) = (model("first"), model("second"), model("third"));
    let strategy = Recording::new(&[0, 1, 2]);
    let router = capped(
        vec![first.into(), second.clone().into(), third.into()],
        strategy.clone(),
        1,
    );
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    open(&attachment, &agent).await;

    assert!(fail(&attachment, &mut agent, down()).await);
    assert!(!fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &second));
    assert_eq!(strategy.contexts().len(), 2);
}

#[tokio::test]
async fn bounds_a_failure_round_when_a_strategy_cycles_to_an_already_used_candidate() {
    let (first, second) = (model("first"), model("second"));
    let router = router(vec![first.into(), second.clone().into()], Recording::new(&[0, 1, 0]));
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    open(&attachment, &agent).await;

    assert!(fail(&attachment, &mut agent, down()).await);
    assert!(!fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &second));
}

#[tokio::test]
async fn keeps_the_successful_candidate_used_when_opening_the_next_failure_round() {
    let (first, second) = (model("first"), model("second"));
    let router = router(vec![first.into(), second.clone().into()], Recording::new(&[0, 1, 1]));
    let mut agent = local_agent();
    let attachment = RouterAttachment::attach(router, &agent);
    open(&attachment, &agent).await;

    assert!(fail(&attachment, &mut agent, down()).await);
    succeed(&attachment, &mut agent).await;
    assert!(!fail(&attachment, &mut agent, down()).await);
    assert!(routed_is(&attachment, &second));
}

#[tokio::test]
async fn uses_the_default_on_decline_and_propagates_invalid_opening_results() {
    struct Foreign;

    #[async_trait]
    impl RoutingStrategy for Foreign {
        async fn select(&self, _context: &RoutingContext) -> std::result::Result<Option<RoutingCandidate>, BoxError> {
            Ok(Some(RoutingCandidate::from(model("foreign"))))
        }
    }

    let first = model("first");
    let agent = local_agent();
    let declining = RouterAttachment::attach(router(vec![first.clone().into()], Recording::new(&[])), &agent);
    assert!(same_model(&open(&declining, &agent).await, &first));

    let invalid = RouterAttachment::attach(router(vec![first.into()], Foreign), &agent);
    let error = invalid
        .select(context(&agent, &InvocationState::new()))
        .await
        .err()
        .unwrap();
    assert_eq!(
        error.to_string(),
        "strategy.select must return a candidate from context.candidates"
    );
}

#[test]
fn strategy_names_are_the_type_names() {
    assert_eq!(FallbackStrategy.name(), "FallbackStrategy");
    assert_eq!(Recording::default().name(), "Recording");
}

#[tokio::test]
async fn forwards_the_agent_metadata_to_the_routed_alternate() {
    let primary = MockModel::new().with_turn("primary");
    let alternate = MockModel::new().with_turn("alternate");
    let router = router(
        vec![
            (Arc::new(primary.clone()) as Arc<dyn Model>).into(),
            (Arc::new(alternate.clone()) as Arc<dyn Model>).into(),
        ],
        Recording::new(&[1]),
    );
    let mut agent = crate::Agent::builder()
        .model(router)
        .retry_strategy(Vec::new())
        .printer(false)
        .build()
        .unwrap();
    agent
        .local
        .set_agent_metadata(Some(crate::types::AgentMetadata::new().with_session_id("routed")));

    agent.invoke("hello").await.unwrap();

    assert_eq!(
        alternate.requests()[0].agent_metadata,
        Some(crate::types::AgentMetadata::new().with_session_id("routed"))
    );
    assert!(primary.requests().is_empty());
}
