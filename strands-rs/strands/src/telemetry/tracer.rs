//! Spans and local execution traces.
//!
//! Spans are `tracing` spans (`invoke_agent <name>` through the `otel.name` field,
//! `execute_agent_loop_cycle`, `chat`, `execute_tool <tool>`) with fields named after their
//! attributes, so `tracing-opentelemetry` exports the span names and attributes the other Strands
//! SDKs export. The [`AgentTrace`] tree is collected whether or not anything records the spans.

mod memory;
mod parts;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::Span;
use tracing::field::Empty;

pub(crate) use self::memory::{
    AgentSpanContext, EndMemoryAddSpanOptions, EndMemoryExtractSpanOptions, EndMemoryInjectSpanOptions,
    EndMemorySearchSpanOptions, StartMemoryAddSpanOptions, StartMemoryExtractSpanOptions, StartMemoryInjectSpanOptions,
    StartMemorySearchSpanOptions,
};
use self::parts::{
    event_name_for_message, message_text, otel_messages, otel_parts, stable_parts, system_prompt_otel_parts,
    system_prompt_stable, to_json,
};
use super::span::{Attributes, add_event, end_span, exports, record_attributes, start_span};
use super::types::AttributeValue;
use super::utils::{TracerSettings, now_ms};
use crate::models::streaming::{Metrics, Usage};
use crate::types::{JsonObject, Message, SystemPrompt, ToolResultBlock, ToolResultStatus, ToolUse};

const TARGET: &str = "strands::telemetry";
const OPERATION_DETAILS: &str = "gen_ai.client.inference.operation.details";

/// A node in the local timing tree of an invocation (`AgentTrace`).
///
/// Collected whether or not OpenTelemetry is configured. Serializes with `null` for an absent
/// parent, end time or message.
///
/// ```
/// use strands::telemetry::AgentTrace;
///
/// let mut cycle = AgentTrace::new("Cycle 1", 1_000);
/// cycle.add_child(AgentTrace::new("stream_messages", 1_001)).end(1_100);
/// cycle.end(1_200);
/// assert_eq!(cycle.children[0].parent_id.as_deref(), Some(cycle.id.as_str()));
/// assert_eq!(cycle.duration, 200);
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AgentTrace {
    /// Unique identifier (a UUID).
    pub id: String,
    /// Display name, such as `Cycle 1` or `Tool: calc`.
    pub name: String,
    /// The parent trace's id; `None` for a root trace.
    pub parent_id: Option<String>,
    /// Start time in milliseconds since the Unix epoch.
    pub start_time: u64,
    /// End time in milliseconds since the Unix epoch; `None` until the trace ends.
    pub end_time: Option<u64>,
    /// Duration in milliseconds.
    pub duration: u64,
    /// Nested traces.
    pub children: Vec<AgentTrace>,
    /// String metadata such as `cycleId`, `toolUseId` and `toolName`.
    pub metadata: JsonObject,
    /// The message associated with the trace, such as the model output.
    pub message: Option<Message>,
}

impl AgentTrace {
    /// Creates a root trace that starts at `start_time` (milliseconds since the epoch).
    pub fn new(name: impl Into<String>, start_time: u64) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            parent_id: None,
            start_time,
            end_time: None,
            duration: 0,
            children: Vec::new(),
            metadata: JsonObject::new(),
            message: None,
        }
    }

    /// Creates a root trace that starts now.
    pub fn start(name: impl Into<String>) -> Self {
        Self::new(name, now_ms())
    }

    /// Nests `child` under this trace and returns it.
    pub fn add_child(&mut self, mut child: AgentTrace) -> &mut AgentTrace {
        child.parent_id = Some(self.id.clone());
        let index = self.children.len();
        self.children.push(child);
        &mut self.children[index]
    }

    /// Ends the trace at `end_time` and records its duration (`end`).
    pub fn end(&mut self, end_time: u64) {
        self.end_time = Some(end_time);
        self.duration = end_time.saturating_sub(self.start_time);
    }

    /// Ends the trace now.
    pub fn end_now(&mut self) {
        self.end(now_ms());
    }
}

/// Where a model or tool trace sits in the tree: a child, by id, of a cycle of one invocation.
/// The id stays valid when a tool trace is inserted before it.
#[derive(Debug, Clone)]
struct TraceRef {
    generation: u64,
    cycle: usize,
    child: String,
}

/// The local traces of the current invocation and the spans that parent the next ones.
#[derive(Debug, Default)]
struct TraceState {
    /// Counts `invoke_agent` spans, so a trace handle from an earlier invocation finds nothing.
    generation: u64,
    traces: Vec<AgentTrace>,
    current_cycle: Option<usize>,
    agent_span: Option<Span>,
    loop_span: Option<Span>,
    /// The tool use ids of the current tool batch, in call order.
    tool_order: Vec<String>,
}

impl TraceState {
    fn cycle_child(&mut self, trace: Option<TraceRef>) -> Option<&mut AgentTrace> {
        let trace = trace.filter(|trace| trace.generation == self.generation)?;
        self.traces
            .get_mut(trace.cycle)?
            .children
            .iter_mut()
            .find(|child| child.id == trace.child)
    }

    /// The call index of a tool trace in the current batch.
    fn tool_rank(&self, trace: &AgentTrace) -> Option<usize> {
        let tool_use_id = trace.metadata.get("toolUseId")?.as_str()?;
        self.tool_order.iter().position(|id| id == tool_use_id)
    }
}

/// Creates the agent's spans and collects its local traces.
#[derive(Debug)]
pub(crate) struct Tracer {
    settings: TracerSettings,
    trace_attributes: Vec<(String, AttributeValue)>,
    baggage_attributes: BTreeMap<String, String>,
    state: Mutex<TraceState>,
}

impl Default for Tracer {
    fn default() -> Self {
        Self::new(BTreeMap::new(), BTreeMap::new())
    }
}

/// Options for [`Tracer::start_agent_span`] (`StartAgentSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartAgentSpanOptions<'a> {
    pub(crate) messages: &'a [Message],
    pub(crate) agent_name: &'a str,
    pub(crate) agent_id: Option<&'a str>,
    pub(crate) model_id: Option<&'a str>,
    pub(crate) tools: &'a [String],
    pub(crate) trace_attributes: &'a [(String, AttributeValue)],
    pub(crate) tools_config: Option<&'a JsonObject>,
    pub(crate) system_prompt: Option<&'a SystemPrompt>,
}

/// Options for [`AgentSpan::end`] (`EndAgentSpanOptions`).
#[derive(Debug, Default)]
pub(crate) struct EndAgentSpanOptions<'a> {
    pub(crate) response: Option<&'a Message>,
    pub(crate) error: Option<String>,
    pub(crate) accumulated_usage: Option<Usage>,
    pub(crate) stop_reason: Option<&'a str>,
}

/// Options for [`Tracer::start_model_invoke_span`] (`StartModelInvokeSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct StartModelInvokeSpanOptions<'a> {
    pub(crate) messages: &'a [Message],
    pub(crate) model_id: Option<&'a str>,
    pub(crate) system_prompt: Option<&'a SystemPrompt>,
}

/// Options for [`ModelSpan::end`] (`EndModelSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndModelSpanOptions<'a> {
    pub(crate) usage: Option<&'a Usage>,
    pub(crate) metrics: Option<&'a Metrics>,
    pub(crate) error: Option<&'a str>,
    pub(crate) output: Option<&'a Message>,
    pub(crate) stop_reason: Option<&'a str>,
}

/// Options for [`ToolSpan::end`] (`EndToolCallSpanOptions`).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct EndToolCallSpanOptions<'a> {
    pub(crate) tool_result: Option<&'a ToolResultBlock>,
    pub(crate) error: Option<&'a str>,
}

macro_rules! gen_ai_span {
    ($parent:expr, $name:literal $(, $field:literal)* $(,)?) => {
        match $parent {
            Some(parent) => tracing::info_span!(
                target: TARGET, parent: &parent, $name,
                "otel.name" = Empty, "otel.status_code" = Empty, "otel.status_description" = Empty,
                "gen_ai.event.start_time" = Empty, "gen_ai.event.end_time" = Empty,
                $($field = Empty),*
            ),
            None => tracing::info_span!(
                target: TARGET, $name,
                "otel.name" = Empty, "otel.status_code" = Empty, "otel.status_description" = Empty,
                "gen_ai.event.start_time" = Empty, "gen_ai.event.end_time" = Empty,
                $($field = Empty),*
            ),
        }
    };
}

macro_rules! usage_fields {
    ($parent:expr, $name:literal $(, $field:literal)* $(,)?) => {
        gen_ai_span!(
            $parent, $name,
            "gen_ai.usage.prompt_tokens", "gen_ai.usage.input_tokens", "gen_ai.usage.completion_tokens",
            "gen_ai.usage.output_tokens", "gen_ai.usage.total_tokens", "gen_ai.usage.cache_read.input_tokens",
            "gen_ai.usage.cache_read_input_tokens", "gen_ai.usage.cache_creation.input_tokens",
            "gen_ai.usage.cache_write_input_tokens"
            $(, $field)*
        )
    };
}

impl Tracer {
    /// A tracer with the conventions the environment selects (`OTEL_SEMCONV_STABILITY_OPT_IN`,
    /// the Langfuse endpoints and `OTEL_SERVICE_NAME`).
    pub(crate) fn new(
        trace_attributes: BTreeMap<String, AttributeValue>,
        baggage_attributes: BTreeMap<String, String>,
    ) -> Self {
        Self::with_settings(TracerSettings::from_env(), trace_attributes, baggage_attributes)
    }

    pub(crate) fn with_settings(
        settings: TracerSettings,
        trace_attributes: BTreeMap<String, AttributeValue>,
        baggage_attributes: BTreeMap<String, String>,
    ) -> Self {
        Self {
            settings,
            trace_attributes: trace_attributes.into_iter().collect(),
            baggage_attributes,
            state: Mutex::new(TraceState::default()),
        }
    }

    /// A tracer with the same settings and attributes and its own local traces, for work that
    /// runs detached from the invocation (background tool calls).
    pub(crate) fn detached(&self) -> Self {
        Self {
            settings: self.settings.clone(),
            trace_attributes: self.trace_attributes.clone(),
            baggage_attributes: self.baggage_attributes.clone(),
            state: Mutex::new(TraceState::default()),
        }
    }

    /// The attributes added to every span; subagent children inherit them.
    pub(crate) fn trace_attributes(&self) -> BTreeMap<String, AttributeValue> {
        self.trace_attributes.iter().cloned().collect()
    }

    /// The baggage entries every invocation runs under.
    pub(crate) fn baggage_attributes(&self) -> &BTreeMap<String, String> {
        &self.baggage_attributes
    }

    /// Whether agent spans record tool definitions (`gen_ai_tool_definitions`).
    pub(crate) fn includes_tool_definitions(&self) -> bool {
        self.settings.include_tool_definitions
    }

    /// The local traces of the latest invocation.
    pub(crate) fn local_traces(&self) -> Vec<AgentTrace> {
        self.lock().traces.clone()
    }

    fn lock(&self) -> MutexGuard<'_, TraceState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `gen_ai.operation.name` and the provider key of the convention in use.
    fn common_attributes(&self, operation_name: &str) -> Attributes {
        let mut attributes = Attributes::new();
        attributes.set("gen_ai.operation.name", operation_name);
        let provider_key = if self.settings.use_latest_conventions {
            "gen_ai.provider.name"
        } else {
            "gen_ai.system"
        };
        attributes.set(provider_key, self.settings.service_name.as_str());
        attributes
    }

    /// Starts the `invoke_agent <name>` span, parented to the current span, and resets the local
    /// traces.
    pub(crate) fn start_agent_span(self: &Arc<Self>, options: StartAgentSpanOptions<'_>) -> AgentSpan {
        {
            let mut state = self.lock();
            state.generation = state.generation.wrapping_add(1);
            state.traces.clear();
            state.current_cycle = None;
        }
        let span = usage_fields!(
            None::<Span>,
            "invoke_agent",
            "gen_ai.operation.name",
            "gen_ai.system",
            "gen_ai.provider.name",
            "gen_ai.agent.name",
            "name",
            "gen_ai.agent.id",
            "gen_ai.request.model",
            "langfuse.observation.type",
        );
        if !span.is_disabled() {
            let span_name = format!("invoke_agent {}", options.agent_name);
            span.record("otel.name", span_name.as_str());
            let mut attributes = self.common_attributes("invoke_agent");
            attributes.set("gen_ai.agent.name", options.agent_name);
            attributes.set("name", span_name);
            if let Some(agent_id) = options.agent_id.filter(|id| !id.is_empty()) {
                attributes.set("gen_ai.agent.id", agent_id);
            }
            if let Some(model_id) = options.model_id.filter(|id| !id.is_empty()) {
                attributes.set("gen_ai.request.model", model_id);
            }
            if exports(&span) {
                self.agent_content_attributes(&mut attributes, &options);
            }
            attributes.extend(&self.trace_attributes);
            attributes.extend(options.trace_attributes);
            start_span(&span, attributes);
            self.add_event_messages(&span, options.messages);
        }
        self.lock().agent_span = Some(span.clone());
        AgentSpan {
            tracer: self.clone(),
            span: Some(span),
            meter: None,
        }
    }

    /// The tool names, tool definitions and system prompt of an agent span.
    fn agent_content_attributes(&self, attributes: &mut Attributes, options: &StartAgentSpanOptions<'_>) {
        if !options.tools.is_empty() {
            attributes.set("gen_ai.agent.tools", to_json(options.tools));
        }
        if self.settings.include_tool_definitions
            && let Some(tools_config) = options.tools_config
        {
            attributes.set("gen_ai.tool.definitions", to_json(tools_config));
        }
        if let Some(system_prompt) = options.system_prompt {
            attributes.set("system_prompt", to_json(system_prompt));
        }
    }

    /// Starts an `execute_agent_loop_cycle` span under the agent span and opens the cycle's
    /// local trace.
    pub(crate) fn start_agent_loop_span(self: &Arc<Self>, cycle_id: &str, messages: &[Message]) -> LoopSpan {
        let (parent, generation, cycle) = {
            let mut state = self.lock();
            let mut trace = AgentTrace::start(format!("Cycle {}", state.traces.len() + 1));
            trace.metadata.insert("cycleId".to_owned(), json!(cycle_id));
            state.traces.push(trace);
            let cycle = state.traces.len() - 1;
            state.current_cycle = Some(cycle);
            state.tool_order.clear();
            (state.agent_span.clone(), state.generation, cycle)
        };
        let span = gen_ai_span!(parent, "execute_agent_loop_cycle", "agent_loop.cycle_id");
        if !span.is_disabled() {
            let mut attributes = Attributes::new();
            attributes.set("agent_loop.cycle_id", cycle_id);
            attributes.extend(&self.trace_attributes);
            start_span(&span, attributes);
            self.add_event_messages(&span, messages);
        }
        self.lock().loop_span = Some(span.clone());
        LoopSpan {
            tracer: self.clone(),
            span: Some(span),
            generation,
            cycle,
        }
    }

    /// Starts a `chat` span under the cycle span and a `stream_messages` trace under the cycle.
    pub(crate) fn start_model_invoke_span(self: &Arc<Self>, options: StartModelInvokeSpanOptions<'_>) -> ModelSpan {
        let (parent, trace) = self.child_trace(AgentTrace::start("stream_messages"));
        let span = usage_fields!(
            parent,
            "chat",
            "gen_ai.operation.name",
            "gen_ai.system",
            "gen_ai.provider.name",
            "gen_ai.request.model",
            "gen_ai.server.request.duration",
        );
        if !span.is_disabled() {
            let mut attributes = self.common_attributes("chat");
            if let Some(model_id) = options.model_id.filter(|id| !id.is_empty()) {
                attributes.set("gen_ai.request.model", model_id);
            }
            attributes.extend(&self.trace_attributes);
            start_span(&span, attributes);
            self.add_system_prompt_event(&span, options.system_prompt);
            self.add_event_messages(&span, options.messages);
        }
        ModelSpan {
            tracer: self.clone(),
            span: Some(span),
            trace,
        }
    }

    /// Starts an `execute_tool <tool>` span under the cycle span and a `Tool: <tool>` trace under
    /// the cycle.
    pub(crate) fn start_tool_call_span(self: &Arc<Self>, tool: &ToolUse) -> ToolSpan {
        let mut trace = AgentTrace::start(format!("Tool: {}", tool.name));
        trace.metadata.insert("toolUseId".to_owned(), json!(tool.tool_use_id));
        trace.metadata.insert("toolName".to_owned(), json!(tool.name));
        let (parent, trace) = self.child_trace(trace);
        let span = gen_ai_span!(
            parent,
            "execute_tool",
            "gen_ai.operation.name",
            "gen_ai.system",
            "gen_ai.provider.name",
            "gen_ai.tool.name",
            "gen_ai.tool.call.id",
            "gen_ai.tool.status",
        );
        if !span.is_disabled() {
            span.record("otel.name", format!("execute_tool {}", tool.name).as_str());
            let mut attributes = self.common_attributes("execute_tool");
            attributes.set("gen_ai.tool.name", tool.name.as_str());
            attributes.set("gen_ai.tool.call.id", tool.tool_use_id.as_str());
            attributes.extend(&self.trace_attributes);
            start_span(&span, attributes);
            self.add_tool_input(&span, tool);
        }
        ToolSpan {
            tracer: self.clone(),
            span: Some(span),
            trace,
        }
    }

    /// Records the call order of a tool batch, so the batch's tool traces sit in that order
    /// however their calls interleave.
    pub(crate) fn order_tool_calls<'a>(&self, tool_use_ids: impl IntoIterator<Item = &'a str>) {
        self.lock().tool_order = tool_use_ids.into_iter().map(str::to_owned).collect();
    }

    /// Nests a trace under the current cycle (an orphan without one), a tool trace
    /// before the traces of later calls of its batch, and returns the cycle span to parent the
    /// matching span.
    fn child_trace(&self, mut trace: AgentTrace) -> (Option<Span>, Option<TraceRef>) {
        let mut state = self.lock();
        let parent = state.loop_span.clone();
        let generation = state.generation;
        let Some(cycle) = state.current_cycle else {
            return (parent, None);
        };
        let position = state.tool_rank(&trace).and_then(|rank| {
            state
                .traces
                .get(cycle)?
                .children
                .iter()
                .position(|child| state.tool_rank(child).is_some_and(|other| other > rank))
        });
        let Some(cycle_trace) = state.traces.get_mut(cycle) else {
            return (parent, None);
        };
        trace.parent_id = Some(cycle_trace.id.clone());
        let child = trace.id.clone();
        match position {
            Some(index) => cycle_trace.children.insert(index, trace),
            None => cycle_trace.children.push(trace),
        }
        (
            parent,
            Some(TraceRef {
                generation,
                cycle,
                child,
            }),
        )
    }

    fn add_tool_input(&self, span: &Span, tool: &ToolUse) {
        if !exports(span) {
            return;
        }
        if !self.settings.use_latest_conventions {
            add_event(
                span,
                "gen_ai.tool.message",
                vec![
                    ("role", "tool".to_owned()),
                    ("content", to_json(&tool.input)),
                    ("id", tool.tool_use_id.clone()),
                ],
                false,
            );
            return;
        }
        let mut arguments = Attributes::new();
        arguments.set("gen_ai.tool.call.arguments", to_json(&tool.input));
        record_attributes(span, arguments);
        let input = json!([{
            "role": "tool",
            "parts": [{"type": "tool_call", "name": tool.name, "id": tool.tool_use_id, "arguments": tool.input}],
        }]);
        add_event(
            span,
            OPERATION_DETAILS,
            vec![("gen_ai.input.messages", to_json(&input))],
            self.settings.span_attributes_only,
        );
    }

    /// Records messages: one operation details event in the latest conventions, one event per
    /// message otherwise.
    fn add_event_messages(&self, span: &Span, messages: &[Message]) {
        if !exports(span) {
            return;
        }
        if self.settings.use_latest_conventions {
            add_event(
                span,
                OPERATION_DETAILS,
                vec![("gen_ai.input.messages", to_json(&otel_messages(messages)))],
                self.settings.span_attributes_only,
            );
            return;
        }
        for message in messages {
            add_event(
                span,
                event_name_for_message(message),
                vec![("content", to_json(&message.content))],
                false,
            );
        }
    }

    /// `gen_ai.system.message`, or `gen_ai.system_instructions` in the latest conventions.
    fn add_system_prompt_event(&self, span: &Span, system_prompt: Option<&SystemPrompt>) {
        let Some(system_prompt) = system_prompt.filter(|_| exports(span)) else {
            return;
        };
        if !self.settings.use_latest_conventions {
            add_event(
                span,
                "gen_ai.system.message",
                vec![("content", system_prompt_stable(system_prompt))],
                false,
            );
            return;
        }
        add_event(
            span,
            OPERATION_DETAILS,
            vec![(
                "gen_ai.system_instructions",
                to_json(&system_prompt_otel_parts(system_prompt)),
            )],
            self.settings.span_attributes_only,
        );
    }

    /// Prompt, completion and cache token counts, legacy names included.
    fn usage_attributes(&self, attributes: &mut Attributes, usage: &Usage) {
        let prompt_tokens = usage.total_prompt_tokens();
        attributes.set("gen_ai.usage.prompt_tokens", prompt_tokens);
        attributes.set("gen_ai.usage.input_tokens", prompt_tokens);
        attributes.set("gen_ai.usage.completion_tokens", usage.output_tokens);
        attributes.set("gen_ai.usage.output_tokens", usage.output_tokens);
        attributes.set("gen_ai.usage.total_tokens", usage.total_tokens);
        let legacy = !self.settings.use_latest_conventions;
        if let Some(tokens) = usage.cache_read_input_tokens.filter(|tokens| *tokens > 0) {
            attributes.set("gen_ai.usage.cache_read.input_tokens", tokens);
            if legacy {
                attributes.set("gen_ai.usage.cache_read_input_tokens", tokens);
            }
        }
        if let Some(tokens) = usage.cache_write_input_tokens.filter(|tokens| *tokens > 0) {
            attributes.set("gen_ai.usage.cache_creation.input_tokens", tokens);
            if legacy {
                attributes.set("gen_ai.usage.cache_write_input_tokens", tokens);
            }
        }
    }

    fn end_agent_span(&self, span: &Span, options: &EndAgentSpanOptions<'_>) {
        {
            let mut state = self.lock();
            state.agent_span = None;
            state.loop_span = None;
            state.current_cycle = None;
        }
        if span.is_disabled() {
            return;
        }
        let mut attributes = Attributes::new();
        if let Some(usage) = &options.accumulated_usage {
            self.usage_attributes(&mut attributes, usage);
        }
        if self.settings.is_langfuse {
            attributes.set("langfuse.observation.type", "span");
        }
        if let Some(response) = options.response {
            self.add_response_event(span, response, options.stop_reason);
        }
        end_span(span, attributes, options.error.as_deref());
    }

    /// The agent's final answer.
    fn add_response_event(&self, span: &Span, response: &Message, stop_reason: Option<&str>) {
        if !exports(span) {
            return;
        }
        let finish_reason = stop_reason.filter(|reason| !reason.is_empty()).unwrap_or("end_turn");
        let text = message_text(response);
        if !self.settings.use_latest_conventions {
            add_event(
                span,
                "gen_ai.choice",
                vec![("message", text), ("finish_reason", finish_reason.to_owned())],
                false,
            );
            return;
        }
        let output = json!([{"role": "assistant", "parts": [{"type": "text", "content": text}], "finish_reason": finish_reason}]);
        add_event(
            span,
            OPERATION_DETAILS,
            vec![("gen_ai.output.messages", to_json(&output))],
            self.settings.span_attributes_only,
        );
    }

    fn end_loop_span(&self, span: &Span, generation: u64, cycle: usize, error: Option<&str>) {
        {
            let mut state = self.lock();
            if state.generation == generation {
                if let Some(trace) = state.traces.get_mut(cycle) {
                    trace.end_now();
                }
                if state.current_cycle == Some(cycle) {
                    state.current_cycle = None;
                }
            }
            if state.loop_span.as_ref().map(Span::id) == Some(span.id()) {
                state.loop_span = None;
            }
        }
        if span.is_disabled() {
            return;
        }
        end_span(span, Attributes::new(), error);
    }

    fn end_model_span(&self, span: &Span, trace: Option<TraceRef>, options: EndModelSpanOptions<'_>) {
        if let Some(model_trace) = self.lock().cycle_child(trace) {
            if let Some(output) = options.output {
                model_trace.message = Some(output.clone());
            }
            model_trace.end_now();
        }
        if span.is_disabled() {
            return;
        }
        if let Some(output) = options.output {
            self.add_output_event(span, output, options.stop_reason);
        }
        let mut attributes = Attributes::new();
        if let Some(usage) = options.usage {
            self.usage_attributes(&mut attributes, usage);
            if let Some(metrics) = options.metrics.filter(|metrics| metrics.latency_ms > 0) {
                attributes.set("gen_ai.server.request.duration", metrics.latency_ms);
            }
        }
        end_span(span, attributes, options.error);
    }

    /// The model's output message.
    fn add_output_event(&self, span: &Span, message: &Message, stop_reason: Option<&str>) {
        if !exports(span) {
            return;
        }
        let finish_reason = stop_reason.filter(|reason| !reason.is_empty()).unwrap_or("unknown");
        if !self.settings.use_latest_conventions {
            add_event(
                span,
                "gen_ai.choice",
                vec![
                    ("finish_reason", finish_reason.to_owned()),
                    ("message", to_json(&stable_parts(&message.content))),
                ],
                false,
            );
            return;
        }
        let output = json!([{
            "role": message.role,
            "parts": otel_parts(&message.content),
            "finish_reason": finish_reason,
        }]);
        add_event(
            span,
            OPERATION_DETAILS,
            vec![("gen_ai.output.messages", to_json(&output))],
            self.settings.span_attributes_only,
        );
    }

    fn end_tool_span(&self, span: &Span, trace: Option<TraceRef>, options: EndToolCallSpanOptions<'_>) {
        if let Some(tool_trace) = self.lock().cycle_child(trace) {
            tool_trace.end_now();
        }
        if span.is_disabled() {
            return;
        }
        let mut attributes = Attributes::new();
        if let Some(result) = options.tool_result {
            self.tool_result_attributes(span, &mut attributes, result);
        }
        end_span(span, attributes, options.error);
    }

    fn tool_result_attributes(&self, span: &Span, attributes: &mut Attributes, result: &ToolResultBlock) {
        let status = match result.status {
            ToolResultStatus::Success => "success",
            ToolResultStatus::Error => "error",
        };
        attributes.set("gen_ai.tool.status", status);
        if !exports(span) {
            return;
        }
        if !self.settings.use_latest_conventions {
            add_event(
                span,
                "gen_ai.choice",
                vec![
                    ("message", to_json(&result.content)),
                    ("id", result.tool_use_id.clone()),
                ],
                false,
            );
            return;
        }
        if result.status != ToolResultStatus::Error {
            attributes.set("gen_ai.tool.call.result", to_json(&result.content));
        }
        let output = json!([{
            "role": "tool",
            "parts": [{"type": "tool_call_response", "id": result.tool_use_id, "response": result.content}],
        }]);
        add_event(
            span,
            OPERATION_DETAILS,
            vec![("gen_ai.output.messages", to_json(&output))],
            self.settings.span_attributes_only,
        );
    }
}

/// An open `invoke_agent` span; dropping it, as a consumer that stops early does, ends it with the
/// accumulated usage only.
pub(crate) struct AgentSpan {
    tracer: Arc<Tracer>,
    span: Option<Span>,
    meter: Option<Arc<Mutex<super::Meter>>>,
}

impl AgentSpan {
    /// Reads the accumulated usage from `meter` when the span ends without one.
    pub(crate) fn with_meter(mut self, meter: Arc<Mutex<super::Meter>>) -> Self {
        self.meter = Some(meter);
        self
    }

    /// Ends the span.
    pub(crate) fn end(mut self, options: EndAgentSpanOptions<'_>) {
        self.finish(options);
    }

    fn finish(&mut self, mut options: EndAgentSpanOptions<'_>) {
        let Some(span) = self.span.take() else {
            return;
        };
        if options.accumulated_usage.is_none()
            && let Some(meter) = &self.meter
        {
            let usage = meter
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .metrics()
                .accumulated_usage;
            options.accumulated_usage = Some(usage);
        }
        self.tracer.end_agent_span(&span, &options);
    }
}

impl Drop for AgentSpan {
    fn drop(&mut self) {
        self.finish(EndAgentSpanOptions::default());
    }
}

/// An open `execute_agent_loop_cycle` span; dropping it ends it.
pub(crate) struct LoopSpan {
    tracer: Arc<Tracer>,
    span: Option<Span>,
    generation: u64,
    cycle: usize,
}

impl LoopSpan {
    /// Ends the span, with an error when the cycle failed.
    pub(crate) fn end(mut self, error: Option<&str>) {
        self.finish(error);
    }

    fn finish(&mut self, error: Option<&str>) {
        let Some(span) = self.span.take() else {
            return;
        };
        self.tracer.end_loop_span(&span, self.generation, self.cycle, error);
    }
}

impl Drop for LoopSpan {
    fn drop(&mut self) {
        self.finish(None);
    }
}

/// An open `chat` span; dropping it ends it without output (a consumer that stopped early).
pub(crate) struct ModelSpan {
    tracer: Arc<Tracer>,
    span: Option<Span>,
    trace: Option<TraceRef>,
}

impl ModelSpan {
    /// Ends the span.
    pub(crate) fn end(mut self, options: EndModelSpanOptions<'_>) {
        self.finish(options);
    }

    fn finish(&mut self, options: EndModelSpanOptions<'_>) {
        let Some(span) = self.span.take() else {
            return;
        };
        self.tracer.end_model_span(&span, self.trace.take(), options);
    }
}

impl Drop for ModelSpan {
    fn drop(&mut self) {
        self.finish(EndModelSpanOptions::default());
    }
}

/// An open `execute_tool` span; dropping it ends it without a result.
pub(crate) struct ToolSpan {
    tracer: Arc<Tracer>,
    span: Option<Span>,
    trace: Option<TraceRef>,
}

impl ToolSpan {
    /// The span the tool runs in.
    pub(crate) fn span(&self) -> Span {
        self.span.clone().unwrap_or_else(Span::none)
    }

    /// Ends the span with the raw tool outcome.
    pub(crate) fn end(mut self, options: EndToolCallSpanOptions<'_>) {
        self.finish(options);
    }

    fn finish(&mut self, options: EndToolCallSpanOptions<'_>) {
        let Some(span) = self.span.take() else {
            return;
        };
        self.tracer.end_tool_span(&span, self.trace.take(), options);
    }
}

impl Drop for ToolSpan {
    fn drop(&mut self) {
        self.finish(EndToolCallSpanOptions::default());
    }
}

#[cfg(test)]
mod tests;
