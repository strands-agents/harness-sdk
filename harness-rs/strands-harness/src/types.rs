//! Option types for [`create_harness`](crate::create_harness).
//!
//! `*Config` is a data shape, `*Option` the set of forms the like-named option accepts, and
//! [`HarnessAgentOptions`](crate::HarnessAgentOptions) the config plus runtime-only fields.

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use serde::{Deserialize, Serialize, Serializer};
use strands::context_manager::ContextManagerStrategy;
use strands::memory::MemoryStore;

use crate::config::BuiltinToolName;
pub(crate) use crate::tools::programmatic_tool_caller::ProgrammaticToolCallerConfig;
pub(crate) use crate::tools::web_fetch::{WebFetchConfig, WebFetchTransport};
pub(crate) use crate::tools::web_search::WebSearchSetting;

/// Reasoning effort applied to the resolved model (`Effort`); see
/// [`HarnessAgentOptions::effort`](crate::HarnessAgentOptions::effort).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum Effort {
    /// The model vendor's default level, else the provider's recommended one (`'auto'`, the default).
    #[default]
    Auto,
    /// Reasoning off: the provider's `none` level where it has one, otherwise no reasoning field.
    Off,
    /// `'minimal'`.
    Minimal,
    /// `'low'`.
    Low,
    /// `'medium'`.
    Medium,
    /// `'high'`.
    High,
    /// `'xhigh'`.
    Xhigh,
    /// `'max'`.
    Max,
}

impl Effort {
    /// Every effort, in the order error messages list them.
    pub(crate) const ALL: [Self; 8] = [
        Self::Auto,
        Self::Off,
        Self::Minimal,
        Self::Low,
        Self::Medium,
        Self::High,
        Self::Xhigh,
        Self::Max,
    ];

    /// The config spelling, such as `"xhigh"`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }

    pub(crate) fn names() -> String {
        Self::ALL.map(Self::as_str).join(", ")
    }
}

impl fmt::Display for Effort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Effort {
    type Err = strands::Error;

    /// Parses the config spelling; anything else fails listing the supported efforts.
    fn from_str(value: &str) -> strands::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|effort| effort.as_str() == value)
            .ok_or_else(|| {
                strands::Error::other(format!(
                    "Effort {} is not valid. Supported: {}.",
                    json_string(value),
                    Self::names()
                ))
            })
    }
}

/// A setting that is a boolean or a config object, such as a built-in tool's entry in
/// [`BuiltinToolsConfig`]: on, off, or on with a config.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Setting<C> {
    /// `true` enables with the defaults; `false` disables.
    Enabled(bool),
    /// Enables and configures.
    Config(C),
}

impl<C> Setting<C> {
    /// Whether the setting enables what it configures.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        !matches!(self, Self::Enabled(false))
    }
}

impl<C> From<bool> for Setting<C> {
    fn from(enabled: bool) -> Self {
        Self::Enabled(enabled)
    }
}

impl<C: Serialize> Serialize for Setting<C> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Enabled(enabled) => serializer.serialize_bool(*enabled),
            Self::Config(config) => config.serialize(serializer),
        }
    }
}

macro_rules! setting_from {
    ($($config:ty),* $(,)?) => {$(
        impl From<$config> for Setting<$config> {
            fn from(config: $config) -> Self {
                Self::Config(config)
            }
        }
    )*};
}

setting_from!(
    ReadConfig,
    ShellConfig,
    WebFetchConfig,
    ProgrammaticToolCallerConfig,
    SubagentConfig,
    SessionConfig,
    MemoryConfig,
    crate::config::HarnessConfigWebFetch,
    crate::config::HarnessConfigMemory,
);

/// Per-tool config for the `subagent` built-in (`SubagentConfig`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubagentConfig {
    /// How many levels of delegation a child may itself open; `0` removes the tool. 2 when
    /// absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
}

/// Per-tool config for the `read` built-in (`ReadConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, bon::Builder)]
pub struct ReadConfig {
    /// Return images and binary documents as viewable media. Defaults to whether the model
    /// accepts them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<bool>,
}

/// Per-tool config for the `shell` built-in (`ShellConfig`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, bon::Builder)]
pub struct ShellConfig {
    /// Tool description shown to the model; `None` for the SDK's default.
    #[builder(into)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Edits to the default built-in tool set (`BuiltinToolsConfig`). `false` disables a tool,
/// `true` enables it, and a per-tool config enables and configures it (`web_search` takes
/// [`WebSearchSetting::Exa`] instead). `all` is the portable config's `"*"` key (default `true`):
/// it includes the harness defaults; set it to `false` to start from nothing and enable tools one by one.
///
/// ```
/// use strands_harness::{BuiltinToolsConfig, ShellConfig};
///
/// let edits = BuiltinToolsConfig::builder()
///     .subagent(false)
///     .shell(ShellConfig::builder().description("Run a command.").build())
///     .build();
/// assert!(edits.all.is_none());
/// ```
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct BuiltinToolsConfig {
    /// Whether the harness defaults are the baseline (`"*"`); `true` when `None`.
    pub all: Option<bool>,
    /// `shell`.
    #[builder(into)]
    pub shell: Option<Setting<ShellConfig>>,
    /// `read`.
    #[builder(into)]
    pub read: Option<Setting<ReadConfig>>,
    /// `write`; takes no config.
    pub write: Option<bool>,
    /// `edit`; takes no config.
    pub edit: Option<bool>,
    /// `web_fetch`.
    #[builder(into)]
    pub web_fetch: Option<Setting<WebFetchConfig>>,
    /// `web_search`.
    #[builder(into)]
    pub web_search: Option<WebSearchSetting>,
    /// `programmatic_tool_caller`.
    #[builder(into)]
    pub programmatic_tool_caller: Option<Setting<ProgrammaticToolCallerConfig>>,
    /// `subagent`.
    #[builder(into)]
    pub subagent: Option<Setting<SubagentConfig>>,
}

/// What `builtin_tools` accepts: a list pins exactly those tools (an empty list disables them
/// all), a mapping edits the defaults.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum BuiltinToolsOption {
    /// Exactly these tools.
    List(Vec<BuiltinToolName>),
    /// Edits to the defaults.
    Mapping(BuiltinToolsConfig),
}

impl From<Vec<BuiltinToolName>> for BuiltinToolsOption {
    fn from(names: Vec<BuiltinToolName>) -> Self {
        Self::List(names)
    }
}

impl From<&[BuiltinToolName]> for BuiltinToolsOption {
    fn from(names: &[BuiltinToolName]) -> Self {
        Self::List(names.to_vec())
    }
}

impl<const N: usize> From<[BuiltinToolName; N]> for BuiltinToolsOption {
    fn from(names: [BuiltinToolName; N]) -> Self {
        Self::List(names.to_vec())
    }
}

impl From<BuiltinToolsConfig> for BuiltinToolsOption {
    fn from(config: BuiltinToolsConfig) -> Self {
        Self::Mapping(config)
    }
}

/// Session persistence (`SessionConfig`); the empty config selects the defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, bon::Builder)]
pub struct SessionConfig {
    /// Identifier for the session's stored state, sanitized to `[a-z0-9_-]`. Defaults to a fresh
    /// random 8-hex id each run; pass a previous run's [`Agent::session_id`](strands::Agent::session_id)
    /// to resume it.
    #[builder(into)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Root directory for session state and offloaded artifacts. Defaults to `./.agent/sessions`.
    #[builder(into)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<PathBuf>,
}

/// The harness's default long-term memory (`MemoryConfig`); the empty config selects the
/// defaults. For a different policy pass the SDK's
/// [`memory_manager`](crate::HarnessAgentOptions::memory_manager) instead.
#[derive(Clone, Default, bon::Builder)]
pub struct MemoryConfig {
    /// Directory the default file store's files live in. Defaults to `./.agent/memory`.
    #[builder(into)]
    pub dir: Option<PathBuf>,
    /// Replaces the default file store while keeping the harness's memory policy (injection on,
    /// `search_memory` on, no `add_memory` tool). Unlike a full memory manager, the `subagent`
    /// delegate shares these stores read-only. Empty selects the default store.
    #[builder(default)]
    pub stores: Vec<Arc<dyn MemoryStore>>,
}

impl fmt::Debug for MemoryConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryConfig")
            .field("dir", &self.dir)
            .field(
                "stores",
                &self.stores.iter().map(|store| store.name()).collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// What `context_manager` accepts (`ContextManagerOption`): exactly the SDK's
/// [`ContextManagerStrategy`], whose [`Disabled`](ContextManagerStrategy::Disabled) stands for
/// both `false` and `null`.
pub type ContextManagerOption = ContextManagerStrategy;

/// A string as `JSON.stringify` writes it, for error messages that quote values.
pub(crate) fn json_string(value: &str) -> String {
    serde_json::Value::String(value.to_owned()).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_effort_outside_the_enum_by_name() {
        let error = "bogus".parse::<Effort>().unwrap_err();
        assert_eq!(
            error.to_string(),
            "Effort \"bogus\" is not valid. Supported: auto, off, minimal, low, medium, high, xhigh, max."
        );
        assert_eq!("xhigh".parse::<Effort>().unwrap(), Effort::Xhigh);
    }
}

/// Where `mcp_servers` come from. The type exists with or without the `mcp` feature; without it,
/// [`create_harness`](crate::create_harness) fails when servers are set.
///
/// ```
/// use strands_harness::McpServersOption;
///
/// assert!(matches!(McpServersOption::from("./mcp.json"), McpServersOption::Path(_)));
/// ```
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum McpServersOption {
    /// A JSON config file: a flat `{ name: {..} }` map, or that map under `mcpServers`.
    Path(PathBuf),
    /// Server entries by name, as JSON.
    Json(strands::types::JsonObject),
    /// An SDK source, typed server configs included.
    #[cfg(feature = "mcp")]
    Source(strands::mcp::McpServersSource),
}

impl From<&str> for McpServersOption {
    fn from(path: &str) -> Self {
        Self::Path(PathBuf::from(path))
    }
}

impl From<String> for McpServersOption {
    fn from(path: String) -> Self {
        Self::Path(PathBuf::from(path))
    }
}

impl From<PathBuf> for McpServersOption {
    fn from(path: PathBuf) -> Self {
        Self::Path(path)
    }
}

impl From<strands::types::JsonObject> for McpServersOption {
    fn from(servers: strands::types::JsonObject) -> Self {
        Self::Json(servers)
    }
}

#[cfg(feature = "mcp")]
impl From<strands::mcp::McpServersSource> for McpServersOption {
    fn from(source: strands::mcp::McpServersSource) -> Self {
        Self::Source(source)
    }
}

#[cfg(feature = "mcp")]
impl McpServersOption {
    pub(crate) fn into_source(self) -> strands::mcp::McpServersSource {
        match self {
            Self::Path(path) => strands::mcp::McpServersSource::Path(path),
            Self::Json(servers) => strands::mcp::McpServersSource::Json(servers),
            Self::Source(source) => source,
        }
    }
}
