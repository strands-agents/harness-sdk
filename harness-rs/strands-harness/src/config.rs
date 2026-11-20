//! Portable harness configuration.
//!
//! [`HarnessAgentOptions`](crate::HarnessAgentOptions) is the runtime API and takes live SDK
//! objects; [`HarnessAgentConfig`] is the JSON form of the same agent definition, shared with the
//! other Strands harnesses. Live values are module references there, which Rust cannot load yet:
//! [`harness_agent_options_from_config`] rejects them with a clear error.

mod options;
mod validate;

use std::fmt;
use std::str::FromStr;
use std::sync::LazyLock;

use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};
use strands::types::JsonObject;

use crate::defaults::{DEFAULT_BUILTIN_PLUGINS, DEFAULT_BUILTIN_TOOLS, DEFAULT_EFFORT, DEFAULT_MODEL};
use crate::types::{
    Effort, ProgrammaticToolCallerConfig, ReadConfig, SessionConfig, Setting, ShellConfig, SubagentConfig,
    WebFetchTransport, WebSearchSetting, json_string,
};

pub use options::harness_agent_options_from_config;
#[cfg(test)]
pub(crate) use options::harness_agent_options_from_config_with_env;
pub(crate) use validate::normalize_harness_agent_config;

/// A built-in tool (`BuiltinToolName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BuiltinToolName {
    /// `shell`.
    Shell,
    /// `read`.
    Read,
    /// `write`.
    Write,
    /// `edit`.
    Edit,
    /// `web_fetch`.
    WebFetch,
    /// `web_search`.
    WebSearch,
    /// `programmatic_tool_caller`.
    ProgrammaticToolCaller,
    /// `subagent`.
    Subagent,
}

/// Every built-in tool, in canonical order (`BUILTIN_TOOL_NAMES`).
pub const BUILTIN_TOOL_NAMES: &[BuiltinToolName] = &[
    BuiltinToolName::Shell,
    BuiltinToolName::Read,
    BuiltinToolName::Write,
    BuiltinToolName::Edit,
    BuiltinToolName::WebFetch,
    BuiltinToolName::WebSearch,
    BuiltinToolName::ProgrammaticToolCaller,
    BuiltinToolName::Subagent,
];

impl BuiltinToolName {
    /// The tool name, such as `"web_fetch"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Read => "read",
            Self::Write => "write",
            Self::Edit => "edit",
            Self::WebFetch => "web_fetch",
            Self::WebSearch => "web_search",
            Self::ProgrammaticToolCaller => "programmatic_tool_caller",
            Self::Subagent => "subagent",
        }
    }

    /// The keys its per-tool config takes (`BUILTIN_TOOL_CONFIG_KEYS`), or `None` for a tool
    /// that takes only `true` or `false`.
    #[must_use]
    pub fn config_keys(self) -> Option<&'static [&'static str]> {
        BUILTIN_TOOL_CONFIG_KEYS
            .iter()
            .find(|(name, _)| *name == self)
            .map(|(_, keys)| *keys)
    }

    pub(crate) fn names() -> String {
        BUILTIN_TOOL_NAMES
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

impl fmt::Display for BuiltinToolName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BuiltinToolName {
    type Err = strands::Error;

    /// Parses a tool name; an unknown one fails listing the available tools.
    fn from_str(value: &str) -> strands::Result<Self> {
        BUILTIN_TOOL_NAMES
            .iter()
            .copied()
            .find(|name| name.as_str() == value)
            .ok_or_else(|| {
                strands::Error::other(format!(
                    "Unknown built-in tool {}. Available: {}.",
                    json_string(value),
                    Self::names()
                ))
            })
    }
}

/// The config keys each configurable built-in accepts (`BUILTIN_TOOL_CONFIG_KEYS`).
pub(crate) const BUILTIN_TOOL_CONFIG_KEYS: &[(BuiltinToolName, &[&str])] = &[
    (BuiltinToolName::Read, &["media"]),
    (BuiltinToolName::Shell, &["description"]),
    (BuiltinToolName::WebFetch, &["model", "transport"]),
    (BuiltinToolName::ProgrammaticToolCaller, &["allowedTools", "timeout"]),
    (BuiltinToolName::Subagent, &["maxDepth"]),
];

/// A built-in feature plugin (`BuiltinPluginName`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BuiltinPluginName {
    /// `todos`: the `todo_write` tool and a re-surfaced list before each step.
    Todos,
    /// `environment`: platform, date, working directory and project docs before each user turn.
    Environment,
}

/// Every built-in plugin (`BUILTIN_PLUGIN_NAMES`).
pub const BUILTIN_PLUGIN_NAMES: &[BuiltinPluginName] = &[BuiltinPluginName::Todos, BuiltinPluginName::Environment];

impl BuiltinPluginName {
    /// The plugin's option name, such as `"todos"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todos => "todos",
            Self::Environment => "environment",
        }
    }
}

impl fmt::Display for BuiltinPluginName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for BuiltinPluginName {
    type Err = strands::Error;

    /// Parses a plugin name; an unknown one fails listing the available plugins.
    fn from_str(value: &str) -> strands::Result<Self> {
        BUILTIN_PLUGIN_NAMES
            .iter()
            .copied()
            .find(|name| name.as_str() == value)
            .ok_or_else(|| {
                let mut available: Vec<&str> = BUILTIN_PLUGIN_NAMES.iter().map(|name| name.as_str()).collect();
                available.sort_unstable();
                strands::Error::other(format!(
                    "Unknown built-in plugin {}. Available: {}.",
                    json_string(value),
                    available.join(", ")
                ))
            })
    }
}

/// What a module reference provides (`HarnessModuleKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum HarnessModuleKind {
    /// `tool`.
    Tool,
    /// `subagent`.
    Subagent,
    /// `plugin`.
    Plugin,
    /// `sandbox`.
    Sandbox,
    /// `memory-store`.
    MemoryStore,
    /// `model`.
    Model,
    /// `intervention`.
    Intervention,
    /// `agent-config`.
    AgentConfig,
}

impl HarnessModuleKind {
    /// The config spelling, such as `"memory-store"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tool => "tool",
            Self::Subagent => "subagent",
            Self::Plugin => "plugin",
            Self::Sandbox => "sandbox",
            Self::MemoryStore => "memory-store",
            Self::Model => "model",
            Self::Intervention => "intervention",
            Self::AgentConfig => "agent-config",
        }
    }
}

/// The language a module reference is written in (`HarnessModuleLanguage`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum HarnessModuleLanguage {
    /// `typescript`.
    Typescript,
    /// `python`.
    Python,
}

impl HarnessModuleLanguage {
    /// The config spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Typescript => "typescript",
            Self::Python => "python",
        }
    }
}

/// A reference to a value defined in code (`HarnessModuleReference`). Rust parses and keeps
/// these so a config round-trips, but cannot load them yet.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct HarnessModuleReference {
    /// What the module provides.
    pub kind: HarnessModuleKind,
    /// The module specifier: a path or a package name.
    pub module: String,
    /// The export to read; `default` when `None`.
    pub export: Option<String>,
    /// The language the module is written in.
    pub language: Option<HarnessModuleLanguage>,
    /// Source files the module depends on.
    pub files: Option<Vec<String>>,
    /// The package the module comes from.
    pub dependency: Option<String>,
    /// Keys the reference carries beyond the known ones, kept as written.
    pub extra: JsonObject,
}

impl HarnessModuleReference {
    /// A reference of `kind` to `module`.
    pub fn new(kind: HarnessModuleKind, module: impl Into<String>) -> Self {
        Self {
            kind,
            module: module.into(),
            export: None,
            language: None,
            files: None,
            dependency: None,
            extra: JsonObject::new(),
        }
    }

    /// Sets the export to read.
    #[must_use]
    pub fn with_export(mut self, export: impl Into<String>) -> Self {
        self.export = Some(export.into());
        self
    }

    /// Sets the module's language.
    #[must_use]
    pub fn with_language(mut self, language: HarnessModuleLanguage) -> Self {
        self.language = Some(language);
        self
    }
}

impl Serialize for HarnessModuleReference {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("kind", &self.kind)?;
        map.serialize_entry("module", &self.module)?;
        if let Some(export) = &self.export {
            map.serialize_entry("export", export)?;
        }
        if let Some(language) = &self.language {
            map.serialize_entry("language", language)?;
        }
        if let Some(files) = &self.files {
            map.serialize_entry("files", files)?;
        }
        if let Some(dependency) = &self.dependency {
            map.serialize_entry("dependency", dependency)?;
        }
        for (key, value) in &self.extra {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// The summarizer model in a portable `web_fetch` config: a `"provider/name"` string or a model
/// module reference.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum HarnessConfigModel {
    /// A `"provider/name"` string.
    Name(String),
    /// A model module reference.
    Module(HarnessModuleReference),
}

impl Serialize for HarnessConfigModel {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Name(name) => serializer.serialize_str(name),
            Self::Module(reference) => reference.serialize(serializer),
        }
    }
}

/// JSON form of [`WebFetchConfig`](crate::WebFetchConfig) (`HarnessConfigWebFetch`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, bon::Builder)]
pub struct HarnessConfigWebFetch {
    /// The summarizer model.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<HarnessConfigModel>,
    /// How the request is made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<WebFetchTransport>,
}

/// JSON form of [`BuiltinToolsConfig`](crate::BuiltinToolsConfig) (`HarnessConfigBuiltinTools`),
/// with `web_fetch.model` allowed to be a module reference.
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct HarnessConfigBuiltinTools {
    /// The `"*"` key.
    pub all: Option<bool>,
    /// `shell`.
    pub shell: Option<Setting<ShellConfig>>,
    /// `read`.
    pub read: Option<Setting<ReadConfig>>,
    /// `write`.
    pub write: Option<bool>,
    /// `edit`.
    pub edit: Option<bool>,
    /// `web_fetch`.
    pub web_fetch: Option<Setting<HarnessConfigWebFetch>>,
    /// `web_search`.
    pub web_search: Option<WebSearchSetting>,
    /// `programmatic_tool_caller`.
    pub programmatic_tool_caller: Option<Setting<ProgrammaticToolCallerConfig>>,
    /// `subagent`.
    pub subagent: Option<Setting<SubagentConfig>>,
}

impl Serialize for HarnessConfigBuiltinTools {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        if let Some(all) = self.all {
            map.serialize_entry("*", &all)?;
        }
        if let Some(shell) = &self.shell {
            map.serialize_entry("shell", shell)?;
        }
        if let Some(read) = &self.read {
            map.serialize_entry("read", read)?;
        }
        if let Some(write) = self.write {
            map.serialize_entry("write", &write)?;
        }
        if let Some(edit) = self.edit {
            map.serialize_entry("edit", &edit)?;
        }
        if let Some(web_fetch) = &self.web_fetch {
            map.serialize_entry("web_fetch", web_fetch)?;
        }
        if let Some(web_search) = self.web_search {
            map.serialize_entry("web_search", &web_search)?;
        }
        if let Some(caller) = &self.programmatic_tool_caller {
            map.serialize_entry("programmatic_tool_caller", caller)?;
        }
        if let Some(subagent) = &self.subagent {
            map.serialize_entry("subagent", subagent)?;
        }
        map.end()
    }
}

/// The portable `builtinTools`: a list of names or a mapping.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
#[allow(clippy::large_enum_variant, reason = "a config value, built once")]
pub enum HarnessConfigBuiltinToolsOption {
    /// Exactly these tools.
    List(Vec<BuiltinToolName>),
    /// Edits to the defaults.
    Mapping(HarnessConfigBuiltinTools),
}

impl Serialize for HarnessConfigBuiltinToolsOption {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::List(names) => names.serialize(serializer),
            Self::Mapping(mapping) => mapping.serialize(serializer),
        }
    }
}

/// The portable `contextManager` (`HarnessConfigContextManager`: `"auto"`, `"agentic"` or
/// `false`; JSON also accepts `"off"` for `false`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum HarnessConfigContextManager {
    /// `'auto'` (the default).
    #[default]
    Auto,
    /// `'agentic'`.
    Agentic,
    /// `false`.
    Off,
}

impl Serialize for HarnessConfigContextManager {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Auto => serializer.serialize_str("auto"),
            Self::Agentic => serializer.serialize_str("agentic"),
            Self::Off => serializer.serialize_bool(false),
        }
    }
}

/// JSON form of [`MemoryConfig`](crate::MemoryConfig) (`HarnessConfigMemory`); stores are
/// declared separately as `memoryStores` module references.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, bon::Builder)]
#[builder(on(String, into))]
pub struct HarnessConfigMemory {
    /// Directory the default file store's files live in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

/// The portable `mcpServers`: a path to a JSON file, or the server map itself.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum HarnessConfigMcpServers {
    /// A path to a JSON file, resolved against the project root.
    Path(String),
    /// The server map, by name.
    Servers(JsonObject),
}

impl Default for HarnessConfigMcpServers {
    fn default() -> Self {
        Self::Servers(JsonObject::new())
    }
}

impl Serialize for HarnessConfigMcpServers {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Path(path) => serializer.serialize_str(path),
            Self::Servers(servers) => servers.serialize(serializer),
        }
    }
}

/// The portable `skills`: on or off, one source, or a list of sources.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HarnessConfigSkills {
    /// `true` scans the default directory; `false` disables skills.
    Enabled(bool),
    /// One directory path or `https://` URL.
    Source(String),
    /// Several sources.
    Sources(Vec<String>),
}

impl Serialize for HarnessConfigSkills {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Enabled(enabled) => serializer.serialize_bool(*enabled),
            Self::Source(source) => serializer.serialize_str(source),
            Self::Sources(sources) => sources.serialize(serializer),
        }
    }
}

/// The portable `interventions`: one value or a list (presets, `.cedar` paths, policies).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HarnessConfigInterventions {
    /// One value.
    One(String),
    /// Several values, layered in order.
    Many(Vec<String>),
}

impl Serialize for HarnessConfigInterventions {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::One(value) => serializer.serialize_str(value),
            Self::Many(values) => values.serialize(serializer),
        }
    }
}

/// Key-value pairs serialized as a JSON object in their order.
fn pairs_as_map<S: Serializer, T: Serialize>(pairs: &[(String, T)], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_map(pairs.iter().map(|(key, value)| (key, value)))
}

/// Dependencies a project declares for the runtimes that load its modules (`HarnessDependencies`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, bon::Builder)]
pub struct HarnessDependencies {
    /// npm package names to version ranges, in declaration order; serialized as a JSON object.
    #[serde(serialize_with = "pairs_as_map")]
    #[builder(default, with = |packages: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>| {
        packages.into_iter().map(|(name, version)| (name.into(), version.into())).collect()
    })]
    pub typescript: Vec<(String, String)>,
    /// pip requirement lines.
    #[builder(default, with = |lines: impl IntoIterator<Item = impl Into<String>>| lines.into_iter().map(Into::into).collect())]
    pub python: Vec<String>,
}

/// The complete portable form of a harness definition (`HarnessAgentConfig`).
///
/// Parse one from JSON with `serde_json`, which applies the config validation and its messages;
/// unknown keys are dropped with a warning.
///
/// ```
/// use strands_harness::{Effort, HarnessAgentConfig};
///
/// let config: HarnessAgentConfig = serde_json::from_value(serde_json::json!({
///     "name": "Reviewer",
///     "effort": "high",
///     "builtinTools": ["read", "shell"],
/// }))?;
/// assert_eq!(config.effort, Effort::High);
/// assert_eq!(config.model, "bedrock/global.anthropic.claude-opus-5");
/// # Ok::<(), serde_json::Error>(())
/// ```
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase", try_from = "serde_json::Value")]
#[builder(on(String, into))]
pub struct HarnessAgentConfig {
    /// The agent's name.
    #[builder(default = "Strands harness".to_owned())]
    pub name: String,
    /// What the agent does.
    #[builder(default)]
    pub description: String,
    /// A domain block appended after the harness contract.
    #[builder(default)]
    pub instructions: String,
    /// A `"provider/name"` model string.
    #[builder(default = DEFAULT_MODEL.to_owned())]
    pub model: String,
    /// A model defined in code, replacing `model`.
    pub model_module: Option<HarnessModuleReference>,
    /// Reasoning effort.
    #[builder(default = DEFAULT_EFFORT)]
    pub effort: Effort,
    /// Tools defined in code.
    #[builder(default)]
    pub tools: Vec<HarnessModuleReference>,
    /// Specialist agents defined in code, each exposed as a tool.
    #[builder(default)]
    pub subagents: Vec<HarnessModuleReference>,
    /// MCP servers to connect.
    #[builder(default)]
    pub mcp_servers: HarnessConfigMcpServers,
    /// Which built-in tools to enable.
    #[builder(default = HarnessConfigBuiltinToolsOption::List(DEFAULT_BUILTIN_TOOLS.to_vec()))]
    pub builtin_tools: HarnessConfigBuiltinToolsOption,
    /// Prompt caching.
    #[builder(default = true)]
    pub caching: bool,
    /// SDK context management.
    #[builder(default = HarnessConfigContextManager::Auto)]
    pub context_manager: HarnessConfigContextManager,
    /// Session persistence.
    #[builder(default = Setting::Enabled(true))]
    pub session: Setting<SessionConfig>,
    /// Agent Skills.
    #[builder(default = HarnessConfigSkills::Enabled(true))]
    pub skills: HarnessConfigSkills,
    /// Long-term memory.
    #[builder(default = Setting::Enabled(true))]
    pub memory: Setting<HarnessConfigMemory>,
    /// Memory stores defined in code.
    #[builder(default)]
    pub memory_stores: Vec<HarnessModuleReference>,
    /// Plugins defined in code.
    #[builder(default)]
    pub plugins: Vec<HarnessModuleReference>,
    /// Built-in feature plugins.
    #[builder(default = DEFAULT_BUILTIN_PLUGINS.to_vec())]
    pub builtin_plugins: Vec<BuiltinPluginName>,
    /// Tool-call interventions.
    pub interventions: Option<HarnessConfigInterventions>,
    /// Intervention handlers defined in code.
    #[builder(default)]
    pub intervention_modules: Vec<HarnessModuleReference>,
    /// A sandbox defined in code.
    pub sandbox: Option<HarnessModuleReference>,
    /// SDK `AgentConfig` values defined in code, by key, in declaration order; serialized as a
    /// JSON object.
    #[serde(serialize_with = "pairs_as_map")]
    #[builder(default)]
    pub agent_config_modules: Vec<(String, HarnessModuleReference)>,
    /// Dependencies of the referenced modules.
    #[builder(default)]
    pub dependencies: HarnessDependencies,
    /// JSON-compatible SDK `AgentConfig` fields the harness does not own.
    #[builder(default)]
    pub agent_config: JsonObject,
}

impl Default for HarnessAgentConfig {
    fn default() -> Self {
        Self::builder().build()
    }
}

impl TryFrom<serde_json::Value> for HarnessAgentConfig {
    type Error = String;

    fn try_from(value: serde_json::Value) -> Result<Self, String> {
        normalize_harness_agent_config(&value).map_err(|error| error.to_string())
    }
}

/// The defaults every key of a portable config falls back to (`DEFAULT_HARNESS_AGENT_CONFIG`).
pub static DEFAULT_HARNESS_AGENT_CONFIG: LazyLock<HarnessAgentConfig> = LazyLock::new(HarnessAgentConfig::default);

/// Validates a config built in code the way a parsed one is.
///
/// ```
/// use strands_harness::{HarnessAgentConfig, define_harness_agent_config};
///
/// let config = define_harness_agent_config(HarnessAgentConfig {
///     name: "Reviewer".into(),
///     ..Default::default()
/// })?;
/// assert_eq!(config.name, "Reviewer");
/// assert!(define_harness_agent_config(HarnessAgentConfig { name: String::new(), ..Default::default() }).is_err());
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// The validation messages, such as `Invalid agent config:\nname must be a non-empty string.`
pub fn define_harness_agent_config(config: HarnessAgentConfig) -> strands::Result<HarnessAgentConfig> {
    let value = serde_json::to_value(config).map_err(strands::Error::other)?;
    normalize_harness_agent_config(&value)
}

#[cfg(test)]
mod tests;
