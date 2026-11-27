//! Dogwood policy authorization of tool calls.
//!
//! [`DogwoodAuthorization`] evaluates a [Dogwood](https://github.com/dogwood-policy/dogwood)
//! `.dw` policy set before each tool call and records each allowed call's result afterwards, so
//! temporal rules (`when temporal { formerly within 1h Action::"search"::response{} }`) can
//! correlate across calls. A call maps to the principal, `Action::"<tool name>"` (qualified by the
//! schema's namespace when it has one), `Resource::"agent"`, and `input` (the tool arguments) in
//! both the Cedar context and the temporal record. It runs `dogwood-language`, the engine behind
//! Dogwood's WebAssembly build, so decisions and messages match the other Strands SDKs.
//!
//! ```
//! use strands::Agent;
//! use strands::testing::MockModel;
//! use strands::types::ToolSpec;
//! use strands::vended_interventions::dogwood::{DogwoodAuthorization, DogwoodAuthorizationConfig};
//!
//! let search = ToolSpec::new("search", "Search for information");
//! let dogwood = DogwoodAuthorization::new(DogwoodAuthorizationConfig {
//!     policies: r#"permit(principal, action == Action::"search", resource);"#.into(),
//!     tools: Some(vec![search]),
//!     ..Default::default()
//! })?;
//! let agent = Agent::builder()
//!     .model(MockModel::new())
//!     .interventions([dogwood])
//!     .printer(false)
//!     .build()?;
//! # let _ = agent;
//! # Ok::<(), strands::Error>(())
//! ```

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use dogwood_ops::ops::validate_policies;
use dogwood_ops::{AuthorizerDecision, Diagnostic, EventInput, OpError, SchemaInputs};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::agent::InvocationState;
use crate::clock::Clock;
use crate::error::{BoxError, Error, Result};
use crate::hooks::{AfterToolCallEvent, BeforeToolCallEvent};
use crate::interventions::{InterventionAction, InterventionHandler, InterventionResult, OnError};
use crate::types::{JsonObject, JsonValue, ToolResultStatus, ToolSpec};

mod engine;

use engine::Engine;

/// The one context group a [`ContextEnricher`] can add.
const ENRICHED_GROUP: &str = "session";

/// The context group carrying the decision time, `context.system.now`.
const SYSTEM_GROUP: &str = "system";

/// The event kind that is a decision point.
const REQUEST: &str = "request";

/// The namespace Dogwood's schema generator emits; it takes no namespace of its own.
const GENERATED_NAMESPACE: &str = "Drupe";

/// The resource entity Dogwood's schema generator emits, from its MCP-gateway template.
const GENERATED_RESOURCE: &str = "Gateway";

/// The resource entity a schema declares, matching `CedarAuthorization`.
const RESOURCE: &str = "Resource";

/// Identifiers Cedar's grammar admits as a namespace and its parser then rejects.
const CEDAR_RESERVED: [&str; 9] = ["true", "false", "if", "then", "else", "in", "is", "like", "has"];

/// Cedar reserves this prefix for its own types.
const CEDAR_INTERNAL_PREFIX: &str = "__cedar";

/// An entity declaration with attributes: in a generated schema, an object parameter.
static PARAMETER_ENTITY: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?m)^(\s*)entity (\w+) = \{").ok());

const NO_PRINCIPAL: &str = "No principal identity found in invocation state";
const UNUSABLE: &str = "Dogwood authorizer is no longer usable; denying";
const PANICKED: &str = "Dogwood evaluation panicked; denying";

/// Event field groups, `group -> { field -> value }`.
type EventGroups = BTreeMap<String, BTreeMap<String, JsonValue>>;

/// A Dogwood entity reference (`EntityRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct EntityRef {
    /// The entity type, namespace included, such as `User` or `Acme::User`.
    #[serde(rename = "type")]
    pub entity_type: String,
    /// The raw, un-escaped entity id.
    pub id: String,
}

impl EntityRef {
    /// An entity reference.
    pub fn new(entity_type: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            entity_type: entity_type.into(),
            id: id.into(),
        }
    }

    fn to_dogwood(&self) -> dogwood_ops::EntityRef {
        dogwood_ops::EntityRef {
            ty: self.entity_type.clone(),
            id: self.id.clone(),
        }
    }
}

/// An entity supplied to every decision: its identity plus the attributes and direct parents a
/// policy reads (`EntityInput`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct EntityInput {
    /// The entity type, namespace included.
    #[serde(rename = "type")]
    pub entity_type: String,
    /// The raw, un-escaped entity id.
    pub id: String,
    /// Attributes, `name -> value`, validated against the action schema at decision time.
    #[serde(default)]
    pub attrs: JsonObject,
    /// Direct parents (`memberOf` edges); Cedar computes the transitive closure.
    #[serde(default)]
    pub parents: Vec<EntityRef>,
}

impl EntityInput {
    /// An entity with no attributes or parents.
    pub fn new(entity_type: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            entity_type: entity_type.into(),
            id: id.into(),
            ..Self::default()
        }
    }

    /// Sets the attributes.
    #[must_use]
    pub fn with_attrs(mut self, attrs: JsonObject) -> Self {
        self.attrs = attrs;
        self
    }

    /// Sets the direct parents.
    #[must_use]
    pub fn with_parents(mut self, parents: impl IntoIterator<Item = EntityRef>) -> Self {
        self.parents = parents.into_iter().collect();
        self
    }

    fn to_dogwood(&self) -> dogwood_ops::EntityInput {
        dogwood_ops::EntityInput {
            ty: self.entity_type.clone(),
            id: self.id.clone(),
            attrs: self
                .attrs
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
            parents: self.parents.iter().map(EntityRef::to_dogwood).collect(),
        }
    }
}

crate::callback::callback! {
    /// Resolves the principal from the invocation state; `None` denies (fail-closed).
    pub struct PrincipalResolver(Fn(&InvocationState) -> Result<Option<EntityRef>, BoxError>);
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
    /// Adds fields to the `session` group of the Cedar request context, read by a policy as
    /// `context.session.<field>`. The fields reach `when { .. }` conditions only: the default
    /// event schema declares a tool's input fields and nothing else, so a temporal predicate
    /// cannot read them.
    pub struct ContextEnricher(Fn(&ContextEnricherInput<'_>) -> Result<JsonObject, BoxError>);
}

/// Settings of a [`DogwoodAuthorization`] (`DogwoodAuthorizationConfig`).
#[derive(Clone, Default, bon::Builder)]
pub struct DogwoodAuthorizationConfig {
    /// Dogwood policy text, or the path of a `.dw` file.
    #[builder(into)]
    pub policies: String,
    /// Tools the action schema is generated from, when no `action_schema` is given. A tool's spec
    /// is [`Tool::tool_spec`](crate::tools::Tool::tool_spec).
    pub tools: Option<Vec<ToolSpec>>,
    /// Cedar action schema text, or the path of a `.cedarschema` file; generated from `tools`
    /// when unset. The handler reads the namespace from the schema's actions, so the schema must
    /// declare its user entity as `User` and its resource entity as `Resource`.
    #[builder(into)]
    pub action_schema: Option<String>,
    /// Entities supplied to every decision. Needs `action_schema`: a generated schema declares
    /// `User` and `Resource` with no attributes and no membership.
    pub entities: Option<Vec<EntityInput>>,
    /// The namespace of a generated action schema: `Acme::Action::"search"` instead of
    /// `Action::"search"`, with the default principal `Acme::User::"anonymous"`. Only valid with
    /// `tools`.
    #[builder(into)]
    pub namespace: Option<String>,
    /// A fixed principal. Defaults to `User::"anonymous"`, qualified by the schema's namespace.
    /// Exclusive with `principal_resolver`; against a generated schema its type must be `User`.
    pub principal: Option<EntityRef>,
    /// Resolves the principal per call, for multi-tenant agents. Exclusive with `principal`.
    #[builder(into)]
    pub principal_resolver: Option<PrincipalResolver>,
    /// Adds fields to `context.session`.
    #[builder(into)]
    pub context_enricher: Option<ContextEnricher>,
    /// What happens when the resolver or enricher fails. Defaults to [`OnError::Throw`];
    /// [`OnError::Deny`] fails closed; [`OnError::Proceed`] runs the tool without any check. A
    /// failed Dogwood decision always denies.
    pub on_error: Option<OnError>,
}

impl fmt::Debug for DogwoodAuthorizationConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DogwoodAuthorizationConfig")
            .field("policies", &self.policies)
            .field("tools", &self.tools)
            .field("action_schema", &self.action_schema)
            .field("entities", &self.entities)
            .field("namespace", &self.namespace)
            .field("principal", &self.principal)
            .field("on_error", &self.on_error)
            .finish_non_exhaustive()
    }
}

/// What recording a tool's result needs, captured when the call was allowed.
struct AllowedCall {
    tool_name: String,
    action: String,
    principal: EntityRef,
    logged: EventGroups,
}

struct History {
    authorizer: Engine,
    /// Calls decided and allowed, by tool-use id, until their result is recorded.
    allowed_calls: HashMap<String, AllowedCall>,
    /// Set by a panic inside the engine, whose state is then not trusted: every later decision
    /// denies without calling in.
    unusable: bool,
}

/// One event's fields before the engine's timestamp is applied.
struct Fields<'a> {
    action: &'a str,
    kind: &'a str,
    principal: &'a EntityRef,
    logged: EventGroups,
    context: EventGroups,
}

enum Submitted {
    Decided(Option<AuthorizerDecision>),
    Failed(String),
    Panicked,
}

/// Authorizes each tool call against a Dogwood policy set (`DogwoodAuthorization`).
///
/// Holds temporal history, so one instance is one ordered history. Every temporal predicate is
/// pinned to the deciding principal, so one instance serves many principals without their
/// histories mixing. History is never pruned; [`reset`](Self::reset) drops every principal's at
/// once.
///
/// A tool's result is not recorded, only the fact that it returned (or failed), so a predicate on
/// a result field type-checks and then never matches. A condition compares the tool arguments as
/// the model emitted them, and a generated schema is typed to match: an enum parameter compares
/// as a string and a number parameter as a whole number.
pub struct DogwoodAuthorization {
    history: Mutex<History>,
    actions_by_tool: HashMap<String, String>,
    declared_kinds: HashSet<String>,
    /// Tools whose action context declares `system`, which a conforming request must supply.
    system_tools: HashSet<String>,
    resource: EntityRef,
    default_principal: Option<EntityRef>,
    /// The only principal type a generated schema admits; `None` for a hand-written schema.
    principal_type: Option<String>,
    principal_resolver: Option<PrincipalResolver>,
    context_enricher: Option<ContextEnricher>,
    entities: Vec<dogwood_ops::EntityInput>,
    on_error: OnError,
    clock: Clock,
}

impl fmt::Debug for DogwoodAuthorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DogwoodAuthorization")
            .field("resource", &self.resource)
            .field("default_principal", &self.default_principal)
            .field("principal_type", &self.principal_type)
            .finish_non_exhaustive()
    }
}

impl DogwoodAuthorization {
    /// A handler with these settings; the policy set is parsed, type-checked and lowered now.
    ///
    /// # Errors
    ///
    /// Neither `action_schema` nor `tools`; both `principal` and `principal_resolver`;
    /// non-empty `entities` without `action_schema`; `namespace` with `action_schema`, or a
    /// namespace that is not `::`-separated Cedar identifiers; a `principal` of a type the
    /// generated schema does not declare; a missing `.dw` or `.cedarschema` file; a policy set
    /// that fails to parse or type-check against the schema (`Dogwood policy validation
    /// failed: ..`).
    pub fn new(config: DogwoodAuthorizationConfig) -> Result<Self> {
        let action_schema_source = config.action_schema.clone().filter(|schema| !schema.is_empty());
        check_config_shape(&config, action_schema_source.is_some())?;
        check_cedar_namespace(config.namespace.as_deref())?;

        let policies = load_source(&config.policies, ".dw")?;
        let action_schema = match &action_schema_source {
            Some(schema) => load_source(schema, ".cedarschema")?,
            None => apply_namespace(
                &generate_action_schema(config.tools.as_deref().unwrap_or_default())?,
                config.namespace.as_deref(),
            ),
        };
        // The one finding a generated schema causes by construction: it cannot declare the
        // enricher's context group. Everything else is fatal, including a typo in a temporal
        // predicate.
        let tolerate_enriched_group = action_schema_source.is_none() && config.context_enricher.is_some();
        let report = validate_policies(&policies, &SchemaInputs::default(), &action_schema).map_err(dogwood_error)?;
        check_policy_type_checks(&report.errors, tolerate_enriched_group)?;

        let authorizer = Engine::new(&policies, &action_schema).map_err(dogwood_error)?;
        let system_tools = tools_with_system_context(&authorizer.cedar_schema_json()?)?;
        let actions = authorizer.actions();
        let namespace = namespace_prefix_of(&actions);
        let actions_by_tool = actions
            .iter()
            .map(|action| (tool_name_of(action).to_owned(), action.clone()))
            .collect();
        let principal_type = action_schema_source.is_none().then(|| format!("{namespace}User"));
        let default_principal = match (&config.principal_resolver, config.principal) {
            (Some(_), _) => None,
            (None, Some(principal)) => Some(principal),
            (None, None) => Some(EntityRef::new(format!("{namespace}User"), "anonymous")),
        };
        let handler = Self {
            declared_kinds: authorizer.event_kinds().into_iter().collect(),
            history: Mutex::new(History {
                authorizer,
                allowed_calls: HashMap::new(),
                unusable: false,
            }),
            actions_by_tool,
            system_tools,
            resource: EntityRef::new(format!("{namespace}{RESOURCE}"), "agent"),
            default_principal,
            principal_type,
            principal_resolver: config.principal_resolver,
            context_enricher: config.context_enricher,
            entities: config
                .entities
                .unwrap_or_default()
                .iter()
                .map(EntityInput::to_dogwood)
                .collect(),
            on_error: config.on_error.unwrap_or_default(),
            clock: Clock::system(),
        };
        if let Some(principal) = &handler.default_principal
            && !handler.declares_principal_type(&principal.entity_type)
        {
            return Err(Error::other(format!(
                "`principal` must be of type `{}`, got `{}`",
                handler.principal_type.as_deref().unwrap_or_default(),
                principal.entity_type
            )));
        }
        Ok(handler)
    }

    /// Drops the accumulated temporal history of every principal this instance has decided for.
    pub fn reset(&self) {
        let mut history = self.history();
        if history.unusable {
            return;
        }
        // A call allowed against the old history must not record its result into the new one.
        history.allowed_calls.clear();
        history.authorizer.reset();
    }

    #[cfg(test)]
    fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    fn history(&self) -> MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn declares_principal_type(&self, entity_type: &str) -> bool {
        self.principal_type
            .as_deref()
            .is_none_or(|declared| declared == entity_type)
    }

    fn principal(&self, invocation_state: &InvocationState) -> Result<Option<EntityRef>, BoxError> {
        match (&self.default_principal, &self.principal_resolver) {
            (Some(principal), _) => Ok(Some(principal.clone())),
            (None, Some(resolve)) => resolve(invocation_state),
            (None, None) => Ok(None),
        }
    }

    fn decide(&self, event: &BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        let tool_use = event.tool_use();
        {
            let mut history = self.history();
            if history.unusable {
                return Ok(InterventionAction::deny(UNUSABLE));
            }
            // Resuming an interrupt fires this event again for a call already in the history.
            // The tool name is matched too, so an abandoned interrupt's entry cannot wave through
            // a later call that reuses its id for another tool.
            let decided = history
                .allowed_calls
                .get(&tool_use.tool_use_id)
                .is_some_and(|call| call.tool_name == tool_use.name);
            if decided {
                return Ok(InterventionAction::proceed());
            }
            history.allowed_calls.remove(&tool_use.tool_use_id);
        }

        let principal = self
            .principal(event.invocation_state())?
            .filter(|principal| !principal.entity_type.is_empty() && !principal.id.is_empty());
        let Some(principal) = principal else {
            return Ok(InterventionAction::deny(NO_PRINCIPAL));
        };
        if !self.declares_principal_type(&principal.entity_type) {
            return Ok(InterventionAction::deny(format!(
                "Principal type '{}' is not declared by the Dogwood action schema; denying",
                principal.entity_type
            )));
        }
        let Some(action) = self.actions_by_tool.get(&tool_use.name) else {
            return Ok(InterventionAction::deny(format!(
                "Tool '{}' is not declared by the Dogwood action schema; denying",
                tool_use.name
            )));
        };

        let enriched = self.enrich(&tool_use.name, &tool_use.input, event.invocation_state())?;
        let input = match input_group(&tool_use.input) {
            Ok(input) => input,
            Err(error) => return Ok(InterventionAction::deny(format!("Dogwood could not decide: {error}"))),
        };
        let logged = EventGroups::from([("input".to_owned(), input)]);
        let mut context = logged.clone();
        // No enriched fields means no group: the schema declares none for it.
        if let Some(enriched) = enriched.filter(|fields| !fields.is_empty()) {
            context.insert(ENRICHED_GROUP.to_owned(), enriched);
        }

        let mut history = self.history();
        let request = self.event(
            &history,
            Fields {
                action,
                kind: REQUEST,
                principal: &principal,
                logged: logged.clone(),
                context,
            },
        );
        let decision = match self.submit(&mut history, &request) {
            Submitted::Decided(decision) => decision,
            Submitted::Failed(error) => {
                return Ok(InterventionAction::deny(format!("Dogwood could not decide: {error}")));
            }
            Submitted::Panicked => return Ok(InterventionAction::deny(PANICKED)),
        };
        if let Some(denial) = denial_reason(decision.as_ref(), &tool_use.name) {
            return Ok(InterventionAction::deny(denial));
        }
        history.allowed_calls.insert(
            tool_use.tool_use_id.clone(),
            AllowedCall {
                tool_name: tool_use.name.clone(),
                action: action.clone(),
                principal,
                logged,
            },
        );
        Ok(InterventionAction::proceed())
    }

    /// Records an allowed call's result as a history-only `response` or `error` event. Runs no
    /// user code: the principal and fields are the ones the request was decided under.
    fn record(&self, event: &AfterToolCallEvent) {
        let tool_use = event.tool_use();
        let mut history = self.history();
        let matches = history
            .allowed_calls
            .get(&tool_use.tool_use_id)
            .is_some_and(|call| call.tool_name == tool_use.name);
        if history.unusable || !matches {
            return;
        }
        let Some(allowed) = history.allowed_calls.remove(&tool_use.tool_use_id) else {
            return;
        };
        // An error status with no error is how the executor reports a call a later handler
        // blocked; only an attached error proves the tool ran.
        if event.result().status == ToolResultStatus::Error && event.error().is_none() {
            return;
        }
        let kind = if event.error().is_some() { "error" } else { "response" };
        if !self.declared_kinds.contains(kind) {
            return;
        }
        let result = self.event(
            &history,
            Fields {
                action: &allowed.action,
                kind,
                principal: &allowed.principal,
                logged: allowed.logged.clone(),
                context: allowed.logged,
            },
        );
        let failure = match self.submit(&mut history, &result) {
            Submitted::Decided(_) => return,
            Submitted::Failed(error) => error,
            Submitted::Panicked => PANICKED.to_owned(),
        };
        // An unrecorded result cannot be enforced, so a later rule keyed on it does not fire.
        // Failing the tool call that already ran would be worse.
        tracing::warn!(
            "tool=<{}>, kind=<{kind}> | dogwood could not record a tool result, {failure}",
            allowed.tool_name
        );
    }

    fn enrich(
        &self,
        tool_name: &str,
        tool_input: &JsonValue,
        invocation_state: &InvocationState,
    ) -> Result<Option<BTreeMap<String, JsonValue>>, BoxError> {
        let Some(enrich) = &self.context_enricher else {
            return Ok(None);
        };
        let empty = JsonValue::Object(JsonObject::new());
        let tool_input = if tool_input.is_null() { &empty } else { tool_input };
        let fields = enrich(&ContextEnricherInput {
            tool_name,
            tool_input,
            invocation_state,
        })?;
        Ok(Some(fields.into_iter().collect()))
    }

    fn event(&self, history: &History, fields: Fields<'_>) -> EventInput {
        let timestamp = self.timestamp(history);
        let mut context = fields.context;
        if fields.kind == REQUEST && self.system_tools.contains(tool_name_of(fields.action)) {
            context.insert(SYSTEM_GROUP.to_owned(), system_group(timestamp));
        }
        EventInput {
            action: fields.action.to_owned(),
            kind: fields.kind.to_owned(),
            timestamp,
            principal: Some(fields.principal.to_dogwood()),
            resource: Some(self.resource.to_dogwood()),
            logged: fields.logged,
            context,
            entities: self.entities.clone(),
        }
    }

    /// Feeds one event to the engine. A panic inside it latches the handler unusable.
    fn submit(&self, history: &mut History, event: &EventInput) -> Submitted {
        let authorizer = &mut history.authorizer;
        match catch_unwind(AssertUnwindSafe(|| authorizer.is_authorized(event))) {
            Ok(Ok(decision)) => Submitted::Decided(decision),
            Ok(Err(error)) => Submitted::Failed(error),
            Err(_) => {
                history.unusable = true;
                Submitted::Panicked
            }
        }
    }

    /// Epoch seconds, never going backwards: the engine rejects a timestamp before the previous
    /// event's, and a system clock can step back.
    fn timestamp(&self, history: &History) -> i64 {
        let now = self.clock.now().as_second();
        now.max(history.authorizer.last_timestamp().unwrap_or(0))
    }
}

#[async_trait]
impl InterventionHandler for DogwoodAuthorization {
    fn name(&self) -> &str {
        "dogwood-authorization"
    }

    fn on_error(&self) -> OnError {
        self.on_error
    }

    async fn before_tool_call(&self, event: &mut BeforeToolCallEvent) -> InterventionResult<BeforeToolCallEvent> {
        self.decide(event)
    }

    async fn after_tool_call(&self, event: &mut AfterToolCallEvent) -> InterventionResult<AfterToolCallEvent> {
        self.record(event);
        Ok(InterventionAction::proceed())
    }
}

fn check_config_shape(config: &DogwoodAuthorizationConfig, has_action_schema: bool) -> Result<()> {
    if config.principal.is_some() && config.principal_resolver.is_some() {
        return Err(Error::other(
            "Provide either `principal` or `principal_resolver`, not both",
        ));
    }
    if !has_action_schema && config.tools.is_none() {
        return Err(Error::other("Provide either `action_schema` or `tools`"));
    }
    if !has_action_schema && config.entities.as_ref().is_some_and(|entities| !entities.is_empty()) {
        return Err(Error::other(
            "`entities` requires `action_schema`; a generated schema declares no entity attributes",
        ));
    }
    if has_action_schema && config.namespace.is_some() {
        return Err(Error::other(
            "`namespace` applies to a generated schema; a hand-written `action_schema` declares its own",
        ));
    }
    Ok(())
}

/// Rejects an illegal namespace up front; it would otherwise surface as a schema parse error
/// naming generated text the caller never wrote.
fn check_cedar_namespace(namespace: Option<&str>) -> Result<()> {
    let Some(namespace) = namespace else {
        return Ok(());
    };
    let legal = namespace.split("::").all(|segment| {
        is_cedar_identifier(segment)
            && !CEDAR_RESERVED.contains(&segment)
            && !segment.starts_with(CEDAR_INTERNAL_PREFIX)
    });
    if legal {
        return Ok(());
    }
    Err(Error::other(format!(
        "`namespace` must be `::`-separated Cedar identifiers, none of them reserved: '{namespace}'"
    )))
}

fn is_cedar_identifier(segment: &str) -> bool {
    let mut chars = segment.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|rest| rest.is_ascii_alphanumeric() || rest == '_')
}

/// Text ending in `extension` is a path to read; anything else is the source itself.
fn load_source(value: &str, extension: &str) -> Result<String> {
    if !value.ends_with(extension) {
        return Ok(value.to_owned());
    }
    std::fs::read_to_string(value).map_err(|_| Error::other(format!("Dogwood {extension} file not found: {value}")))
}

fn generate_action_schema(tools: &[ToolSpec]) -> Result<String> {
    // The generator needs an input schema on every tool; a spec without one takes no input.
    let tools: Vec<ToolSpec> = tools
        .iter()
        .cloned()
        .map(|mut tool| {
            tool.input_schema
                .get_or_insert_with(|| serde_json::json!({"type": "object", "properties": {}}));
            tool
        })
        .collect();
    let mut manifest = serde_json::to_value(&tools)?;
    retype_for_raw_arguments(&mut manifest);
    let schema = dogwood_ops::mcp_to_cedar_schema(&manifest.to_string()).map_err(dogwood_error)?;
    Ok(records_for_object_parameters(&rename_resource(&schema)))
}

/// Declares each object parameter as a common record type instead of the entity type generation
/// emits: the model sends an object, which conforms to a record and not to an entity reference.
/// `User` and `Resource` are declared without attributes, so they stay entities.
fn records_for_object_parameters(schema: &str) -> String {
    match PARAMETER_ENTITY.as_ref() {
        Some(entity) => entity.replace_all(schema, "${1}type ${2} = {").into_owned(),
        None => schema.to_owned(),
    }
}

/// Retypes parameters to the JSON a condition compares against. Generation types an `enum`
/// constraint as an entity type and a `number` as `decimal`, neither of which a raw argument
/// matches; dropping the constraint generates `String`, and `integer` generates `Long`. Only an
/// array-valued `enum` and the exact string `number` are rewritten, so a parameter named `enum`
/// or `type` is untouched.
fn retype_for_raw_arguments(value: &mut JsonValue) {
    match value {
        JsonValue::Object(map) => {
            if map.get("enum").is_some_and(JsonValue::is_array) {
                map.shift_remove("enum");
            }
            if let Some(number) = map.get_mut("type").filter(|ty| *ty == "number") {
                *number = JsonValue::from("integer");
            }
            map.values_mut().for_each(retype_for_raw_arguments);
        }
        JsonValue::Array(items) => items.iter_mut().for_each(retype_for_raw_arguments),
        _ => {}
    }
}

/// Renames the generator's resource entity to the one `CedarAuthorization` uses. Only the
/// declaration and the action references change: a tool or parameter whose own name contains
/// the generated name keeps it.
fn rename_resource(schema: &str) -> String {
    schema
        .replacen(
            &format!("entity {GENERATED_RESOURCE};"),
            &format!("entity {RESOURCE};"),
            1,
        )
        .replace(
            &format!("resource: [{GENERATED_RESOURCE}]"),
            &format!("resource: [{RESOURCE}]"),
        )
}

/// Declares a generated schema under `namespace`, or at the top level when there is none. An
/// object parameter is generated as its own entity type and referenced qualified, so those
/// references move with the declaration.
fn apply_namespace(schema: &str, namespace: Option<&str>) -> String {
    if namespace == Some(GENERATED_NAMESPACE) {
        return schema.to_owned();
    }
    let qualifier = namespace.map_or_else(String::new, |namespace| format!("{namespace}::"));
    let requalified = schema.replace(&format!("{GENERATED_NAMESPACE}::"), &qualifier);
    let opening = format!("namespace {GENERATED_NAMESPACE} {{");
    if let Some(namespace) = namespace {
        return requalified.replacen(&opening, &format!("namespace {namespace} {{"), 1);
    }
    let unwrapped = requalified.replacen(&opening, "", 1);
    match unwrapped.trim_end().strip_suffix('}') {
        Some(body) => body.to_owned(),
        None => unwrapped,
    }
}

/// The namespace the schema's actions live in, as a prefix ready to concatenate (`Acme::`), or
/// empty at the top level.
fn namespace_prefix_of(actions: &[String]) -> String {
    let Some(first) = actions.first() else {
        return String::new();
    };
    // The last marker, so a namespace with an `Action` segment of its own stays whole.
    match first.rfind("::Action::") {
        Some(index) if index > 0 => first[..index + 2].to_owned(),
        _ => String::new(),
    }
}

/// The tool name in a fully qualified action id: its last `::` segment.
fn tool_name_of(action: &str) -> &str {
    action.rsplit("::").next().unwrap_or(action)
}

/// The tools whose action context declares a `system` group, read from the lowered Cedar schema.
fn tools_with_system_context(cedar_schema_json: &str) -> Result<HashSet<String>> {
    let schema: JsonValue = serde_json::from_str(cedar_schema_json)?;
    let mut tools = HashSet::new();
    for namespace in schema.as_object().into_iter().flat_map(JsonObject::values) {
        let actions = namespace.get("actions").and_then(JsonValue::as_object);
        for (name, action) in actions.into_iter().flatten() {
            let declares = context_attributes(&action["appliesTo"]["context"], namespace)
                .is_some_and(|attributes| attributes.contains_key(SYSTEM_GROUP));
            if declares {
                tools.insert(name.clone());
            }
        }
    }
    Ok(tools)
}

/// A context's attributes: an inline record, or the common type it names in its namespace.
fn context_attributes<'a>(context: &'a JsonValue, namespace: &'a JsonValue) -> Option<&'a JsonObject> {
    if let Some(attributes) = context.get("attributes").and_then(JsonValue::as_object) {
        return Some(attributes);
    }
    let name = context
        .get("name")
        .or_else(|| context.get("type"))
        .and_then(JsonValue::as_str)?;
    namespace.get("commonTypes")?.get(name)?.get("attributes")?.as_object()
}

/// `{ now: datetime }` for the event time, in Cedar's extension escape.
fn system_group(timestamp: i64) -> BTreeMap<String, JsonValue> {
    let now = jiff::Timestamp::from_second(timestamp)
        .map(|at| at.strftime("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default();
    BTreeMap::from([(
        "now".to_owned(),
        serde_json::json!({"__extn": {"fn": "datetime", "arg": now}}),
    )])
}

/// The tool input as an event group; absent input is an empty group.
fn input_group(input: &JsonValue) -> std::result::Result<BTreeMap<String, JsonValue>, serde_json::Error> {
    if input.is_null() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_value(input.clone())
}

/// Fails unless every validation error is one a generated schema causes by construction, so a
/// policy that could only ever deny is rejected here rather than at the first tool call. Cedar
/// reports the shallowest missing attribute, so an enriched group reads as a bare `session`.
fn check_policy_type_checks(errors: &[Diagnostic], tolerate_enriched_group: bool) -> Result<()> {
    let enriched = format!("attribute `{ENRICHED_GROUP}` in context");
    let fatal: Vec<&str> = errors
        .iter()
        .filter(|error| !(tolerate_enriched_group && error.message.contains(&enriched)))
        .map(|error| error.message.as_str())
        .collect();
    if fatal.is_empty() {
        return Ok(());
    }
    Err(Error::other(format!(
        "Dogwood policy validation failed: {}",
        fatal.join(", ")
    )))
}

/// The denial reason for a decision, or `None` when it allowed.
fn denial_reason(decision: Option<&AuthorizerDecision>, tool_name: &str) -> Option<String> {
    // A decision kind always yields a verdict; an absent one fails closed.
    let Some(decision) = decision else {
        return Some(format!("No Dogwood decision returned for '{tool_name}'; denying"));
    };
    if decision.allowed {
        return None;
    }
    if !decision.errors.is_empty() {
        return Some(format!("Dogwood evaluation failed: {}", decision.errors.join(", ")));
    }
    let rules = &decision.determining_rules;
    if rules.is_empty() {
        return Some("Access denied by Dogwood policy".to_owned());
    }
    let rules: Vec<String> = rules.iter().map(ToString::to_string).collect();
    Some(format!("Access denied by Dogwood policy (rule {})", rules.join(", ")))
}

fn dogwood_error(error: OpError) -> Error {
    Error::other(error)
}

#[cfg(test)]
mod tests;
