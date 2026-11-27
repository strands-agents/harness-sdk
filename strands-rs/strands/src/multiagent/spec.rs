//! Multi-agent specification and resolution.
//!
//! The model configures child agents at runtime; the developer sets one policy per axis that
//! shapes the parameters the model sees and what it may supply:
//!
//! - [`Fixed`]: a developer-pinned value, hidden from the model;
//! - [`Inherit`]: the parent agent's value, hidden from the model;
//! - [`Open`]: a free-form value from the model;
//! - [`Choice`]: a pick from a developer-supplied set.

use std::fmt;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::json;

use crate::agent::Agent;
use crate::error::{Error, Result};
use crate::models::Model;
use crate::types::{JsonObject, JsonValue};

/// The model-facing description of each axis parameter (`AXIS_DESCRIPTIONS`).
pub(crate) const AGENT_TYPE_DESCRIPTION: &str = "Role to assign this agent.";
pub(crate) const INSTRUCTIONS_DESCRIPTION: &str = "A system prompt defining this agent's role.";
pub(crate) const TOOLS_DESCRIPTION: &str = "Subset of tools to grant this agent. Fewer is safer; it cannot exceed your own. Omit to grant all inherited tools.";
pub(crate) const MODEL_DESCRIPTION: &str = "Which model this agent runs on. Omit to inherit the parent's model.";

/// A value an axis pins or a choice stands for.
#[derive(Clone)]
#[non_exhaustive]
pub enum SpecValue {
    /// Text: instructions, a tool name, a context mode, or a Bedrock model id.
    Text(String),
    /// A list of tool names.
    List(Vec<String>),
    /// A model instance.
    Model(Arc<dyn Model>),
}

impl SpecValue {
    fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }
}

impl From<&str> for SpecValue {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for SpecValue {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<Vec<String>> for SpecValue {
    fn from(list: Vec<String>) -> Self {
        Self::List(list)
    }
}

impl From<Vec<&str>> for SpecValue {
    fn from(list: Vec<&str>) -> Self {
        Self::List(list.into_iter().map(str::to_owned).collect())
    }
}

impl From<Arc<dyn Model>> for SpecValue {
    fn from(model: Arc<dyn Model>) -> Self {
        Self::Model(model)
    }
}

impl fmt::Debug for SpecValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Text(text) => f.debug_tuple("Text").field(text).finish(),
            Self::List(list) => f.debug_tuple("List").field(list).finish(),
            Self::Model(model) => f.debug_tuple("Model").field(&model.model_id()).finish(),
        }
    }
}

impl PartialEq for SpecValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Text(a), Self::Text(b)) => a == b,
            (Self::List(a), Self::List(b)) => a == b,
            (Self::Model(a), Self::Model(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }
}

/// The developer pins the value; the axis adds no model-facing parameter (`Fixed`).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct Fixed {
    /// The pinned value; `None` pins "unset".
    pub value: Option<SpecValue>,
}

impl Fixed {
    /// Pins `value`.
    pub fn new(value: impl Into<SpecValue>) -> Self {
        Self {
            value: Some(value.into()),
        }
    }

    /// Pins "unset".
    #[must_use]
    pub fn none() -> Self {
        Self::default()
    }
}

/// The child takes the parent's value; the axis adds no model-facing parameter (`Inherit`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Inherit;

impl Inherit {
    /// The inherit marker.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

/// The model writes the value freely; the axis adds a string parameter (`Open`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Open;

impl Open {
    /// The open marker.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

/// A selectable entry of a [`Choice`] (named to stay clear of the prelude's `Option`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ChoiceOption {
    /// The name the model picks.
    pub name: String,
    /// The value behind the name; `None` stands for the name itself.
    pub value: Option<SpecValue>,
    /// Shown to the model next to the name.
    pub description: String,
}

impl ChoiceOption {
    /// An option standing for its own name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            value: None,
            description: String::new(),
        }
    }

    /// Sets the value behind the name.
    #[must_use]
    pub fn with_value(mut self, value: impl Into<SpecValue>) -> Self {
        self.value = Some(value.into());
        self
    }

    /// Sets the description shown to the model.
    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    fn resolved_value(&self) -> SpecValue {
        self.value.clone().unwrap_or_else(|| SpecValue::Text(self.name.clone()))
    }
}

impl From<&str> for ChoiceOption {
    fn from(name: &str) -> Self {
        Self::new(name)
    }
}

impl From<String> for ChoiceOption {
    fn from(name: String) -> Self {
        Self::new(name)
    }
}

/// The model picks from a developer-supplied set (`Choice`); with `multiple`, more than one.
///
/// ```
/// use strands::multiagent::{Choice, ChoiceOption};
///
/// let tools = Choice::new([ChoiceOption::new("readonly").with_value("read"), "shell".into()]).multiple(true);
/// assert_eq!(tools.value_for("readonly"), "read".into());
/// assert_eq!(tools.value_for("unknown"), "unknown".into());
/// ```
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct Choice {
    /// The options, bare names or [`ChoiceOption`]s.
    pub options: Vec<ChoiceOption>,
    /// Whether the model may pick several, as an array.
    pub multiple: bool,
}

impl Choice {
    /// A single choice from `options`.
    pub fn new(options: impl IntoIterator<Item = impl Into<ChoiceOption>>) -> Self {
        Self {
            options: options.into_iter().map(Into::into).collect(),
            multiple: false,
        }
    }

    /// Sets whether the model may pick several.
    #[must_use]
    pub fn multiple(mut self, multiple: bool) -> Self {
        self.multiple = multiple;
        self
    }

    /// The options with each value resolved: an unset value stands for the name (`normalized`).
    #[must_use]
    pub fn normalized(&self) -> Vec<ChoiceOption> {
        self.options
            .iter()
            .map(|option| ChoiceOption {
                value: Some(option.resolved_value()),
                ..option.clone()
            })
            .collect()
    }

    /// The value behind `name`, or `name` itself when no option has it.
    #[must_use]
    pub fn value_for(&self, name: &str) -> SpecValue {
        self.options
            .iter()
            .find(|option| option.name == name)
            .map_or_else(|| SpecValue::Text(name.to_owned()), ChoiceOption::resolved_value)
    }

    fn has(&self, name: &str) -> bool {
        self.options.iter().any(|option| option.name == name)
    }
}

/// Any authority mode an axis can take (`Axis`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Axis {
    /// [`Fixed`].
    Fixed(Fixed),
    /// [`Inherit`].
    Inherit(Inherit),
    /// [`Open`].
    Open(Open),
    /// [`Choice`].
    Choice(Choice),
}

impl Axis {
    /// The mode's name, for error messages.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Fixed(_) => "Fixed",
            Self::Inherit(_) => "Inherit",
            Self::Open(_) => "Open",
            Self::Choice(_) => "Choice",
        }
    }
}

impl From<Fixed> for Axis {
    fn from(axis: Fixed) -> Self {
        Self::Fixed(axis)
    }
}

impl From<Inherit> for Axis {
    fn from(axis: Inherit) -> Self {
        Self::Inherit(axis)
    }
}

impl From<Open> for Axis {
    fn from(axis: Open) -> Self {
        Self::Open(axis)
    }
}

impl From<Choice> for Axis {
    fn from(axis: Choice) -> Self {
        Self::Choice(axis)
    }
}

/// A named role, selected with `agent_type`: a partial child configuration (`Preset`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
#[builder(on(String, into))]
#[non_exhaustive]
pub struct Preset {
    /// The child's system prompt.
    pub instructions: Option<String>,
    /// The tool names granted to the child.
    #[builder(with = |tools: impl IntoIterator<Item = impl Into<String>>| tools.into_iter().map(Into::into).collect())]
    pub tools: Option<Vec<String>>,
    /// The child's model: an instance ([`SpecValue::Model`]) or a Bedrock model id
    /// ([`SpecValue::Text`]).
    #[builder(into)]
    pub model: Option<SpecValue>,
    /// Shown to the model next to the preset's name.
    #[builder(default)]
    pub description: String,
}

/// The resolved configuration of one child agent, handed to the [`ChildAgentBuilder`]
/// (`AgentSpec`). `None` fields inherit from the parent.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct AgentSpec {
    /// The child's name, which the default builder also uses as its id.
    pub name: Option<String>,
    /// The preset the child was built from.
    pub agent_type: Option<String>,
    /// The child's system prompt.
    pub instructions: Option<String>,
    /// The tool names granted to the child; `None` grants all of the parent's.
    pub tools: Option<Vec<String>>,
    /// The child's model; `None` inherits the parent's.
    pub model: Option<SpecValue>,
}

/// Turns a resolved spec into a child agent, built the way the parent was (`AgentBuilder`). The
/// builder may be async: the child is awaited before it runs.
///
/// ```
/// use strands::Agent;
/// use strands::multiagent::{AgentSpec, ChildAgentBuilder};
/// use strands::testing::MockModel;
///
/// let from_async = ChildAgentBuilder::new(|spec: AgentSpec| async move {
///     let _ = spec;
///     Agent::builder().model(MockModel::new()).printer(false).build()
/// });
/// let from_sync = ChildAgentBuilder::sync(|_spec: &AgentSpec| {
///     Agent::builder().model(MockModel::new()).printer(false).build()
/// });
/// # let _ = (from_async, from_sync);
/// ```
#[derive(Clone)]
pub struct ChildAgentBuilder(Arc<dyn Fn(AgentSpec) -> BoxFuture<'static, Result<Agent>> + Send + Sync>);

impl ChildAgentBuilder {
    /// A builder from an async closure.
    pub fn new<F, Fut>(build: F) -> Self
    where
        F: Fn(AgentSpec) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Agent>> + Send + 'static,
    {
        Self(Arc::new(move |spec| Box::pin(build(spec))))
    }

    /// A builder from a synchronous closure.
    pub fn sync(build: impl Fn(&AgentSpec) -> Result<Agent> + Send + Sync + 'static) -> Self {
        Self(Arc::new(move |spec| {
            let child = build(&spec);
            Box::pin(async move { child })
        }))
    }

    /// Builds the child for `spec`.
    pub fn build(&self, spec: AgentSpec) -> BoxFuture<'static, Result<Agent>> {
        (self.0)(spec)
    }
}

impl fmt::Debug for ChildAgentBuilder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ChildAgentBuilder(..)")
    }
}

/// Describes a preset by its description plus the fields it sets.
fn describe_preset(preset: &Preset) -> String {
    let mut parts = Vec::new();
    if preset.instructions.is_some() {
        parts.push("instructions".to_owned());
    }
    if let Some(tools) = &preset.tools {
        let names = if tools.is_empty() {
            "none".to_owned()
        } else {
            tools.join(", ")
        };
        parts.push(format!("tools: {names}"));
    }
    match &preset.model {
        Some(SpecValue::Text(model)) => parts.push(format!("model: {model}")),
        Some(_) => parts.push("model".to_owned()),
        None => {}
    }
    if parts.is_empty() {
        return preset.description.clone();
    }
    let sets = format!("sets {}", parts.join("; "));
    if preset.description.is_empty() {
        sets
    } else {
        format!("{} ({sets})", preset.description)
    }
}

/// The axes [`schema_properties`] and [`resolve_spec`] read.
pub(crate) struct SpecAxes<'a> {
    pub(crate) presets: &'a IndexMap<String, Preset>,
    pub(crate) default_preset: Option<&'a str>,
    pub(crate) instructions: &'a Axis,
    pub(crate) tools: &'a Axis,
    pub(crate) model: &'a Axis,
}

/// Renders each model-visible axis, plus an `agent_type` choice over the presets, as JSON Schema
/// properties.
pub(crate) fn schema_properties(axes: &SpecAxes<'_>) -> Result<JsonObject> {
    let agent_type = (!axes.presets.is_empty()).then(|| {
        Axis::Choice(Choice::new(axes.presets.iter().map(|(name, preset)| {
            ChoiceOption::new(name).with_description(describe_preset(preset))
        })))
    });
    let entries = [
        ("agent_type", AGENT_TYPE_DESCRIPTION, agent_type.as_ref()),
        ("instructions", INSTRUCTIONS_DESCRIPTION, Some(axes.instructions)),
        ("tools", TOOLS_DESCRIPTION, Some(axes.tools)),
        ("model", MODEL_DESCRIPTION, Some(axes.model)),
    ];
    let mut properties = JsonObject::new();
    for (key, base, axis) in entries {
        let mut description = base.to_owned();
        if key == "agent_type"
            && let Some(default) = axes.default_preset
        {
            description = format!("{description} Omit to use the default ('{default}').");
        }
        match axis {
            Some(Axis::Open(_)) => {
                properties.insert(key.to_owned(), json!({"type": "string", "description": description}));
            }
            Some(Axis::Choice(choice)) => {
                properties.insert(key.to_owned(), choice_property(key, choice, description)?);
            }
            _ => {}
        }
    }
    Ok(properties)
}

fn choice_property(key: &str, choice: &Choice, mut description: String) -> Result<JsonValue> {
    if choice.options.is_empty() {
        return Err(Error::other(format!(
            "{key}: new Choice([]) offers no options; use new Fixed(...), or omit {key} to use its default."
        )));
    }
    if key == "tools" && !choice.multiple {
        return Err(Error::other(format!(
            "{key}: new Choice(...) must set multiple to true; a child agent selects a subset of {key}."
        )));
    }
    let values: Vec<&str> = choice.options.iter().map(|option| option.name.as_str()).collect();
    let lines: Vec<String> = choice
        .options
        .iter()
        .filter(|option| !option.description.is_empty())
        .map(|option| format!("- {}: {}", option.name, option.description))
        .collect();
    if !lines.is_empty() {
        description = format!("{description}\nOptions:\n{}", lines.join("\n"));
    }
    Ok(if choice.multiple {
        json!({"type": "array", "items": {"type": "string", "enum": values}, "description": description})
    } else {
        json!({"type": "string", "enum": values, "description": description})
    })
}

/// A scalar axis: the model's value, then the preset's, then the axis default.
/// The model's value is the raw JSON, which an [`Open`] axis passes through.
fn resolve_scalar(model_value: Option<&JsonValue>, axis: &Axis, preset_value: Option<SpecValue>) -> Option<Resolved> {
    if let Some(value) = model_value {
        if matches!(axis, Axis::Open(_)) {
            return Some(Resolved::Raw(value.clone()));
        }
        if let (Axis::Choice(choice), Some(name)) = (axis, value.as_str())
            && choice.has(name)
        {
            return Some(Resolved::Value(choice.value_for(name)));
        }
    }
    if let Some(value) = preset_value {
        return Some(Resolved::Value(value));
    }
    match axis {
        Axis::Fixed(fixed) => fixed.value.clone().map(Resolved::Value),
        _ => None,
    }
}

enum Resolved {
    Raw(JsonValue),
    Value(SpecValue),
}

/// A list axis: the model's picks among the allowed options, then the preset's (clamped to the
/// options), then every option of a multiple choice, then a fixed list.
fn resolve_list(model_value: Option<&JsonValue>, axis: &Axis, preset_values: Option<&[String]>) -> Option<Vec<String>> {
    let choice = match axis {
        Axis::Choice(choice) => Some(choice),
        _ => None,
    };
    let text_of = |choice: &Choice, name: &str| choice.value_for(name).as_text().map(str::to_owned);
    if let (Some(value), Some(choice)) = (model_value, choice) {
        let requested: Vec<&str> = match value {
            JsonValue::String(name) => vec![name.as_str()],
            JsonValue::Array(names) => names.iter().filter_map(JsonValue::as_str).collect(),
            _ => Vec::new(),
        };
        return Some(
            requested
                .into_iter()
                .filter(|name| choice.has(name))
                .filter_map(|name| text_of(choice, name))
                .collect(),
        );
    }
    if let Some(preset_values) = preset_values {
        let Some(choice) = choice else {
            return Some(preset_values.to_vec());
        };
        let allowed: Vec<String> = choice
            .options
            .iter()
            .filter_map(|option| text_of(choice, &option.name))
            .collect();
        return Some(
            preset_values
                .iter()
                .filter(|tool| allowed.contains(tool))
                .cloned()
                .collect(),
        );
    }
    match axis {
        Axis::Choice(choice) if choice.multiple => Some(
            choice
                .options
                .iter()
                .filter_map(|option| text_of(choice, &option.name))
                .collect(),
        ),
        Axis::Fixed(Fixed {
            value: Some(SpecValue::List(list)),
        }) => Some(list.clone()),
        Axis::Fixed(Fixed {
            value: Some(SpecValue::Text(name)),
        }) => Some(vec![name.clone()]),
        _ => None,
    }
}

/// Why a model input could not be resolved into a spec.
#[derive(Debug)]
pub(crate) enum SpecError {
    /// The input is invalid in a way the model can fix.
    Invalid(String),
    /// `instructions` resolved to something other than a string.
    InstructionsNotText,
}

/// Combines one model input, named `name`, with the axis policies into a spec. A model-supplied
/// value wins, then the preset's, then the axis default; an omitted `agent_type` selects the
/// default preset unless the model wrote its own instructions.
pub(crate) fn resolve_spec(
    input: &JsonObject,
    name: &str,
    axes: &SpecAxes<'_>,
) -> std::result::Result<AgentSpec, SpecError> {
    let model_agent_type = input.get("agent_type").filter(|value| !value.is_null());
    let known = model_agent_type
        .and_then(JsonValue::as_str)
        .filter(|agent_type| axes.presets.contains_key(*agent_type));
    if model_agent_type.is_some() && known.is_none() {
        let mut names: Vec<&str> = axes.presets.keys().map(String::as_str).collect();
        names.sort_unstable();
        let shown = model_agent_type.map(JsonValue::to_string).unwrap_or_default();
        return Err(SpecError::Invalid(format!(
            "Unknown agent_type {shown}; valid values: {}.",
            names.join(", ")
        )));
    }
    let overriding_instructions =
        matches!(axes.instructions, Axis::Open(_) | Axis::Choice(_)) && input.contains_key("instructions");
    let agent_type = match known {
        Some(agent_type) => Some(agent_type.to_owned()),
        None if !overriding_instructions => axes.default_preset.map(str::to_owned),
        None => None,
    };
    let preset = agent_type.as_ref().and_then(|agent_type| axes.presets.get(agent_type));
    let present = |key: &str| input.get(key).filter(|value| !value.is_null());

    let instructions = match resolve_scalar(
        present("instructions"),
        axes.instructions,
        preset
            .and_then(|preset| preset.instructions.clone())
            .map(SpecValue::Text),
    ) {
        None => None,
        Some(Resolved::Raw(JsonValue::String(text)) | Resolved::Value(SpecValue::Text(text))) => Some(text),
        Some(_) => return Err(SpecError::InstructionsNotText),
    };
    let tools = resolve_list(
        present("tools"),
        axes.tools,
        preset.and_then(|preset| preset.tools.as_deref()),
    );
    let model = match resolve_scalar(
        present("model"),
        axes.model,
        preset.and_then(|preset| preset.model.clone()),
    ) {
        Some(Resolved::Value(value)) => Some(value),
        Some(Resolved::Raw(JsonValue::String(text))) => Some(SpecValue::Text(text)),
        _ => None,
    };
    Ok(AgentSpec {
        name: Some(name.to_owned()),
        agent_type,
        instructions,
        tools,
        model,
    })
}

/// Choices, preset descriptions, schema properties and spec resolution, as the subagent tool uses
/// them.
#[cfg(test)]
mod tests {
    use super::*;

    fn presets() -> IndexMap<String, Preset> {
        IndexMap::from([
            (
                "researcher".to_owned(),
                Preset::builder()
                    .instructions("research")
                    .tools(["read"])
                    .description("finds facts")
                    .build(),
            ),
            ("bare".to_owned(), Preset::default()),
        ])
    }

    fn axes<'a>(
        presets: &'a IndexMap<String, Preset>,
        instructions: &'a Axis,
        tools: &'a Axis,
        model: &'a Axis,
    ) -> SpecAxes<'a> {
        SpecAxes {
            presets,
            default_preset: presets.keys().next().map(String::as_str),
            instructions,
            tools,
            model,
        }
    }

    #[test]
    fn describes_presets_by_the_fields_they_set() {
        let presets = presets();
        assert_eq!(
            describe_preset(&presets["researcher"]),
            "finds facts (sets instructions; tools: read)"
        );
        assert_eq!(describe_preset(&presets["bare"]), "");
        let model_only = Preset::builder().model("claude").build();
        assert_eq!(describe_preset(&model_only), "sets model: claude");
        let no_tools = Preset::builder().tools(Vec::<String>::new()).build();
        assert_eq!(describe_preset(&no_tools), "sets tools: none");
    }

    #[test]
    fn resolves_model_value_then_preset_then_axis_default() {
        let presets = presets();
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let axes = axes(&presets, &open, &inherit, &inherit);
        let input = json!({"task": "x"});
        let spec = resolve_spec(input.as_object().unwrap(), "sub", &axes).unwrap();
        assert_eq!(spec.agent_type.as_deref(), Some("researcher"));
        assert_eq!(spec.instructions.as_deref(), Some("research"));
        assert_eq!(spec.tools, Some(vec!["read".to_owned()]));
        let input = json!({"instructions": "custom"});
        let spec = resolve_spec(input.as_object().unwrap(), "sub", &axes).unwrap();
        assert_eq!(spec.agent_type, None);
        assert_eq!(spec.instructions.as_deref(), Some("custom"));
        assert_eq!(spec.tools, None);
    }

    #[test]
    fn rejects_an_unknown_agent_type() {
        let presets = presets();
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let input = json!({"agent_type": "nope"});
        let Err(SpecError::Invalid(message)) = resolve_spec(
            input.as_object().unwrap(),
            "sub",
            &axes(&presets, &open, &inherit, &inherit),
        ) else {
            panic!("expected an invalid input");
        };
        assert_eq!(message, "Unknown agent_type \"nope\"; valid values: bare, researcher.");
    }

    #[test]
    fn clamps_preset_tools_to_the_choice() {
        let presets = presets();
        let tools = Axis::Choice(Choice::new(["write"]).multiple(true));
        let (fixed, inherit) = (Axis::Fixed(Fixed::none()), Axis::Inherit(Inherit));
        let spec = resolve_spec(&JsonObject::new(), "sub", &axes(&presets, &fixed, &tools, &inherit)).unwrap();
        assert_eq!(spec.tools, Some(Vec::new()));
    }

    #[test]
    fn wraps_strings_and_fills_unset() {
        let choice = Choice::new([
            ChoiceOption::new("alias").with_value("real").with_description("d"),
            ChoiceOption::new("bare"),
            "raw".into(),
        ]);
        let options = choice.normalized();
        assert_eq!(options.len(), 3);
        assert_eq!(options[0].value, Some("real".into()));
        assert_eq!(options[0].description, "d");
        assert_eq!(options[1].value, Some("bare".into()));
        assert_eq!(
            (options[2].name.as_str(), options[2].value.clone()),
            ("raw", Some("raw".into()))
        );
    }

    #[test]
    fn returns_mapped_value_for_known_option_and_passthrough_for_unknown() {
        let choice = Choice::new([ChoiceOption::new("alias").with_value("real")]);
        assert_eq!(choice.value_for("alias"), "real".into());
        assert_eq!(choice.value_for("missing"), "missing".into());
    }

    #[test]
    fn rejects_prototype_keys_null_and_non_string_agent_type_values() {
        let presets = IndexMap::from([("g".to_owned(), Preset::default())]);
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let axes = axes(&presets, &open, &inherit, &inherit);
        for bad in [
            json!("constructor"),
            json!("toString"),
            json!("__proto__"),
            json!(["g"]),
        ] {
            let input = json!({"task": "x", "agent_type": bad});
            let Err(SpecError::Invalid(message)) = resolve_spec(input.as_object().unwrap(), "a", &axes) else {
                panic!("expected an invalid input for {bad}");
            };
            assert!(message.starts_with("Unknown agent_type"), "{message}");
        }
        let input = json!({"task": "x", "agent_type": null});
        let spec = resolve_spec(input.as_object().unwrap(), "a", &axes).unwrap();
        assert_eq!(spec.agent_type.as_deref(), Some("g"));
    }

    #[test]
    fn resolves_fixed_tools_list() {
        let presets = IndexMap::new();
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let tools = Axis::Fixed(Fixed::new(vec!["a", "b"]));
        let input = json!({"task": "x"});
        let spec = resolve_spec(
            input.as_object().unwrap(),
            "a",
            &axes(&presets, &open, &tools, &inherit),
        )
        .unwrap();
        assert_eq!(spec.tools, Some(vec!["a".to_owned(), "b".to_owned()]));
    }

    #[test]
    fn resolves_fixed_empty_to_empty_array_not_undefined() {
        let presets = IndexMap::new();
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let tools = Axis::Fixed(Fixed::new(Vec::<String>::new()));
        let input = json!({"task": "x"});
        let spec = resolve_spec(
            input.as_object().unwrap(),
            "a",
            &axes(&presets, &open, &tools, &inherit),
        )
        .unwrap();
        assert_eq!(spec.tools, Some(Vec::new()));
    }

    #[test]
    fn rejects_empty_choices_and_single_tool_choices() {
        let presets = IndexMap::new();
        let (open, inherit) = (Axis::Open(Open), Axis::Inherit(Inherit));
        let empty = Axis::Choice(Choice::new(Vec::<String>::new()));
        let error = schema_properties(&axes(&presets, &open, &inherit, &empty)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "model: new Choice([]) offers no options; use new Fixed(...), or omit model to use its default."
        );
        let error = schema_properties(&axes(&presets, &open, &empty, &inherit)).unwrap_err();
        assert!(error.to_string().contains("offers no options"), "{error}");
        let error = schema_properties(&axes(&presets, &empty, &inherit, &inherit)).unwrap_err();
        assert!(error.to_string().contains("offers no options"), "{error}");
        let single = Axis::Choice(Choice::new(["read", "shell"]));
        let error = schema_properties(&axes(&presets, &open, &single, &inherit)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "tools: new Choice(...) must set multiple to true; a child agent selects a subset of tools."
        );
    }
}
