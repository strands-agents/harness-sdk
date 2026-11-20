use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::agent::{Agent, InvokeOptions, LocalAgent};
use crate::test_support::{MockTool, local_agent};
use crate::testing::{MockModel, MockTurn};
use crate::tools::ToolOutcome;
use crate::types::{ContentBlock, StopReason, ToolResultBlock, ToolUse, ToolUseBlock};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/vended_interventions/cedar/testdata");

fn fixture(name: &str) -> String {
    format!("{FIXTURES}/{name}")
}

fn entities() -> CedarEntities {
    vec![
        json!({"uid": {"type": "Resource", "id": "agent"}, "attrs": {}, "parents": []}),
        json!({"uid": {"type": "User", "id": "alice"}, "attrs": {"role": "admin"}, "parents": []}),
        json!({"uid": {"type": "User", "id": "bob"}, "attrs": {"role": "analyst"}, "parents": []}),
        json!({"uid": {"type": "User", "id": "eve"}, "attrs": {"role": "viewer"}, "parents": []}),
    ]
    .into()
}

#[derive(Clone)]
struct UserId(String);

#[derive(Clone)]
struct Environment(String);

fn user(id: &'static str) -> Option<PrincipalResolver> {
    Some(PrincipalResolver::new(move |_| Ok(Some(TypeAndId::new("User", id)))))
}

fn user_from_state(entity_type: &'static str) -> Option<PrincipalResolver> {
    Some(PrincipalResolver::new(move |state: &InvocationState| {
        Ok(state.get::<UserId>().map(|user| TypeAndId::new(entity_type, user.0)))
    }))
}

fn crashing_resolver() -> Option<PrincipalResolver> {
    Some(PrincipalResolver::new(|_| Err("resolver crash".into())))
}

fn cedar(config: CedarAuthorizationConfig) -> CedarAuthorization {
    CedarAuthorization::new(config).unwrap()
}

fn error_of(config: CedarAuthorizationConfig) -> String {
    CedarAuthorization::new(config).err().unwrap().to_string()
}

#[derive(Clone, Default)]
struct Runs(Arc<AtomicUsize>);

impl Runs {
    fn get(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

fn tool_use_turn(name: &str, id: &str, input: JsonValue) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, id, input))])
}

/// Runs one tool call through an agent gated by `handler` and reports how often the tool ran.
async fn run_calls(
    handler: Arc<CedarAuthorization>,
    calls: &[(&str, JsonValue)],
    state: InvocationState,
) -> (Runs, Agent) {
    let runs = Runs::default();
    let mut model = MockModel::new();
    for (index, (name, input)) in calls.iter().enumerate() {
        model = model.with_turn(tool_use_turn(name, &format!("tool-{index}"), input.clone()));
    }
    let model = model.with_turn("Done");
    let mut names: Vec<&str> = calls.iter().map(|(name, _)| *name).collect();
    names.dedup();
    let tools: Vec<MockTool> = names
        .into_iter()
        .map(|name| {
            let runs = runs.clone();
            MockTool::new(name).with_result(move |context| {
                runs.0.fetch_add(1, Ordering::SeqCst);
                ToolOutcome::Result(ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]))
            })
        })
        .collect();
    let mut agent = Agent::builder()
        .model(model)
        .tools(tools)
        .interventions([handler])
        .printer(false)
        .build()
        .unwrap();
    let options = InvokeOptions {
        invocation_state: Some(state),
        ..Default::default()
    };
    agent.invoke_with("Go", options).await.unwrap();
    (runs, agent)
}

async fn runs_once(handler: CedarAuthorization, name: &str, input: JsonValue, state: InvocationState) -> bool {
    run_calls(Arc::new(handler), &[(name, input)], state).await.0.get() == 1
}

fn state_with_user(id: &str) -> InvocationState {
    let state = InvocationState::new();
    state.insert(UserId(id.to_owned()));
    state
}

fn decide(handler: &CedarAuthorization, agent: &LocalAgent, name: &str, input: JsonValue) -> String {
    let event = BeforeToolCallEvent::new(
        agent.tool_agent(),
        InvocationState::new(),
        ToolUse::new(name, "t", input),
        None,
    );
    match handler.authorize(&event).unwrap() {
        InterventionAction::Deny(deny) => deny.reason,
        action => action.action_type().to_owned(),
    }
}

#[tokio::test]
async fn allows_permitted_tool_calls() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        entities: Some(entities()),
        principal_resolver: user_from_state("User"),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({"query": "test"}), state_with_user("alice")).await);
}

#[tokio::test]
async fn denies_tools_not_in_any_permit_policy_default_deny() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        entities: Some(entities()),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert!(!runs_once(handler, "delete_record", json!({"id": "1"}), InvocationState::new()).await);
}

fn role_based(id: &'static str) -> CedarAuthorization {
    cedar(CedarAuthorizationConfig {
        policies: fixture("role-based.cedar"),
        entities: Some(entities()),
        principal_resolver: user(id),
        ..Default::default()
    })
}

#[tokio::test]
async fn enforces_role_based_access_admin_can_delete_analyst_cannot() {
    assert!(runs_once(role_based("alice"), "delete_record", json!({}), InvocationState::new()).await);
    assert!(!runs_once(role_based("bob"), "delete_record", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn enforces_role_based_access_analyst_can_search_viewer_cannot() {
    assert!(runs_once(role_based("bob"), "search", json!({}), InvocationState::new()).await);
    assert!(!runs_once(role_based("eve"), "search", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn enforces_rate_limits_via_call_count_in_session_context() {
    let handler = Arc::new(cedar(CedarAuthorizationConfig {
        policies: fixture("rate-limited.cedar"),
        entities: Some(entities()),
        principal_resolver: user("alice"),
        ..Default::default()
    }));
    let calls = [
        ("send_email", json!({})),
        ("send_email", json!({})),
        ("send_email", json!({})),
        ("send_email", json!({})),
    ];
    let (runs, agent) = run_calls(handler, &calls, InvocationState::new()).await;
    assert_eq!(runs.get(), 2);
    assert_eq!(
        agent.app_state().get_value(CEDAR_AUTHORIZATION_STATE_KEY),
        Some(json!({"send_email": 2}))
    );
}

#[tokio::test]
async fn enforces_environment_restrictions_via_context_enricher() {
    let enricher = ContextEnricher::new(|input: &ContextEnricherInput<'_>| {
        let environment = input
            .invocation_state
            .get::<Environment>()
            .map_or_else(|| "unknown".to_owned(), |environment| environment.0);
        let mut session = JsonObject::new();
        session.insert("environment".to_owned(), environment.into());
        Ok(session)
    });
    let handler = Arc::new(cedar(CedarAuthorizationConfig {
        policies: fixture("env-restricted.cedar"),
        entities: Some(entities()),
        principal_resolver: user("alice"),
        context_enricher: Some(enricher),
        ..Default::default()
    }));
    let state = |environment: &str| {
        let state = InvocationState::new();
        state.insert(Environment(environment.to_owned()));
        state
    };
    let (runs, _) = run_calls(handler.clone(), &[("search", json!({}))], state("development")).await;
    assert_eq!(runs.get(), 1);
    let (runs, _) = run_calls(handler, &[("search", json!({}))], state("production")).await;
    assert_eq!(runs.get(), 0);
}

#[tokio::test]
async fn denies_when_principal_is_missing_fail_closed() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        entities: Some(entities()),
        principal_resolver: user_from_state("User"),
        ..Default::default()
    });
    let (runs, agent) = run_calls(Arc::new(handler), &[("search", json!({}))], InvocationState::new()).await;
    assert_eq!(runs.get(), 0);
    let result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(
        result.contains("DENIED: No principal identity found in invocation state"),
        "{result}"
    );
}

#[test]
fn throws_on_malformed_policy_at_construction_time() {
    let error = error_of(CedarAuthorizationConfig {
        policies: "this is not valid cedar syntax at all!!!".into(),
        entities: Some(entities()),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert_eq!(
        error,
        "Invalid Cedar policy: failed to parse policies from string: unexpected token `is`"
    );
}

#[tokio::test]
async fn supports_static_principal_no_invocation_state_needed() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        entities: Some(vec![json!({"uid": {"type": "Resource", "id": "agent"}, "attrs": {}, "parents": []})].into()),
        principal: Some(TypeAndId::new("User", "alice")),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({}), InvocationState::new()).await);
}

#[test]
fn throws_when_both_principal_and_principal_resolver_are_provided() {
    let error = error_of(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        principal: Some(TypeAndId::new("User", "alice")),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert_eq!(error, "Provide either `principal` or `principal_resolver`, not both");
}

#[tokio::test]
async fn defaults_to_user_anonymous_when_neither_principal_nor_principal_resolver_is_provided() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal == User::"anonymous", action == Action::"search", resource);"#.into(),
        entities: Some(vec![json!({"uid": {"type": "Resource", "id": "agent"}, "attrs": {}, "parents": []})].into()),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn uses_unconstrained_resource_by_default() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"search", resource == Resource::"agent");"#.into(),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn constrains_on_tool_arguments_via_context_input() {
    let policies =
        r#"permit(principal, action == Action::"delete", resource) when { context.input.record_id == "42" };"#;
    let handler = |policies: &str| {
        cedar(CedarAuthorizationConfig {
            policies: policies.into(),
            principal_resolver: user("alice"),
            ..Default::default()
        })
    };
    assert!(
        !runs_once(
            handler(policies),
            "delete",
            json!({"record_id": "99"}),
            InvocationState::new()
        )
        .await
    );
    assert!(
        runs_once(
            handler(policies),
            "delete",
            json!({"record_id": "42"}),
            InvocationState::new()
        )
        .await
    );
}

fn department(department: &'static str) -> CedarAuthorization {
    let enricher = ContextEnricher::new(move |_: &ContextEnricherInput<'_>| {
        let mut session = JsonObject::new();
        session.insert("department".to_owned(), department.into());
        Ok(session)
    });
    cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action, resource) when { context.session.department == "engineering" };"#.into(),
        entities: Some(vec![json!({"uid": {"type": "Resource", "id": "agent"}, "attrs": {}, "parents": []})].into()),
        principal_resolver: user("alice"),
        context_enricher: Some(enricher),
        ..Default::default()
    })
}

#[tokio::test]
async fn adds_custom_fields_usable_in_policies() {
    assert!(runs_once(department("engineering"), "search", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn denies_when_enricher_value_does_not_match_policy() {
    assert!(!runs_once(department("marketing"), "search", json!({}), InvocationState::new()).await);
}

fn crashing(on_error: OnError) -> Agent {
    let handler = cedar(CedarAuthorizationConfig {
        policies: "permit(principal, action, resource);".into(),
        principal_resolver: crashing_resolver(),
        on_error: Some(on_error),
        ..Default::default()
    });
    Agent::builder()
        .model(
            MockModel::new()
                .with_turn(tool_use_turn("tool", "tool-1", json!({})))
                .with_turn("Done"),
        )
        .tools([MockTool::new("tool")])
        .interventions([handler])
        .printer(false)
        .build()
        .unwrap()
}

#[tokio::test]
async fn throws_by_default_when_handler_errors() {
    let error = crashing(OnError::Throw).invoke("Go").await.err().unwrap();
    assert_eq!(error.to_string(), "resolver crash");
}

#[tokio::test]
async fn denies_when_on_error_is_deny_and_handler_throws() {
    let mut agent = crashing(OnError::Deny);
    let result = agent.invoke("Go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    let tool_result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(
        tool_result.contains("DENIED: Handler threw: resolver crash"),
        "{tool_result}"
    );
}

#[tokio::test]
async fn proceeds_when_on_error_is_proceed_and_handler_throws() {
    let mut agent = crashing(OnError::Proceed);
    let result = agent.invoke("Go").await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::EndTurn);
    let tool_result = serde_json::to_string(&agent.messages()[2]).unwrap();
    assert!(tool_result.contains("\"status\":\"success\""), "{tool_result}");
}

#[tokio::test]
async fn reads_cedar_file_from_disk() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        entities: Some(
            vec![
                json!({"uid": {"type": "Resource", "id": "agent"}, "attrs": {}, "parents": []}),
                json!({"uid": {"type": "User", "id": "alice"}, "attrs": {"role": "analyst"}, "parents": []}),
            ]
            .into(),
        ),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({}), InvocationState::new()).await);
}

#[tokio::test]
async fn reads_json_entity_file_from_disk() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal in User::"alice", action == Action::"search", resource);"#.into(),
        entities: Some(fixture("entities.json").into()),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({}), InvocationState::new()).await);
}

#[test]
fn throws_when_cedar_file_does_not_exist() {
    let error = error_of(CedarAuthorizationConfig {
        policies: "/nonexistent/path.cedar".into(),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert_eq!(error, "Cedar policy file not found: /nonexistent/path.cedar");
}

#[test]
fn entities_must_have_a_uid_with_type_and_id() {
    for entity in [
        json!({"attrs": {}}),
        json!({"uid": {"type": "User"}}),
        json!({"uid": {"__entity": {"id": "x"}}}),
    ] {
        let error = error_of(CedarAuthorizationConfig {
            policies: "permit(principal, action, resource);".into(),
            entities: Some(vec![entity].into()),
            ..Default::default()
        });
        assert_eq!(error, "Invalid entity: each entity must have a uid with type and id");
    }
}

/// An agent whose model attempts `send_email` the given number of times on each successive invoke.
struct Sender {
    agent: Agent,
    sent: Runs,
}

impl Sender {
    fn new(handler: &Arc<CedarAuthorization>, attempts_per_invoke: &[usize]) -> Self {
        let model = MockModel::new();
        let mut tool_use = 0;
        for attempts in attempts_per_invoke {
            for _ in 0..*attempts {
                model.add_turn(tool_use_turn("send_email", &format!("tool-{tool_use}"), json!({})));
                tool_use += 1;
            }
            model.add_turn("Done");
        }
        let sent = Runs::default();
        let counter = sent.clone();
        let tool = MockTool::new("send_email").with_result(move |context| {
            counter.0.fetch_add(1, Ordering::SeqCst);
            ToolOutcome::Result(ToolResultBlock::success(context.tool_use().tool_use_id.clone(), vec![]))
        });
        let agent = Agent::builder()
            .model(model)
            .tools([tool])
            .interventions([handler.clone()])
            .printer(false)
            .build()
            .unwrap();
        Self { agent, sent }
    }

    async fn invoke(&mut self) {
        self.agent.invoke("Send").await.unwrap();
    }

    fn counts(&self) -> Option<JsonValue> {
        self.agent.app_state().get_value(CEDAR_AUTHORIZATION_STATE_KEY)
    }
}

fn rate_limit(limit: usize) -> Arc<CedarAuthorization> {
    Arc::new(cedar(CedarAuthorizationConfig {
        policies: format!("permit(principal, action, resource) when {{ context.session.call_count < {limit} }};"),
        ..Default::default()
    }))
}

#[tokio::test]
async fn reset_call_counts_clears_counts_and_re_enables_rate_limited_tools() {
    let handler = rate_limit(2);
    let mut sender = Sender::new(&handler, &[2, 1]);

    sender.invoke().await;
    assert_eq!(sender.sent.get(), 1);

    handler.reset_call_counts(sender.agent.app_state());
    assert_eq!(sender.counts(), Some(json!({})));

    sender.invoke().await;
    assert_eq!(sender.sent.get(), 2);
}

#[tokio::test]
async fn counts_calls_per_agent_when_agents_share_one_instance() {
    let handler = rate_limit(3);
    let mut child = Sender::new(&handler, &[3]);
    let mut parent = Sender::new(&handler, &[1, 1]);

    parent.invoke().await;
    child.invoke().await;
    assert_eq!(child.sent.get(), 2);
    assert_eq!(child.counts(), Some(json!({"send_email": 2})));
    assert_eq!(parent.counts(), Some(json!({"send_email": 1})));

    parent.invoke().await;
    assert_eq!(parent.sent.get(), 2);
    assert_eq!(parent.counts(), Some(json!({"send_email": 2})));
}

#[tokio::test]
async fn restores_counts_from_each_agents_own_app_state() {
    let handler = rate_limit(3);
    let mut child = Sender::new(&handler, &[1]);
    let mut parent = Sender::new(&handler, &[1]);
    child
        .agent
        .app_state()
        .set(CEDAR_AUTHORIZATION_STATE_KEY, json!({"send_email": 2}))
        .unwrap();

    parent.invoke().await;
    child.invoke().await;

    assert_eq!(parent.sent.get(), 1);
    assert_eq!(child.sent.get(), 0);
}

#[tokio::test]
async fn reset_call_counts_clears_only_the_given_agent() {
    let handler = rate_limit(3);
    let mut child = Sender::new(&handler, &[2, 1]);
    let mut parent = Sender::new(&handler, &[2, 1]);
    child.invoke().await;
    parent.invoke().await;

    handler.reset_call_counts(child.agent.app_state());
    child.invoke().await;
    parent.invoke().await;

    assert_eq!(child.sent.get(), 3);
    assert_eq!(parent.sent.get(), 2);
    assert_eq!(child.counts(), Some(json!({"send_email": 1})));
    assert_eq!(parent.counts(), Some(json!({"send_email": 2})));
}

#[test]
fn reloads_policies_from_file() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: fixture("test.cedar"),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    handler.reload().unwrap();
}

fn temp_policy(contents: &str) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("policy.cedar");
    std::fs::write(&path, contents).unwrap();
    let path = path.to_string_lossy().into_owned();
    (dir, path)
}

#[test]
fn throws_on_reload_if_policy_file_was_deleted() {
    let (_dir, path) = temp_policy("permit(principal, action, resource);");
    let handler = cedar(CedarAuthorizationConfig {
        policies: path.clone(),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        handler.reload().unwrap_err().to_string(),
        format!("Cedar policy file not found: {path}")
    );
}

#[tokio::test]
async fn validates_policies_on_reload() {
    let (_dir, path) = temp_policy("permit(principal, action, resource);");
    let handler = cedar(CedarAuthorizationConfig {
        policies: path.clone(),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    std::fs::write(&path, "this is broken!!!").unwrap();
    assert!(
        handler
            .reload()
            .unwrap_err()
            .to_string()
            .starts_with("Invalid Cedar policy")
    );
    let local = local_agent();
    assert_eq!(decide(&handler, &local, "anything", json!({})), "proceed");
}

#[test]
fn passes_validation_when_policies_match_schema() {
    cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal is User, action == Action::"search", resource is Resource);"#.into(),
        schema: Some(fixture("test.cedarschema")),
        principal_resolver: user("alice"),
        ..Default::default()
    });
}

#[test]
fn throws_when_policy_references_unknown_action() {
    let error = error_of(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"nonexistent_tool", resource);"#.into(),
        schema: Some(fixture("test.cedarschema")),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert_eq!(
        error,
        "Cedar policy validation failed: policy0: for policy `policy0`, unrecognized action `Action::\"nonexistent_tool\"`"
    );
}

#[test]
fn throws_when_policy_references_unknown_attribute() {
    let error = error_of(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"search", resource) when { principal.nonexistent == "x" };"#
            .into(),
        schema: Some(fixture("test.cedarschema")),
        principal_resolver: user("alice"),
        ..Default::default()
    });
    assert_eq!(
        error,
        "Cedar policy validation failed: policy0: for policy `policy0`, attribute `nonexistent` on entity type `User` not found"
    );
}

#[test]
fn accepts_inline_schema_string() {
    let schema = r#"
        entity User = { role: String };
        entity Resource;
        action "search" appliesTo { principal: [User], resource: [Resource] };
      "#;
    cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal is User, action == Action::"search", resource is Resource);"#.into(),
        schema: Some(schema.into()),
        principal_resolver: user("alice"),
        ..Default::default()
    });
}

#[test]
fn throws_when_cedarschema_file_does_not_exist() {
    let error = error_of(CedarAuthorizationConfig {
        policies: "permit(principal, action, resource);".into(),
        schema: Some("/nonexistent/schema.cedarschema".into()),
        ..Default::default()
    });
    assert_eq!(error, "Cedar schema file not found: /nonexistent/schema.cedarschema");
}

#[test]
fn skips_schema_validation_when_schema_is_not_provided() {
    cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"anything", resource);"#.into(),
        principal_resolver: user("alice"),
        ..Default::default()
    });
}

fn tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition::new(
            "search",
            json!({"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}),
        ),
        ToolDefinition::new(
            "delete",
            json!({"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}),
        ),
    ]
}

#[test]
fn auto_generates_schema_and_validates_policies_when_tools_are_provided() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"search", resource);"#.into(),
        tools: Some(tools()),
        ..Default::default()
    });
    assert_eq!(handler.name(), "cedar-authorization");
}

#[test]
fn catches_unknown_action_names_via_auto_generated_schema() {
    let error = error_of(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"nonexistent", resource);"#.into(),
        tools: Some(tools()),
        ..Default::default()
    });
    assert_eq!(
        error,
        "Cedar policy validation failed: policy0: for policy `policy0`, unrecognized action `Action::\"nonexistent\"`"
    );
}

#[test]
fn allows_policies_referencing_context_session_handler_injected_not_in_schema() {
    cedar(CedarAuthorizationConfig {
        policies:
            r#"permit(principal, action == Action::"search", resource) when { context.session.role == "admin" };"#
                .into(),
        tools: Some(tools()),
        ..Default::default()
    });
}

#[tokio::test]
async fn allows_tool_calls_when_tools_config_is_provided() {
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"search", resource);"#.into(),
        tools: Some(tools()),
        principal: Some(TypeAndId::new("User", "alice")),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({"query": "test"}), InvocationState::new()).await);
}

#[tokio::test]
async fn validates_nested_tool_input_schemas_without_breaking() {
    let mut nested = tools();
    nested.push(ToolDefinition::new(
        "create_user",
        json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "address": {"type": "object", "properties": {"street": {"type": "string"}, "city": {"type": "string"}}}
            }
        }),
    ));
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"create_user", resource);"#.into(),
        tools: Some(nested),
        principal: Some(TypeAndId::new("User", "alice")),
        ..Default::default()
    });
    let input = json!({"name": "Bob", "address": {"street": "123", "city": "NYC"}});
    assert!(runs_once(handler, "create_user", input, InvocationState::new()).await);
}

#[test]
fn surfaces_schema_generator_errors_for_naming_collisions_in_nested_inputs() {
    let colliding = vec![ToolDefinition::new(
        "create_user",
        json!({
            "type": "object",
            "properties": {
                "address": {
                    "type": "object",
                    "properties": {
                        "street": {"type": "string"},
                        "geo": {"type": "object", "properties": {"lat": {"type": "number"}, "lng": {"type": "number"}}}
                    }
                },
                "address_geo": {"type": "object", "properties": {"lat": {"type": "string"}, "lng": {"type": "string"}}}
            }
        }),
    )];
    let error = error_of(CedarAuthorizationConfig {
        policies: "permit(principal, action, resource);".into(),
        tools: Some(colliding),
        ..Default::default()
    });
    assert!(error.starts_with("Schema generation failed: "), "{error}");
}

#[test]
fn generated_schemas_match_the_ts_generator() {
    let plain = schema_generator::generate_schema(&tools(), None).unwrap();
    assert_eq!(
        plain,
        "\n  type SessionContext = {\n    call_count: Long,\n    hour_utc: Long\n  };\n\n  type deleteInput = {\n    id: String\n  };\n\n  type searchInput = {\n    query: String\n  };\n\n  entity Resource;\n\n  entity User;\n\n  action \"delete\" appliesTo {\n    principal: [User],\n    resource: [Resource],\n    context: {\n      input: deleteInput,\n      session: SessionContext\n    }\n  };\n\n  action \"search\" appliesTo {\n    principal: [User],\n    resource: [Resource],\n    context: {\n      input: searchInput,\n      session: SessionContext\n    }\n  };\n"
    );
    let namespaced = schema_generator::generate_schema(&tools()[..1], Some("MyApp")).unwrap();
    assert_eq!(
        namespaced,
        "namespace MyApp {\n  type SessionContext = {\n    call_count: Long,\n    hour_utc: Long\n  };\n\n  type searchInput = {\n    query: String\n  };\n\n  entity Resource;\n\n  entity User;\n\n  action \"search\" appliesTo {\n    principal: [User],\n    resource: [Resource],\n    context: {\n      input: searchInput,\n      session: SessionContext\n    }\n  };\n}\n"
    );
}

#[tokio::test]
async fn uses_namespaced_action_and_resource_types_when_namespace_is_set() {
    let handler = |user: &str| {
        let parents = if user == "alice" {
            json!([{"type": "Agent::Role", "id": "admin"}])
        } else {
            json!([])
        };
        cedar(CedarAuthorizationConfig {
            namespace: Some("Agent".into()),
            policies: r#"permit(principal in Agent::Role::"admin", action == Agent::Action::"search", resource);"#
                .into(),
            entities: Some(
                vec![
                    json!({"uid": {"type": "Agent::Role", "id": "admin"}, "attrs": {}, "parents": []}),
                    json!({"uid": {"type": "Agent::User", "id": user}, "attrs": {}, "parents": parents}),
                    json!({"uid": {"type": "Agent::Resource", "id": "default"}, "attrs": {}, "parents": []}),
                ]
                .into(),
            ),
            principal_resolver: user_from_state("Agent::User"),
            ..Default::default()
        })
    };
    assert!(
        runs_once(
            handler("alice"),
            "search",
            json!({"query": "test"}),
            state_with_user("alice")
        )
        .await
    );
}

#[tokio::test]
async fn denies_when_principal_is_not_in_the_role_namespaced() {
    let handler = cedar(CedarAuthorizationConfig {
        namespace: Some("Agent".into()),
        policies: r#"permit(principal in Agent::Role::"admin", action == Agent::Action::"search", resource);"#.into(),
        entities: Some(
            vec![
                json!({"uid": {"type": "Agent::Role", "id": "admin"}, "attrs": {}, "parents": []}),
                json!({"uid": {"type": "Agent::User", "id": "bob"}, "attrs": {}, "parents": []}),
                json!({"uid": {"type": "Agent::Resource", "id": "default"}, "attrs": {}, "parents": []}),
            ]
            .into(),
        ),
        principal_resolver: user_from_state("Agent::User"),
        ..Default::default()
    });
    assert!(!runs_once(handler, "search", json!({"query": "test"}), state_with_user("bob")).await);
}

#[tokio::test]
async fn works_with_namespace_and_tools_schema_generation_path() {
    let handler = cedar(CedarAuthorizationConfig {
        namespace: Some("MyApp".into()),
        policies: r#"permit(principal, action == MyApp::Action::"search", resource);"#.into(),
        tools: Some(tools()[..1].to_vec()),
        entities: Some(
            vec![json!({"uid": {"type": "MyApp::Resource", "id": "default"}, "attrs": {}, "parents": []})].into(),
        ),
        ..Default::default()
    });
    assert!(runs_once(handler, "search", json!({"query": "test"}), InvocationState::new()).await);
}

#[test]
fn deny_and_failure_reasons_match_ts() {
    let local = local_agent();
    let forbid = cedar(CedarAuthorizationConfig {
        policies: fixture("permit-search-deny-delete.cedar"),
        ..Default::default()
    });
    assert_eq!(
        decide(&forbid, &local, "delete_record", json!({})),
        "Access denied by Cedar policy: policy1"
    );
    assert_eq!(
        decide(&forbid, &local, "other", json!({})),
        "Access denied by Cedar policy"
    );

    let permit_all = cedar(CedarAuthorizationConfig {
        policies: "permit(principal, action, resource);".into(),
        ..Default::default()
    });
    assert_eq!(
        decide(&permit_all, &local, "x", json!({"v": 1.5})),
        "Cedar evaluation failed: data did not match any variant of untagged enum RawCedarValueJson"
    );
    assert_eq!(
        decide(&permit_all, &local, "x", json!({"v": null})),
        "Cedar evaluation failed: while parsing context, found a `null`; JSON `null`s are not allowed in Cedar"
    );

    let type_error = cedar(CedarAuthorizationConfig {
        policies: "permit(principal, action, resource) when { context.input.n + 1 > 0 };".into(),
        ..Default::default()
    });
    assert_eq!(
        decide(&type_error, &local, "x", json!({"n": "a"})),
        "Access denied by Cedar policy: type error: expected long, got string"
    );
    assert_eq!(
        local.app_state().get_value(CEDAR_AUTHORIZATION_STATE_KEY),
        Some(json!({"delete_record": 0, "other": 0, "x": 0}))
    );
}

#[test]
fn treats_an_empty_schema_or_namespace_as_absent() {
    let policies = r#"permit(principal, action == Action::"search", resource);"#;
    let empty_schema = cedar(CedarAuthorizationConfig {
        policies: policies.into(),
        schema: Some(String::new()),
        ..Default::default()
    });
    let agent = local_agent();
    assert_eq!(decide(&empty_schema, &agent, "search", json!({})), "proceed");
    let empty_namespace = cedar(CedarAuthorizationConfig {
        policies: policies.into(),
        namespace: Some(String::new()),
        ..Default::default()
    });
    assert_eq!(empty_namespace.action_type, "Action");
    assert_eq!(empty_namespace.resource, TypeAndId::new("Resource", "agent"));
    assert_eq!(empty_namespace.principal, Some(TypeAndId::new("User", "anonymous")));
    assert_eq!(decide(&empty_namespace, &agent, "search", json!({})), "proceed");
}

#[test]
fn skips_validation_for_an_empty_schema_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.cedarschema");
    std::fs::write(&path, "").unwrap();
    let handler = cedar(CedarAuthorizationConfig {
        policies: r#"permit(principal, action == Action::"search", resource);"#.into(),
        schema: Some(path.to_string_lossy().into_owned()),
        ..Default::default()
    });
    assert_eq!(decide(&handler, &local_agent(), "search", json!({})), "proceed");
}
