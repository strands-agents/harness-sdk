use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};

use jiff::Timestamp;
use serde_json::json;

use super::*;
use crate::agent::{Agent, InvokeOptions};
use crate::test_support::{MockTool, tool_agent};
use crate::testing::{MockModel, MockTurn};
use crate::tools::{Tool, ToolOutcome};
use crate::types::{ContentBlock, StopReason, ToolResultBlock, ToolResultContent, ToolUse, ToolUseBlock};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/vended_interventions/dogwood/testdata");

const PERMIT_SEARCH: &str = r#"permit(principal, action == Action::"search", resource);"#;

/// The same permit, qualified for a hand-written schema that declares `namespace Drupe`.
const PERMIT_SEARCH_NAMESPACED: &str = r#"permit(principal, action == Drupe::Action::"search", resource);"#;

/// Permits `search`, and `delete_file` only after a `search` has completed.
const DELETE_AFTER_SEARCH: &str = r#"
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{} };
"#;

fn fixture(name: &str) -> String {
    format!("{FIXTURES}/{name}")
}

fn spec(name: &str, description: &str, schema: JsonValue) -> ToolSpec {
    ToolSpec::new(name, description).with_input_schema(schema)
}

fn tools() -> Vec<ToolSpec> {
    vec![
        spec(
            "search",
            "Search for information",
            json!({"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}),
        ),
        spec(
            "delete_file",
            "Delete a file",
            json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        ),
        spec(
            "http_request",
            "Make an HTTP request",
            json!({
                "type": "object",
                "properties": {
                    "method": {"type": "string", "enum": ["GET", "POST", "DELETE"]},
                    "url": {"type": "string"},
                    "retries": {"type": "number"}
                },
                "required": ["method", "url"]
            }),
        ),
    ]
}

/// An object parameter, which schema generation declares as an entity type of its own.
fn object_parameter_tools() -> Vec<ToolSpec> {
    vec![spec(
        "http_request",
        "Make an HTTP request",
        json!({
            "type": "object",
            "properties": {"url": {"type": "string"}, "headers": {"type": "object", "properties": {"auth": {"type": "string"}}}},
            "required": ["url"]
        }),
    )]
}

fn config(policies: &str) -> DogwoodAuthorizationConfig {
    DogwoodAuthorizationConfig {
        policies: policies.to_owned(),
        tools: Some(tools()),
        ..Default::default()
    }
}

fn dogwood(config: DogwoodAuthorizationConfig) -> DogwoodAuthorization {
    DogwoodAuthorization::new(config).unwrap()
}

fn error_of(config: DogwoodAuthorizationConfig) -> String {
    DogwoodAuthorization::new(config).err().unwrap().to_string()
}

#[derive(Clone)]
struct UserId(String);

#[derive(Clone)]
struct Role(String);

#[derive(Clone)]
struct Kind(String);

fn state() -> InvocationState {
    InvocationState::new()
}

fn as_user(id: &str) -> InvocationState {
    let state = state();
    state.insert(UserId(id.to_owned()));
    state
}

fn with_role(role: &str) -> InvocationState {
    let state = state();
    state.insert(Role(role.to_owned()));
    state
}

fn call(name: &str, id: &str, input: JsonValue, state: InvocationState) -> BeforeToolCallEvent {
    BeforeToolCallEvent::new(tool_agent(), state, ToolUse::new(name, id, input), None)
}

fn search() -> BeforeToolCallEvent {
    call("search", "tool-1", json!({"query": "test"}), state())
}

fn result_event(name: &str, id: &str, result: ToolResultBlock, state: InvocationState) -> AfterToolCallEvent {
    let tool_use = ToolUse::new(name, id, json!({"query": "test"}));
    AfterToolCallEvent::new(tool_agent(), state, tool_use, None, result)
}

fn succeeded(name: &str, state: InvocationState) -> AfterToolCallEvent {
    let result = ToolResultBlock::success("tool-1", vec![ToolResultContent::text("results")]);
    result_event(name, "tool-1", result, state)
}

fn failed(name: &str, message: &str) -> AfterToolCallEvent {
    let result = ToolResultBlock::error("tool-1", vec![ToolResultContent::text(message)]).with_error(message);
    result_event(name, "tool-1", result, state())
}

/// What the executor yields when a hook cancelled the call: an error status, no error.
fn cancelled(name: &str) -> AfterToolCallEvent {
    let result = ToolResultBlock::error("tool-1", vec![ToolResultContent::text("Tool cancelled by hook")]);
    result_event(name, "tool-1", result, state())
}

/// `None` when the handler proceeds, else the deny reason.
fn outcome(handler: &DogwoodAuthorization, event: &BeforeToolCallEvent) -> Option<String> {
    match handler.decide(event).unwrap() {
        InterventionAction::Proceed(_) => None,
        InterventionAction::Deny(deny) => Some(deny.reason),
        action => panic!("unexpected action {}", action.action_type()),
    }
}

fn proceeds(handler: &DogwoodAuthorization, event: &BeforeToolCallEvent) -> bool {
    outcome(handler, event).is_none()
}

/// Whether `delete_file` is currently permitted, without disturbing the history.
fn delete_allowed(handler: &DogwoodAuthorization) -> bool {
    proceeds(
        handler,
        &call("delete_file", "probe", json!({"path": "/tmp/a"}), state()),
    )
}

fn user_from_state() -> Option<PrincipalResolver> {
    Some(PrincipalResolver::new(|state: &InvocationState| {
        Ok(state.get::<UserId>().map(|user| EntityRef::new("User", user.0)))
    }))
}

// --- configuration ---

#[test]
fn rejects_configuring_both_a_principal_and_a_resolver() {
    let error = error_of(DogwoodAuthorizationConfig {
        principal: Some(EntityRef::new("User", "alice")),
        principal_resolver: Some(PrincipalResolver::new(|_| Ok(None))),
        ..config(PERMIT_SEARCH)
    });
    assert!(error.contains("not both"), "{error}");
}

#[test]
fn rejects_entities_supplied_without_an_action_schema() {
    // A generated schema declares its entities bare, so an entity with attrs fails conformance
    // at decision time and denies every call.
    let alice = EntityInput::new("User", "alice").with_attrs(json!({"role": "admin"}).as_object().cloned().unwrap());
    let error = error_of(DogwoodAuthorizationConfig {
        entities: Some(vec![alice]),
        ..config(PERMIT_SEARCH)
    });
    assert!(error.contains("`entities` requires `action_schema`"), "{error}");
}

#[test]
fn accepts_an_empty_entity_list_alongside_a_generated_schema() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        entities: Some(Vec::new()),
        ..config(PERMIT_SEARCH)
    });
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn rejects_a_namespace_alongside_a_hand_written_action_schema() {
    let error = error_of(DogwoodAuthorizationConfig {
        policies: "permit(principal, action, resource);".into(),
        action_schema: Some(fixture("tools.cedarschema")),
        namespace: Some("Acme".into()),
        ..Default::default()
    });
    assert!(error.contains("`namespace` applies to a generated schema"), "{error}");
}

// The reserved segments parse as identifiers and only fail once Cedar reads the generated
// schema, so the guard has to name them itself.
#[test]
fn rejects_the_namespace() {
    for namespace in [
        "my-ns",
        "",
        "9bad",
        "Acme::",
        "Acme Prod",
        "if",
        "has",
        "__cedar",
        "Acme::in",
    ] {
        let error = error_of(DogwoodAuthorizationConfig {
            namespace: Some(namespace.into()),
            ..config(PERMIT_SEARCH)
        });
        assert!(error.contains("none of them reserved"), "{namespace:?}: {error}");
    }
}

#[test]
fn rejects_a_policy_still_naming_the_generated_namespace_when_one_is_configured() {
    let error = error_of(DogwoodAuthorizationConfig {
        namespace: Some("Acme".into()),
        ..config(PERMIT_SEARCH_NAMESPACED)
    });
    assert!(error.contains("validation failed"), "{error}");
}

#[test]
fn accepts_the_generated_namespace_named_explicitly() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        namespace: Some("Drupe".into()),
        ..config(PERMIT_SEARCH_NAMESPACED)
    });
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn rejects_a_config_with_neither_an_action_schema_nor_tools() {
    let error = error_of(DogwoodAuthorizationConfig {
        policies: PERMIT_SEARCH.into(),
        ..Default::default()
    });
    assert!(error.contains("Provide either `action_schema` or `tools`"), "{error}");
}

#[test]
fn generates_a_schema_from_tool_instances_as_well_as_from_specs() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        tools: Some(vec![MockTool::new("search").tool_spec()]),
        ..config(PERMIT_SEARCH)
    });
    // The mock tool declares no input fields, and the engine checks the input against them.
    assert_eq!(outcome(&handler, &call("search", "tool-1", json!({}), state())), None);
}

#[test]
fn generates_a_schema_from_a_spec_without_an_input_schema() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        tools: Some(vec![ToolSpec::new("search", "Search for information")]),
        ..config(PERMIT_SEARCH)
    });
    assert_eq!(outcome(&handler, &call("search", "tool-1", json!({}), state())), None);
}

#[test]
fn reads_a_policy_from_a_dw_file_on_disk() {
    let handler = dogwood(config(&fixture("permit-search.dw")));
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn throws_when_a_dw_path_does_not_exist() {
    let error = error_of(config(&fixture("missing.dw")));
    assert!(error.contains("Dogwood .dw file not found"), "{error}");
}

#[test]
fn rejects_a_policy_naming_a_tool_the_generated_schema_does_not_declare() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"not_a_tool", resource);"#,
    ));
    assert!(error.contains("unrecognized action"), "{error}");
}

#[test]
fn rejects_a_misspelled_action_inside_a_temporal_predicate() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"delete_file", resource)
           when temporal { formerly within 1h Action::"serach"::response{} };"#,
    ));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn rejects_a_misspelled_field_inside_a_temporal_predicate() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"delete_file", resource)
           when temporal { formerly within 1h Action::"search"::response{ input.qurey: "x" } };"#,
    ));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn rejects_a_misspelled_tool_input_field() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"search", resource) when { context.input.qurey == "x" };"#,
    ));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

const SESSION_ROLE_POLICY: &str =
    r#"permit(principal, action == Action::"search", resource) when { context.session.role == "admin" };"#;

fn admin_enricher() -> Option<ContextEnricher> {
    Some(ContextEnricher::new(|_| {
        Ok(json!({"role": "admin"}).as_object().cloned().unwrap_or_default())
    }))
}

#[test]
fn rejects_an_enriched_group_when_no_enricher_supplies_it() {
    let error = error_of(config(SESSION_ROLE_POLICY));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn accepts_an_enriched_group_a_generated_schema_cannot_declare() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        context_enricher: admin_enricher(),
        ..config(SESSION_ROLE_POLICY)
    });
    // The policy validates, but the engine checks each request's context against the schema,
    // which cannot declare the enriched group, so the call fails closed.
    let reason = outcome(&handler, &search()).unwrap();
    assert!(reason.contains("nonconforming request"), "{reason}");
}

#[test]
fn still_rejects_an_enriched_group_against_a_hand_written_action_schema() {
    // A hand-written schema can declare the group, so an undeclared one is a mistake.
    let error = error_of(DogwoodAuthorizationConfig {
        policies: r#"permit(principal, action == Drupe::Action::"search", resource) when { context.session.role == "admin" };"#
            .into(),
        action_schema: Some(fixture("tools.cedarschema")),
        context_enricher: admin_enricher(),
        ..Default::default()
    });
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn accepts_a_condition_comparing_an_enum_parameter_as_the_model_emits_it() {
    // An `enum` constraint generates as a plain `String`, so a string literal is the form that
    // both validates and matches.
    let handler = dogwood(config(
        r#"permit(principal, action == Action::"http_request", resource)
           when { context.input.method == "GET" };"#,
    ));
    let get = call(
        "http_request",
        "tool-1",
        json!({"method": "GET", "url": "http://x"}),
        state(),
    );
    let delete = call(
        "http_request",
        "tool-2",
        json!({"method": "DELETE", "url": "http://x"}),
        state(),
    );

    assert_eq!(outcome(&handler, &get), None);
    assert!(!proceeds(&handler, &delete));
}

#[test]
fn accepts_a_condition_comparing_a_number_parameter_as_the_model_emits_it() {
    let handler = dogwood(config(
        r#"permit(principal, action == Action::"http_request", resource)
           when { context has input.retries && context.input.retries == 2 };"#,
    ));
    let input = json!({"method": "GET", "url": "http://x", "retries": 2});

    assert_eq!(outcome(&handler, &call("http_request", "tool-1", input, state())), None);
}

#[test]
fn accepts_an_ordering_comparison_on_a_number_parameter() {
    let handler = dogwood(config(
        r#"permit(principal, action == Action::"http_request", resource)
           when { context has input.retries && context.input.retries > 2 };"#,
    ));
    let many = call(
        "http_request",
        "tool-1",
        json!({"method": "GET", "url": "http://x", "retries": 5}),
        state(),
    );
    let few = call(
        "http_request",
        "tool-2",
        json!({"method": "GET", "url": "http://x", "retries": 1}),
        state(),
    );

    assert_eq!(outcome(&handler, &many), None);
    assert!(!proceeds(&handler, &few));
}

#[test]
fn accepts_a_set_operator_on_an_array_of_enum_parameter() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        tools: Some(vec![spec(
            "tag",
            "Tag a record",
            json!({
                "type": "object",
                "properties": {"tags": {"type": "array", "items": {"type": "string", "enum": ["public", "secret"]}}},
                "required": ["tags"]
            }),
        )]),
        ..config(
            r#"permit(principal, action == Action::"tag", resource)
               when { !context.input.tags.containsAny(["secret"]) };"#,
        )
    });
    let open = call("tag", "tool-1", json!({"tags": ["public"]}), state());
    let closed = call("tag", "tool-2", json!({"tags": ["secret"]}), state());

    assert_eq!(outcome(&handler, &open), None);
    assert!(!proceeds(&handler, &closed));
}

#[test]
fn rejects_a_condition_whose_types_mismatch_for_any_other_reason() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"http_request", resource)
           when { context.input.url == 3 };"#,
    ));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn rejects_a_wrong_type_comparison_against_an_enum_or_number_parameter() {
    let construct = |condition: &str| {
        error_of(config(&format!(
            r#"permit(principal, action == Action::"http_request", resource) when {{ {condition} }};"#
        )))
    };
    for condition in [
        "context.input.method == 5",
        r#"context has input.retries && context.input.retries == "3""#,
    ] {
        let error = construct(condition);
        assert!(
            error.contains("Dogwood policy validation failed"),
            "{condition}: {error}"
        );
    }
}

#[test]
fn rejects_reading_an_optional_parameter_without_a_has_guard() {
    let error = error_of(config(
        r#"permit(principal, action == Action::"http_request", resource)
           when { context.input.retries == 2 };"#,
    ));
    assert!(error.contains("Dogwood policy validation failed"), "{error}");
}

#[test]
fn generates_the_schema_under_a_configured_namespace() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        namespace: Some("Acme".into()),
        ..config(
            r#"
            permit(principal == Acme::User::"anonymous", action == Acme::Action::"search",
                   resource == Acme::Resource::"agent")
            when { context.input.query == "test" };

            permit(principal, action == Acme::Action::"delete_file", resource)
            when temporal { formerly within 1h Acme::Action::"search"::response{} };
            "#,
        )
    });

    // The derived principal and resource follow the namespace, and a temporal predicate under it
    // still matches the history.
    assert_eq!(outcome(&handler, &search()), None);
    assert!(!delete_allowed(&handler));
    handler.record(&succeeded("search", state()));
    assert!(delete_allowed(&handler));
}

#[test]
fn generates_the_schema_under_a_nested_namespace() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        namespace: Some("Acme::Prod".into()),
        ..config(r#"permit(principal, action == Acme::Prod::Action::"search", resource);"#)
    });
    assert_eq!(outcome(&handler, &search()), None);
}

// An object parameter is generated as its own entity type and referenced qualified, so the
// namespace rewrite has to move those references too or the schema fails to resolve them.
#[test]
fn generates_a_schema_for_an_object_parameter_under_the_prefix() {
    for (prefix, namespace) in [
        ("", None),
        ("Acme::", Some("Acme")),
        ("Drupe::", Some("Drupe")),
        ("Acme::Prod::", Some("Acme::Prod")),
    ] {
        let handler = dogwood(DogwoodAuthorizationConfig {
            policies: format!(
                r#"permit(principal, action == {prefix}Action::"http_request", resource)
                   when {{ context has input.headers && context.input.headers has auth }};"#
            ),
            tools: Some(object_parameter_tools()),
            namespace: namespace.map(str::to_owned),
            ..Default::default()
        });
        let authed = call(
            "http_request",
            "tool-1",
            json!({"url": "http://x", "headers": {"auth": "token"}}),
            state(),
        );
        let anonymous = call("http_request", "tool-2", json!({"url": "http://x"}), state());

        assert_eq!(outcome(&handler, &authed), None, "{prefix:?}");
        assert!(!proceeds(&handler, &anonymous), "{prefix:?}");
    }
}

// Renaming the generator's resource entity must not touch a tool that carries the same word in
// its own name, or the action it declares becomes unreachable and no rule can apply to it.
#[test]
fn decides_a_tool_named_after_the_entity_the_generated_schema_renames() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        tools: Some(vec![spec(
            "Gateway_admin",
            "Administer the gateway",
            json!({"type": "object", "properties": {"Gateway": {"type": "string"}}, "required": ["Gateway"]}),
        )]),
        ..config(
            r#"permit(principal, action == Action::"Gateway_admin", resource == Resource::"agent");
               forbid(principal, action == Action::"Gateway_admin", resource)
               when { context.input.Gateway == "root" };"#,
        )
    });
    let permitted = call("Gateway_admin", "tool-1", json!({"Gateway": "staging"}), state());
    let forbidden = call("Gateway_admin", "tool-2", json!({"Gateway": "root"}), state());

    assert_eq!(outcome(&handler, &permitted), None);
    assert!(!proceeds(&handler, &forbidden));
}

// An undeclared principal type passes validation and allows the call, because a rule scoping
// the principal just never matches.
#[test]
fn rejects_a_static_principal_of_a_type_the_generated_schema_does_not_declare() {
    let error = error_of(DogwoodAuthorizationConfig {
        principal: Some(EntityRef::new("Admin", "alice")),
        ..config(PERMIT_SEARCH)
    });
    assert!(
        error.contains("`principal` must be of type `User`, got `Admin`"),
        "{error}"
    );
}

#[test]
fn rejects_an_unqualified_static_principal_under_a_configured_namespace() {
    let error = error_of(DogwoodAuthorizationConfig {
        namespace: Some("Acme".into()),
        principal: Some(EntityRef::new("User", "alice")),
        ..config(r#"permit(principal, action == Acme::Action::"search", resource);"#)
    });
    assert!(
        error.contains("`principal` must be of type `Acme::User`, got `User`"),
        "{error}"
    );
}

#[test]
fn accepts_a_static_principal_of_any_type_a_hand_written_action_schema_may_declare() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        policies: PERMIT_SEARCH_NAMESPACED.into(),
        action_schema: Some(fixture("tools.cedarschema")),
        principal: Some(EntityRef::new("Drupe::User", "alice")),
        ..Default::default()
    });
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn reads_an_action_schema_from_a_cedarschema_file_on_disk() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        policies: PERMIT_SEARCH_NAMESPACED.into(),
        action_schema: Some(fixture("tools.cedarschema")),
        ..Default::default()
    });
    assert_eq!(outcome(&handler, &search()), None);
}

// --- verdicts ---

#[test]
fn proceeds_when_the_policy_permits_the_tool() {
    let handler = dogwood(config(PERMIT_SEARCH));
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn denies_a_tool_no_permit_covers_without_naming_a_rule() {
    let handler = dogwood(config(PERMIT_SEARCH));
    let delete = call("delete_file", "tool-1", json!({"path": "/tmp/a"}), state());
    assert_eq!(
        outcome(&handler, &delete).as_deref(),
        Some("Access denied by Dogwood policy")
    );
}

#[test]
fn names_the_determining_rule_when_an_explicit_forbid_denies() {
    let handler = dogwood(config(&format!(
        "{PERMIT_SEARCH}\nforbid(principal, action == Action::\"search\", resource);"
    )));
    assert_eq!(
        outcome(&handler, &search()).as_deref(),
        Some("Access denied by Dogwood policy (rule 1)")
    );
}

#[test]
fn denies_a_tool_the_action_schema_does_not_declare() {
    let handler = dogwood(config(PERMIT_SEARCH));
    let unknown = call("delete_everything", "tool-1", json!({"query": "test"}), state());
    assert_eq!(
        outcome(&handler, &unknown).as_deref(),
        Some("Tool 'delete_everything' is not declared by the Dogwood action schema; denying")
    );
}

#[test]
fn denies_when_a_principal_resolver_yields_no_identity() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        principal_resolver: Some(PrincipalResolver::new(|_| Ok(None))),
        ..config(PERMIT_SEARCH)
    });
    assert_eq!(outcome(&handler, &search()).as_deref(), Some(NO_PRINCIPAL));
}

#[test]
fn decides_against_the_principal_the_resolver_returns() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        principal_resolver: user_from_state(),
        ..config(r#"permit(principal == User::"alice", action == Action::"search", resource);"#)
    });
    let alice = call("search", "tool-1", json!({"query": "test"}), as_user("alice"));
    let bob = call("search", "tool-2", json!({"query": "test"}), as_user("bob"));

    assert_eq!(outcome(&handler, &alice), None);
    assert_eq!(
        outcome(&handler, &bob).as_deref(),
        Some("Access denied by Dogwood policy")
    );
}

#[test]
fn denies_when_a_principal_resolver_returns_an_undeclared_entity_type() {
    let handler = dogwood(DogwoodAuthorizationConfig {
        principal_resolver: Some(PrincipalResolver::new(|state: &InvocationState| {
            Ok(state.get::<Kind>().map(|kind| EntityRef::new(kind.0, "mallory")))
        })),
        ..config(PERMIT_SEARCH)
    });
    let state = state();
    state.insert(Kind("Admin".to_owned()));
    let event = call("search", "tool-1", json!({"query": "test"}), state);

    assert_eq!(
        outcome(&handler, &event).as_deref(),
        Some("Principal type 'Admin' is not declared by the Dogwood action schema; denying")
    );
}

#[test]
fn decides_against_the_fields_the_context_enricher_adds() {
    // The schema declares the enriched group, so the requests conform.
    let handler = dogwood(DogwoodAuthorizationConfig {
        policies: r#"permit(principal, action == Drupe::Action::"search", resource) when { context.session.role == "admin" };"#
            .into(),
        action_schema: Some(fixture("tools-session.cedarschema")),
        context_enricher: Some(ContextEnricher::new(|input: &ContextEnricherInput<'_>| {
            let role = input.invocation_state.get::<Role>().map(|role| role.0).unwrap_or_default();
            Ok(json!({"role": role}).as_object().cloned().unwrap_or_default())
        })),
        ..Default::default()
    });
    let admin = call("search", "tool-1", json!({"query": "test"}), with_role("admin"));
    let viewer = call("search", "tool-2", json!({"query": "test"}), with_role("viewer"));

    assert_eq!(outcome(&handler, &admin), None);
    assert_eq!(
        outcome(&handler, &viewer).as_deref(),
        Some("Access denied by Dogwood policy")
    );
}

#[test]
fn decides_only_once_for_a_tool_use_id_so_a_resumed_interrupt_is_not_counted_twice() {
    let enrich_count = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&enrich_count);
    let handler = dogwood(DogwoodAuthorizationConfig {
        context_enricher: Some(ContextEnricher::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(JsonObject::new())
        })),
        ..config(PERMIT_SEARCH)
    });

    assert_eq!(outcome(&handler, &search()), None);
    assert_eq!(outcome(&handler, &search()), None);
    assert_eq!(enrich_count.load(Ordering::SeqCst), 1);
}

// --- fail-closed behavior ---

#[test]
fn reports_an_evaluation_error_as_the_cause_rather_than_as_a_policy_decision() {
    // The policy reads a group no enricher supplies, so evaluation errors out.
    let handler = dogwood(DogwoodAuthorizationConfig {
        context_enricher: Some(ContextEnricher::new(|_| Ok(JsonObject::new()))),
        ..config(SESSION_ROLE_POLICY)
    });
    let reason = outcome(&handler, &search()).unwrap();
    assert!(reason.contains("Dogwood evaluation failed"), "{reason}");
}

#[test]
fn denies_rather_than_throwing_when_model_supplied_tool_input_is_not_a_valid_event() {
    let handler = dogwood(config(PERMIT_SEARCH));
    // `__decimal` is a tagged form the model can emit; its value must be a string.
    let event = call("search", "tool-1", json!({"query": {"__decimal": 1.5}}), state());
    let reason = outcome(&handler, &event).unwrap();
    assert!(reason.contains("Dogwood could not decide"), "{reason}");
}

#[test]
fn stays_usable_after_a_malformed_event_is_rejected() {
    let handler = dogwood(config(PERMIT_SEARCH));
    let malformed = call("search", "tool-1", json!({"query": {"__decimal": 1.5}}), state());
    let _ = outcome(&handler, &malformed);

    assert_eq!(
        outcome(&handler, &call("search", "tool-2", json!({"query": "test"}), state())),
        None
    );
}

// --- temporal history ---

#[test]
fn unlocks_a_temporally_gated_tool_once_a_response_is_recorded() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    assert!(!delete_allowed(&handler));
    assert_eq!(outcome(&handler, &search()), None);
    handler.record(&succeeded("search", state()));
    assert!(delete_allowed(&handler));
}

#[test]
fn records_a_thrown_tool_failure_as_an_error_event_not_a_response() {
    let handler = dogwood(config(
        r#"
permit(principal, action == Action::"search", resource);
forbid(principal, action == Action::"search", resource)
when temporal { formerly within 1h Action::"search"::error{} };
"#,
    ));

    assert_eq!(outcome(&handler, &search()), None);
    handler.record(&failed("search", "tool exploded"));
    assert!(!proceeds(
        &handler,
        &call("search", "tool-2", json!({"query": "test"}), state())
    ));
}

#[test]
fn does_not_record_a_result_for_a_call_it_denied() {
    let handler = dogwood(config(
        r#"
forbid(principal, action == Action::"search", resource);
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{} };
"#,
    ));

    assert!(!proceeds(&handler, &search()));
    handler.record(&cancelled("search"));
    assert!(!delete_allowed(&handler));
}

#[test]
fn does_not_record_a_result_for_a_call_a_later_handler_blocked() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    assert_eq!(outcome(&handler, &search()), None);
    handler.record(&cancelled("search"));
    assert!(!delete_allowed(&handler));
}

#[test]
fn does_not_record_a_result_it_never_authorized() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    handler.record(&succeeded("search", state()));
    assert!(!delete_allowed(&handler));
}

#[test]
fn skips_a_result_whose_tool_name_does_not_match_the_allowed_call() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    assert_eq!(outcome(&handler, &search()), None);
    // Same tool-use id under another tool, so this is not that call's result.
    handler.record(&succeeded("delete_everything", state()));
    assert!(!delete_allowed(&handler));
}

#[test]
fn decides_a_tool_use_id_reused_by_a_different_tool_on_its_own_terms() {
    let handler = dogwood(config(PERMIT_SEARCH));

    assert_eq!(outcome(&handler, &search()), None);
    // An abandoned interrupt leaves its allow behind; reusing the id for another tool must not
    // ride on it.
    let reused = call("delete_file", "tool-1", json!({"path": "/tmp/a"}), state());
    assert!(!proceeds(&handler, &reused));
}

#[test]
fn records_a_result_without_consulting_the_resolver_or_enricher_again() {
    let resolve_count = Arc::new(AtomicUsize::new(0));
    let enrich_count = Arc::new(AtomicUsize::new(0));
    let (resolves, enriches) = (Arc::clone(&resolve_count), Arc::clone(&enrich_count));
    let handler = dogwood(DogwoodAuthorizationConfig {
        principal_resolver: Some(PrincipalResolver::new(move |state: &InvocationState| {
            resolves.fetch_add(1, Ordering::SeqCst);
            Ok(state.get::<UserId>().map(|user| EntityRef::new("User", user.0)))
        })),
        context_enricher: Some(ContextEnricher::new(move |_| {
            enriches.fetch_add(1, Ordering::SeqCst);
            Ok(JsonObject::new())
        })),
        ..config(DELETE_AFTER_SEARCH)
    });

    let _ = outcome(
        &handler,
        &call("search", "tool-1", json!({"query": "test"}), as_user("alice")),
    );
    handler.record(&succeeded("search", as_user("alice")));

    assert_eq!(
        (
            resolve_count.load(Ordering::SeqCst),
            enrich_count.load(Ordering::SeqCst)
        ),
        (1, 1)
    );
    // Recorded under the principal the request was decided for, not a re-resolved one.
    let delete_as_alice = call("delete_file", "d-1", json!({"path": "/a"}), as_user("alice"));
    assert_eq!(outcome(&handler, &delete_as_alice), None);
}

#[test]
fn correlates_a_temporal_predicate_on_a_recorded_tool_input_field() {
    let handler = dogwood(config(
        r#"
permit(principal, action == Action::"search", resource);
permit(principal, action == Action::"delete_file", resource)
when temporal { formerly within 1h Action::"search"::response{ input.query: "audit" } };
"#,
    ));

    let _ = outcome(
        &handler,
        &call("search", "tool-1", json!({"query": "unrelated"}), state()),
    );
    handler.record(&succeeded("search", state()));
    assert!(!delete_allowed(&handler));
}

#[test]
fn keeps_one_principal_history_from_unlocking_another_principal() {
    // The default event schema pins every predicate to the deciding principal.
    let handler = dogwood(DogwoodAuthorizationConfig {
        principal_resolver: user_from_state(),
        ..config(DELETE_AFTER_SEARCH)
    });

    let _ = outcome(
        &handler,
        &call("search", "tool-1", json!({"query": "test"}), as_user("alice")),
    );
    handler.record(&succeeded("search", as_user("alice")));

    let alice = call("delete_file", "d-1", json!({"path": "/a"}), as_user("alice"));
    let bob = call("delete_file", "d-2", json!({"path": "/a"}), as_user("bob"));
    assert_eq!(outcome(&handler, &alice), None);
    assert!(!proceeds(&handler, &bob));
}

#[test]
fn records_a_result_even_when_the_system_clock_steps_backwards() {
    let seconds = Arc::new(AtomicI64::new(5_000));
    let now = Arc::clone(&seconds);
    let clock = Clock::from_fn(move || Timestamp::from_second(now.load(Ordering::SeqCst)).unwrap_or_default());
    let handler = dogwood(config(DELETE_AFTER_SEARCH)).with_clock(clock);

    assert_eq!(outcome(&handler, &search()), None);
    // The engine rejects an event dated before the previous one.
    seconds.store(4_000, Ordering::SeqCst);
    handler.record(&succeeded("search", state()));
    assert!(delete_allowed(&handler));
}

// --- reset ---

#[test]
fn drops_accumulated_history_and_keeps_deciding() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    let _ = outcome(&handler, &search());
    handler.record(&succeeded("search", state()));
    assert!(delete_allowed(&handler));

    handler.reset();

    assert!(!delete_allowed(&handler));
    assert_eq!(outcome(&handler, &search()), None);
}

#[test]
fn drops_an_in_flight_call_so_its_response_misses_the_new_history() {
    let handler = dogwood(config(DELETE_AFTER_SEARCH));

    let _ = outcome(&handler, &search());
    handler.reset();
    handler.record(&succeeded("search", state()));
    assert!(!delete_allowed(&handler));
}

// --- agent integration ---

/// Runs one `search` call through an agent gated by `handler`; reports whether the tool ran.
async fn run_search(handler: Arc<DogwoodAuthorization>) -> (bool, StopReason) {
    let ran = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&ran);
    let model = MockModel::new()
        .with_turn(MockTurn::content([ContentBlock::from(ToolUseBlock::new(
            "search",
            "tool-1",
            json!({"query": "test"}),
        ))]))
        .with_turn("Done");
    let tool = MockTool::new("search").with_result(move |context| {
        flag.store(true, Ordering::SeqCst);
        ToolOutcome::Result(ToolResultBlock::success(
            context.tool_use().tool_use_id.clone(),
            vec![ToolResultContent::text("results")],
        ))
    });
    let mut agent = Agent::builder()
        .model(model)
        .tools([tool])
        .interventions([handler])
        .printer(false)
        .build()
        .unwrap();
    let result = agent.invoke_with("Search", InvokeOptions::default()).await.unwrap();
    (ran.load(Ordering::SeqCst), result.stop_reason())
}

#[tokio::test]
async fn runs_a_permitted_tool_and_records_its_response() {
    let handler = Arc::new(dogwood(config(DELETE_AFTER_SEARCH)));

    let (ran, stop_reason) = run_search(Arc::clone(&handler)).await;

    assert_eq!(stop_reason, StopReason::EndTurn);
    assert!(ran);
    assert!(delete_allowed(&handler));
}

#[tokio::test]
async fn blocks_a_forbidden_tool_and_records_nothing_after_it() {
    let handler = Arc::new(dogwood(config(
        r#"permit(principal, action == Action::"delete_file", resource);"#,
    )));

    let (ran, _) = run_search(handler).await;

    assert!(!ran);
}

#[tokio::test]
async fn denies_the_tool_call_when_a_resolver_throws_and_on_error_is_deny() {
    let handler = Arc::new(dogwood(DogwoodAuthorizationConfig {
        principal_resolver: Some(PrincipalResolver::new(|_| Err("identity lookup failed".into()))),
        on_error: Some(OnError::Deny),
        ..config(PERMIT_SEARCH)
    }));

    let (ran, _) = run_search(handler).await;

    assert!(!ran);
}
