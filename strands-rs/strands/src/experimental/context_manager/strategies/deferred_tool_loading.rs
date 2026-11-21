//! Deferred tool loading: keeps tools' input schemas out of the model's context until the model
//! loads them. Build it with [`Offload::defer`](super::offload::Offload::defer).

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;

use crate::agent::{LocalAgent, ToolAgent};
use crate::error::{Error, Result};
use crate::experimental::context_manager::retrieval_tool::RETRIEVAL_TOOL_NAME;
use crate::experimental::context_manager::stash::Stash;
use crate::experimental::context_manager::strategies::offload::ConditionValue;
use crate::experimental::context_manager::strategies::offload::conditions::{
    ConditionName, ParsedCondition, parse_condition_as,
};
use crate::experimental::context_manager::strategies::offload::target::{OffloadTarget, OffloadTargetMatcher};
use crate::experimental::context_manager::types::{ContextState, ContextStrategy};
use crate::logging::warn_once;
use crate::middleware::{ExecuteToolContext, ExecuteToolResult, ExecuteToolStage, InvokeModelStage, StageStream};
use crate::models::model_info::{default_context_window_limit, lookup_model};
use crate::models::model_proxy::CallTools;
use crate::models::{DeferredToolLoading, Model, heuristic_json};
use crate::tools::{
    DeferredToolsFn, LOAD_TOOLS_TOOL_NAME, STRUCTURED_OUTPUT_TOOL_NAME, SdkToolRole, Tool, ToolRegistry,
    create_load_tools, has_sdk_tool_role,
};
use crate::types::{
    ContentBlock, JsonValue, Message, TextBlock, ToolReferenceBlock, ToolResultBlock, ToolResultContent, ToolSpec,
};

/// The strategy name (`'offload:defer'`).
const STRATEGY_NAME: &str = "offload:defer";

/// SDK tools that are never deferred, since SDK-injected text tells the model to call them or they
/// load the rest. The background-tasks manage tool is one too, recognized by its role since its
/// name is configurable. `retrieve_offloaded_content` and `skills` are named for the
/// `ContextOffloader` and `AgentSkills` tools.
const PROTECTED_TOOL_NAMES: [&str; 5] = [
    LOAD_TOOLS_TOOL_NAME,
    RETRIEVAL_TOOL_NAME,
    STRUCTURED_OUTPUT_TOOL_NAME,
    "retrieve_offloaded_content",
    "skills",
];

/// Input schema keywords that describe no parameter.
const ANNOTATION_KEYWORDS: [&str; 4] = ["$schema", "type", "title", "description"];

/// Which tools [`Offload::defer`](super::offload::Offload::defer) defers (`DeferTarget`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum DeferTarget {
    /// Every tool (`'toolSpecs'`).
    ToolSpecs,
    /// The named tools, each optionally `tool::<name>`; a leading `!` keeps a tool in full
    /// instead. A list of only exclusions defers every other tool.
    Tools(Vec<String>),
}

impl DeferTarget {
    /// The named tools (`['shell', '!read']`).
    pub fn tools(tools: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Tools(tools.into_iter().map(Into::into).collect())
    }

    fn to_json(&self) -> String {
        match self {
            Self::ToolSpecs => "\"toolSpecs\"".to_owned(),
            Self::Tools(tools) => serde_json::to_string(tools).unwrap_or_default(),
        }
    }
}

/// When [`Offload::defer`](super::offload::Offload::defer) defers tools (`DeferConditions`).
///
/// Checked on every model call against that call's tools; either condition is enough, and with
/// none it defers at any tool count. The same tools and conditions always defer the same tools,
/// so the tools list stays the same from call to call and after a session restore. A tool change
/// that meets a condition mid-conversation defers from the next call on, so the model then loads
/// tools it was calling directly.
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct DeferConditions {
    /// Tools in the call at or above which it defers: a whole number above 0. The SDK's own tools
    /// count, but not the structured output tool, so an invocation with structured output defers
    /// the same tools as one without.
    #[builder(into)]
    pub tool_count: Option<ConditionValue>,
    /// Estimated tokens of the input schemas it would defer, at or above which it defers: a whole
    /// number above 0, or `"5%"` of the context window.
    #[builder(into)]
    pub schema_tokens: Option<ConditionValue>,
}

/// A matcher for a list target, or `None` for `ToolSpecs`, which covers every tool.
fn target_matcher(target: &DeferTarget) -> Result<Option<OffloadTargetMatcher>> {
    let DeferTarget::Tools(entries) = target else {
        return Ok(None);
    };
    if entries
        .iter()
        .any(|entry| entry == "toolSpecs" || entry == "!toolSpecs")
    {
        return Err(Error::other(format!(
            "Offload.defer target {} lists 'toolSpecs', which is not a tool name: use 'toolSpecs' alone, or list only the tools to keep in full, such as ['!shell']",
            target.to_json()
        )));
    }
    OffloadTargetMatcher::new(OffloadTarget::Tools(entries.clone())).map(Some)
}

struct Inner {
    target: DeferTarget,
    /// Matches a list target's tool names; `None` for `ToolSpecs`, which covers every tool.
    matcher: Option<OffloadTargetMatcher>,
    tool_count: Option<usize>,
    schema_tokens: Option<ParsedCondition>,
    /// The tools each agent's latest model call deferred, by agent id.
    deferred: Mutex<HashMap<String, HashSet<String>>>,
}

/// A strategy that keeps tools' input schemas out of the model's context until the model loads
/// them with `load_tools` (`DeferStrategy`, built with
/// [`Offload::defer`](super::offload::Offload::defer)).
///
/// On every model call it picks the tools to defer from that call's tools and passes their names
/// on the call as its `deferred_tools`. The call's model decides how a deferred tool reaches it
/// (`ModelCapabilities::deferred_tool_loading`); a model that can't defer tools gets every spec.
/// The model still sees each deferred tool's name and description and loads a schema with
/// `load_tools`, which the context manager registers. A call to a deferred tool before its load
/// gets the schema back instead of running. SDK tools such as `load_tools` and `retrieve_context`
/// are never deferred, nor is a tool that takes no parameters, since its stub would leave nothing
/// out. It never changes the messages. One per context manager, the `deferredToolLoading` preset
/// included.
///
/// ```
/// use strands::experimental::context_manager::{DeferConditions, DeferTarget, Offload};
///
/// // From 20 tools, or once their schemas reach 5% of the context window, defer every one but shell's.
/// let defer = Offload::defer(DeferTarget::tools(["!shell"]))?.when(DeferConditions {
///     tool_count: Some(20.into()),
///     schema_tokens: Some("5%".into()),
/// })?;
/// # let _ = defer;
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Clone)]
pub struct DeferStrategy {
    inner: Arc<Inner>,
}

impl fmt::Debug for DeferStrategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeferStrategy")
            .field("target", &self.inner.target)
            .field("tool_count", &self.inner.tool_count)
            .field("schema_tokens", &self.inner.schema_tokens)
            .finish_non_exhaustive()
    }
}

impl DeferStrategy {
    /// # Errors
    ///
    /// A target that is an empty list, lists `toolSpecs`, or excludes every tool it includes, or
    /// a condition that is out of range.
    pub(crate) fn new(target: DeferTarget, conditions: DeferConditions) -> Result<Self> {
        let DeferConditions {
            tool_count,
            schema_tokens,
        } = conditions;
        let matcher = target_matcher(&target)?;
        let tool_count = parse_tool_count(tool_count.as_ref())?;
        let schema_tokens = parse_condition_as(ConditionName::BlockThreshold, schema_tokens.as_ref(), "schemaTokens")?;
        Ok(Self {
            inner: Arc::new(Inner {
                target,
                matcher,
                tool_count,
                schema_tokens,
                deferred: Mutex::default(),
            }),
        })
    }

    /// A copy of this strategy with these conditions in place of its current ones (`when`).
    ///
    /// # Errors
    ///
    /// A `tool_count` that is not a whole number above 0, or a `schema_tokens` that is not a whole
    /// number above 0 or a `"N%"` string below `"100%"`.
    pub fn when(&self, conditions: DeferConditions) -> Result<Self> {
        Self::new(self.inner.target.clone(), conditions)
    }

    /// The tools `load_tools` loads: the ones the agent's latest model call deferred. Before the
    /// agent's first call, as when an interrupted load resumes on a restored agent, every
    /// registered tool the target covers, since which of them the next call defers depends on that
    /// call's tools and model.
    pub(crate) fn deferred_tools(&self, agent: &ToolAgent) -> Vec<String> {
        if let Some(recorded) = self.recorded(agent.id()) {
            return recorded.into_iter().collect();
        }
        let registry = agent.tool_registry();
        registry
            .list()
            .iter()
            .filter(|tool| self.targets(registry, &tool.tool_spec()))
            .map(|tool| tool.name().to_owned())
            .collect()
    }

    /// The tools an agent's model call with these tool specs on this model sends: every spec and
    /// the names of the ones it defers, or every spec but `load_tools` when it defers none
    /// (`callTools`).
    pub(crate) fn call_tools(
        &self,
        registry: &ToolRegistry,
        tool_specs: &[ToolSpec],
        model: &Arc<dyn Model>,
    ) -> CallTools {
        let deferred = if defers_tools(model.as_ref()) {
            self.to_defer(registry, tool_specs, model.as_ref())
        } else {
            HashSet::new()
        };
        if !deferred.is_empty() {
            return CallTools {
                tool_specs: tool_specs.to_vec(),
                deferred_tools: deferred,
            };
        }
        CallTools {
            tool_specs: tool_specs
                .iter()
                .filter(|spec| spec.name != LOAD_TOOLS_TOOL_NAME)
                .cloned()
                .collect(),
            deferred_tools: HashSet::new(),
        }
    }

    /// The `load_tools` tool, which loads the tools this strategy deferred on the calling agent's
    /// latest model call.
    pub(crate) fn load_tools(&self) -> Arc<dyn Tool> {
        let strategy = self.clone();
        let deferred: DeferredToolsFn = Arc::new(move |agent: &ToolAgent| strategy.deferred_tools(agent));
        create_load_tools(deferred)
    }

    fn recorded(&self, agent_id: &str) -> Option<HashSet<String>> {
        self.inner
            .deferred
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(agent_id)
            .cloned()
    }

    /// Records the tools an agent's call defers, and logs when they differ from its previous
    /// call's.
    fn record(&self, agent_id: &str, deferred: &HashSet<String>, model: &dyn Model) {
        let mut records = self.inner.deferred.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = records
            .get(agent_id)
            .map_or(!deferred.is_empty(), |previous| previous != deferred);
        if changed {
            tracing::debug!(
                "model_id=<{}>, deferred=<{}> | deferred tools changed",
                model.model_id().unwrap_or_default(),
                deferred.len()
            );
        }
        records.insert(agent_id.to_owned(), deferred.clone());
    }

    /// Defers this call's tools, or sends every spec without the loader when the call defers
    /// none.
    fn render(&self, agent: &ToolAgent, tool_specs: &[ToolSpec], model: &Arc<dyn Model>) -> CallTools {
        let registry = agent.tool_registry();
        let tools = self.call_tools(registry, tool_specs, model);
        self.record(agent.id(), &tools.deferred_tools, model.as_ref());
        let model_id = model.model_id().unwrap_or_default();
        if !defers_tools(model.as_ref()) && !self.to_defer(registry, tool_specs, model.as_ref()).is_empty() {
            warn_once(&format!(
                "model_id=<{model_id}> | model or its config can not defer tool schemas | sending every tool spec"
            ));
        }
        if !tools.deferred_tools.is_empty() && takes_stubs_by_default(model.as_ref()) {
            warn_once(&format!(
                "model_id=<{model_id}> | model is not in the shared model info | sending deferred tools as stubs, set modelInfo.capabilities.deferredToolLoading to unsupported if it calls them badly"
            ));
        }
        tools
    }

    /// The tools among these specs the target covers, when either condition is met; none
    /// otherwise.
    fn to_defer(&self, registry: &ToolRegistry, tool_specs: &[ToolSpec], model: &dyn Model) -> HashSet<String> {
        let candidates: Vec<&ToolSpec> = tool_specs.iter().filter(|spec| self.targets(registry, spec)).collect();
        if !self.conditions_met(&candidates, tool_specs, model) {
            return HashSet::new();
        }
        candidates.into_iter().map(|spec| spec.name.clone()).collect()
    }

    /// Whether the target covers the agent's tool and the tool may be deferred.
    fn targets(&self, registry: &ToolRegistry, spec: &ToolSpec) -> bool {
        let tool = registry.get(&spec.name);
        if PROTECTED_TOOL_NAMES.contains(&spec.name.as_str())
            || has_sdk_tool_role(tool, SdkToolRole::ManageBackgroundTasks)
        {
            return false;
        }
        // The tool's own schema, since background tasks add a parameter to every schema in the call.
        let own = tool.map(|tool| tool.tool_spec());
        if !takes_parameters(own.as_ref().unwrap_or(spec)) {
            return false;
        }
        self.inner
            .matcher
            .as_ref()
            .is_none_or(|matcher| matcher.matches_tool(&spec.name))
    }

    /// Whether either condition is met, or there are none. `tool_count` counts every tool in the
    /// call but the structured output tool, the SDK's own and those kept in full included;
    /// `schema_tokens` measures what deferring saves.
    fn conditions_met(&self, candidates: &[&ToolSpec], tool_specs: &[ToolSpec], model: &dyn Model) -> bool {
        if self.unconditioned() {
            return true;
        }
        let tool_count = tool_specs
            .iter()
            .filter(|spec| spec.name != STRUCTURED_OUTPUT_TOOL_NAME)
            .count();
        if self.inner.tool_count.is_some_and(|threshold| tool_count >= threshold) {
            return true;
        }
        let Some(schema_tokens) = self.inner.schema_tokens else {
            return false;
        };
        let measured: u64 = candidates.iter().map(|spec| heuristic_json(&input_schema(spec))).sum();
        let window = model
            .model_info()
            .limits
            .context_window
            .filter(|window| *window > 0)
            .unwrap_or_else(default_context_window_limit);
        measured >= schema_tokens.of(window)
    }

    /// Whether the strategy has no conditions, so it defers at any tool count.
    fn unconditioned(&self) -> bool {
        self.inner.tool_count.is_none() && self.inner.schema_tokens.is_none()
    }

    /// Answers a call to a tool the latest model call deferred, made before the conversation
    /// loaded its schema, with the schema instead of running the tool: a stub takes any input, and
    /// once a summary removes a load the model can call a deferred tool from memory. Loads are read
    /// from the messages, so a load that was summarized away is delivered again. Before the agent's
    /// first model call, as when an interrupted call resumes on a restored agent, the guard uses
    /// the tools a model call would defer with the agent's tools and model, so an approved call to
    /// a tool that wouldn't be deferred runs.
    fn unloaded_answer(&self, context: &ExecuteToolContext) -> Option<ToolResultBlock> {
        let agent = &context.agent;
        let name = &context.tool_use.name;
        context.tool.as_ref()?;
        let deferred = self.recorded(agent.id()).unwrap_or_else(|| {
            let registry = agent.tool_registry();
            self.call_tools(registry, &registry.tool_specs(), agent.model())
                .deferred_tools
        });
        if !deferred.contains(name) || loaded_tools(agent.messages()).contains(name) {
            return None;
        }
        Some(ToolResultBlock::error(
            context.tool_use.tool_use_id.clone(),
            vec![
                ToolResultContent::Text(TextBlock::new(format!(
                    "Not run: {name} was called before its parameters were loaded. They are loaded now; call it again."
                ))),
                ToolReferenceBlock::new(name.clone()).into(),
            ],
        ))
    }
}

#[async_trait]
impl ContextStrategy for DeferStrategy {
    fn name(&self) -> &str {
        STRATEGY_NAME
    }

    fn init(&self, agent: &mut LocalAgent, _stash: Option<&Stash>) -> Result<()> {
        if self.unconditioned() {
            warn_once(&format!(
                "strategy=<{STRATEGY_NAME}>, target=<{}> | strategy has no conditions, so it defers every tool it targets at any tool count | use .when() to set toolCount or schemaTokens",
                self.inner.target.to_json()
            ));
        }
        let render = self.clone();
        agent.add_middleware(InvokeModelStage::input(move |mut context| {
            let tools = render.render(&context.agent, &context.tool_specs, &context.model);
            context.tool_specs = tools.tool_specs;
            context.deferred_tools = tools.deferred_tools;
            async move { Ok(context) }
        }));
        let guard = self.clone();
        agent.add_middleware(ExecuteToolStage::wrap(move |context, next| {
            match guard.unloaded_answer(&context) {
                Some(result) => StageStream::from_result(Ok(ExecuteToolResult::new(result))),
                None => next.call(context),
            }
        }));
        Ok(())
    }

    /// Messages are never changed; the tools list is rendered on each model call.
    async fn apply(&self, _context: &mut ContextState<'_>) -> Result<bool> {
        Ok(false)
    }

    fn as_defer_strategy(&self) -> Option<&DeferStrategy> {
        Some(self)
    }
}

fn parse_tool_count(raw: Option<&ConditionValue>) -> Result<Option<usize>> {
    match raw {
        None => Ok(None),
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a whole tool count above 0"
        )]
        Some(ConditionValue::Number(count)) if count.fract() == 0.0 && *count >= 1.0 => Ok(Some(*count as usize)),
        Some(other) => Err(Error::other(format!(
            "toolCount={other} is invalid: expected a whole tool count above 0"
        ))),
    }
}

fn input_schema(spec: &ToolSpec) -> JsonValue {
    spec.input_schema
        .clone()
        .unwrap_or_else(|| JsonValue::Object(serde_json::Map::new()))
}

/// The tools a tool result in these messages loaded with a tool reference.
fn loaded_tools(messages: &[Message]) -> HashSet<String> {
    messages
        .iter()
        .flat_map(|message| &message.content)
        .filter_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(&result.content),
            _ => None,
        })
        .flatten()
        .filter_map(|content| match content {
            ToolResultContent::ToolReference(reference) => Some(reference.name.clone()),
            _ => None,
        })
        .collect()
}

/// Whether a tool's input schema describes parameters, which its stub leaves out.
fn takes_parameters(spec: &ToolSpec) -> bool {
    let Some(JsonValue::Object(schema)) = &spec.input_schema else {
        return false;
    };
    let non_empty = |key: &str, empty: fn(&JsonValue) -> bool| schema.get(key).is_some_and(|value| !empty(value));
    non_empty("properties", |value| {
        value.as_object().is_some_and(serde_json::Map::is_empty)
    }) || non_empty("required", |value| value.as_array().is_some_and(Vec::is_empty))
        || schema.get("additionalProperties").is_some_and(JsonValue::is_object)
        || schema.keys().any(|keyword| {
            !ANNOTATION_KEYWORDS.contains(&keyword.as_str())
                && !["properties", "required", "additionalProperties"].contains(&keyword.as_str())
        })
}

/// Whether the model gets stubs only because nothing says otherwise: not the shared model info,
/// not its config.
fn takes_stubs_by_default(model: &dyn Model) -> bool {
    model.model_info().capabilities.deferred_tool_loading == Some(DeferredToolLoading::Stubs)
        && model
            .get_config()
            .model_info
            .is_none_or(|info| info.capabilities.deferred_tool_loading.is_none())
        && lookup_model(&model.model_id().unwrap_or_default()).is_none()
}

/// Whether the model defers tools, which only a model that sends every full spec doesn't.
fn defers_tools(model: &dyn Model) -> bool {
    model
        .model_info()
        .capabilities
        .deferred_tool_loading
        .unwrap_or(DeferredToolLoading::Unsupported)
        != DeferredToolLoading::Unsupported
}

#[cfg(test)]
#[path = "deferred_tool_loading/tests.rs"]
mod tests;
