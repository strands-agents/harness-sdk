//! The harness's built-in tools: normalizing the `builtin_tools` option into one record with every
//! name resolved, building the tools from it, and the default `subagent`, which rebuilds a child
//! from the same record.

use std::sync::Arc;

use strands::ModelSource;
use strands::tools::{Tool, ToolSource};

use crate::agent::{HarnessAgentOptions, MemoryOption, ParentConfig, create_harness_boxed};
use crate::config::{BUILTIN_TOOL_NAMES, BuiltinToolName};
use crate::defaults::{DEFAULT_BUILTIN_TOOLS, DEFAULT_MODEL};
use crate::env::Env;
use crate::factory::{
    BuiltinToolFactory, ChildBuilder, ChildSpec, ReadToolOptions, SubagentToolOptions, WebFetchToolOptions,
};
use crate::memory::{ResolveMemoryOptions, resolve_memory};
use crate::models::{WebSearchKind, resolve_web_fetch_model, supports_media, web_search_kind};
use crate::types::{
    BuiltinToolsConfig, BuiltinToolsOption, MemoryConfig, ProgrammaticToolCallerConfig, ReadConfig, Setting,
    ShellConfig, SubagentConfig, WebFetchConfig, WebSearchSetting,
};

/// The `builtin_tools` option with every built-in name resolved (`ResolvedBuiltinTools`).
#[derive(Debug, Clone)]
pub(crate) struct ResolvedBuiltinTools {
    pub(crate) shell: Setting<ShellConfig>,
    pub(crate) read: Setting<ReadConfig>,
    pub(crate) write: bool,
    pub(crate) edit: bool,
    pub(crate) web_fetch: Setting<WebFetchConfig>,
    pub(crate) web_search: WebSearchSetting,
    pub(crate) programmatic_tool_caller: Setting<ProgrammaticToolCallerConfig>,
    pub(crate) subagent: Setting<SubagentConfig>,
}

fn config_of<C: Clone + Default>(setting: &Setting<C>) -> Option<C> {
    match setting {
        Setting::Enabled(false) => None,
        Setting::Config(config) => Some(config.clone()),
        _ => Some(C::default()),
    }
}

impl ResolvedBuiltinTools {
    /// Whether `name` is on (`web_search` counts as on for both native search and Exa).
    pub(crate) fn is_enabled(&self, name: BuiltinToolName) -> bool {
        match name {
            BuiltinToolName::Shell => self.shell.is_enabled(),
            BuiltinToolName::Read => self.read.is_enabled(),
            BuiltinToolName::Write => self.write,
            BuiltinToolName::Edit => self.edit,
            BuiltinToolName::WebFetch => self.web_fetch.is_enabled(),
            BuiltinToolName::WebSearch => self.web_search != WebSearchSetting::Off,
            BuiltinToolName::ProgrammaticToolCaller => self.programmatic_tool_caller.is_enabled(),
            BuiltinToolName::Subagent => self.subagent.is_enabled(),
        }
    }

    /// The enabled names in canonical order.
    pub(crate) fn enabled(&self) -> Vec<BuiltinToolName> {
        BUILTIN_TOOL_NAMES
            .iter()
            .copied()
            .filter(|name| self.is_enabled(*name))
            .collect()
    }

    /// `web_fetch`'s config: the empty config when enabled without one, `None` when off.
    pub(crate) fn web_fetch_config(&self) -> Option<WebFetchConfig> {
        config_of(&self.web_fetch)
    }

    pub(crate) fn shell_config(&self) -> Option<ShellConfig> {
        config_of(&self.shell)
    }

    pub(crate) fn read_config(&self) -> Option<ReadConfig> {
        config_of(&self.read)
    }

    pub(crate) fn programmatic_tool_caller_config(&self) -> Option<ProgrammaticToolCallerConfig> {
        config_of(&self.programmatic_tool_caller)
    }

    pub(crate) fn subagent_config(&self) -> Option<SubagentConfig> {
        config_of(&self.subagent)
    }

    /// The record as a mapping with every name set and the defaults included
    /// (`{ '*': true, ...resolved }`).
    pub(crate) fn to_config(&self) -> BuiltinToolsConfig {
        BuiltinToolsConfig {
            all: Some(true),
            shell: Some(self.shell.clone()),
            read: Some(self.read.clone()),
            write: Some(self.write),
            edit: Some(self.edit),
            web_fetch: Some(self.web_fetch.clone()),
            web_search: Some(self.web_search),
            programmatic_tool_caller: Some(self.programmatic_tool_caller.clone()),
            subagent: Some(self.subagent.clone()),
        }
    }

    /// The setting of `name` in a child's pinned mapping: the parent's own, or off.
    fn pinned(&self, name: BuiltinToolName, keep: bool) -> BuiltinToolsConfig {
        let off = |enabled: bool| if keep { enabled } else { false };
        let mut config = BuiltinToolsConfig::default();
        match name {
            BuiltinToolName::Shell => config.shell = Some(if keep { self.shell.clone() } else { false.into() }),
            BuiltinToolName::Read => config.read = Some(if keep { self.read.clone() } else { false.into() }),
            BuiltinToolName::Write => config.write = Some(off(self.write)),
            BuiltinToolName::Edit => config.edit = Some(off(self.edit)),
            BuiltinToolName::WebFetch => {
                config.web_fetch = Some(if keep { self.web_fetch.clone() } else { false.into() });
            }
            BuiltinToolName::WebSearch => config.web_search = Some(self.web_search),
            BuiltinToolName::ProgrammaticToolCaller => {
                config.programmatic_tool_caller = Some(if keep {
                    self.programmatic_tool_caller.clone()
                } else {
                    false.into()
                });
            }
            BuiltinToolName::Subagent => {
                config.subagent = Some(if keep { self.subagent.clone() } else { false.into() });
            }
        }
        config
    }
}

fn merge(into: &mut BuiltinToolsConfig, from: BuiltinToolsConfig) {
    into.all = from.all.or(into.all);
    into.shell = from.shell.or(into.shell.take());
    into.read = from.read.or(into.read.take());
    into.write = from.write.or(into.write);
    into.edit = from.edit.or(into.edit);
    into.web_fetch = from.web_fetch.or(into.web_fetch.take());
    into.web_search = from.web_search.or(into.web_search);
    into.programmatic_tool_caller = from.programmatic_tool_caller.or(into.programmatic_tool_caller.take());
    into.subagent = from.subagent.or(into.subagent.take());
}

/// Resolves `builtin_tools` to one entry per built-in name: `None` selects the defaults, a list
/// pins exactly those names, and a mapping edits the defaults (or nothing, with
/// `all: Some(false)`).
pub(crate) fn resolve_builtin_tools(value: Option<&BuiltinToolsOption>) -> ResolvedBuiltinTools {
    let (star, mapping) = match value {
        None => (true, BuiltinToolsConfig::default()),
        Some(BuiltinToolsOption::List(names)) => (false, list_mapping(names)),
        Some(BuiltinToolsOption::Mapping(mapping)) => (mapping.all.unwrap_or(true), mapping.clone()),
    };
    let base = |name: BuiltinToolName| star && DEFAULT_BUILTIN_TOOLS.contains(&name);
    ResolvedBuiltinTools {
        shell: mapping.shell.unwrap_or_else(|| base(BuiltinToolName::Shell).into()),
        read: mapping.read.unwrap_or_else(|| base(BuiltinToolName::Read).into()),
        write: mapping.write.unwrap_or_else(|| base(BuiltinToolName::Write)),
        edit: mapping.edit.unwrap_or_else(|| base(BuiltinToolName::Edit)),
        web_fetch: mapping
            .web_fetch
            .unwrap_or_else(|| base(BuiltinToolName::WebFetch).into()),
        web_search: mapping
            .web_search
            .unwrap_or_else(|| base(BuiltinToolName::WebSearch).into()),
        programmatic_tool_caller: mapping
            .programmatic_tool_caller
            .unwrap_or_else(|| base(BuiltinToolName::ProgrammaticToolCaller).into()),
        subagent: registered_subagent(
            mapping
                .subagent
                .unwrap_or_else(|| base(BuiltinToolName::Subagent).into()),
        ),
    }
}

/// A subagent that may not delegate even once is not registered at all.
fn registered_subagent(setting: Setting<SubagentConfig>) -> Setting<SubagentConfig> {
    match setting {
        Setting::Config(SubagentConfig { max_depth: Some(0) }) => false.into(),
        setting => setting,
    }
}

fn list_mapping(names: &[BuiltinToolName]) -> BuiltinToolsConfig {
    let resolved_on = ResolvedBuiltinTools {
        shell: true.into(),
        read: true.into(),
        write: true,
        edit: true,
        web_fetch: true.into(),
        web_search: true.into(),
        programmatic_tool_caller: true.into(),
        subagent: true.into(),
    };
    let mut mapping = BuiltinToolsConfig::default();
    for name in names {
        merge(&mut mapping, resolved_on.pinned(*name, true));
    }
    mapping
}

/// Whether the caller named `web_search` (in a list, or as a mapping key) rather than getting it
/// from the defaults; an explicit request on a model without native search
/// fails instead of being logged.
pub(crate) fn web_search_explicit(value: Option<&BuiltinToolsOption>) -> bool {
    match value {
        Some(BuiltinToolsOption::List(names)) => names.contains(&BuiltinToolName::WebSearch),
        Some(BuiltinToolsOption::Mapping(mapping)) => mapping.web_search.is_some(),
        None => false,
    }
}

/// How `web_search` is served (`WebSearchMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebSearchMode {
    /// A model flag on a provider with native search.
    Native,
    /// The AgentCore tool, on Bedrock.
    AgentCore,
    /// The third-party Exa tool.
    Exa,
}

/// How `web_search` is served for `model`: Exa whenever opted into, native where the model has
/// it, AgentCore on other Bedrock models, otherwise off (an error when it was requested
/// explicitly).
pub(crate) fn web_search_mode(
    setting: WebSearchSetting,
    explicit: bool,
    model: Option<&ModelSource>,
) -> strands::Result<Option<WebSearchMode>> {
    match setting {
        WebSearchSetting::Off => return Ok(None),
        WebSearchSetting::Exa => {
            tracing::warn!(
                "web_search is opted into Exa (exa.ai), a third-party service: every search query leaves your environment and is subject to Exa's privacy policy (https://exa.ai/privacy-policy)."
            );
            return Ok(Some(WebSearchMode::Exa));
        }
        _ => {}
    }
    match web_search_kind(model) {
        Some(WebSearchKind::Native) => return Ok(Some(WebSearchMode::Native)),
        Some(WebSearchKind::AgentCore) => return Ok(Some(WebSearchMode::AgentCore)),
        None => {}
    }
    let target = match model {
        None => format!("Model {DEFAULT_MODEL}"),
        Some(ModelSource::Id(spec)) => format!("Model {spec}"),
        Some(ModelSource::Router(_)) => "A pre-built ModelRouter".to_owned(),
        Some(_) => "A pre-built Model instance".to_owned(),
    };
    if explicit {
        return Err(strands::Error::other(format!(
            "{target} has no built-in web search. Pass builtinTools: {{ web_search: 'exa' }} to search through Exa (a third party), or remove 'web_search' from builtinTools. See https://strandsagents.com/docs/user-guide/harness/tools/web-access/#web_search"
        )));
    }
    tracing::info!(
        "{target} has no built-in web search, so the web_search tool is disabled. To enable it through Exa (a third party), pass builtinTools: {{ web_search: 'exa' }}. See https://strandsagents.com/docs/user-guide/harness/tools/web-access/#web_search"
    );
    Ok(None)
}

/// The tools of the enabled built-ins, in canonical order. `web_search` is built for the Exa and
/// AgentCore modes; native search is a model flag.
pub(crate) fn build_builtin_tools(
    resolved: &ResolvedBuiltinTools,
    web_search: Option<WebSearchMode>,
    parent: &Arc<ParentConfig>,
    env: &Env,
    factory: &BuiltinToolFactory,
) -> strands::Result<Vec<Arc<dyn Tool>>> {
    let mut tools = Vec::new();
    for name in resolved.enabled() {
        let tool = match name {
            BuiltinToolName::Shell => (factory.shell)(&resolved.shell_config().unwrap_or_default())?,
            BuiltinToolName::Read => {
                let media = resolved
                    .read_config()
                    .and_then(|config| config.media)
                    .unwrap_or_else(|| supports_media(parent.model.as_ref()));
                (factory.read)(ReadToolOptions { media })?
            }
            BuiltinToolName::Write => (factory.write)()?,
            BuiltinToolName::Edit => (factory.edit)()?,
            BuiltinToolName::WebFetch => {
                let config = resolved.web_fetch_config().unwrap_or_default();
                let model = resolve_web_fetch_model(parent.model.as_ref(), config.model.as_ref(), env)?;
                (factory.web_fetch)(WebFetchToolOptions {
                    model,
                    transport: config.transport,
                })?
            }
            BuiltinToolName::WebSearch => match web_search {
                Some(mode @ (WebSearchMode::Exa | WebSearchMode::AgentCore)) => (factory.web_search)(mode, env)?,
                _ => continue,
            },
            BuiltinToolName::ProgrammaticToolCaller => {
                (factory.programmatic_tool_caller)(&resolved.programmatic_tool_caller_config().unwrap_or_default())?
            }
            BuiltinToolName::Subagent => (factory.subagent)(subagent_tool_options(
                parent,
                resolved.subagent_config().unwrap_or_default(),
                env,
            ))?,
        };
        tools.push(tool);
    }
    Ok(tools)
}

/// What a `subagent` child can be granted: the parent's named consumer tools, plus its MCP
/// clients, which every child keeps.
#[derive(Clone, Default)]
pub(crate) struct Delegable {
    pub(crate) tools: Vec<(String, Arc<dyn Tool>)>,
    pub(crate) mcp_clients: Vec<ToolSource>,
}

impl Delegable {
    fn tool(&self, name: &str) -> Option<&Arc<dyn Tool>> {
        self.tools
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, tool)| tool)
    }
}

/// Indexes the parent's consumer tools for delegation. Only top-level named tools join the
/// selectable set; MCP clients are shared with every child (not reconnected), so a delegate keeps
/// every MCP tool.
pub(crate) fn delegable(tools: &[ToolSource]) -> Delegable {
    let mut delegable = Delegable::default();
    for source in tools {
        match source {
            ToolSource::Tool(tool) if delegable.tool(tool.name()).is_none() => {
                delegable.tools.push((tool.name().to_owned(), Arc::clone(tool)));
            }
            source if is_mcp_client(source) => delegable.mcp_clients.push(source.clone()),
            _ => {}
        }
    }
    delegable
}

/// What the default `subagent` tool is built from: the child builder, the selectable tools (the
/// parent's built-ins minus `web_search`, which is resolved per model, plus its consumer tools),
/// and the depth bound.
pub(crate) fn subagent_tool_options(
    parent: &Arc<ParentConfig>,
    config: SubagentConfig,
    env: &Env,
) -> SubagentToolOptions {
    let parent_builtins = resolve_builtin_tools(Some(&BuiltinToolsOption::Mapping(parent.builtin_tools.clone())));
    let delegable = Arc::new(delegable(&parent.tools));
    let inherited_tools = parent_builtins
        .enabled()
        .into_iter()
        .filter(|name| *name != BuiltinToolName::WebSearch)
        .map(|name| name.as_str().to_owned())
        .chain(delegable.tools.iter().map(|(name, _)| name.clone()))
        .collect();
    SubagentToolOptions {
        builder: child_builder(Arc::clone(parent), Arc::clone(&delegable), env.clone()),
        inherited_tools,
        max_depth: config.max_depth,
    }
}

fn child_builder(parent: Arc<ParentConfig>, delegable: Arc<Delegable>, env: Env) -> ChildBuilder {
    Arc::new(move |spec| {
        let options = child_options(&parent, &delegable, spec, &env);
        let env = env.clone();
        Box::pin(async move { create_harness_boxed(options?, env).await })
    })
}

/// The options a `subagent` child is built from: the parent's config with the spec applied,
/// printing off, sessions off and a recall-only view of the parent's memory.
pub(crate) fn child_options(
    parent: &ParentConfig,
    delegable: &Delegable,
    spec: ChildSpec,
    env: &Env,
) -> strands::Result<HarnessAgentOptions> {
    let mut options = parent.to_options();
    options.printer = Some(false);
    let parent_builtins = resolve_builtin_tools(Some(&BuiltinToolsOption::Mapping(parent.builtin_tools.clone())));
    let shared = match &parent.memory {
        None => Some(MemoryConfig::default()),
        Some(MemoryOption::On(config)) => Some(config.clone()),
        Some(_) => None,
    };
    if let Some(memory) = shared {
        let manager = resolve_memory(
            ResolveMemoryOptions {
                stores: memory.stores,
                model: parent.model.clone(),
                dir: memory.dir,
                web_fetch_model: parent_builtins.web_fetch_config().and_then(|config| config.model),
                read_only: true,
            },
            env,
        )?;
        options.memory_manager = Some(manager.into());
    }
    options.memory = Some(MemoryOption::Off);
    if let Some(instructions) = spec.instructions {
        options.instructions = Some(instructions);
    }
    if let Some(selected) = spec.tools {
        options.builtin_tools = Some(pinned_child_tools(parent, &parent_builtins, delegable, &selected).into());
        options.tools = selected
            .iter()
            .filter_map(|name| delegable.tool(name))
            .map(|tool| ToolSource::Tool(Arc::clone(tool)))
            .chain(delegable.mcp_clients.iter().cloned())
            .collect();
    }
    if let Some(model) = spec.model {
        options.model = Some(model);
    }
    Ok(options)
}

/// The child's built-in mapping for a narrowed selection: every name pinned so each tool keeps
/// its parent config, except `web_search`, which is not selectable: a parent that named it
/// passes its setting on for the child to resolve against its own model.
fn pinned_child_tools(
    parent: &ParentConfig,
    parent_builtins: &ResolvedBuiltinTools,
    delegable: &Delegable,
    selected: &[String],
) -> BuiltinToolsConfig {
    let builtin_names: Vec<BuiltinToolName> = selected
        .iter()
        .filter(|name| delegable.tool(name).is_none())
        .filter_map(|name| name.parse().ok())
        .collect();
    let explicit = parent.builtin_tools.web_search.is_some();
    let mut mapping = BuiltinToolsConfig::default();
    for &name in BUILTIN_TOOL_NAMES {
        if name == BuiltinToolName::WebSearch && !explicit {
            continue;
        }
        let keep = builtin_names.contains(&name) || name == BuiltinToolName::WebSearch;
        merge(&mut mapping, parent_builtins.pinned(name, keep));
    }
    mapping
}

fn is_mcp_client(source: &ToolSource) -> bool {
    #[cfg(feature = "mcp")]
    {
        matches!(source, ToolSource::McpClient(_))
    }
    #[cfg(not(feature = "mcp"))]
    {
        let _ = source;
        false
    }
}

#[cfg(test)]
mod tests;
