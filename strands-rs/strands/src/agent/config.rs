//! Agent configuration (`AgentConfig`) and per-invocation options (`InvokeOptions`).

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use schemars::JsonSchema as SchemarsJsonSchema;

use super::invocation_context::{InvocationContext, InvokeLimits};
use super::invocation_state::InvocationState;
use crate::background_tasks::BackgroundTasksConfig;
use crate::cancel::CancelSignal;
use crate::conversation_manager::ConversationManager;
use crate::experimental::context_manager::ContextManagerStrategy;
use crate::interventions::InterventionHandler;
use crate::memory::MemoryManagerSource;
use crate::models::Model;
use crate::models::routing::ModelRouter;
use crate::plugins::Plugin;
use crate::retry::RetryStrategy;
use crate::sandbox::Sandbox;
use crate::session::SessionManager;
use crate::storage::Storage;
use crate::telemetry::AttributeValue;
use crate::tools::{ToolExecutorStrategy, ToolSource, schema_for};
use crate::types::{JsonObject, JsonSchema, Message, SystemPrompt, Toggle};

/// The model an agent calls: a model instance, a router or a Bedrock model id.
#[derive(Clone)]
#[non_exhaustive]
pub enum ModelSource {
    /// A model instance.
    Model(Arc<dyn Model>),
    /// A [`ModelRouter`]; the agent's model is its default model. Not accepted as `aux_model`.
    Router(ModelRouter),
    /// A Bedrock model id; needs the `bedrock` feature.
    Id(String),
}

impl From<Arc<dyn Model>> for ModelSource {
    fn from(model: Arc<dyn Model>) -> Self {
        Self::Model(model)
    }
}

impl<M: Model> From<M> for ModelSource {
    fn from(model: M) -> Self {
        Self::Model(Arc::new(model))
    }
}

impl<M: Model> From<Arc<M>> for ModelSource {
    fn from(model: Arc<M>) -> Self {
        Self::Model(model)
    }
}

impl From<ModelRouter> for ModelSource {
    fn from(router: ModelRouter) -> Self {
        Self::Router(router)
    }
}

impl From<&str> for ModelSource {
    fn from(model_id: &str) -> Self {
        Self::Id(model_id.to_owned())
    }
}

impl From<String> for ModelSource {
    fn from(model_id: String) -> Self {
        Self::Id(model_id)
    }
}

impl fmt::Debug for ModelSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Model(model) => f.debug_tuple("Model").field(&model.model_id()).finish(),
            Self::Router(router) => f.debug_tuple("Router").field(router).finish(),
            Self::Id(model_id) => f.debug_tuple("Id").field(model_id).finish(),
        }
    }
}

/// Configuration for an [`Agent`](crate::Agent) (`AgentConfig`).
///
/// Build an agent from it with [`Agent::new`](crate::Agent::new), or set the same keys on
/// [`Agent::builder`](crate::Agent::builder).
///
/// ```
/// use strands::{Agent, AgentConfig};
/// use strands::testing::MockModel;
///
/// let agent = Agent::new(AgentConfig {
///     model: Some(MockModel::new().with_turn("Hi").into()),
///     system_prompt: Some("You are a concise assistant.".into()),
///     printer: Some(false),
///     ..Default::default()
/// })?;
/// assert_eq!(agent.name(), "Strands Agent");
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Default, bon::Builder)]
#[builder(
    builder_type(name = AgentBuilder, vis = "pub", doc {
        /// Builds an [`Agent`](crate::Agent); the setters are the [`AgentConfig`] keys.
    }),
    start_fn(name = builder, vis = "pub(crate)"),
    finish_fn(name = into_config, vis = "pub(crate)")
)]
pub struct AgentConfig {
    /// Initial tools; nested lists are flattened and agents become tools (`ToolList`). Set them
    /// with the builder's `tools(..)`, which takes any iterator of [`ToolSource`] items.
    #[builder(field)]
    pub tools: Vec<ToolSource>,
    /// Plugins to initialize with the agent. Set them with the builder's `plugins(..)`, which
    /// takes plugins by value or as `Arc`s.
    #[builder(field)]
    pub plugins: Vec<Arc<dyn Plugin>>,
    /// Intervention handlers, evaluated in registration order at each lifecycle point
    /// (`interventions`); names must be unique. Set them with the builder's `interventions(..)`,
    /// which takes handlers of one type by value or as `Arc`s, or one at a time with
    /// `intervention(..)`.
    #[builder(field)]
    pub interventions: Vec<Arc<dyn InterventionHandler>>,
    /// The model the agent calls: a model instance, a [`ModelRouter`] or a Bedrock model id.
    /// Defaults to Bedrock, resolved when the agent first calls it. With a router, the agent's
    /// model is the router's default model.
    #[builder(into)]
    pub model: Option<ModelSource>,
    /// The model for auxiliary side calls (conversation-manager summaries, memory extraction,
    /// classification); defaults to `model`. The context manager's summarize strategy does not
    /// use it: it resolves its own model, then `model`. A router is rejected: side calls run outside the loop it
    /// attaches to.
    #[builder(into)]
    pub aux_model: Option<ModelSource>,
    /// Initial conversation history.
    #[builder(default)]
    pub messages: Vec<Message>,
    /// The system prompt.
    #[builder(into)]
    pub system_prompt: Option<SystemPrompt>,
    /// Initial app state.
    pub app_state: Option<JsonObject>,
    /// Initial model-provider state, such as a restored response id.
    pub model_state: Option<JsonObject>,
    /// Print text, reasoning and tool activity to stdout as it streams. Defaults to `true`; turn
    /// it off in services with `printer(false)`.
    pub printer: Option<bool>,
    /// Retry strategies for failed model calls. `None` installs the default
    /// [`DefaultModelRetryStrategy`](crate::DefaultModelRetryStrategy); an empty list disables
    /// retries.
    pub retry_strategy: Option<Vec<RetryStrategy>>,
    /// JSON schema the agent's final answer must satisfy. The builder
    /// sets it from a type with `structured_output_schema::<T>()`, or from JSON with
    /// `structured_output_schema_json(..)`.
    #[builder(setters(name = structured_output_schema_json))]
    pub structured_output_schema: Option<JsonSchema>,
    /// The agent's name. Defaults to `Strands Agent`.
    #[builder(into)]
    pub name: Option<String>,
    /// What the agent does.
    #[builder(into)]
    pub description: Option<String>,
    /// The agent's id. Defaults to `agent`.
    #[builder(into)]
    pub id: Option<String>,
    /// Send tool specs to the model sorted by name on every request (model calls, context
    /// summaries, token counts), to keep prompt-cache prefixes stable when the same tools are
    /// registered in a different order, for example from MCP servers (`sortTools`). Sorting
    /// happens before middleware, which can still reorder them. Defaults to `false`, which keeps
    /// registration order.
    pub sort_tools: Option<bool>,
    /// How the tool calls of one model turn run. Defaults to concurrent.
    #[builder(into)]
    pub tool_executor: Option<ToolExecutorStrategy>,
    /// Keeps the history within the context window. Defaults to a
    /// [`SlidingWindowConversationManager`](crate::conversation_manager::SlidingWindowConversationManager)
    /// of 40 messages; a stateful model uses
    /// [`NullConversationManager`](crate::conversation_manager::NullConversationManager) and
    /// rejects one. The builder's `conversation_manager(..)` takes a manager by value or as an
    /// `Arc`.
    #[builder(with = |manager: impl ConversationManager| Arc::new(manager) as Arc<dyn ConversationManager>)]
    pub conversation_manager: Option<Arc<dyn ConversationManager>>,
    /// Strategy-driven context management (experimental): a preset, a
    /// configuration, an instance, or `Disabled`. When set (except `Disabled`) it owns overflow
    /// recovery and compression, and a co-provided `conversation_manager` is ignored.
    #[builder(into)]
    pub context_manager: Option<ContextManagerStrategy>,
    /// Background tool execution:
    /// `true`, a [`BackgroundTasksConfig`], or `false`. Unset is off.
    #[builder(into)]
    pub background_tasks: Option<Toggle<BackgroundTasksConfig>>,
    /// Attributes added to every span of the agent, replacing a standard
    /// attribute of the same name. Keys other than the standard ones need the `otel` feature.
    /// The builder takes any iterator of key and value pairs.
    #[builder(with = |attributes: impl IntoIterator<Item = (impl Into<String>, impl Into<AttributeValue>)>| {
        attributes.into_iter().map(|(key, value)| (key.into(), value.into())).collect()
    })]
    pub trace_attributes: Option<BTreeMap<String, AttributeValue>>,
    /// OpenTelemetry baggage entries attached to the context for every invocation,
    /// propagated to downstream services in the W3C `baggage` header;
    /// needs the `otel` feature. The builder takes any iterator of key and value pairs.
    #[builder(with = |entries: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>| {
        entries.into_iter().map(|(key, value)| (key.into(), value.into())).collect()
    })]
    pub baggage_attributes: Option<BTreeMap<String, String>>,
    /// Where sandbox-aware tools run commands and code and read and write files (`sandbox`).
    /// `None` uses the shared
    /// [`NotASandboxLocalEnvironment`](crate::sandbox::NotASandboxLocalEnvironment), the host
    /// with no isolation. A configured sandbox's [`get_tools`](Sandbox::get_tools) are
    /// registered at initialization, except those whose name is already registered. The
    /// builder's `sandbox(..)` takes a sandbox by value or as an `Arc`.
    #[builder(with = |sandbox: impl crate::sandbox::IntoSandbox| sandbox.into_sandbox())]
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// Default storage backend for agent subsystems (`storage`). Subsystems without their own
    /// storage (the session manager, the context manager's stash) resolve from it, each under
    /// its own namespace; a subsystem's own storage always wins. The builder's `storage(..)`
    /// takes a storage by value or as an `Arc`.
    #[builder(with = |storage: impl crate::storage::IntoStorage| storage.into_storage())]
    pub storage: Option<Arc<dyn Storage>>,
    /// Saves and restores the agent's session. With one attached, the agent's
    /// session id is the manager's and the model receives it in its
    /// [`AgentMetadata`](crate::types::AgentMetadata).
    pub session_manager: Option<SessionManager>,
    /// Cross-session memory: a [`MemoryManager`](crate::memory::MemoryManager)
    /// or a [`MemoryManagerConfig`](crate::memory::MemoryManagerConfig) the agent builds one from.
    #[builder(into)]
    pub memory_manager: Option<MemoryManagerSource>,
}

impl<S: agent_builder::State> AgentBuilder<S> {
    /// Adds tools: any iterator of tools, agents, `Arc<dyn Tool>`s or nested lists
    /// (`tools`). Mixed types go through [`tool_list!`](crate::tool_list).
    pub fn tools(mut self, tools: impl IntoIterator<Item = impl Into<ToolSource>>) -> Self {
        self.tools.extend(tools.into_iter().map(Into::into));
        self
    }

    /// Adds plugins, by value or as `Arc`s (`plugins`).
    pub fn plugins(mut self, plugins: impl IntoIterator<Item = impl Plugin>) -> Self {
        self.plugins
            .extend(plugins.into_iter().map(|plugin| Arc::new(plugin) as Arc<dyn Plugin>));
        self
    }

    /// Adds intervention handlers of one type, by value or as `Arc`s (`interventions`). Add
    /// handlers of different types with [`intervention`](Self::intervention), one at a time, or
    /// as a list of `Arc<dyn InterventionHandler>`:
    ///
    /// ```
    /// use std::sync::Arc;
    ///
    /// use strands::Agent;
    /// use strands::interventions::InterventionHandler;
    /// use strands::testing::MockModel;
    /// use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopConfig};
    ///
    /// struct Audit;
    ///
    /// #[strands::async_trait]
    /// impl InterventionHandler for Audit {
    ///     fn name(&self) -> &str {
    ///         "audit"
    ///     }
    /// }
    ///
    /// let one_by_one = Agent::builder()
    ///     .model(MockModel::new())
    ///     .intervention(HumanInTheLoop::default())
    ///     .intervention(Audit)
    ///     .printer(false)
    ///     .build()?;
    /// let shared: [Arc<dyn InterventionHandler>; 2] = [Arc::new(HumanInTheLoop::default()), Arc::new(Audit)];
    /// let listed = Agent::builder().model(MockModel::new()).interventions(shared).printer(false).build()?;
    /// # let _ = (one_by_one, listed);
    /// # Ok::<(), strands::Error>(())
    /// ```
    pub fn interventions(mut self, handlers: impl IntoIterator<Item = impl InterventionHandler>) -> Self {
        self.interventions.extend(
            handlers
                .into_iter()
                .map(|handler| Arc::new(handler) as Arc<dyn InterventionHandler>),
        );
        self
    }

    /// Adds one intervention handler, by value or as an `Arc` (an `Arc<dyn InterventionHandler>`
    /// included), after the ones already added.
    pub fn intervention(mut self, handler: impl InterventionHandler) -> Self {
        self.interventions.push(Arc::new(handler));
        self
    }

    /// Sets the structured output schema from a type's `schemars` schema;
    /// needs `schemars = "1"` in your dependencies.
    pub fn structured_output_schema<T: SchemarsJsonSchema>(
        self,
    ) -> AgentBuilder<agent_builder::SetStructuredOutputSchema<S>>
    where
        S::StructuredOutputSchema: agent_builder::IsUnset,
    {
        self.structured_output_schema_json(schema_for::<T>())
    }
}

impl<S: agent_builder::IsComplete> AgentBuilder<S> {
    /// Builds the agent.
    ///
    /// # Errors
    ///
    /// The same errors as [`Agent::new`](crate::Agent::new).
    pub fn build(self) -> crate::Result<crate::Agent> {
        crate::Agent::new(self.into_config())
    }
}

impl fmt::Debug for AgentConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentConfig")
            .field("model", &self.model)
            .field("name", &self.name)
            .field("id", &self.id)
            .field("tools", &self.tools)
            .finish_non_exhaustive()
    }
}

/// Options for one invocation (`InvokeOptions`).
///
/// ```
/// use strands::{InvokeOptions, InvokeLimits};
///
/// #[derive(serde::Deserialize, schemars::JsonSchema)]
/// struct Summary { title: String }
///
/// let options = InvokeOptions {
///     limits: Some(InvokeLimits { turns: Some(5), ..Default::default() }),
///     ..Default::default()
/// }
/// .structured_output_schema::<Summary>();
/// assert!(options.structured_output_schema.is_some());
/// ```
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct InvokeOptions {
    /// JSON schema for this invocation's structured output, overriding the agent's.
    /// The builder sets it from a type with
    /// `structured_output_schema::<T>()`, or from JSON with `structured_output_schema_json(..)`.
    #[builder(setters(name = structured_output_schema_json))]
    pub structured_output_schema: Option<JsonSchema>,
    /// Per-invocation state passed to hooks and tools and returned on the result.
    pub invocation_state: Option<InvocationState>,
    /// A signal from outside the agent that cancels the invocation, merged with the agent's own.
    /// Its message and `after_current_tools` count like the agent's.
    pub cancel_signal: Option<CancelSignal>,
    /// Runs this call inside the request a hook event's or tool context's handle belongs to,
    /// sharing its limits and usage.
    pub invocation_context: Option<InvocationContext>,
    /// Limits for the request this call starts (`limits`).
    pub limits: Option<InvokeLimits>,
}

impl InvokeOptions {
    /// Sets the structured output schema from a type's `schemars` schema.
    #[must_use]
    pub fn structured_output_schema<T: SchemarsJsonSchema>(mut self) -> Self {
        self.structured_output_schema = Some(schema_for::<T>());
        self
    }
}

impl<S: invoke_options_builder::State> InvokeOptionsBuilder<S> {
    /// Sets the structured output schema from a type's `schemars` schema.
    pub fn structured_output_schema<T: SchemarsJsonSchema>(
        self,
    ) -> InvokeOptionsBuilder<invoke_options_builder::SetStructuredOutputSchema<S>>
    where
        S::StructuredOutputSchema: invoke_options_builder::IsUnset,
    {
        self.structured_output_schema_json(schema_for::<T>())
    }
}
