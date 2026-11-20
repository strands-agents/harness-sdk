//! Cedar policy authorization of tool calls.
//!
//! [`CedarAuthorization`] evaluates [Cedar](https://cedarpolicy.com) policies before each tool
//! call. A call maps to the request `principal`, `Action::"<tool name>"`, `Resource::"agent"` and
//! the context `{ input: <tool input>, session: { hour_utc, call_count, ..enricher } }`. It runs
//! the native `cedar-policy` engine through the JSON interface of Cedar's WebAssembly build, so
//! decisions and messages match the other Strands SDKs.
//!
//! ```
//! use strands::Agent;
//! use strands::testing::MockModel;
//! use strands::vended_interventions::cedar::{CedarAuthorization, CedarAuthorizationConfig};
//!
//! let cedar = CedarAuthorization::new(CedarAuthorizationConfig {
//!     policies: r#"permit(principal, action == Action::"search", resource);"#.into(),
//!     ..Default::default()
//! })?;
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .interventions([cedar])
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

mod schema_generator;

use std::fmt;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError, RwLock};

use async_trait::async_trait;
use cedar_policy::ffi::{AuthorizationCall, ValidationCall, check_parse_policy_set_json, is_authorized, validate};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::agent::InvocationState;
use crate::error::{BoxError, Error, Result};
use crate::hooks::BeforeToolCallEvent;
use crate::interventions::{InterventionAction, InterventionHandler, InterventionResult, OnError};
use crate::state_store::StateStore;
use crate::types::{JsonObject, JsonValue, ToolSpec};

/// The app-state key of the per-tool call counts.
pub const CEDAR_AUTHORIZATION_STATE_KEY: &str = "cedar-authorization";

const NO_PRINCIPAL: &str = "No principal identity found in invocation state";
const INVALID_ENTITY: &str = "Invalid entity: each entity must have a uid with type and id";
const ACTION_ERRORS: [&str; 2] = ["unrecognized action", "unable to find an applicable action"];

/// A Cedar entity reference (`TypeAndId`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TypeAndId {
    /// The entity type, such as `User` or `Agent::User`.
    #[serde(rename = "type")]
    pub entity_type: String,
    /// The entity id.
    pub id: String,
}

impl TypeAndId {
    /// An entity reference.
    pub fn new(entity_type: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            entity_type: entity_type.into(),
            id: id.into(),
        }
    }
}

/// A tool for schema generation, in the MCP tool shape (`ToolDefinition`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolDefinition {
    /// The tool name, which is the Cedar action id.
    pub name: String,
    /// The JSON Schema of the tool input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<JsonValue>,
    /// What the tool does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl ToolDefinition {
    /// A definition with an input schema.
    pub fn new(name: impl Into<String>, input_schema: JsonValue) -> Self {
        Self {
            name: name.into(),
            input_schema: Some(input_schema),
            description: None,
        }
    }
}

impl From<ToolSpec> for ToolDefinition {
    fn from(spec: ToolSpec) -> Self {
        Self {
            name: spec.name,
            input_schema: spec.input_schema,
            description: Some(spec.description),
        }
    }
}

/// Entity data: Cedar entity JSON, or the path of a `.json` file.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum CedarEntities {
    /// Entities in Cedar's JSON format.
    List(Vec<JsonValue>),
    /// A JSON file with an array of entities.
    File(PathBuf),
}

impl From<Vec<JsonValue>> for CedarEntities {
    fn from(entities: Vec<JsonValue>) -> Self {
        Self::List(entities)
    }
}

impl From<PathBuf> for CedarEntities {
    fn from(path: PathBuf) -> Self {
        Self::File(path)
    }
}

impl From<&str> for CedarEntities {
    fn from(path: &str) -> Self {
        Self::File(path.into())
    }
}

impl From<String> for CedarEntities {
    fn from(path: String) -> Self {
        Self::File(path.into())
    }
}

crate::callback::callback! {
    /// Resolves the principal from the invocation state; `None` denies.
    pub struct PrincipalResolver(Fn(&InvocationState) -> Result<Option<TypeAndId>, BoxError>);
}

/// What a [`ContextEnricher`] gets.
#[derive(Debug)]
#[non_exhaustive]
pub struct ContextEnricherInput<'a> {
    /// The tool name.
    pub tool_name: &'a str,
    /// The tool input.
    pub tool_input: &'a JsonValue,
    /// The caller's invocation state.
    pub invocation_state: &'a InvocationState,
}

crate::callback::callback! {
    /// Adds fields to `context.session`; it cannot overwrite `hour_utc` or
    /// `call_count`.
    pub struct ContextEnricher(Fn(&ContextEnricherInput<'_>) -> Result<JsonObject, BoxError>);
}

/// Settings of a [`CedarAuthorization`] (`CedarAuthorizationConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct CedarAuthorizationConfig {
    /// Cedar policy text, or the path of a `.cedar` file.
    #[builder(into)]
    pub policies: String,
    /// Tools to generate a validation schema from, when no `schema` is given.
    pub tools: Option<Vec<ToolDefinition>>,
    /// Entity data; only needed for entity hierarchies and attributes.
    #[builder(into)]
    pub entities: Option<CedarEntities>,
    /// A Cedar schema to validate the policies against: schema text, or the path of a
    /// `.cedarschema` file. Generated from `tools` when unset.
    #[builder(into)]
    pub schema: Option<String>,
    /// The namespace of actions and resources: `Agent::Action::"search"` instead of
    /// `Action::"search"`; generated schemas keep it.
    #[builder(into)]
    pub namespace: Option<String>,
    /// A fixed principal. Defaults to `User::"anonymous"`. Exclusive with `principal_resolver`.
    pub principal: Option<TypeAndId>,
    /// Resolves the principal per call, for multi-tenant agents. Exclusive with `principal`.
    #[builder(into)]
    pub principal_resolver: Option<PrincipalResolver>,
    /// Adds fields to `context.session`.
    #[builder(into)]
    pub context_enricher: Option<ContextEnricher>,
    /// What happens when the resolver or enricher fails. Defaults to [`OnError::Throw`];
    /// [`OnError::Deny`] fails closed; [`OnError::Proceed`] runs the tool without any check.
    pub on_error: Option<OnError>,
}

impl fmt::Debug for CedarAuthorizationConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CedarAuthorizationConfig")
            .field("policies", &self.policies)
            .field("tools", &self.tools)
            .field("entities", &self.entities)
            .field("schema", &self.schema)
            .field("namespace", &self.namespace)
            .field("principal", &self.principal)
            .field("on_error", &self.on_error)
            .finish_non_exhaustive()
    }
}

/// Where the policies, entities and schema come from; [`CedarAuthorization::reload`] reads them
/// again.
struct Sources {
    policies: String,
    entities: Option<CedarEntities>,
    schema: Option<String>,
    tools: Option<Vec<ToolDefinition>>,
    namespace: Option<String>,
}

struct Loaded {
    policies: String,
    entities: Vec<JsonValue>,
}

/// Authorizes each tool call against Cedar policies (`CedarAuthorization`).
///
/// A denial is the tool result `DENIED: Access denied by Cedar policy[: <details>]`. The per-tool
/// call counts behind `context.session.call_count` are kept in app state under
/// [`CEDAR_AUTHORIZATION_STATE_KEY`]; a denied call does not count.
pub struct CedarAuthorization {
    sources: Sources,
    loaded: RwLock<Loaded>,
    principal: Option<TypeAndId>,
    principal_resolver: Option<PrincipalResolver>,
    context_enricher: Option<ContextEnricher>,
    on_error: OnError,
    action_type: String,
    resource: TypeAndId,
    call_counts: Mutex<IndexMap<String, i64>>,
}

impl fmt::Debug for CedarAuthorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CedarAuthorization")
            .field("principal", &self.principal)
            .field("action_type", &self.action_type)
            .field("resource", &self.resource)
            .finish_non_exhaustive()
    }
}

impl CedarAuthorization {
    /// A handler with these settings; policies are parsed and validated now.
    ///
    /// # Errors
    ///
    /// Both a principal and a resolver; a missing policy, schema or entity file
    /// (`Cedar policy file not found: <path>`); invalid policies (`Invalid Cedar policy: ..`);
    /// policies that fail schema validation (`Cedar policy validation failed: ..`); a failed
    /// schema generation (`Schema generation failed: ..`); an entity without a uid.
    pub fn new(config: CedarAuthorizationConfig) -> Result<Self> {
        if config.principal.is_some() && config.principal_resolver.is_some() {
            return Err(Error::other(
                "Provide either `principal` or `principal_resolver`, not both",
            ));
        }
        // An empty schema or namespace counts as no schema or namespace.
        let sources = Sources {
            policies: config.policies,
            entities: config.entities,
            schema: config.schema.filter(|schema| !schema.is_empty()),
            tools: config.tools,
            namespace: config.namespace.filter(|namespace| !namespace.is_empty()),
        };
        let loaded = sources.load()?;
        let namespace = sources.namespace.as_deref();
        let principal = match (&config.principal_resolver, config.principal) {
            (Some(_), _) => None,
            (None, Some(principal)) => Some(principal),
            (None, None) => Some(TypeAndId::new(qualify(namespace, "User"), "anonymous")),
        };
        let resource_id = if namespace.is_some() { "default" } else { "agent" };
        Ok(Self {
            action_type: qualify(namespace, "Action"),
            resource: TypeAndId::new(qualify(namespace, "Resource"), resource_id),
            sources,
            loaded: RwLock::new(loaded),
            principal,
            principal_resolver: config.principal_resolver,
            context_enricher: config.context_enricher,
            on_error: config.on_error.unwrap_or_default(),
            call_counts: Mutex::new(IndexMap::new()),
        })
    }

    /// Clears the rate-limit call counts, in memory and in `app_state`. Pass
    /// the agent's `app_state()`.
    pub fn reset_call_counts(&self, app_state: &StateStore) {
        self.counts().clear();
        if let Err(error) = app_state.set(CEDAR_AUTHORIZATION_STATE_KEY, json!({})) {
            tracing::warn!("error=<{error}> | failed to reset the cedar call counts");
        }
    }

    /// Reads the policies, entities and schema again (`reload`), validating before the new ones
    /// take effect.
    ///
    /// # Errors
    ///
    /// The same as [`new`](Self::new); the previous policies stay in effect.
    pub fn reload(&self) -> Result<()> {
        let loaded = self.sources.load()?;
        *self.loaded.write().unwrap_or_else(PoisonError::into_inner) = loaded;
        Ok(())
    }

    fn counts(&self) -> std::sync::MutexGuard<'_, IndexMap<String, i64>> {
        self.call_counts.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn increment_call_count(&self, app_state: &StateStore, tool_name: &str) -> i64 {
        let mut counts = self.counts();
        if counts.is_empty() {
            let stored: Option<IndexMap<String, i64>> = app_state.get(CEDAR_AUTHORIZATION_STATE_KEY).ok().flatten();
            counts.extend(stored.unwrap_or_default());
        }
        let next = counts.get(tool_name).copied().unwrap_or(0) + 1;
        counts.insert(tool_name.to_owned(), next);
        store_counts(app_state, &counts);
        next
    }

    fn decrement_call_count(&self, app_state: &StateStore, tool_name: &str) {
        let mut counts = self.counts();
        let Some(current) = counts.get_mut(tool_name).filter(|current| **current > 0) else {
            return;
        };
        *current -= 1;
        store_counts(app_state, &counts);
    }

    fn principal(&self, invocation_state: &InvocationState) -> Result<Option<TypeAndId>, BoxError> {
        match (&self.principal, &self.principal_resolver) {
            (Some(principal), _) => Ok(Some(principal.clone())),
            (None, Some(resolve)) => resolve(invocation_state),
            (None, None) => Ok(None),
        }
    }

    fn authorize(&self, event: &BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        let principal = self
            .principal(event.invocation_state())?
            .filter(|principal| !principal.entity_type.is_empty() && !principal.id.is_empty());
        let Some(principal) = principal else {
            return Ok(InterventionAction::deny(NO_PRINCIPAL));
        };
        let tool_name = event.tool_use().name.as_str();
        let app_state = event.agent().app_state();
        let call_count = self.increment_call_count(app_state, tool_name);
        let tool_input = match &event.tool_use().input {
            JsonValue::Null => json!({}),
            input => input.clone(),
        };
        let mut session = match &self.context_enricher {
            Some(enrich) => enrich(&ContextEnricherInput {
                tool_name,
                tool_input: &tool_input,
                invocation_state: event.invocation_state(),
            })?,
            None => JsonObject::new(),
        };
        session.insert("hour_utc".to_owned(), utc_hour().into());
        session.insert("call_count".to_owned(), call_count.into());

        let call = {
            let loaded = self.loaded.read().unwrap_or_else(PoisonError::into_inner);
            json!({
                "principal": principal,
                "action": {"type": self.action_type, "id": tool_name},
                "resource": self.resource,
                "context": {"input": tool_input, "session": session},
                "policies": {"staticPolicies": loaded.policies},
                "entities": loaded.entities,
            })
        };
        match evaluate(call) {
            Decision::Allow => Ok(InterventionAction::proceed()),
            Decision::Deny(reason) => {
                self.decrement_call_count(app_state, tool_name);
                Ok(InterventionAction::deny(reason))
            }
        }
    }
}

#[async_trait]
impl InterventionHandler for CedarAuthorization {
    fn name(&self) -> &str {
        "cedar-authorization"
    }

    fn on_error(&self) -> OnError {
        self.on_error
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        self.authorize(event)
    }
}

enum Decision {
    Allow,
    Deny(String),
}

fn messages(errors: &[JsonValue], pointer: &str) -> Vec<String> {
    errors
        .iter()
        .filter_map(|error| error.pointer(pointer).and_then(JsonValue::as_str))
        .map(str::to_owned)
        .collect()
}

/// Runs Cedar's `is_authorized` on a JSON authorization call.
fn evaluate(call: JsonValue) -> Decision {
    let answer = match serde_json::from_value::<AuthorizationCall>(call) {
        Ok(call) => is_authorized(call),
        Err(error) => return Decision::Deny(format!("Cedar evaluation failed: {error}")),
    };
    let answer = serde_json::to_value(answer).unwrap_or(JsonValue::Null);
    if !matches!(answer.get("type").and_then(JsonValue::as_str), Some("success")) {
        let errors = answer
            .get("errors")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        return Decision::Deny(format!(
            "Cedar evaluation failed: {}",
            messages(&errors, "/message").join(", ")
        ));
    }
    let response = &answer["response"];
    if response["decision"] == "allow" {
        return Decision::Allow;
    }
    let reasons = response["diagnostics"]["reason"]
        .as_array()
        .map(|reasons| {
            reasons
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let errors = response["diagnostics"]["errors"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let details: Vec<String> = reasons
        .into_iter()
        .chain(messages(&errors, "/error/message"))
        .filter(|detail| !detail.is_empty())
        .collect();
    if details.is_empty() {
        return Decision::Deny("Access denied by Cedar policy".to_owned());
    }
    Decision::Deny(format!("Access denied by Cedar policy: {}", details.join(", ")))
}

fn store_counts(app_state: &StateStore, counts: &IndexMap<String, i64>) {
    if let Err(error) = app_state.set(CEDAR_AUTHORIZATION_STATE_KEY, counts) {
        tracing::warn!("error=<{error}> | failed to store the cedar call counts");
    }
}

fn qualify(namespace: Option<&str>, name: &str) -> String {
    match namespace {
        Some(namespace) => format!("{namespace}::{name}"),
        None => name.to_owned(),
    }
}

fn utc_hour() -> i64 {
    jiff::Timestamp::now().as_second().rem_euclid(86_400) / 3_600
}

impl Sources {
    fn load(&self) -> Result<Loaded> {
        let policies = load_policies(&self.policies)?;
        let entities = load_entities(self.entities.as_ref())?;
        let (schema, generated) = match (&self.schema, &self.tools) {
            (Some(schema), _) => (Some(load_schema(schema)?), false),
            (None, Some(tools)) => (
                Some(schema_generator::generate_schema(tools, self.namespace.as_deref())?),
                true,
            ),
            (None, None) => (None, false),
        };
        validate_policies(&policies, schema.as_deref(), generated)?;
        Ok(Loaded { policies, entities })
    }
}

fn load_policies(policies: &str) -> Result<String> {
    load_file_if(policies, ".cedar", "Cedar policy file not found")
}

fn load_schema(schema: &str) -> Result<String> {
    load_file_if(schema, ".cedarschema", "Cedar schema file not found")
}

/// Text ending in `suffix` is a path to read; anything else is the content itself.
fn load_file_if(text: &str, suffix: &str, missing: &str) -> Result<String> {
    if !text.ends_with(suffix) {
        return Ok(text.to_owned());
    }
    std::fs::read_to_string(text).map_err(|_| Error::other(format!("{missing}: {text}")))
}

fn load_entities(entities: Option<&CedarEntities>) -> Result<Vec<JsonValue>> {
    let entities = match entities {
        None => return Ok(Vec::new()),
        Some(CedarEntities::List(entities)) => entities.clone(),
        Some(CedarEntities::File(path)) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
    };
    for entity in &entities {
        let uid = entity.get("uid").ok_or_else(|| Error::other(INVALID_ENTITY))?;
        let uid = uid.get("__entity").unwrap_or(uid);
        let present = |field: &str| {
            uid.get(field)
                .and_then(JsonValue::as_str)
                .is_some_and(|value| !value.is_empty())
        };
        if !present("type") || !present("id") {
            return Err(Error::other(INVALID_ENTITY));
        }
    }
    Ok(entities)
}

fn validate_policies(policies: &str, schema: Option<&str>, generated: bool) -> Result<()> {
    let parsed = check_parse_policy_set_json(json!({"staticPolicies": policies}))?;
    if parsed.get("type").and_then(JsonValue::as_str) != Some("success") {
        let errors = parsed
            .get("errors")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        return Err(Error::other(format!(
            "Invalid Cedar policy: {}",
            messages(&errors, "/message").join(", ")
        )));
    }
    let Some(schema) = schema.filter(|schema| !schema.is_empty()) else {
        return Ok(());
    };
    let call: ValidationCall = serde_json::from_value(json!({
        "schema": schema,
        "policies": {"staticPolicies": policies},
    }))?;
    let answer = serde_json::to_value(validate(call))?;
    let failed = |errors: Vec<String>| Error::other(format!("Cedar policy validation failed: {}", errors.join(", ")));
    if !matches!(answer.get("type").and_then(JsonValue::as_str), Some("success")) {
        let errors = answer
            .get("errors")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        return Err(failed(messages(&errors, "/message")));
    }
    let errors: Vec<String> = answer["validationErrors"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|error| {
            let message = error.pointer("/error/message")?.as_str()?;
            // A generated schema knows only the tool inputs, not the handler-injected session
            // fields, so only action errors (typos in tool names) count.
            let relevant = !generated || ACTION_ERRORS.iter().any(|needle| message.contains(needle));
            relevant.then(|| format!("{}: {message}", error["policyId"].as_str().unwrap_or_default()))
        })
        .collect();
    if errors.is_empty() {
        return Ok(());
    }
    Err(failed(errors))
}

#[cfg(test)]
mod tests;
