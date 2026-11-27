//! A stateful Dogwood authorizer over `dogwood-language`, deciding like
//! `dogwood_ops::LiveAuthorizer` with one difference: an empty event group is sent as an empty
//! record instead of being dropped, so a tool called without arguments still supplies the
//! `input` its action context requires.

use std::collections::{BTreeMap, BTreeSet};

use dogwood_ops::dogwood_language::{Authorizer, Decision, Event, LoweredPolicySet, Value};
use dogwood_ops::fail_closed::fail_closed;
use dogwood_ops::live::to_value;
use dogwood_ops::ops::{Verdict, lower_for_authorizer};
use dogwood_ops::{AuthorizerDecision, EventInput, OpError, SchemaInputs};

use crate::error::{Error, Result};

/// An action's namespace (its `Action` segment included) and bare id.
struct ActionParts {
    namespace: Vec<String>,
    id: String,
}

/// One ordered history of events and the decisions made against it.
pub(super) struct Engine {
    authorizer: Authorizer,
    lowered: LoweredPolicySet,
    /// Every action by its fully qualified id (`Drupe::Action::search`).
    actions: BTreeMap<String, ActionParts>,
    kinds: BTreeSet<String>,
    decisions: usize,
    last_timestamp: Option<i64>,
}

impl Engine {
    /// Lowers `policies` against `action_schema`, with the default event schema, providers and
    /// macros, and starts an empty history.
    pub(super) fn new(policies: &str, action_schema: &str) -> Result<Self, OpError> {
        let lowered = lower_for_authorizer(policies, &SchemaInputs::default(), action_schema)?;
        let mut actions = BTreeMap::new();
        let mut kinds = BTreeSet::new();
        for signature in lowered.event_signatures() {
            let namespace: Vec<String> = signature.namespace().iter().map(ToString::to_string).collect();
            let qualified = format!("{}::{}", namespace.join("::"), signature.action());
            actions.entry(qualified).or_insert_with(|| ActionParts {
                namespace,
                id: signature.action().to_owned(),
            });
            kinds.insert(signature.kind().to_owned());
        }
        Ok(Self {
            authorizer: Authorizer::new(lowered.clone()),
            lowered,
            actions,
            kinds,
            decisions: 0,
            last_timestamp: None,
        })
    }

    /// The lowered Cedar schema in Cedar's JSON form.
    pub(super) fn cedar_schema_json(&self) -> Result<String> {
        self.lowered
            .cedar_schema_json()
            .map_err(|error| Error::other(error.to_string()))
    }

    /// Every fully qualified action id the schema declares.
    pub(super) fn actions(&self) -> Vec<String> {
        self.actions.keys().cloned().collect()
    }

    /// Every event kind the event schema declares.
    pub(super) fn event_kinds(&self) -> Vec<String> {
        self.kinds.iter().cloned().collect()
    }

    /// The timestamp of the last event recorded; the next one must not be earlier.
    pub(super) fn last_timestamp(&self) -> Option<i64> {
        self.last_timestamp
    }

    /// Drops the history; the decision index restarts at 0.
    pub(super) fn reset(&mut self) {
        self.authorizer = Authorizer::new(self.lowered.clone());
        self.decisions = 0;
        self.last_timestamp = None;
    }

    /// Feeds one event: a decision for a decision kind, `None` for a history-only event. Any
    /// evaluation error denies. A malformed or rejected event leaves the history untouched.
    pub(super) fn is_authorized(&mut self, input: &EventInput) -> Result<Option<AuthorizerDecision>, String> {
        let Some(action) = self.actions.get(&input.action) else {
            return Err(format!(
                "unknown action `{}`: not declared by the action schema",
                input.action
            ));
        };
        if !self.kinds.contains(&input.kind) {
            return Err(format!("unknown event kind `{}`", input.kind));
        }
        if self.last_timestamp.is_some_and(|last| input.timestamp < last) {
            return Err(format!(
                "event timestamp {} is before the previous event's",
                input.timestamp
            ));
        }
        let event = build_event(input, action)?;
        // A nonconforming decision event is denied without entering the history, so only a
        // conforming one moves the timestamp on.
        let conforms = self
            .lowered
            .check_event_conformance(&event, self.authorizer.mirror_rule())
            .is_ok();
        let response = self
            .authorizer
            .submit(&event)
            .map_err(|rejection| format!("event rejected, not recorded in the history: {rejection}"))?;
        if conforms {
            self.last_timestamp = Some(input.timestamp);
        }
        let Some(response) = response else {
            return Ok(None);
        };
        let errors: Vec<String> = response.diagnostics().errors().map(str::to_owned).collect();
        let mut verdict = match response.decision() {
            Decision::Allow => Verdict::Allow,
            Decision::Deny => Verdict::Deny,
        };
        let mut determining_rules: Vec<usize> = response
            .diagnostics()
            .reason()
            .map(|reason| reason.rule_index)
            .collect();
        fail_closed(&mut verdict, &mut determining_rules, &errors);
        let decision = AuthorizerDecision {
            index: self.decisions,
            timestamp: input.timestamp,
            verdict,
            allowed: verdict == Verdict::Allow,
            determining_rules,
            errors,
        };
        self.decisions += 1;
        Ok(Some(decision))
    }
}

fn build_event(input: &EventInput, action: &ActionParts) -> Result<Event, String> {
    let namespace: Vec<&str> = action.namespace.iter().map(String::as_str).collect();
    let mut builder = Event::builder_for(&namespace, &action.id, &input.kind).timestamp(input.timestamp);
    if let Some(principal) = &input.principal {
        builder = builder.principal_for(&principal.ty, &principal.id);
    }
    if let Some(resource) = &input.resource {
        builder = builder.resource_for(&resource.ty, &resource.id);
    }
    // Fields start at depth 1: a group is itself the depth-0 record.
    for (group, fields) in &input.logged {
        if fields.is_empty() {
            builder = builder.logged_field(group, Value::Object(BTreeMap::new()));
        }
        for (name, value) in fields {
            builder = builder.field(group, name, to_value(value, 1)?);
        }
    }
    for (group, fields) in &input.context {
        if fields.is_empty() {
            builder = builder.request_context_field(group, Value::Object(BTreeMap::new()));
        }
        for (name, value) in fields {
            builder = builder.request_context(group, name, to_value(value, 1)?);
        }
    }
    for entity in &input.entities {
        let attrs = entity
            .attrs
            .iter()
            .map(|(name, value)| to_value(value, 0).map(|value| (name.as_str(), value)))
            .collect::<Result<Vec<_>, _>>()?;
        builder = builder.entity_for(&entity.ty, &entity.id, attrs);
        if !entity.parents.is_empty() {
            let parents: Vec<(&str, &str)> = entity
                .parents
                .iter()
                .map(|parent| (parent.ty.as_str(), parent.id.as_str()))
                .collect();
            builder = builder.parents_for(&entity.ty, &entity.id, parents);
        }
    }
    Ok(builder.build())
}
