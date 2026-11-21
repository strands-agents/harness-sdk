//! The harness factory: a preconfigured Strands [`Agent`] in one call.

use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::future::BoxFuture;
use strands::background_tasks::BackgroundTasksConfig;
use strands::conversation_manager::ConversationManager;
use strands::experimental::context_manager::ContextManagerStrategy;
use strands::hooks::InitializedEvent;
use strands::interventions::InterventionHandler;
use strands::memory::{MemoryManager, MemoryManagerSource};
use strands::plugins::Plugin;
use strands::retry::RetryStrategy;
use strands::sandbox::Sandbox;
use strands::session::{SaveLatestStrategy, SessionManager, SessionManagerConfig};
use strands::storage::{LocalFileStorage, Storage};
use strands::telemetry::AttributeValue;
use strands::tools::{Tool, ToolExecutorStrategy, ToolSource};
use strands::types::{JsonObject, JsonSchema, Message, SystemPrompt, Toggle};
use strands::vended_plugins::skills::{AgentSkills, AgentSkillsConfig, SkillSource};
use strands::{Agent, AgentConfig, ModelSource};

use crate::builtin_tools::{
    WebSearchMode, build_builtin_tools, resolve_builtin_tools, web_search_explicit, web_search_mode,
};
use crate::config::BuiltinPluginName;
use crate::defaults::{DEFAULT_BUILTIN_PLUGINS, DEFAULT_MODEL, DEFAULT_SESSION_DIR, DEFAULT_SKILLS_DIR};
use crate::env::Env;
use crate::factory::{BUILTIN_TOOL_FACTORY, BuiltinToolFactory, ENVIRONMENT_PLUGIN_NAME, TODOS_PLUGIN_NAME};
use crate::interventions::{InterventionsOption, resolve_interventions};
use crate::memory::{ResolveMemoryOptions, resolve_memory};
use crate::models::{ModelPlan, ModelRequest, resolve_model};
use crate::prompt::build_system_prompt;
use crate::telemetry::setup_telemetry;
use crate::types::{
    BuiltinToolsConfig, BuiltinToolsOption, ContextManagerOption, Effort, McpServersOption, MemoryConfig, SessionConfig,
};

/// The name the SDK's skills plugin registers under.
const AGENT_SKILLS_NAME: &str = "strands:agent-skills";

/// The delegation tool always runs in the background: its calls are long-running subtasks whose
/// intermediate work should stay out of the parent's turn.
const ALWAYS_BACKGROUND_TOOL_NAMES: [&str; 1] = ["subagent"];

/// What `session` accepts.
#[derive(Clone)]
#[non_exhaustive]
pub enum SessionOption {
    /// No persistence (`false`, `null`): the conversation and offloaded artifacts stay in memory.
    Off,
    /// File-backed persistence under the config's directory and id (`true` is the empty config).
    On(SessionConfig),
    /// A session manager, used as is. Pass [`storage`](HarnessAgentOptions::storage) with it, or
    /// offloaded artifacts are embedded in its snapshots.
    Manager(SessionManager),
}

impl From<bool> for SessionOption {
    fn from(enabled: bool) -> Self {
        if enabled {
            Self::On(SessionConfig::default())
        } else {
            Self::Off
        }
    }
}

impl From<SessionConfig> for SessionOption {
    fn from(config: SessionConfig) -> Self {
        Self::On(config)
    }
}

impl From<SessionManager> for SessionOption {
    fn from(manager: SessionManager) -> Self {
        Self::Manager(manager)
    }
}

impl fmt::Debug for SessionOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Off => f.write_str("Off"),
            Self::On(config) => f.debug_tuple("On").field(config).finish(),
            Self::Manager(manager) => f.debug_tuple("Manager").field(&manager.session_id()).finish(),
        }
    }
}

/// What `skills` accepts.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum SkillsOption {
    /// No skills (`false`, `null`).
    Off,
    /// Scans `./.agent/skills` when it exists (`true`, the default).
    Default,
    /// These sources, passed to the SDK's `AgentSkills` plugin unfiltered: the plugin reads them
    /// through the agent's sandbox and warns on a missing one. An empty list is off.
    Sources(Vec<SkillSource>),
    /// A plugin instance, used as is.
    Plugin(AgentSkills),
}

impl From<bool> for SkillsOption {
    fn from(enabled: bool) -> Self {
        if enabled { Self::Default } else { Self::Off }
    }
}

impl From<SkillSource> for SkillsOption {
    fn from(source: SkillSource) -> Self {
        Self::Sources(vec![source])
    }
}

impl From<&str> for SkillsOption {
    fn from(source: &str) -> Self {
        Self::Sources(vec![source.into()])
    }
}

impl From<String> for SkillsOption {
    fn from(source: String) -> Self {
        Self::Sources(vec![source.into()])
    }
}

impl From<PathBuf> for SkillsOption {
    fn from(source: PathBuf) -> Self {
        Self::Sources(vec![source.into()])
    }
}

impl From<&Path> for SkillsOption {
    fn from(source: &Path) -> Self {
        Self::Sources(vec![source.into()])
    }
}

impl<T: Into<SkillSource>> From<Vec<T>> for SkillsOption {
    fn from(sources: Vec<T>) -> Self {
        Self::Sources(sources.into_iter().map(Into::into).collect())
    }
}

impl<T: Into<SkillSource>, const N: usize> From<[T; N]> for SkillsOption {
    fn from(sources: [T; N]) -> Self {
        Self::Sources(sources.into_iter().map(Into::into).collect())
    }
}

impl From<AgentSkills> for SkillsOption {
    fn from(plugin: AgentSkills) -> Self {
        Self::Plugin(plugin)
    }
}

/// What `memory` accepts.
#[derive(Clone)]
#[non_exhaustive]
pub enum MemoryOption {
    /// No long-term memory (`false`, `null`).
    Off,
    /// The harness's file-based memory (`true` is the empty config).
    On(MemoryConfig),
    /// A memory manager, used as is.
    Manager(MemoryManager),
}

impl From<bool> for MemoryOption {
    fn from(enabled: bool) -> Self {
        if enabled {
            Self::On(MemoryConfig::default())
        } else {
            Self::Off
        }
    }
}

impl From<MemoryConfig> for MemoryOption {
    fn from(config: MemoryConfig) -> Self {
        Self::On(config)
    }
}

impl From<MemoryManager> for MemoryOption {
    fn from(manager: MemoryManager) -> Self {
        Self::Manager(manager)
    }
}

impl fmt::Debug for MemoryOption {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Off => f.write_str("Off"),
            Self::On(config) => f.debug_tuple("On").field(config).finish(),
            Self::Manager(_) => f.write_str("Manager(..)"),
        }
    }
}

/// Options for [`create_harness`] (`HarnessAgentOptions`). Every field is optional.
///
/// The fields after `interventions` are the SDK's [`AgentConfig`] fields the harness does not
/// own, forwarded verbatim; an explicit value always wins over the harness default it
/// corresponds to.
///
/// ```
/// use strands_harness::{BuiltinToolName, Effort, HarnessAgentOptions};
///
/// let options = HarnessAgentOptions::builder()
///     .model("anthropic/claude-opus-5")
///     .effort(Effort::High)
///     .instructions("You are a migration assistant.")
///     .builtin_tools([BuiltinToolName::Read, BuiltinToolName::Shell])
///     .session(false)
///     .build();
/// assert_eq!(options.effort, Effort::High);
/// ```
#[derive(Default, bon::Builder)]
#[builder(builder_type(name = HarnessAgentOptionsBuilder, vis = "pub", doc {
    /// Builds [`HarnessAgentOptions`]; the setters are its fields.
}))]
pub struct HarnessAgentOptions {
    /// Consumer tools, added alongside the built-in tools. A tool name must be unique across all
    /// sources (built-in tools, `tools`, plugins); a collision fails at construction. To replace
    /// a built-in, drop it first through `builtin_tools`. Consumer tools also join the
    /// `subagent` tool's narrowable set, and a connected MCP client is offered on its
    /// `mcp_servers` axis under its client name. Set them with the builder's `tools(..)`.
    #[builder(field)]
    pub tools: Vec<ToolSource>,
    /// Consumer plugins, registered before the harness's. An `AgentSkills` plugin here replaces
    /// the one the harness would add, and a plugin named like a built-in plugin
    /// (`strands:todos`, `strands:environment`) replaces it. A `subagent` child inherits these.
    /// Set them with the builder's `plugins(..)`.
    #[builder(field)]
    pub plugins: Vec<Arc<dyn Plugin>>,
    /// A model or router, a `"provider/name"` string (such as `"anthropic/claude-fable-5"`), a
    /// bare Bedrock model id, or `None` for the harness default (Bedrock Opus 5).
    #[builder(into)]
    pub model: Option<ModelSource>,
    /// Reasoning effort applied to the resolved model, mapped to each provider's request fields:
    /// [`Effort::Auto`] (the default) uses the provider's recommended level, [`Effort::Off`]
    /// turns reasoning off, and a named level sets it; a level the provider does not support
    /// fails. Ignored for a model instance or router.
    #[builder(default)]
    pub effort: Effort,
    /// A domain block appended after the harness contract. Ignored when `system_prompt` is set.
    #[builder(into)]
    pub instructions: Option<String>,
    /// MCP servers to connect: a path to a JSON file (a flat `{ name: {..} }` map, or that map
    /// under `mcpServers`) or the map itself. A server that fails to start yields no tools unless
    /// it sets `continueOnError: false`; each server's tools are prefixed with its name unless
    /// it sets its own `prefix` (`""` opts out). Needs the `mcp` feature: without it, setting
    /// servers fails at [`create_harness`].
    #[builder(into)]
    pub mcp_servers: Option<McpServersOption>,
    /// Which built-in tools to enable: a list pins exactly those (an empty list disables them
    /// all), a [`BuiltinToolsConfig`] edits the defaults. `web_search` turns on the provider's
    /// native search (OpenAI, Anthropic, and the GPT-5, GPT-6 and Daybreak models on Bedrock
    /// Mantle); elsewhere it is off, and naming it there fails.
    /// [`WebSearchSetting::Exa`](crate::WebSearchSetting::Exa) (`"exa"` in a config) uses Exa's
    /// hosted search on any model instead (needs the `mcp` feature). A `subagent` child inherits
    /// this.
    #[builder(into)]
    pub builtin_tools: Option<BuiltinToolsOption>,
    /// SDK Background Tasks. The `subagent` tool always runs in the background; by default the
    /// model may choose background execution for any other compatible tool. `false` disables
    /// Background Tasks; a config controls the other tools, concurrency, completion and timeouts.
    #[builder(into)]
    pub background_tasks: Option<Toggle<BackgroundTasksConfig>>,
    /// Prompt caching where the provider supports it; on by default. `Some(true)` is an explicit
    /// request, which fails on a model that cannot cache; `Some(false)` turns off what the harness
    /// configures. Not applied to a model instance or router (an explicit request warns).
    pub caching: Option<bool>,
    /// SDK context management: [`ContextManagerStrategy::Auto`] (the default) or `Agentic`
    /// selects an SDK strategy, an instance is used as is, and `Disabled` turns it off.
    #[builder(into)]
    pub context_manager: Option<ContextManagerOption>,
    /// File-backed conversation persistence, on by default: a fresh random 8-hex id under
    /// `./.agent/sessions`, with offloaded artifacts kept there too. Ignored when
    /// `session_manager` is set.
    #[builder(into)]
    pub session: Option<SessionOption>,
    /// Agent Skills through the SDK's `AgentSkills` plugin; by default `./.agent/skills` when it
    /// exists. Ignored when an `AgentSkills` plugin is in `plugins`.
    #[builder(into)]
    pub skills: Option<SkillsOption>,
    /// File-based long-term memory, on by default: durable facts distilled into markdown under
    /// `./.agent/memory`, searched before each user turn. Ignored when `memory_manager` is set.
    /// Extraction runs in the background, so call [`Agent::shutdown`] to persist what is pending.
    #[builder(into)]
    pub memory: Option<MemoryOption>,
    /// The built-in feature plugins to enable; `environment` by default, which injects the
    /// platform, date, working directory and the project's `AGENTS.md` before each user turn.
    /// `todos` is opt-in: it adds a `todo_write` tool and re-surfaces the list before each step.
    #[builder(with = |names: impl IntoIterator<Item = BuiltinPluginName>| names.into_iter().collect())]
    pub builtin_plugins: Option<Vec<BuiltinPluginName>>,
    /// Gates tool calls behind approval or a policy; off by default. A preset (`"ask"`,
    /// `"smart"`), a natural-language policy, a `.cedar` policy file, a handler, or a list. A
    /// `subagent` child inherits the policy, so a delegate cannot bypass it.
    #[builder(into)]
    pub interventions: Option<InterventionsOption>,
    /// See [`AgentConfig::aux_model`].
    #[builder(into)]
    pub aux_model: Option<ModelSource>,
    /// See [`AgentConfig::messages`].
    #[builder(default)]
    pub messages: Vec<Message>,
    /// See [`AgentConfig::system_prompt`]. Replaces the harness prompt and `instructions`.
    #[builder(into)]
    pub system_prompt: Option<SystemPrompt>,
    /// See [`AgentConfig::app_state`].
    pub app_state: Option<JsonObject>,
    /// See [`AgentConfig::model_state`].
    pub model_state: Option<JsonObject>,
    /// See [`AgentConfig::printer`].
    pub printer: Option<bool>,
    /// See [`AgentConfig::retry_strategy`].
    pub retry_strategy: Option<Vec<RetryStrategy>>,
    /// See [`AgentConfig::structured_output_schema`].
    pub structured_output_schema: Option<JsonSchema>,
    /// See [`AgentConfig::name`].
    #[builder(into)]
    pub name: Option<String>,
    /// See [`AgentConfig::description`].
    #[builder(into)]
    pub description: Option<String>,
    /// See [`AgentConfig::id`].
    #[builder(into)]
    pub id: Option<String>,
    /// See [`AgentConfig::tool_executor`].
    #[builder(into)]
    pub tool_executor: Option<ToolExecutorStrategy>,
    /// See [`AgentConfig::sort_tools`].
    pub sort_tools: Option<bool>,
    /// See [`AgentConfig::conversation_manager`].
    pub conversation_manager: Option<Arc<dyn ConversationManager>>,
    /// See [`AgentConfig::trace_attributes`].
    pub trace_attributes: Option<BTreeMap<String, AttributeValue>>,
    /// See [`AgentConfig::baggage_attributes`].
    pub baggage_attributes: Option<BTreeMap<String, String>>,
    /// See [`AgentConfig::sandbox`]. The harness's built-ins route through it, so the tools the
    /// sandbox vends are dropped once the agent initializes.
    pub sandbox: Option<Arc<dyn Sandbox>>,
    /// See [`AgentConfig::storage`]. Backs the context manager's stash; defaults to the
    /// session's own folder when the harness builds the session.
    pub storage: Option<Arc<dyn Storage>>,
    /// See [`AgentConfig::session_manager`]. Wins over `session`.
    pub session_manager: Option<SessionManager>,
    /// See [`AgentConfig::memory_manager`]. Wins over `memory`.
    #[builder(into)]
    pub memory_manager: Option<MemoryManagerSource>,
}

impl<S: harness_agent_options_builder::State> HarnessAgentOptionsBuilder<S> {
    /// Adds consumer tools: any iterator of tools, `Arc<dyn Tool>`s, MCP clients or nested lists.
    pub fn tools(mut self, tools: impl IntoIterator<Item = impl Into<ToolSource>>) -> Self {
        self.tools.extend(tools.into_iter().map(Into::into));
        self
    }

    /// Adds consumer plugins, by value or as `Arc`s.
    pub fn plugins(mut self, plugins: impl IntoIterator<Item = impl Plugin>) -> Self {
        self.plugins
            .extend(plugins.into_iter().map(|plugin| Arc::new(plugin) as Arc<dyn Plugin>));
        self
    }
}

impl fmt::Debug for HarnessAgentOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HarnessAgentOptions")
            .field("model", &self.model)
            .field("effort", &self.effort)
            .field("instructions", &self.instructions)
            .field("tools", &self.tools)
            .field("builtin_tools", &self.builtin_tools)
            .field("session", &self.session)
            .field("memory", &self.memory)
            .field("skills", &self.skills)
            .finish_non_exhaustive()
    }
}

/// The parent config a `subagent` child is rebuilt from: the harness options the child
/// inherits, with sessions forced off so a throwaway delegate never persists its own state.
#[derive(Clone)]
pub(crate) struct ParentConfig {
    pub(crate) model: Option<ModelSource>,
    pub(crate) effort: Effort,
    pub(crate) context_manager: Option<ContextManagerOption>,
    pub(crate) skills: Option<SkillsOption>,
    /// `None` is the default (on); a memory instance is forwarded as off.
    pub(crate) memory: Option<MemoryOption>,
    /// The parent's consumer tools, MCP clients included.
    pub(crate) tools: Vec<ToolSource>,
    /// The parent's resolved record, with `web_search` adjusted for the child's model.
    pub(crate) builtin_tools: BuiltinToolsConfig,
    pub(crate) caching: Option<bool>,
    pub(crate) builtin_plugins: Option<Vec<BuiltinPluginName>>,
    pub(crate) plugins: Vec<Arc<dyn Plugin>>,
    pub(crate) interventions: Option<InterventionsOption>,
    pub(crate) background_tasks: Option<Toggle<BackgroundTasksConfig>>,
    pub(crate) sandbox: Option<Arc<dyn Sandbox>>,
}

impl ParentConfig {
    pub(crate) fn to_options(&self) -> HarnessAgentOptions {
        HarnessAgentOptions {
            tools: self.tools.clone(),
            plugins: self.plugins.clone(),
            model: self.model.clone(),
            effort: self.effort,
            builtin_tools: Some(BuiltinToolsOption::Mapping(self.builtin_tools.clone())),
            background_tasks: self.background_tasks.clone(),
            caching: self.caching,
            context_manager: self.context_manager.clone(),
            session: Some(SessionOption::Off),
            skills: self.skills.clone(),
            memory: self.memory.clone(),
            builtin_plugins: self.builtin_plugins.clone(),
            interventions: self.interventions.clone(),
            sandbox: self.sandbox.clone(),
            ..Default::default()
        }
    }
}

/// Sanitizes a session id to `[a-z0-9_-]`.
pub(crate) fn sanitize_session_id(session_id: &str) -> String {
    let sanitized: String = session_id
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "default".to_owned()
    } else {
        sanitized
    }
}

fn random_session_id() -> String {
    format!("{:08x}", rand::random::<u32>())
}

/// Resolves `skills` into an `AgentSkills` plugin, or `None` when nothing was requested. The
/// default is best-effort: it loads `./.agent/skills` only when it exists locally.
fn skills_plugin(skills: SkillsOption) -> Option<Arc<dyn Plugin>> {
    let sources = match skills {
        SkillsOption::Plugin(plugin) => return Some(Arc::new(plugin)),
        SkillsOption::Default if Path::new(DEFAULT_SKILLS_DIR).is_dir() => vec![DEFAULT_SKILLS_DIR.into()],
        SkillsOption::Sources(sources) if !sources.is_empty() => sources,
        _ => return None,
    };
    Some(Arc::new(AgentSkills::new(AgentSkillsConfig {
        skills: sources,
        ..Default::default()
    })))
}

fn builtin_plugin_name(name: BuiltinPluginName) -> &'static str {
    match name {
        BuiltinPluginName::Todos => TODOS_PLUGIN_NAME,
        BuiltinPluginName::Environment => ENVIRONMENT_PLUGIN_NAME,
    }
}

/// The built-in plugins to add: each named one, unless a plugin with its name is already registered.
fn select_builtin_plugins(
    names: &[BuiltinPluginName],
    existing: &[Arc<dyn Plugin>],
    factory: &BuiltinToolFactory,
) -> Vec<Arc<dyn Plugin>> {
    names
        .iter()
        .filter(|name| {
            !existing
                .iter()
                .any(|plugin| plugin.name() == builtin_plugin_name(**name))
        })
        .map(|name| match name {
            BuiltinPluginName::Todos => (factory.todos)(),
            BuiltinPluginName::Environment => (factory.environment)(),
        })
        .collect()
}

/// The tools a list of sources names up front: top-level tools only, since nested lists, agents
/// and MCP clients resolve later.
fn named_tools(sources: &[ToolSource]) -> Vec<&Arc<dyn Tool>> {
    sources
        .iter()
        .filter_map(|source| match source {
            ToolSource::Tool(tool) => Some(tool),
            _ => None,
        })
        .collect()
}

/// The tools each plugin vends (such as `todo_write`), via [`Plugin::get_tools`].
fn plugin_tools(plugins: &[Arc<dyn Plugin>]) -> Vec<ToolSource> {
    plugins.iter().flat_map(|plugin| plugin.get_tools()).collect()
}

/// One source of tool names for the collision check.
struct NamedSource<'a> {
    label: &'static str,
    builtin: bool,
    tools: Vec<&'a Arc<dyn Tool>>,
}

/// Fails if two tools would register under the same name, naming the losing source, rather than
/// one tool silently disappearing. Names differing only by `-` and `_`
/// collide, as in the SDK registry.
fn check_name_collisions(sources: &[NamedSource<'_>]) -> strands::Result<()> {
    let mut seen: Vec<(String, &'static str, bool)> = Vec::new();
    for source in sources {
        for tool in &source.tools {
            let key = tool.name().replace('-', "_");
            if let Some((_, label, builtin)) = seen.iter().find(|(known, ..)| *known == key) {
                let place = if *label == source.label {
                    source.label.to_owned()
                } else {
                    format!("{label} and {}", source.label)
                };
                let remedy = if source.builtin || *builtin {
                    "Rename the tool you passed, or drop the built-in via builtinTools / builtinPlugins."
                } else {
                    "Rename one so each tool has a unique name."
                };
                return Err(strands::Error::other(format!(
                    "Tool name {} is registered more than once (from {place}). {remedy}",
                    crate::types::json_string(tool.name())
                )));
            }
            seen.push((key, source.label, source.builtin));
        }
    }
    Ok(())
}

/// The Background Tasks policy: unset or `true` lets the model
/// background any tool; the always-background tools are moved to `always` in every policy.
pub(crate) fn resolve_background_tasks(
    configured: Option<Toggle<BackgroundTasksConfig>>,
    forced: &[String],
) -> Toggle<BackgroundTasksConfig> {
    let policy = match configured {
        Some(Toggle::Off) => return Toggle::Off,
        Some(Toggle::On(config)) if config != BackgroundTasksConfig::default() => config,
        _ => BackgroundTasksConfig {
            agentic: Some(vec!["*".to_owned()]),
            ..Default::default()
        },
    };
    let omit_forced = |selectors: Vec<String>| -> Vec<String> {
        selectors
            .into_iter()
            .filter(|selector| selector == "*" || !forced.contains(selector))
            .collect()
    };
    let explicit_always = policy.always.is_some();
    let mut always = omit_forced(policy.always.clone().unwrap_or_default());
    always.extend(forced.iter().cloned());
    Toggle::On(BackgroundTasksConfig {
        agentic: policy.agentic.clone().map(omit_forced),
        always: (!always.is_empty() || explicit_always).then_some(always),
        never: policy.never.clone().map(omit_forced),
        ..policy
    })
}

/// A harness agent's configuration before the agent is built, kept apart so tests can inspect
/// what `create_harness` resolved.
#[cfg_attr(not(test), allow(dead_code, reason = "inspected by tests"))]
pub(crate) struct Assembly {
    pub(crate) config: AgentConfig,
    /// The config a `subagent` child is rebuilt from.
    pub(crate) parent: Arc<ParentConfig>,
    pub(crate) model_plan: Option<ModelPlan>,
    /// Tool names the harness registers itself, which the sandbox-tool cleanup must keep.
    pub(crate) known_tool_names: HashSet<String>,
}

/// Builds a preconfigured Strands agent with the harness defaults.
///
/// Every default is overridable through [`HarnessAgentOptions`], and the result is a plain
/// [`Agent`] that can be changed further. Resolution is async because MCP servers are connected
/// here.
///
/// ```no_run
/// use strands_harness::{HarnessAgentOptions, create_harness};
///
/// # async fn run() -> strands::Result<()> {
/// let mut agent = create_harness(
///     HarnessAgentOptions::builder()
///         .model("anthropic/claude-opus-5")
///         .interventions("ask")
///         .build(),
/// )
/// .await?;
/// let result = agent.invoke("Fix the failing test in src/lib.rs").await?;
/// println!("{result}");
/// agent.shutdown().await?;
/// # Ok(())
/// # }
/// ```
///
/// # Errors
///
/// An invalid option (an unknown model provider, an unsupported effort level, a tool name
/// registered twice, an empty session id, ...), a provider whose cargo feature is disabled, an
/// MCP config that cannot be loaded, or an agent the SDK rejects.
pub async fn create_harness(options: HarnessAgentOptions) -> strands::Result<Agent> {
    create_harness_boxed(options, Env::process()).await
}

/// [`create_harness`] with an explicit environment, boxed so the `subagent` builder can recurse.
pub(crate) fn create_harness_boxed(
    options: HarnessAgentOptions,
    env: Env,
) -> BoxFuture<'static, strands::Result<Agent>> {
    Box::pin(async move {
        let has_sandbox = options.sandbox.is_some();
        let assembly = assemble(options, &env).await?;
        let agent = Agent::new(assembly.config)?;
        if has_sandbox {
            drop_sandbox_tools(&agent, assembly.known_tool_names);
        }
        Ok(agent)
    })
}

/// Drops the tools the sandbox vends (such as `sandbox_bash`) once the SDK registers them at
/// initialization: the harness's built-ins already route through the sandbox. A name the
/// harness registered itself is kept.
fn drop_sandbox_tools(agent: &Agent, known: HashSet<String>) {
    let _cleanup = agent.add_hook(move |event: &mut InitializedEvent<'_>| {
        let vended: Vec<String> = event
            .agent()
            .sandbox()
            .get_tools()
            .iter()
            .map(|tool| tool.name().to_owned())
            .filter(|name| !known.contains(name))
            .collect();
        for name in vended {
            event.agent_mut().tool_registry_mut().remove(&name);
        }
    });
}

#[cfg(feature = "mcp")]
async fn with_mcp_servers(
    mut tools: Vec<ToolSource>,
    servers: Option<McpServersOption>,
) -> strands::Result<Vec<ToolSource>> {
    tools.extend(load_mcp_servers(servers.map(McpServersOption::into_source)).await?);
    Ok(tools)
}

#[cfg(not(feature = "mcp"))]
async fn with_mcp_servers(
    tools: Vec<ToolSource>,
    servers: Option<McpServersOption>,
) -> strands::Result<Vec<ToolSource>> {
    if servers.is_some() {
        return Err(strands::Error::other(
            "mcp_servers needs the strands-harness feature \"mcp\"; enable it to connect MCP servers.",
        ));
    }
    Ok(tools)
}

#[cfg(feature = "mcp")]
async fn load_mcp_servers(servers: Option<strands::mcp::McpServersSource>) -> strands::Result<Vec<ToolSource>> {
    use strands::mcp::{McpClient, McpClientOptions, McpLoadServersOptions};

    let Some(servers) = servers else {
        return Ok(Vec::new());
    };
    let defaults = McpClientOptions {
        continue_on_error: true,
        ..Default::default()
    };
    let options = McpLoadServersOptions {
        prefix_with_server_name: true,
    };
    let clients = McpClient::load_servers(servers, defaults, options).await?;
    Ok(clients.into_iter().map(ToolSource::McpClient).collect())
}

/// A harness-built session manager and the stash storage in its folder.
type SessionParts = (SessionManager, Option<Arc<dyn Storage>>);

fn session_parts(session: Option<SessionOption>) -> strands::Result<Option<SessionParts>> {
    let config = match session.unwrap_or(SessionOption::On(SessionConfig::default())) {
        SessionOption::Off => return Ok(None),
        SessionOption::Manager(manager) => return Ok(Some((manager, None))),
        SessionOption::On(config) => config,
    };
    if config.id.as_deref().is_some_and(|id| id.trim().is_empty()) {
        return Err(strands::Error::other("session.id must be a non-empty string."));
    }
    let dir = config.dir.unwrap_or_else(|| PathBuf::from(DEFAULT_SESSION_DIR));
    let session_id = config.id.as_deref().map_or_else(random_session_id, sanitize_session_id);
    let manager = SessionManager::new(SessionManagerConfig {
        storage: Some(Arc::new(LocalFileStorage::new(&dir).namespace("")?)),
        session_id: Some(session_id.clone()),
        save_latest_on: Some(SaveLatestStrategy::Message),
        ..Default::default()
    })?;
    // The stash goes to files, not into the snapshot rewritten on every message. It lives in the
    // session's own folder because each folder under the session dir is read as a session.
    let stash: Arc<dyn Storage> = Arc::new(LocalFileStorage::new(dir.join(&session_id)));
    Ok(Some((manager, Some(stash))))
}

/// Resolves every harness option into the SDK agent configuration.
pub(crate) async fn assemble(options: HarnessAgentOptions, env: &Env) -> strands::Result<Assembly> {
    assemble_with(options, env, &BUILTIN_TOOL_FACTORY).await
}

/// [`assemble`] with the constructors the built-ins are made with.
#[allow(
    clippy::too_many_lines,
    reason = "one pass over the options, in the order they resolve"
)]
pub(crate) async fn assemble_with(
    options: HarnessAgentOptions,
    env: &Env,
    factory: &BuiltinToolFactory,
) -> strands::Result<Assembly> {
    let HarnessAgentOptions {
        tools,
        plugins: consumer_plugins,
        model,
        effort,
        instructions,
        mcp_servers,
        builtin_tools,
        background_tasks,
        caching,
        context_manager,
        session,
        skills,
        memory,
        builtin_plugins,
        interventions,
        aux_model,
        messages,
        system_prompt,
        app_state,
        model_state,
        printer,
        retry_strategy,
        structured_output_schema,
        name,
        description,
        id,
        tool_executor,
        sort_tools,
        conversation_manager,
        trace_attributes,
        baggage_attributes,
        sandbox,
        storage,
        session_manager,
        memory_manager,
    } = options;

    setup_telemetry(env)?;

    let resolved = resolve_builtin_tools(builtin_tools.as_ref());
    let explicit_search = web_search_explicit(builtin_tools.as_ref());
    let web_search = web_search_mode(resolved.web_search, explicit_search, model.as_ref())?;

    // Not passing `caching` uses the default (on) and warns on an unsupported model; passing it
    // is an explicit request, which fails there instead.
    let request = ModelRequest {
        effort,
        web_search: web_search == Some(WebSearchMode::Native),
        caching: caching.unwrap_or(true),
        caching_explicit: caching.is_some(),
    };
    let resolved_model = resolve_model(model.as_ref(), DEFAULT_MODEL, request, env)?;
    let system_prompt = system_prompt.or_else(|| Some(build_system_prompt(instructions.as_deref(), &[]).into()));

    let consumer = with_mcp_servers(tools, mcp_servers).await?;

    let memory_instance = matches!(memory, Some(MemoryOption::Manager(_))) || memory_manager.is_some();
    let mut forwarded = resolved.to_config();
    if web_search.is_none() {
        // Off, or on by default but unavailable here: forward it off so a child on the same model
        // stays quiet.
        forwarded.web_search = Some(false.into());
    } else if !explicit_search {
        // Forward the default as a default, so a child without native search logs, not fails.
        forwarded.web_search = None;
    }
    let parent = Arc::new(ParentConfig {
        model,
        effort,
        context_manager: context_manager.clone(),
        skills: skills.clone(),
        memory: if memory_instance {
            Some(MemoryOption::Off)
        } else {
            memory.clone()
        },
        tools: consumer.clone(),
        builtin_tools: forwarded,
        caching,
        builtin_plugins: builtin_plugins.clone(),
        plugins: consumer_plugins.clone(),
        interventions: interventions.clone(),
        background_tasks: background_tasks.clone(),
        sandbox: sandbox.clone(),
    });
    let builtin = build_builtin_tools(&resolved, web_search == Some(WebSearchMode::Exa), &parent, env, factory)?;

    // Consumer plugins stay first so the tail is the harness's own.
    let mut plugins = consumer_plugins.clone();
    let has_skills = plugins.iter().any(|plugin| plugin.name() == AGENT_SKILLS_NAME);
    if let Some(plugin) = skills_plugin(skills.unwrap_or(SkillsOption::Default)).filter(|_| !has_skills) {
        plugins.push(plugin);
    }
    let builtin_plugin_names = builtin_plugins.unwrap_or_else(|| DEFAULT_BUILTIN_PLUGINS.to_vec());
    let selected_plugins = select_builtin_plugins(&builtin_plugin_names, &plugins, factory);
    plugins.extend(selected_plugins);
    let harness_plugins = &plugins[consumer_plugins.len()..];

    let (session_manager, storage) = match session_manager {
        Some(manager) => (Some(manager), storage),
        None => match session_parts(session)? {
            Some((manager, stash)) => (Some(manager), storage.or(stash)),
            None => (None, storage),
        },
    };

    let memory_manager = match memory_manager {
        Some(source) => Some(source),
        None => match memory.unwrap_or(MemoryOption::On(MemoryConfig::default())) {
            MemoryOption::Off => None,
            MemoryOption::Manager(manager) => Some(manager.into()),
            MemoryOption::On(config) => Some(
                resolve_memory(
                    ResolveMemoryOptions {
                        stores: config.stores,
                        model: parent.model.clone(),
                        dir: config.dir,
                        web_fetch_model: resolved.web_fetch_config().and_then(|config| config.model),
                        read_only: false,
                    },
                    env,
                )?
                .into(),
            ),
        },
    };
    // A manager carries its resolved tools (`search_memory` by default); a config does not, so
    // only a manager can be checked for name collisions here.
    let memory_tools = match &memory_manager {
        Some(MemoryManagerSource::Manager(manager)) => manager.get_tools(),
        _ => Vec::new(),
    };

    let builtin_sources: Vec<ToolSource> = builtin.iter().map(|tool| ToolSource::Tool(Arc::clone(tool))).collect();
    let harness_plugin_tools = plugin_tools(harness_plugins);
    let consumer_plugin_tools = plugin_tools(&consumer_plugins);
    let sources = [
        NamedSource {
            label: "a built-in tool",
            builtin: true,
            tools: named_tools(&builtin_sources),
        },
        NamedSource {
            label: "tools",
            builtin: false,
            tools: named_tools(&consumer),
        },
        NamedSource {
            label: "a built-in plugin",
            builtin: true,
            tools: named_tools(&harness_plugin_tools),
        },
        NamedSource {
            label: "plugins",
            builtin: false,
            tools: named_tools(&consumer_plugin_tools),
        },
        NamedSource {
            label: "memory",
            builtin: true,
            tools: named_tools(&memory_tools),
        },
    ];
    check_name_collisions(&sources)?;
    let known_tool_names = sources
        .iter()
        .flat_map(|source| source.tools.iter().map(|tool| tool.name().to_owned()))
        .collect();

    let handlers: Vec<Arc<dyn InterventionHandler>> = resolve_interventions(interventions.as_ref(), None)?;
    let forced: Vec<String> = builtin_sources
        .iter()
        .chain(consumer.iter())
        .filter_map(|source| match source {
            ToolSource::Tool(tool) if ALWAYS_BACKGROUND_TOOL_NAMES.contains(&tool.name()) => {
                Some(tool.name().to_owned())
            }
            _ => None,
        })
        .collect();
    let background_tasks = resolve_background_tasks(background_tasks, &forced);

    let mut agent_tools = builtin_sources;
    agent_tools.extend(consumer);
    let config = AgentConfig {
        tools: agent_tools,
        plugins,
        interventions: handlers,
        model: Some(resolved_model.source),
        aux_model,
        messages,
        system_prompt,
        app_state,
        model_state,
        printer,
        retry_strategy,
        structured_output_schema,
        name,
        description,
        id,
        tool_executor,
        sort_tools,
        conversation_manager,
        context_manager: Some(context_manager.unwrap_or(ContextManagerStrategy::Auto)),
        background_tasks: Some(background_tasks),
        trace_attributes,
        baggage_attributes,
        sandbox,
        storage,
        session_manager,
        memory_manager,
    };
    Ok(Assembly {
        config,
        parent,
        model_plan: resolved_model.plan,
        known_tool_names,
    })
}

#[cfg(test)]
mod tests;
