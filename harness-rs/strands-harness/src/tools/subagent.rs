//! The harness `subagent` delegation tool.
//!
//! The model-facing schema follows one authority mode per axis (instructions, tools, MCP
//! servers, model, context):
//!
//! - [`Fixed`]: pinned by the developer; no parameter.
//! - [`Inherit`]: the parent's value; no parameter.
//! - [`Open`]: the model writes the value freely; a string parameter.
//! - [`Choice`]: the model picks from developer-supplied [`ChoiceOption`]s by name; an enum, or an
//!   array of enums when `multiple`. The picked name maps back to the option's value. For `tools`
//!   and `mcp_servers` the pick is clamped to the offered set at call time, so a child never gains
//!   a capability the parent lacked.
//!
//! Named [`Preset`]s add an `agent_type` enum. Children are built per call by an injected
//! [`AgentBuilder`]. A child's interrupts surface on the parent through
//! [`ToolContext::interrupt`]; the interrupted child is kept and resumed with the parent's answers
//! when the parent re-runs the call.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, PoisonError};

use futures::StreamExt;
use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::json;
use strands::agent::{Agent, AgentResult, InvokeArgs, InvokeOptions};
use strands::hooks::AgentStreamEvent;
use strands::interrupt::Interrupt;
use strands::tools::{Tool, ToolContext, ToolOutcome, ToolStream, ToolStreamEvent, ToolStreamItem};
use strands::types::{
    ContentBlock, InterruptParams, InterruptResponse, InterruptResponseContent, JsonObject, JsonSchema, JsonValue,
    Message, Role, StopReason, ToolResultBlock, ToolResultContent, ToolSpec,
};
use strands::{Error, Result};

use strands::multiagent::Axis;
pub use strands::multiagent::{Choice, ChoiceOption, Fixed, Inherit, Open, SpecValue};

/// Declares an axis mode enum over the given policies, converting from each and into [`Axis`].
macro_rules! axis_mode {
    ($(#[$meta:meta])* $name:ident { $($variant:ident),+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        #[non_exhaustive]
        pub enum $name {
            $(
                #[doc = concat!("[`", stringify!($variant), "`].")]
                $variant($variant),
            )+
        }

        $(
            impl From<$variant> for $name {
                fn from(mode: $variant) -> Self {
                    Self::$variant(mode)
                }
            }
        )+

        impl From<$name> for Axis {
            fn from(mode: $name) -> Self {
                match mode {
                    $($name::$variant(mode) => mode.into(),)+
                }
            }
        }
    };
}

axis_mode!(
    /// An axis mode for the `instructions` parameter.
    InstructionsMode { Open, Choice, Fixed }
);
axis_mode!(
    /// An axis mode for the `tools` parameter.
    ToolsMode { Choice, Fixed, Inherit }
);
axis_mode!(
    /// An axis mode for the `mcp_servers` parameter.
    McpServersMode { Choice, Fixed, Inherit }
);
axis_mode!(
    /// An axis mode for the `model` parameter.
    ModelMode { Inherit, Choice, Fixed }
);
axis_mode!(
    /// An axis mode for the `context` parameter.
    ContextAxis { Fixed, Choice }
);

/// The default bound on nested delegation levels (`DEFAULT_SUBAGENT_MAX_DEPTH`).
pub(crate) const DEFAULT_SUBAGENT_MAX_DEPTH: usize = 2;

/// The system prompt of the [`generalist`] preset (`GENERALIST_INSTRUCTIONS`).
pub(crate) const GENERALIST_INSTRUCTIONS: &str = concat!(
    "You are a general-purpose subagent handling a focused subtask on behalf of a parent agent. ",
    "You run in your own fresh conversation and cannot ask follow-up questions, so work from the ",
    "task as given, make reasonable assumptions where it is underspecified, and see it through to a ",
    "verified result. Return a self-contained answer: state what you did, what you found, and ",
    "anything the parent needs to act on. Your final message is the only thing that returns to the ",
    "parent, so put the substance there rather than in intermediate steps."
);

const GENERALIST_DESCRIPTION: &str = "a general-purpose agent for a focused subtask that runs in its own context";

/// Every context mode, in schema order (`CONTEXT_MODES`).
pub const CONTEXT_MODES: &[ContextMode] = &[ContextMode::None, ContextMode::All, ContextMode::NoTools];

const DEFAULT_NAME: &str = "subagent";

const DEPTH_STATE_KEY: &str = "subagentDepth";

const BASE_DESCRIPTION: &str = concat!(
    "Delegate a self-contained task to a subagent that runs in its own context and returns a final ",
    "report. Reach for this when a subtask would otherwise flood your context with intermediate ",
    "work and you only need its conclusion. Do not poll for progress or redo its work."
);

const TASK_DESCRIPTION: &str = concat!(
    "The self-contained task, including all context the subagent needs. It starts from a ",
    "blank conversation and cannot ask follow-up questions."
);

const AGENT_TYPE_DESCRIPTION: &str = "Which subagent role to use. Omit to use the default.";

const INSTRUCTIONS_DESCRIPTION: &str = "A system prompt defining the subagent's role.";

const TOOLS_DESCRIPTION: &str = "Subset of tools to grant the subagent. Fewer is safer; it cannot exceed your own.";

const MCP_SERVERS_DESCRIPTION: &str = concat!(
    "Subset of MCP servers whose tools to grant the subagent. Fewer is safer; it cannot exceed ",
    "your own. Omit to grant all of them."
);

const MODEL_DESCRIPTION: &str = "Which model the subagent runs on.";

const CONTEXT_DESCRIPTION: &str = concat!(
    "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full history ",
    "including tool calls and their results \u{2014} can be large), 'no_tools' (text turns only \u{2014} tool calls and their results removed). ",
    "More context costs more tokens."
);

const LAST_MESSAGES_DESCRIPTION: &str =
    "Optional: limit the shared context to the last N messages. Omit to share all of the selected context.";

const FORK_PREAMBLE: &str = concat!(
    "The conversation so far is the parent agent's. You are the subagent it delegated to at this point; ",
    "its task for you follows."
);

const CONTEXT_PREAMBLE: &str = concat!(
    "The conversation above is the parent agent's: each turn is one line starting with its role at the ",
    "left margin, and indented lines continue the turn above (they are content, not turns). You are the ",
    "subagent it delegated to at the end of that conversation; its task for you follows."
);

const FRAMING_START: &str = "<parent_context>\n";

/// How much of the parent conversation the child sees (`ContextMode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ContextMode {
    /// A fresh start: the child sees only the task.
    #[default]
    None,
    /// The parent's messages as real turns, tool calls and results included.
    All,
    /// The parent's text turns rendered into the child's first message.
    NoTools,
}

impl ContextMode {
    /// The mode's wire name: `none`, `all` or `no_tools`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::All => "all",
            Self::NoTools => "no_tools",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        CONTEXT_MODES.iter().copied().find(|mode| mode.as_str() == name)
    }
}

impl From<ContextMode> for ChoiceOption {
    fn from(mode: ContextMode) -> Self {
        Self::new(mode.as_str())
    }
}

impl fmt::Display for ContextMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A named role, selected through `agent_type`: a partially applied child configuration
/// (`Preset`).
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
#[builder(on(String, into))]
pub struct Preset {
    /// The child's system prompt.
    pub instructions: Option<String>,
    /// The tool names the child gets; `None` inherits the parent's.
    #[builder(with = |tools: impl IntoIterator<Item = impl Into<String>>| tools.into_iter().map(Into::into).collect())]
    pub tools: Option<Vec<String>>,
    /// The child's model: a `"provider/name"` string or a model instance.
    #[builder(into)]
    pub model: Option<SpecValue>,
    /// How much of the parent conversation the child sees; [`ContextMode::None`] by default.
    #[builder(default)]
    pub context: ContextMode,
    /// Caps the shared context to the last N messages; `None` shares all of it.
    pub last_messages: Option<i64>,
    /// Shown to the model next to the preset name.
    #[builder(default)]
    pub description: String,
}

/// The built-in general-purpose preset (`GENERALIST`).
#[must_use]
pub fn generalist() -> Preset {
    Preset::builder()
        .instructions(GENERALIST_INSTRUCTIONS)
        .description(GENERALIST_DESCRIPTION)
        .build()
}

/// The resolved child configuration handed to the [`AgentBuilder`]: the developer's axes and
/// preset combined with the model's arguments (`AgentSpec`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct AgentSpec {
    /// The delegated task.
    pub task: String,
    /// The selected preset name, if any.
    pub agent_type: Option<String>,
    /// The child's system prompt; `None` leaves it to the builder.
    pub instructions: Option<String>,
    /// The tool names the child gets; `None` inherits the parent's.
    pub tools: Option<Vec<String>>,
    /// The MCP server names the child gets; `None` inherits all of the parent's.
    pub mcp_servers: Option<Vec<String>>,
    /// The child's model; `None` inherits the parent's.
    pub model: Option<SpecValue>,
    /// How much of the parent conversation the child sees.
    pub context: ContextMode,
    /// Caps the shared context to the last N messages; `None` shares all of it.
    pub last_messages: Option<i64>,
}

impl AgentSpec {
    /// A spec for `task` with every axis unset.
    pub fn new(task: impl Into<String>, agent_type: Option<String>) -> Self {
        Self {
            task: task.into(),
            agent_type,
            instructions: None,
            tools: None,
            mcp_servers: None,
            model: None,
            context: ContextMode::None,
            last_messages: None,
        }
    }
}

type BuildFn = dyn Fn(AgentSpec) -> BoxFuture<'static, Result<Agent>> + Send + Sync;

/// Turns a resolved [`AgentSpec`] into a child agent, built the way the parent was
/// (`AgentBuilder`).
#[derive(Clone)]
pub struct AgentBuilder(Arc<BuildFn>);

impl AgentBuilder {
    /// Wraps an async builder function.
    pub fn new<F, Fut>(build: F) -> Self
    where
        F: Fn(AgentSpec) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Agent>> + Send + 'static,
    {
        Self(Arc::new(move |spec| Box::pin(build(spec))))
    }

    /// Builds a child for `spec`.
    ///
    /// # Errors
    ///
    /// Whatever the builder function fails with.
    pub async fn build(&self, spec: AgentSpec) -> Result<Agent> {
        (self.0)(spec).await
    }
}

impl fmt::Debug for AgentBuilder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentBuilder").finish_non_exhaustive()
    }
}

/// Options for [`make_subagent`] (`MakeSubagentOptions`). Build them with
/// [`MakeSubagentOptions::builder`].
#[derive(Debug, Clone, bon::Builder)]
#[builder(on(String, into))]
#[non_exhaustive]
pub struct MakeSubagentOptions {
    /// Turns a resolved spec into a child agent, built the way the parent was.
    pub builder: AgentBuilder,
    /// Named roles selectable through `agent_type`, in schema order; a repeated name replaces
    /// the earlier preset in its place.
    #[builder(default, with = |presets: impl IntoIterator<Item = (impl Into<String>, Preset)>| {
        presets.into_iter().map(|(name, preset)| (name.into(), preset)).collect()
    })]
    pub presets: Vec<(String, Preset)>,
    /// The preset used when the model omits `agent_type`; the first preset when absent.
    pub default_preset: Option<String>,
    /// The mode of `instructions`: [`Open`], [`Choice`] or [`Fixed`]; `Open` when absent.
    #[builder(into)]
    pub instructions: Option<InstructionsMode>,
    /// The mode of `tools`: a multiple [`Choice`], [`Fixed`] or [`Inherit`]; a multiple `Choice`
    /// over `inherited_tools` when absent.
    #[builder(into)]
    pub tools: Option<ToolsMode>,
    /// The mode of `mcp_servers`: a multiple [`Choice`], [`Fixed`] or [`Inherit`]; a multiple
    /// `Choice` over `inherited_mcp_servers` (or `Inherit` when there are none) when absent.
    #[builder(into)]
    pub mcp_servers: Option<McpServersMode>,
    /// The mode of `model`: [`Inherit`], [`Choice`] or [`Fixed`]; `Inherit` when absent.
    #[builder(into)]
    pub model: Option<ModelMode>,
    /// The mode of `context`: [`Fixed`] or [`Choice`] over [`CONTEXT_MODES`]; `Fixed("none")` when
    /// absent.
    #[builder(into)]
    pub context: Option<ContextAxis>,
    /// The parent's tool names, for the default `tools` choice.
    #[builder(default, with = |names: impl IntoIterator<Item = impl Into<String>>| names.into_iter().map(Into::into).collect())]
    pub inherited_tools: Vec<String>,
    /// The parent's MCP server names, for the default `mcp_servers` choice.
    #[builder(default, with = |names: impl IntoIterator<Item = impl Into<String>>| names.into_iter().map(Into::into).collect())]
    pub inherited_mcp_servers: Vec<String>,
    /// Bounds delegation depth; the tool refuses at 0. 2 (`DEFAULT_SUBAGENT_MAX_DEPTH`) when absent.
    pub max_depth: Option<usize>,
    /// The tool name; `subagent` when absent.
    pub name: Option<String>,
}

/// The `builtinTools.subagent` config (`SubagentConfig`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubagentConfig {
    /// How many levels of delegation a child may itself open; 2 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
}

/// What [`subagent_tool`] needs from the harness that builds the parent.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SubagentContext {
    /// Rebuilds a child the way the parent was built, with the spec applied.
    pub builder: AgentBuilder,
    /// The parent's selectable tool names: its enabled built-ins (without `web_search`), then
    /// its named consumer tools.
    pub inherited_tools: Vec<String>,
    /// The parent's MCP server (client) names.
    pub inherited_mcp_servers: Vec<String>,
}

impl SubagentContext {
    /// A context with `builder` and no inherited tools or servers.
    #[must_use]
    pub fn new(builder: AgentBuilder) -> Self {
        Self {
            builder,
            inherited_tools: Vec::new(),
            inherited_mcp_servers: Vec::new(),
        }
    }

    /// Sets the parent's selectable tool names.
    #[must_use]
    pub fn with_inherited_tools(mut self, names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.inherited_tools = names.into_iter().map(Into::into).collect();
        self
    }

    /// Sets the parent's MCP server names.
    #[must_use]
    pub fn with_inherited_mcp_servers(mut self, names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.inherited_mcp_servers = names.into_iter().map(Into::into).collect();
        self
    }
}

/// The `subagent` tool the harness wires by default: the [`generalist`] preset, the tools and MCP
/// servers choices over the parent's, a context choice over [`CONTEXT_MODES`], and `config.max_depth`.
///
/// # Errors
///
/// None in practice; the axes it builds are valid. See [`make_subagent`].
pub fn subagent_tool(config: SubagentConfig, context: SubagentContext) -> Result<SubagentTool> {
    make_subagent(MakeSubagentOptions {
        builder: context.builder,
        presets: vec![("generalist".to_owned(), generalist())],
        default_preset: None,
        instructions: None,
        tools: None,
        mcp_servers: None,
        model: None,
        context: Some(Choice::new(CONTEXT_MODES.iter().copied()).into()),
        inherited_tools: context.inherited_tools,
        inherited_mcp_servers: context.inherited_mcp_servers,
        max_depth: config.max_depth,
        name: None,
    })
}

fn check_subset_choice(key: &str, choice: &Choice, empty: &str, what: &str) -> Result<()> {
    if choice.options.is_empty() {
        return Err(Error::other(format!("{key}=Choice([]) offers no options; {empty}")));
    }
    if !choice.multiple {
        return Err(Error::other(format!(
            "{key}=Choice(...) must be multiple=true; a subagent selects a subset of {what}."
        )));
    }
    Ok(())
}

/// Creates a `subagent` tool whose input schema follows the axis modes and presets.
///
/// `max_depth` bounds delegation depth: each child's remaining budget is stored on its own app
/// state right after it is built, read back the next time the tool runs on that child, and
/// decremented again. At 0 the tool refuses with an error result rather than build a child.
///
/// ```
/// use strands_harness::tools::subagent::{AgentBuilder, MakeSubagentOptions, generalist, make_subagent};
///
/// let tool = make_subagent(
///     MakeSubagentOptions::builder()
///         .builder(AgentBuilder::new(|_spec| async { strands::Agent::builder().printer(false).build() }))
///         .presets([("generalist", generalist())])
///         .inherited_tools(["read", "shell"])
///         .build(),
/// )?;
/// # use strands::Tool;
/// assert_eq!(tool.name(), "subagent");
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When a `tools` or `mcp_servers` [`Choice`] has no options or is not `multiple`.
pub fn make_subagent(options: MakeSubagentOptions) -> Result<SubagentTool> {
    let mut presets: IndexMap<String, Preset> = IndexMap::new();
    for (name, preset) in options.presets {
        presets.insert(name, preset);
    }
    if let Some(ToolsMode::Choice(choice)) = &options.tools {
        check_subset_choice(
            "tools",
            choice,
            "use Fixed([]) for a toolless child, or Inherit().",
            "tools",
        )?;
    }
    if let Some(McpServersMode::Choice(choice)) = &options.mcp_servers {
        check_subset_choice(
            "mcp_servers",
            choice,
            "use Fixed([]) for no servers, or Inherit().",
            "servers",
        )?;
    }
    let tools = options.tools.map_or_else(
        || Choice::new(options.inherited_tools).multiple(true).into(),
        Axis::from,
    );
    let mcp_servers = options.mcp_servers.map_or_else(
        || {
            if options.inherited_mcp_servers.is_empty() {
                Inherit::new().into()
            } else {
                Choice::new(options.inherited_mcp_servers).multiple(true).into()
            }
        },
        Axis::from,
    );
    let axes = Axes {
        default_preset: options.default_preset.or_else(|| presets.keys().next().cloned()),
        presets,
        instructions: options.instructions.map_or_else(|| Open::new().into(), Axis::from),
        tools,
        mcp_servers,
        model: options.model.map_or_else(|| Inherit::new().into(), Axis::from),
        context: options.context.map_or_else(|| Fixed::new("none").into(), Axis::from),
    };
    let name = options.name.unwrap_or_else(|| DEFAULT_NAME.to_owned());
    let spec =
        ToolSpec::new(&name, describe_roles(BASE_DESCRIPTION, &axes.presets)).with_input_schema(build_schema(&axes));
    Ok(SubagentTool {
        inner: Arc::new(Inner {
            name,
            spec,
            axes,
            builder: options.builder,
            max_depth: options.max_depth.unwrap_or(DEFAULT_SUBAGENT_MAX_DEPTH),
            pending: Mutex::new(HashMap::new()),
        }),
    })
}

/// The developer's side of the spec: presets and one mode per axis.
#[derive(Debug)]
struct Axes {
    presets: IndexMap<String, Preset>,
    default_preset: Option<String>,
    instructions: Axis,
    tools: Axis,
    mcp_servers: Axis,
    model: Axis,
    context: Axis,
}

fn describe_roles(base: &str, presets: &IndexMap<String, Preset>) -> String {
    if presets.is_empty() {
        return base.to_owned();
    }
    let roles: Vec<String> = presets
        .iter()
        .map(|(name, preset)| {
            let description = if preset.description.is_empty() {
                name
            } else {
                &preset.description
            };
            format!("- {name}: {description}")
        })
        .collect();
    format!("{base}\n\nAvailable subagents (agent_type):\n{}", roles.join("\n"))
}

/// A string enum property (an array of enums when `multiple`) with the per-option descriptions
/// rendered into its description.
fn choice_prop(choice: &Choice, base: &str) -> JsonValue {
    let options = choice.normalized();
    let values: Vec<&str> = options.iter().map(|option| option.name.as_str()).collect();
    let lines: Vec<String> = options
        .iter()
        .filter(|option| !option.description.is_empty())
        .map(|option| format!("- {}: {}", option.name, option.description))
        .collect();
    let mut description = base.to_owned();
    if !lines.is_empty() {
        let rendered = format!("Options:\n{}", lines.join("\n"));
        description = if base.is_empty() {
            rendered
        } else {
            format!("{base}\n{rendered}")
        };
    }
    let mut prop = if choice.multiple {
        json!({"type": "array", "items": {"type": "string", "enum": values}})
    } else {
        json!({"type": "string", "enum": values})
    };
    if !description.is_empty()
        && let Some(object) = prop.as_object_mut()
    {
        object.insert("description".to_owned(), JsonValue::String(description));
    }
    prop
}

/// The input schema; each axis adds zero or one parameter.
fn build_schema(axes: &Axes) -> JsonSchema {
    let mut props = JsonObject::new();
    props.insert(
        "task".to_owned(),
        json!({"type": "string", "description": TASK_DESCRIPTION}),
    );
    if !axes.presets.is_empty() {
        let names: Vec<&str> = axes.presets.keys().map(String::as_str).collect();
        props.insert(
            "agent_type".to_owned(),
            json!({"type": "string", "enum": names, "description": AGENT_TYPE_DESCRIPTION}),
        );
    }
    match &axes.instructions {
        Axis::Open(_) => {
            props.insert(
                "instructions".to_owned(),
                json!({"type": "string", "description": INSTRUCTIONS_DESCRIPTION}),
            );
        }
        Axis::Choice(choice) => {
            props.insert("instructions".to_owned(), choice_prop(choice, INSTRUCTIONS_DESCRIPTION));
        }
        _ => {}
    }
    if let Axis::Choice(choice) = &axes.tools {
        props.insert("tools".to_owned(), choice_prop(choice, TOOLS_DESCRIPTION));
    }
    if let Axis::Choice(choice) = &axes.mcp_servers {
        props.insert("mcp_servers".to_owned(), choice_prop(choice, MCP_SERVERS_DESCRIPTION));
    }
    if let Axis::Choice(choice) = &axes.model {
        props.insert("model".to_owned(), choice_prop(choice, MODEL_DESCRIPTION));
    }
    if let Axis::Choice(choice) = &axes.context {
        props.insert("context".to_owned(), choice_prop(choice, CONTEXT_DESCRIPTION));
        let shares = choice
            .normalized()
            .iter()
            .any(|option| option.value.as_ref().map(spec_value_string).as_deref() != Some("none"));
        if shares {
            props.insert(
                "last_messages".to_owned(),
                json!({"type": "integer", "description": LAST_MESSAGES_DESCRIPTION}),
            );
        }
    }
    json!({"type": "object", "properties": props, "required": ["task"]})
}

/// A whole number without a fraction, `NaN` and `Infinity` by name, or the shortest float text.
fn js_number_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    value.to_string()
}

/// A model-sent value as text: `None` is `undefined`, an array joins its items with commas (null
/// items empty) and an object is `[object Object]`.
fn js_string(value: Option<&JsonValue>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(JsonValue::Null) => "null".to_owned(),
        Some(JsonValue::Bool(flag)) => flag.to_string(),
        Some(JsonValue::Number(number)) => number.as_f64().map_or_else(|| number.to_string(), js_number_text),
        Some(JsonValue::String(text)) => text.clone(),
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsonValue::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(JsonValue::Object(_)) => "[object Object]".to_owned(),
    }
}

/// A model-sent scalar as a number: `null` and blank text are 0, a boolean is 0 or 1, a
/// one-item array reads as its item's text and anything unparseable is NaN.
fn js_to_number(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Null => 0.0,
        JsonValue::Bool(flag) => f64::from(u8::from(*flag)),
        JsonValue::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        JsonValue::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().unwrap_or(f64::NAN)
            }
        }
        JsonValue::Array(items) => match items.as_slice() {
            [] => 0.0,
            [only] => js_to_number(&JsonValue::String(js_string(Some(only)))),
            _ => f64::NAN,
        },
        JsonValue::Object(_) => f64::NAN,
    }
}

/// `String(value)` of a spec value.
fn spec_value_string(value: &SpecValue) -> String {
    match value {
        SpecValue::Text(text) => text.clone(),
        SpecValue::List(list) => list.join(","),
        SpecValue::Model(model) => model.model_id().unwrap_or_else(|| "[object Object]".to_owned()),
        _ => String::new(),
    }
}

fn choice_has(choice: &Choice, name: &str) -> bool {
    choice.options.iter().any(|option| option.name == name)
}

/// The option names a `Choice` axis admits, or `None` when it exposes none.
fn allowed_names(axis: &Axis) -> Option<Vec<String>> {
    match axis {
        Axis::Choice(choice) => Some(choice.options.iter().map(|option| option.name.clone()).collect()),
        _ => None,
    }
}

/// The names the model asked for: a list, or one name as a list of one; anything else is empty.
fn requested_names(value: &JsonValue) -> Vec<String> {
    match value {
        JsonValue::Array(items) => items.iter().map(|item| js_string(Some(item))).collect(),
        JsonValue::String(name) => vec![name.clone()],
        _ => Vec::new(),
    }
}

/// The model's picks, clamped to the offered names and mapped to their values.
fn clamp_choice(value: &JsonValue, choice: &Choice, allowed: &[String]) -> Vec<String> {
    requested_names(value)
        .into_iter()
        .filter(|name| allowed.contains(name))
        .map(|name| spec_value_string(&choice.value_for(&name)))
        .collect()
}

/// A `Fixed` list axis: its names, or `None` when it pins no list.
fn fixed_list(fixed: &Fixed) -> Option<Vec<String>> {
    match &fixed.value {
        Some(SpecValue::List(list)) => Some(list.clone()),
        _ => None,
    }
}

fn axis_choice(axis: &Axis) -> Option<&Choice> {
    match axis {
        Axis::Choice(choice) => Some(choice),
        _ => None,
    }
}

impl Axes {
    /// Combines the model's arguments, the selected preset and the fixed axes into a spec. Per axis a
    /// model-supplied argument wins, then the preset's value, then the axis default; an omitted
    /// `agent_type` selects the default preset.
    fn resolve(&self, raw: &JsonObject) -> std::result::Result<AgentSpec, String> {
        let task = js_string(raw.get("task"));
        let raw_agent_type = raw.get("agent_type");
        let known = raw_agent_type
            .and_then(JsonValue::as_str)
            .filter(|name| self.presets.contains_key(*name));
        if known.is_none() && raw_agent_type.is_some_and(|value| !value.is_null()) {
            let names: Vec<&str> = self.presets.keys().map(String::as_str).collect();
            let shown = raw_agent_type.map(JsonValue::to_string).unwrap_or_default();
            return Err(format!(
                "Unknown agent_type {shown}; valid values: {}.",
                names.join(", ")
            ));
        }
        let overriding =
            matches!(self.instructions, Axis::Open(_) | Axis::Choice(_)) && raw.contains_key("instructions");
        let agent_type = match known {
            Some(name) => Some(name.to_owned()),
            None if overriding => None,
            None => self.default_preset.clone(),
        };
        let preset = agent_type
            .as_deref()
            .filter(|name| !name.is_empty())
            .and_then(|name| self.presets.get(name));
        let mut spec = AgentSpec::new(task, agent_type.clone());
        spec.instructions = self.resolve_instructions(raw, preset);
        spec.tools = self.resolve_tools(raw, preset);
        spec.mcp_servers = self.resolve_mcp_servers(raw);
        spec.model = self.resolve_model(raw, preset);
        self.resolve_context(raw, preset, &mut spec);
        if let Some(value) = raw.get("last_messages").filter(|value| !value.is_null()) {
            let parsed = js_to_number(value);
            #[allow(
                clippy::cast_possible_truncation,
                reason = "truncates a finite value; out of range saturates"
            )]
            let capped = parsed.is_finite().then(|| parsed.trunc() as i64);
            spec.last_messages = capped;
        }
        Ok(spec)
    }

    fn resolve_instructions(&self, raw: &JsonObject, preset: Option<&Preset>) -> Option<String> {
        let given = raw.get("instructions");
        if let (Some(value), Axis::Open(_)) = (given, &self.instructions) {
            return Some(js_string(Some(value)));
        }
        if let (Some(value), Axis::Choice(choice)) = (given, &self.instructions) {
            let name = js_string(Some(value));
            if choice_has(choice, &name) {
                return Some(spec_value_string(&choice.value_for(&name)));
            }
        }
        if let Some(preset) = preset {
            return preset.instructions.clone();
        }
        match &self.instructions {
            Axis::Fixed(fixed) => fixed.value.as_ref().map(spec_value_string),
            _ => None,
        }
    }

    fn resolve_tools(&self, raw: &JsonObject, preset: Option<&Preset>) -> Option<Vec<String>> {
        let allowed = allowed_names(&self.tools);
        let choice = axis_choice(&self.tools);
        if let (Some(value), Some(allowed), Some(choice)) = (raw.get("tools"), &allowed, choice) {
            return Some(clamp_choice(value, choice, allowed));
        }
        if let Some(tools) = preset.and_then(|preset| preset.tools.as_ref()) {
            let (Some(allowed), Some(choice)) = (&allowed, choice) else {
                return Some(tools.clone());
            };
            let values: HashSet<String> = allowed
                .iter()
                .map(|name| spec_value_string(&choice.value_for(name)))
                .collect();
            return Some(tools.iter().filter(|tool| values.contains(*tool)).cloned().collect());
        }
        if let (Some(allowed), Some(choice)) = (&allowed, choice)
            && choice.multiple
        {
            return Some(
                allowed
                    .iter()
                    .map(|name| spec_value_string(&choice.value_for(name)))
                    .collect(),
            );
        }
        match &self.tools {
            Axis::Fixed(fixed) => fixed_list(fixed),
            _ => None,
        }
    }

    fn resolve_mcp_servers(&self, raw: &JsonObject) -> Option<Vec<String>> {
        let allowed = allowed_names(&self.mcp_servers);
        let choice = axis_choice(&self.mcp_servers);
        if let (Some(value), Some(allowed), Some(choice)) = (raw.get("mcp_servers"), &allowed, choice) {
            return Some(clamp_choice(value, choice, allowed));
        }
        if let (Some(allowed), Some(choice)) = (&allowed, choice)
            && choice.multiple
        {
            return Some(
                allowed
                    .iter()
                    .map(|name| spec_value_string(&choice.value_for(name)))
                    .collect(),
            );
        }
        match &self.mcp_servers {
            Axis::Fixed(fixed) => fixed_list(fixed),
            _ => None,
        }
    }

    fn resolve_model(&self, raw: &JsonObject, preset: Option<&Preset>) -> Option<SpecValue> {
        if let (Some(value), Axis::Choice(choice)) = (raw.get("model"), &self.model) {
            let name = js_string(Some(value));
            if choice_has(choice, &name) {
                return Some(choice.value_for(&name));
            }
        }
        if let Some(model) = preset.and_then(|preset| preset.model.clone()) {
            return Some(model);
        }
        match &self.model {
            Axis::Fixed(fixed) => fixed.value.clone(),
            _ => None,
        }
    }

    fn resolve_context(&self, raw: &JsonObject, preset: Option<&Preset>, spec: &mut AgentSpec) {
        if let (Some(value), Axis::Choice(choice)) = (raw.get("context"), &self.context) {
            let name = js_string(Some(value));
            if choice_has(choice, &name) {
                spec.context = context_mode(&choice.value_for(&name));
                return;
            }
        }
        if let Some(preset) = preset {
            spec.context = preset.context;
            spec.last_messages = preset.last_messages;
            return;
        }
        if let Axis::Fixed(Fixed { value: Some(value), .. }) = &self.context {
            spec.context = context_mode(value);
        }
    }
}

/// The mode a context value names; anything else shares nothing.
fn context_mode(value: &SpecValue) -> ContextMode {
    ContextMode::parse(&spec_value_string(value)).unwrap_or_default()
}

/// Whether the SDK's conversation managers would cut the history at `index`: a user message
/// that is not a tool result, and not a tool use without its result right after.
fn is_valid_trim_point(messages: &[Message], index: usize) -> bool {
    let Some(message) = messages.get(index) else {
        return false;
    };
    let has_result = |message: &Message| {
        message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult(_)))
    };
    if message.role != Role::User || has_result(message) {
        return false;
    }
    if message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse(_)))
    {
        return messages.get(index + 1).is_some_and(has_result);
    }
    true
}

/// The parent's messages for `all`: copies without reasoning, injected blocks and tool calls
/// still in flight, the `last_n` window widened back to a valid trim point.
fn fork_messages(parent: &[Message], last_n: Option<i64>) -> Vec<Message> {
    let answered: HashSet<&str> = parent
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    let mut forked: Vec<Message> = parent
        .iter()
        .filter_map(|message| {
            let content: Vec<ContentBlock> = message
                .content
                .iter()
                .filter(|block| match block {
                    ContentBlock::Reasoning(_) | ContentBlock::Injected(_) => false,
                    ContentBlock::ToolUse(tool_use) => answered.contains(tool_use.tool_use_id.as_str()),
                    _ => true,
                })
                .cloned()
                .collect();
            (!content.is_empty()).then(|| Message::new(message.role, content))
        })
        .collect();
    let Some(last_n) = last_n.and_then(|n| usize::try_from(n).ok()).filter(|n| *n > 0) else {
        return forked;
    };
    let mut start = forked.len().saturating_sub(last_n);
    while start > 0 && !is_valid_trim_point(&forked, start) {
        start -= 1;
    }
    forked.split_off(start)
}

/// The child's prompt under `all`: the forked history and the framed task, which a trailing user
/// turn absorbs so roles keep alternating.
fn with_history(task: &str, mut messages: Vec<Message>) -> InvokeArgs {
    let framed = ContentBlock::text(format!("{FORK_PREAMBLE}\n\n{task}"));
    match messages.last_mut() {
        None => return InvokeArgs::Text(task.to_owned()),
        Some(last) if last.role == Role::User => last.content.push(framed),
        Some(_) => messages.push(Message::new(Role::User, vec![framed])),
    }
    InvokeArgs::Messages(messages)
}

fn framing_end() -> String {
    format!("</parent_context>\n\n{CONTEXT_PREAMBLE}\n\n")
}

/// A parent that is itself a subagent opens with its own framed block; keep only its task.
fn strip_framing(text: &str) -> &str {
    if !text.starts_with(FRAMING_START) {
        return text;
    }
    let end = framing_end();
    text.find(&end).map_or(text, |at| &text[at + end.len()..])
}

/// A message's text blocks joined, tool blocks dropped.
fn plain_text(message: &Message) -> String {
    let texts: Vec<&str> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect();
    texts.join(" ").trim().to_owned()
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        _ => "assistant",
    }
}

/// The parent's text turns as a plain-text block for `no_tools`, one `role: text` entry per
/// message, continuation lines indented and the block's tags escaped.
fn render_context(parent: &[Message], last_n: Option<i64>) -> String {
    let mut lines: Vec<String> = parent
        .iter()
        .filter_map(|message| {
            let text = plain_text(message);
            let text = strip_framing(&text);
            (!text.is_empty()).then(|| format!("{}: {text}", role_name(message.role)).replace('\n', "\n  "))
        })
        .collect();
    if let Some(last_n) = last_n.and_then(|n| usize::try_from(n).ok()).filter(|n| *n > 0) {
        lines = lines.split_off(lines.len().saturating_sub(last_n));
    }
    lines
        .join("\n")
        .replace("</parent_context>", "<\\/parent_context>")
        .replace("<parent_context>", "<\\parent_context>")
}

/// The task with a rendered context block and its framing line in front.
fn with_context(task: &str, block: &str) -> String {
    if block.is_empty() {
        return task.to_owned();
    }
    format!("{FRAMING_START}{block}\n{}{task}", framing_end())
}

fn error_result(tool_use_id: &str, message: impl Into<String>) -> ToolOutcome {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(message)]).into()
}

/// Stop reasons that mean the child never produced an answer.
fn failed(stop_reason: &StopReason) -> bool {
    matches!(
        stop_reason,
        StopReason::Cancelled | StopReason::ContentFiltered | StopReason::Refusal
    )
}

/// Maps the child's stop reason onto the parent's tool result.
fn final_tool_result(tool_use_id: &str, result: &AgentResult) -> ToolOutcome {
    let stop_reason = result.stop_reason();
    let text = result.to_string();
    if !failed(&stop_reason) {
        return ToolResultBlock::success(tool_use_id, vec![ToolResultContent::text(text)]).into();
    }
    let mut message = format!("Subagent stopped before finishing (stopReason={stop_reason}).");
    let partial = text.trim_end_matches('\n');
    if !partial.is_empty() {
        message.push_str(&format!("\n\nPartial output:\n{partial}"));
    }
    error_result(tool_use_id, message)
}

fn interrupt_params(interrupt: &Interrupt) -> InterruptParams {
    let params = InterruptParams::new(interrupt.id.clone());
    match &interrupt.reason {
        Some(reason) => params.with_reason(reason.clone()),
        None => params,
    }
}

/// A child awaiting a resume, and the interrupts it stopped on.
struct PendingChild {
    agent: Agent,
    interrupts: Vec<Interrupt>,
}

/// The `subagent` tool: streams a fresh child per call and propagates its interrupts to the
/// parent for resume (`SubagentTool`).
#[derive(Clone)]
pub struct SubagentTool {
    inner: Arc<Inner>,
}

struct Inner {
    name: String,
    spec: ToolSpec,
    axes: Axes,
    builder: AgentBuilder,
    max_depth: usize,
    pending: Mutex<HashMap<String, PendingChild>>,
}

impl fmt::Debug for SubagentTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SubagentTool")
            .field("name", &self.inner.name)
            .field("max_depth", &self.inner.max_depth)
            .finish_non_exhaustive()
    }
}

impl Tool for SubagentTool {
    fn name(&self) -> &str {
        &self.inner.name
    }

    fn description(&self) -> &str {
        &self.inner.spec.description
    }

    fn tool_spec(&self) -> ToolSpec {
        self.inner.spec.clone()
    }

    fn stream(&self, context: ToolContext) -> ToolStream {
        ToolStream::new(self.inner.clone().run(context))
    }
}

/// A prepared call: the child and its prompt, or the outcome when the call ends early.
enum Prepared {
    Run(Box<Agent>, InvokeArgs),
    Done(ToolOutcome),
}

impl Inner {
    fn take_pending(&self, tool_use_id: &str) -> Option<PendingChild> {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(tool_use_id)
    }

    fn keep_pending(&self, tool_use_id: &str, child: PendingChild) {
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(tool_use_id.to_owned(), child);
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    fn run(self: Arc<Self>, context: ToolContext) -> impl futures::Stream<Item = ToolStreamItem> + Send + 'static {
        async_stream::stream! {
            let tool_use_id = context.tool_use().tool_use_id.clone();
            let (mut child, prompt) = match self.prepare(&tool_use_id, &context).await {
                Prepared::Run(child, prompt) => (child, prompt),
                Prepared::Done(outcome) => {
                    yield ToolStreamItem::Outcome(outcome);
                    return;
                }
            };
            let options = InvokeOptions {
                invocation_state: Some(context.invocation_state().clone()),
                cancel_signal: Some(context.cancel_signal().clone()),
                ..InvokeOptions::default()
            };
            let mut result = None;
            let mut failure = None;
            {
                let mut events = child.stream_with(prompt, options);
                while let Some(event) = events.next().await {
                    match event {
                        Ok(event) => {
                            if let AgentStreamEvent::AgentResult(agent_result) = &event {
                                result = Some(agent_result.clone());
                            }
                            let data = serde_json::to_value(&event).unwrap_or(JsonValue::Null);
                            yield ToolStreamItem::Event(ToolStreamEvent::new(data));
                        }
                        Err(error) => {
                            failure = Some(error);
                            break;
                        }
                    }
                }
            }
            if let Some(error) = failure {
                yield ToolStreamItem::Outcome(error_result(&tool_use_id, format!("Subagent error: {error}")));
                return;
            }
            let Some(result) = result else {
                yield ToolStreamItem::Outcome(error_result(&tool_use_id, "Subagent produced no result."));
                return;
            };
            yield ToolStreamItem::Outcome(self.finish(&tool_use_id, &context, child, &result));
        }
    }

    /// Retains an interrupted child and re-raises its interrupts on the parent, or maps the
    /// child's result.
    fn finish(&self, tool_use_id: &str, context: &ToolContext, child: Box<Agent>, result: &AgentResult) -> ToolOutcome {
        let interrupts = result.interrupts();
        if result.stop_reason() == StopReason::Interrupt && !interrupts.is_empty() {
            self.keep_pending(
                tool_use_id,
                PendingChild {
                    agent: *child,
                    interrupts: interrupts.to_vec(),
                },
            );
            for interrupt in interrupts {
                if let Err(error) = context.interrupt(interrupt_params(interrupt)) {
                    return ToolOutcome::Interrupt(error);
                }
            }
            self.take_pending(tool_use_id);
        }
        final_tool_result(tool_use_id, result)
    }

    async fn prepare(&self, tool_use_id: &str, context: &ToolContext) -> Prepared {
        if let Some(pending) = self.take_pending(tool_use_id) {
            return self.prepare_resume(tool_use_id, context, pending);
        }
        let parent = context.agent();
        let depth = match parent.app_state().get_value(DEPTH_STATE_KEY) {
            None => usize_to_f64(self.max_depth),
            Some(stored) => Some(js_to_number(&stored))
                .filter(|depth| depth.is_finite())
                .unwrap_or(0.0),
        };
        if depth <= 0.0 {
            return Prepared::Done(error_result(
                tool_use_id,
                format!(
                    "Delegation depth limit reached ({} levels); you cannot delegate further. Complete this task yourself instead of calling subagent again.",
                    self.max_depth
                ),
            ));
        }
        let raw = context.tool_use().input.as_object().cloned().unwrap_or_default();
        let spec = match self.axes.resolve(&raw) {
            Ok(spec) => spec,
            Err(message) => return Prepared::Done(error_result(tool_use_id, format!("Subagent error: {message}"))),
        };
        let prompt = match spec.context {
            ContextMode::All => with_history(&spec.task, fork_messages(parent.messages(), spec.last_messages)),
            ContextMode::NoTools => InvokeArgs::Text(with_context(
                &spec.task,
                &render_context(parent.messages(), spec.last_messages),
            )),
            _ => InvokeArgs::Text(spec.task.clone()),
        };
        let child = match self.builder.build(spec).await {
            Ok(child) => child,
            Err(error) => return Prepared::Done(error_result(tool_use_id, format!("Subagent error: {error}"))),
        };
        if let Err(error) = child.app_state().set(DEPTH_STATE_KEY, js_number(depth - 1.0)) {
            return Prepared::Done(error_result(tool_use_id, format!("Subagent error: {error}")));
        }
        Prepared::Run(Box::new(child), prompt)
    }

    /// Collects the parent's answers to the retained child's interrupts; an unanswered one
    /// interrupts the parent again.
    fn prepare_resume(&self, tool_use_id: &str, context: &ToolContext, pending: PendingChild) -> Prepared {
        let mut responses = Vec::with_capacity(pending.interrupts.len());
        for interrupt in &pending.interrupts {
            match context.interrupt(interrupt_params(interrupt)) {
                Ok(response) => responses.push(InterruptResponseContent::new(InterruptResponse::new(
                    interrupt.id.clone(),
                    response,
                ))),
                Err(error) => {
                    self.keep_pending(tool_use_id, pending);
                    return Prepared::Done(ToolOutcome::Interrupt(error));
                }
            }
        }
        Prepared::Run(Box::new(pending.agent), InvokeArgs::InterruptResponses(responses))
    }
}

#[allow(clippy::cast_precision_loss, reason = "a delegation depth is small")]
fn usize_to_f64(value: usize) -> f64 {
    value as f64
}

/// A number as JSON: whole numbers in the safe integer range without a fraction.
fn js_number(value: f64) -> JsonValue {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        #[allow(clippy::cast_possible_truncation, reason = "whole and within the safe integer range")]
        return JsonValue::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number)
}

#[cfg(test)]
mod tests;
