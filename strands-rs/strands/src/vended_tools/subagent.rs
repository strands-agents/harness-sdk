//! The `subagent` tool: delegates a self-contained task to a child agent built at call time, and
//! returns the child's final report.
//!
//! The model's arguments are resolved through the authority-mode axes of
//! [`multiagent`](crate::multiagent) ([`Axis`]); a [`ChildAgentBuilder`] turns the result into
//! the child. The child's events stream as the tool's progress events, and its interrupts
//! surface on the parent with ids scoped to the call, so resuming the parent resumes the child.

use std::fmt;
use std::sync::Arc;

use futures::StreamExt;
use indexmap::IndexMap;
use serde_json::json;

use crate::agent::ModelSource;
use crate::agent::{
    Agent, AgentResult, AgentToolStreamer, InvokeArgs, InvokeOptions, Resume, ToolAgent, merge_events_first,
};
use crate::context_manager::ContextManagerStrategy;
use crate::conversation_manager::compression::context_compression::find_valid_trim_point;
use crate::error::{Error, Result};
use crate::multiagent::spec::{SpecAxes, SpecError, resolve_spec, schema_properties};
use crate::multiagent::{AgentSpec, Axis, ChildAgentBuilder, Fixed, Inherit, Open, Preset, SpecValue};
use crate::plugins::Plugin;
use crate::tools::{Tool, ToolContext, ToolOutcome, ToolStream, ToolStreamEvent, ToolStreamItem};
use crate::types::{
    ContentBlock, JsonObject, JsonSchema, JsonValue, Message, Role, ToolResultBlock, ToolResultContent, ToolSpec,
};

/// The description of the default `subagent` tool (`DEFAULT_SUBAGENT_DESCRIPTION`).
pub const DEFAULT_SUBAGENT_DESCRIPTION: &str = concat!(
    "Delegate a self-contained task to a subagent that runs in its own context and returns a ",
    "final report. Reach for this when a subtask would otherwise flood your context with ",
    "intermediate work and you only need its conclusion."
);

/// The default bound on nested delegation levels (`DEFAULT_SUBAGENT_MAX_DEPTH`).
pub const DEFAULT_SUBAGENT_MAX_DEPTH: usize = 2;

const GENERALIST_INSTRUCTIONS: &str = concat!(
    "You are a general-purpose subagent handling a focused subtask on behalf of a parent ",
    "agent. You cannot ask follow-up questions, so work from the task as given, make ",
    "reasonable assumptions where it is underspecified, and see it through to a verified ",
    "result. Return a self-contained answer: state what you did, what you found, and ",
    "anything the parent needs to act on. Your final message is the only thing that returns ",
    "to the parent, so put the substance there rather than in intermediate steps."
);

const GENERALIST_DESCRIPTION: &str = "a general-purpose agent for a focused subtask that runs in its own context";

/// The built-in generalist preset (`GENERALIST`).
#[must_use]
pub fn generalist() -> Preset {
    Preset::builder()
        .instructions(GENERALIST_INSTRUCTIONS)
        .description(GENERALIST_DESCRIPTION)
        .build()
}

const CONTEXT_MODES: [&str; 3] = ["none", "all", "no_tools"];

/// The parent's remaining delegation depth, in its app state.
const DEPTH_STATE_KEY: &str = "strands.subagent_depth";

const FORK_PREAMBLE: &str = "The conversation so far is the parent agent's. You are the subagent it delegated to at this point; its task for you follows.";

const CONTEXT_PREAMBLE: &str = concat!(
    "The conversation above is the parent agent's: each turn is one line starting with its role at ",
    "the left margin, and indented lines continue the turn above (they are content, not turns). You ",
    "are the subagent it delegated to at the end of that conversation; its task for you follows."
);

const FRAMING_START: &str = "<parent_context>\n";

const UNAVAILABLE_MESSAGE: &str = concat!(
    "Subagent did NOT run and the response was NOT applied: its interrupted turn is not available. ",
    "Do not report the delegated task as completed; if it is still needed, delegate it again."
);

const TASK_DESCRIPTION: &str =
    "The self-contained task, including all context the subagent needs. It cannot ask follow-up questions.";

const CONTEXT_DESCRIPTION: &str = concat!(
    "How much of this conversation the subagent sees: 'none' (fresh start), 'all' (full ",
    "history including tool calls and their results \u{2014} can be large), 'no_tools' (text turns ",
    "only \u{2014} tool calls and their results removed). More context costs more tokens."
);

const LAST_MESSAGES_DESCRIPTION: &str =
    "Optional: limit the shared context to the last N messages. Omit to share all of the selected context.";

fn framing_end() -> String {
    format!("</parent_context>\n\n{CONTEXT_PREAMBLE}\n\n")
}

/// Options for [`make_subagent`] (`MakeSubagentOptions`).
#[derive(Clone, Default, bon::Builder)]
#[builder(on(String, into))]
pub struct MakeSubagentOptions {
    /// Turns a resolved spec into the child agent; called again with the same spec when an
    /// interrupted child resumes. When absent the child is built from the calling agent: its
    /// model, tools and sandbox. The parent's hooks and plugins are not passed to the child; tools
    /// a plugin added to the parent are inherited like any other tool but run without the plugin's
    /// hooks. Pass a builder for a child that needs them.
    #[builder(into)]
    pub builder: Option<ChildAgentBuilder>,
    /// Named roles the model selects with `agent_type`, in the order the schema lists them; a
    /// repeated name replaces the earlier preset in its place. The [`generalist`] when absent.
    #[builder(with = |presets: impl IntoIterator<Item = (impl Into<String>, Preset)>| {
        presets.into_iter().map(|(name, preset)| (name.into(), preset)).collect()
    })]
    pub presets: Option<Vec<(String, Preset)>>,
    /// The preset used when the model omits `agent_type`; the first preset when absent.
    pub default_preset: Option<String>,
    /// The policy for the child's system prompt: [`Open`], [`Choice`](crate::multiagent::Choice) or [`Fixed`]; `Open` when
    /// absent.
    pub instructions: Option<Axis>,
    /// The policy for the child's tools: [`Choice`](crate::multiagent::Choice) (with `multiple`), [`Fixed`] or [`Inherit`];
    /// `Inherit` when absent.
    pub tools: Option<Axis>,
    /// The policy for the child's model: [`Inherit`], [`Choice`](crate::multiagent::Choice) or [`Fixed`]; `Inherit` when
    /// absent.
    pub model: Option<Axis>,
    /// How much of the parent's conversation the child sees: [`Fixed`] or [`Choice`](crate::multiagent::Choice) over
    /// `none`, `all` and `no_tools`; `Fixed("none")` when absent.
    pub context: Option<Axis>,
    /// The most nested delegation levels; [`DEFAULT_SUBAGENT_MAX_DEPTH`] when absent.
    pub max_depth: Option<usize>,
    /// The tool name; `subagent` when absent.
    pub name: Option<String>,
    /// The tool description; [`DEFAULT_SUBAGENT_DESCRIPTION`] when absent.
    pub description: Option<String>,
}

impl fmt::Debug for MakeSubagentOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MakeSubagentOptions")
            .field("builder", &self.builder.is_some())
            .field("presets", &self.presets)
            .field("default_preset", &self.default_preset)
            .field("instructions", &self.instructions)
            .field("tools", &self.tools)
            .field("model", &self.model)
            .field("context", &self.context)
            .field("max_depth", &self.max_depth)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

fn check_axis(key: &str, axis: &Axis, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&axis.kind()) {
        return Ok(());
    }
    Err(Error::other(format!(
        "{key}: {} is not supported; use {}.",
        axis.kind(),
        allowed.join(", ")
    )))
}

/// The default `subagent` tool: the generalist preset and every axis at its default
/// (`subagent`).
#[must_use]
pub fn subagent() -> SubagentTool {
    make_subagent(MakeSubagentOptions::default()).unwrap_or_else(|error| {
        tracing::error!("error=<{error}> | default subagent options were rejected, using a task-only schema");
        let schema = json!({
            "type": "object",
            "properties": {"task": {"type": "string", "description": TASK_DESCRIPTION}},
            "required": ["task"]
        });
        SubagentTool {
            inner: Arc::new(Inner {
                name: "subagent".to_owned(),
                spec: ToolSpec::new("subagent", DEFAULT_SUBAGENT_DESCRIPTION).with_input_schema(schema),
                presets: IndexMap::from([("generalist".to_owned(), generalist())]),
                default_preset: Some("generalist".to_owned()),
                instructions: Axis::Open(Open),
                tools: Axis::Inherit(Inherit),
                model: Axis::Inherit(Inherit),
                context: Axis::Fixed(Fixed::new("none")),
                builder: None,
                max_depth: DEFAULT_SUBAGENT_MAX_DEPTH,
            }),
        }
    })
}

/// Creates a subagent tool whose input schema follows the axis policies and presets.
///
/// ```
/// use strands::multiagent::{Choice, Preset};
/// use strands::vended_tools::subagent::{MakeSubagentOptions, make_subagent};
///
/// let researcher = make_subagent(MakeSubagentOptions {
///     presets: Some(vec![(
///         "researcher".to_owned(),
///         Preset::builder().instructions("You research topics.").description("research").build(),
///     )]),
///     context: Some(Choice::new(["none", "all"]).into()),
///     ..MakeSubagentOptions::default()
/// })?;
/// let agent = strands::Agent::builder().tools([researcher]).printer(false).build()?;
/// assert!(agent.tool_registry().get("subagent").is_some());
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// When `max_depth` is 0, `name` or `description` is empty, `default_preset` is not a preset,
/// an axis has a mode it does not support, a [`Choice`](crate::multiagent::Choice) has no options or (for tools) is not
/// `multiple`, or a context mode is not `none`, `all` or `no_tools`.
pub fn make_subagent(options: MakeSubagentOptions) -> Result<SubagentTool> {
    let name = options.name.unwrap_or_else(|| "subagent".to_owned());
    let description = options
        .description
        .unwrap_or_else(|| DEFAULT_SUBAGENT_DESCRIPTION.to_owned());
    let max_depth = options.max_depth.unwrap_or(DEFAULT_SUBAGENT_MAX_DEPTH);
    if name.is_empty() {
        return Err(Error::other("name must be a non-empty string."));
    }
    if description.is_empty() {
        return Err(Error::other("description must be a non-empty string."));
    }
    if max_depth < 1 {
        return Err(Error::other("maxDepth must be a positive integer (>= 1)."));
    }
    let presets: IndexMap<String, Preset> = options.presets.map_or_else(
        || IndexMap::from([("generalist".to_owned(), generalist())]),
        |presets| presets.into_iter().collect(),
    );
    let instructions = options.instructions.unwrap_or(Axis::Open(Open));
    let tools = options.tools.unwrap_or(Axis::Inherit(Inherit));
    let model = options.model.unwrap_or(Axis::Inherit(Inherit));
    let context = options.context.unwrap_or_else(|| Axis::Fixed(Fixed::new("none")));
    check_axis("instructions", &instructions, &["Open", "Choice", "Fixed"])?;
    check_axis("tools", &tools, &["Choice", "Fixed", "Inherit"])?;
    check_axis("model", &model, &["Inherit", "Choice", "Fixed"])?;
    check_axis("context", &context, &["Fixed", "Choice"])?;
    let default_preset = options.default_preset.or_else(|| presets.keys().next().cloned());
    if let Some(default_preset) = &default_preset
        && !presets.contains_key(default_preset)
    {
        let names: Vec<&str> = presets.keys().map(String::as_str).collect();
        return Err(Error::other(format!(
            "defaultPreset '{default_preset}' is not one of the presets: {}.",
            names.join(", ")
        )));
    }
    for mode in context_modes(&context) {
        if !mode.as_ref().is_some_and(|mode| CONTEXT_MODES.contains(&mode.as_str())) {
            let shown = mode.map_or_else(|| "undefined".to_owned(), |mode| JsonValue::String(mode).to_string());
            return Err(Error::other(format!(
                "context mode {shown} must be one of: {}.",
                CONTEXT_MODES.join(", ")
            )));
        }
    }
    let axes = SpecAxes {
        presets: &presets,
        default_preset: default_preset.as_deref(),
        instructions: &instructions,
        tools: &tools,
        model: &model,
    };
    let schema = build_schema(&axes, &context)?;
    let spec = ToolSpec::new(&name, &description).with_input_schema(schema);
    Ok(SubagentTool {
        inner: Arc::new(Inner {
            name,
            spec,
            presets,
            default_preset,
            instructions,
            tools,
            model,
            context,
            builder: options.builder,
            max_depth,
        }),
    })
}

/// The context mode each option of the context axis stands for.
fn context_modes(context: &Axis) -> Vec<Option<String>> {
    let text = |value: Option<SpecValue>| match value {
        Some(SpecValue::Text(text)) => Some(text),
        _ => None,
    };
    match context {
        Axis::Choice(choice) => choice
            .normalized()
            .into_iter()
            .map(|option| text(option.value))
            .collect(),
        Axis::Fixed(fixed) => vec![text(fixed.value.clone())],
        _ => Vec::new(),
    }
}

/// The input schema.
fn build_schema(axes: &SpecAxes<'_>, context: &Axis) -> Result<JsonSchema> {
    let mut properties = JsonObject::new();
    properties.insert(
        "task".to_owned(),
        json!({"type": "string", "description": TASK_DESCRIPTION}),
    );
    properties.extend(schema_properties(axes)?);
    if let Axis::Choice(choice) = context {
        let options = choice.normalized();
        let lines: Vec<String> = options
            .iter()
            .filter(|option| !option.description.is_empty())
            .map(|option| format!("- {}: {}", option.name, option.description))
            .collect();
        let mut description = CONTEXT_DESCRIPTION.to_owned();
        if !lines.is_empty() {
            description = format!("{description}\nOptions:\n{}", lines.join("\n"));
        }
        let names: Vec<&str> = options.iter().map(|option| option.name.as_str()).collect();
        properties.insert(
            "context".to_owned(),
            json!({"type": "string", "enum": names, "description": description}),
        );
        let shares = options
            .iter()
            .any(|option| option.value != Some(SpecValue::Text("none".to_owned())));
        if shares {
            properties.insert(
                "last_messages".to_owned(),
                json!({"type": "integer", "description": LAST_MESSAGES_DESCRIPTION}),
            );
        }
    }
    Ok(json!({"type": "object", "properties": properties, "required": ["task"]}))
}

/// The `subagent` tool: builds a fresh child per call and streams it (`SubagentTool`).
#[derive(Clone)]
pub struct SubagentTool {
    inner: Arc<Inner>,
}

struct Inner {
    name: String,
    spec: ToolSpec,
    presets: IndexMap<String, Preset>,
    default_preset: Option<String>,
    instructions: Axis,
    tools: Axis,
    model: Axis,
    context: Axis,
    builder: Option<ChildAgentBuilder>,
    max_depth: usize,
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
        let (sender, receiver) = futures::channel::mpsc::channel(0);
        let run = self.inner.clone().run(context, sender);
        let outcome = futures::stream::once(run).map(ToolStreamItem::Outcome);
        ToolStream::new(merge_events_first(receiver.map(ToolStreamItem::Event), outcome))
    }
}

/// A prepared call: the child and its prompt, or the outcome when the call ends early.
enum Prepared {
    Run(Box<Agent>, InvokeArgs),
    Done(ToolOutcome),
}

fn error_result(tool_use_id: &str, text: impl Into<String>) -> ToolOutcome {
    ToolResultBlock::error(tool_use_id, vec![ToolResultContent::text(text)]).into()
}

impl Inner {
    fn axes(&self) -> SpecAxes<'_> {
        SpecAxes {
            presets: &self.presets,
            default_preset: self.default_preset.as_deref(),
            instructions: &self.instructions,
            tools: &self.tools,
            model: &self.model,
        }
    }

    async fn build(&self, spec: &AgentSpec, parent: &ToolAgent) -> Result<Agent> {
        match &self.builder {
            Some(builder) => builder.build(spec.clone()).await,
            None => default_builder(spec, parent),
        }
    }

    fn fail(&self, tool_use_id: &str, message: &str) -> ToolOutcome {
        tracing::warn!(
            "tool_name=<{}>, tool_use_id=<{tool_use_id}>, error=<{message}> | subagent failed",
            self.name
        );
        error_result(tool_use_id, format!("Subagent error: {message}"))
    }

    async fn run(
        self: Arc<Self>,
        context: ToolContext,
        mut events: futures::channel::mpsc::Sender<ToolStreamEvent>,
    ) -> ToolOutcome {
        let tool_use_id = context.tool_use().tool_use_id.clone();
        let raw = context.tool_use().input.as_object().cloned().unwrap_or_default();
        let parent = context.agent();
        let mut streamer = AgentToolStreamer::new(
            parent.interrupt_state().clone(),
            &tool_use_id,
            "subagent",
            true,
            "Subagent".to_owned(),
        );
        let (mut child, prompt) = match self.prepare(&tool_use_id, &raw, parent, &mut streamer).await {
            Prepared::Run(child, prompt) => (child, prompt),
            Prepared::Done(outcome) => return outcome,
        };
        let options = InvokeOptions {
            invocation_state: Some(context.invocation_state().copy()),
            cancel_signal: Some(context.cancel_signal().clone()),
            invocation_context: context.invocation_context().cloned(),
            ..InvokeOptions::default()
        };
        if let Err(error) = streamer
            .stream(&mut child, prompt, options, &self.name, &mut events)
            .await
        {
            return self.fail(&tool_use_id, &error.to_string());
        }
        streamer.terminal_tool_result(|result: &AgentResult| vec![ToolResultContent::text(result.to_string())])
    }

    async fn prepare(
        &self,
        tool_use_id: &str,
        raw: &JsonObject,
        parent: &ToolAgent,
        streamer: &mut AgentToolStreamer,
    ) -> Prepared {
        if streamer.is_resuming() {
            return self.prepare_resume(tool_use_id, raw, parent, streamer).await;
        }
        let depth = parent
            .app_state()
            .get_value(DEPTH_STATE_KEY)
            .and_then(|depth| depth.as_u64())
            .map_or(self.max_depth, |depth| usize::try_from(depth).unwrap_or(usize::MAX));
        if depth == 0 {
            return Prepared::Done(error_result(
                tool_use_id,
                format!(
                    "Delegation depth limit reached ({} levels); you cannot delegate further. Complete this task yourself instead of calling {} again.",
                    self.max_depth, self.name
                ),
            ));
        }
        let Some(task) = raw
            .get("task")
            .and_then(JsonValue::as_str)
            .filter(|task| !task.trim().is_empty())
        else {
            return Prepared::Done(error_result(
                tool_use_id,
                "Missing required parameter 'task': describe the task to delegate.",
            ));
        };
        let spec = match resolve_spec(raw, &self.name, &self.axes()) {
            Ok(spec) => spec,
            Err(SpecError::Invalid(message)) => return Prepared::Done(self.fail(tool_use_id, &message)),
            Err(SpecError::InstructionsNotText) => {
                return Prepared::Done(error_result(tool_use_id, "Parameter 'instructions' must be a string."));
            }
        };
        let child = match self.build(&spec, parent).await {
            Ok(child) => child,
            Err(error) => return Prepared::Done(self.fail(tool_use_id, &error.to_string())),
        };
        if let Err(error) = child.app_state().set(DEPTH_STATE_KEY, depth - 1) {
            return Prepared::Done(self.fail(tool_use_id, &error.to_string()));
        }
        let prompt = self.prompt(task, raw, parent);
        Prepared::Run(Box::new(child), prompt)
    }

    /// Rebuilds the interrupted child from the same input and restores its stored turn.
    async fn prepare_resume(
        &self,
        tool_use_id: &str,
        raw: &JsonObject,
        parent: &ToolAgent,
        streamer: &mut AgentToolStreamer,
    ) -> Prepared {
        let spec = match resolve_spec(raw, &self.name, &self.axes()) {
            Ok(spec) => spec,
            Err(SpecError::Invalid(message)) => return Prepared::Done(self.fail(tool_use_id, &message)),
            Err(SpecError::InstructionsNotText) => {
                return Prepared::Done(self.fail(tool_use_id, "Parameter 'instructions' must be a string."));
            }
        };
        let mut child = match self.build(&spec, parent).await {
            Ok(child) => Some(child),
            Err(error) => {
                tracing::warn!(
                    "tool_name=<{}>, tool_use_id=<{tool_use_id}>, error=<{error}> | failed to rebuild interrupted subagent",
                    self.name
                );
                None
            }
        };
        match streamer.resume(child.as_mut(), UNAVAILABLE_MESSAGE).await {
            Resume::Responses(responses) => match child {
                Some(child) => Prepared::Run(Box::new(child), InvokeArgs::InterruptResponses(responses)),
                None => Prepared::Done(error_result(tool_use_id, UNAVAILABLE_MESSAGE)),
            },
            Resume::Raise(interrupts) if interrupts.is_empty() => {
                Prepared::Done(error_result(tool_use_id, "Subagent interrupted without any interrupts"))
            }
            Resume::Raise(interrupts) => Prepared::Done(ToolOutcome::Interrupt(crate::interrupt::InterruptError::new(
                interrupts,
            ))),
            Resume::Stop => Prepared::Done(
                streamer.terminal_tool_result(|result: &AgentResult| vec![ToolResultContent::text(result.to_string())]),
            ),
        }
    }

    /// The context mode and the positive `last_messages` limit from the model's input.
    fn resolve_context(&self, raw: &JsonObject) -> (String, Option<usize>) {
        let mode = match &self.context {
            Axis::Choice(choice) => raw
                .get("context")
                .and_then(|value| match value {
                    JsonValue::String(name) => Some(name.clone()),
                    JsonValue::Null => None,
                    other => Some(other.to_string()),
                })
                .filter(|name| choice.options.iter().any(|option| &option.name == name))
                .and_then(|name| match choice.value_for(&name) {
                    SpecValue::Text(mode) => Some(mode),
                    _ => None,
                }),
            Axis::Fixed(Fixed {
                value: Some(SpecValue::Text(mode)),
            }) => Some(mode.clone()),
            _ => None,
        };
        let last = match raw.get("last_messages") {
            Some(JsonValue::Number(number)) => number.as_f64(),
            Some(JsonValue::String(text)) => text.trim().parse::<f64>().ok(),
            _ => None,
        };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked to be at least 1"
        )]
        let last = last
            .map(f64::trunc)
            .filter(|count| count.is_finite() && *count >= 1.0)
            .map(|count| count as usize);
        (mode.unwrap_or_else(|| "none".to_owned()), last)
    }

    fn prompt(&self, task: &str, raw: &JsonObject, parent: &ToolAgent) -> InvokeArgs {
        let (mode, last_messages) = self.resolve_context(raw);
        match mode.as_str() {
            "all" => {
                let mut messages = fork_messages(parent.messages(), last_messages);
                let framed = ContentBlock::text(format!("{FORK_PREAMBLE}\n\n{task}"));
                match messages.last_mut() {
                    None => InvokeArgs::Text(task.to_owned()),
                    Some(last) if last.role == Role::User => {
                        last.content.push(framed);
                        InvokeArgs::Messages(messages)
                    }
                    Some(_) => {
                        messages.push(Message::new(Role::User, vec![framed]));
                        InvokeArgs::Messages(messages)
                    }
                }
            }
            "no_tools" => {
                let block = render_context(parent.messages(), last_messages);
                if block.is_empty() {
                    InvokeArgs::Text(task.to_owned())
                } else {
                    InvokeArgs::Text(format!("{FRAMING_START}{block}\n{}{task}", framing_end()))
                }
            }
            _ => InvokeArgs::Text(task.to_owned()),
        }
    }
}

/// The child the default builder makes: the parent's model, sandbox, printer
/// setting, trace attributes, intervention handlers and tools (all, or those `spec.tools` names
/// that the parent has, never its context manager's), named after the spec, with an `auto`
/// context manager unless its model is stateful. The parent's hooks and plugins stay behind.
fn default_builder(spec: &AgentSpec, parent: &ToolAgent) -> Result<Agent> {
    let inheritance = parent.inheritance();
    let managed: Vec<String> = inheritance
        .context_manager
        .as_ref()
        .map(|manager| {
            manager
                .get_tools()
                .into_iter()
                .flat_map(|source| source.into_parts().tools)
                .map(|tool| tool.name().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let parent_tools: Vec<Arc<dyn Tool>> = parent
        .tool_registry()
        .list()
        .into_iter()
        .filter(|tool| !managed.iter().any(|name| name == tool.name()))
        .collect();
    let find = |name: &str| parent_tools.iter().find(|tool| tool.name() == name).cloned();
    let tools: Vec<Arc<dyn Tool>> = match &spec.tools {
        None => parent_tools.clone(),
        Some(names) => names
            .iter()
            .filter_map(|name| {
                let tool = find(name);
                if tool.is_none() {
                    tracing::warn!("tool_name=<{name}> | subagent requested tool but parent does not own it, skipping");
                }
                tool
            })
            .collect(),
    };
    let model = match &spec.model {
        Some(SpecValue::Model(model)) => ModelSource::Model(model.clone()),
        Some(SpecValue::Text(model_id)) => ModelSource::Id(model_id.clone()),
        _ => ModelSource::Model(parent.model().clone()),
    };
    let stateful = matches!(&model, ModelSource::Model(model) if model.stateful());
    let trace_attributes = inheritance
        .tracer
        .as_ref()
        .map(|tracer| tracer.trace_attributes())
        .unwrap_or_default();
    Agent::builder()
        .maybe_context_manager((!stateful).then_some(ContextManagerStrategy::Auto))
        .trace_attributes(trace_attributes)
        .interventions(inheritance.interventions.iter().cloned())
        .system_prompt(spec.instructions.clone().unwrap_or_default())
        .tools(tools)
        .model(model)
        .maybe_name(spec.name.clone())
        .maybe_id(spec.name.clone())
        .sandbox(parent.sandbox().clone())
        .printer(parent.printer())
        .build()
}

/// Copies the parent's messages without reasoning, injected context or unanswered tool calls,
/// merging consecutive messages of one role, and widens a `last_messages` window so it never
/// starts inside a tool pair.
fn fork_messages(messages: &[Message], last_messages: Option<usize>) -> Vec<Message> {
    let answered: Vec<&str> = messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.tool_use_id.as_str()),
            _ => None,
        })
        .collect();
    let mut forked: Vec<Message> = Vec::new();
    for message in messages {
        let content: Vec<ContentBlock> = message
            .content
            .iter()
            .filter(|block| match block {
                ContentBlock::Reasoning(_) | ContentBlock::Injected(_) => false,
                ContentBlock::ToolUse(tool_use) => answered.contains(&tool_use.tool_use_id.as_str()),
                _ => true,
            })
            .cloned()
            .collect();
        if content.is_empty() {
            continue;
        }
        match forked.last_mut() {
            Some(previous) if previous.role == message.role => previous.content.extend(content),
            _ => forked.push(Message::new(message.role, content)),
        }
    }
    let Some(last) = last_messages else {
        return forked;
    };
    let mut start = forked.len().saturating_sub(last);
    while start > 0 && find_valid_trim_point(&forked[start..(start + 2).min(forked.len())], 0) != 0 {
        start -= 1;
    }
    forked.split_off(start)
}

/// Renders the parent's text turns as a plain-text block.
fn render_context(messages: &[Message], last_messages: Option<usize>) -> String {
    let messages = match last_messages {
        Some(last) => &messages[messages.len().saturating_sub(last)..],
        None => messages,
    };
    let framing_end = framing_end();
    let lines: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            let text: Vec<&str> = message
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect();
            let mut text = text.join(" ").trim().to_owned();
            if text.starts_with(FRAMING_START)
                && let Some(end) = text.find(&framing_end)
            {
                text = text[end + framing_end.len()..].to_owned();
            }
            (!text.is_empty()).then(|| format!("{}: {text}", role_name(message.role)).replace('\n', "\n  "))
        })
        .collect();
    lines
        .join("\n")
        .replace("<parent_context>", "<\\parent_context>")
        .replace("</parent_context>", "<\\/parent_context>")
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::User => "user",
        _ => "assistant",
    }
}

#[cfg(test)]
mod tests;
