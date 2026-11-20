//! The bridge from a portable config to [`HarnessAgentOptions`].

use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use strands::ModelSource;
use strands::experimental::context_manager::ContextManagerStrategy;
use strands::types::JsonObject;
use strands::vended_plugins::skills::SkillSource;

use super::{
    HarnessAgentConfig, HarnessConfigBuiltinTools, HarnessConfigBuiltinToolsOption, HarnessConfigContextManager,
    HarnessConfigInterventions, HarnessConfigMcpServers, HarnessConfigModel, HarnessConfigSkills,
    HarnessModuleReference, normalize_harness_agent_config,
};
use crate::agent::{HarnessAgentOptions, MemoryOption, SessionOption, SkillsOption};
use crate::defaults::{DEFAULT_BUILTIN_PLUGINS, DEFAULT_BUILTIN_TOOLS, DEFAULT_MEMORY_DIR, DEFAULT_SESSION_DIR};
use crate::env::Env;
use crate::interventions::{InterventionValue, InterventionsOption};
use crate::logging::warn_once;
use crate::types::{BuiltinToolsConfig, MemoryConfig, SessionConfig, Setting, WebFetchConfig, json_string};

/// Maps a portable config onto [`HarnessAgentOptions`].
///
/// Directory options (`session.dir`, `memory.dir`, local `skills`, `.cedar` interventions, MCP
/// `cwd`) resolve against `base_dir` (the project root; the current directory when `None`),
/// `~` against the home directory. A file-backed `mcpServers` is read here and `${VAR}` or
/// `${env:VAR}` placeholders are expanded. Values equal to the harness defaults are left unset
/// so the factory's own defaults apply.
///
/// ```
/// use strands_harness::{DEFAULT_HARNESS_AGENT_CONFIG, harness_agent_options_from_config};
///
/// let options = harness_agent_options_from_config(&DEFAULT_HARNESS_AGENT_CONFIG, None)?;
/// assert_eq!(options.name.as_deref(), Some("Strands harness"));
/// assert!(options.builtin_tools.is_none());
/// # Ok::<(), strands::Error>(())
/// ```
///
/// # Errors
///
/// The config fails validation; it holds a module reference (`module references are not
/// supported in Rust yet`, plus ` (language "typescript")` when the reference names one); the
/// MCP file cannot be read; or an MCP placeholder names an unset variable.
pub fn harness_agent_options_from_config(
    config: &HarnessAgentConfig,
    base_dir: Option<&Path>,
) -> strands::Result<HarnessAgentOptions> {
    harness_agent_options_from_config_with_env(config, base_dir, &Env::process())
}

pub(crate) fn harness_agent_options_from_config_with_env(
    config: &HarnessAgentConfig,
    base_dir: Option<&Path>,
    env: &Env,
) -> strands::Result<HarnessAgentOptions> {
    let value = serde_json::to_value(config).map_err(strands::Error::other)?;
    let config = normalize_harness_agent_config(&value)?;
    reject_module_references(&config)?;
    let cwd = std::env::current_dir().map_err(strands::Error::other)?;
    let base_dir = normalize(&cwd.join(base_dir.unwrap_or(Path::new("."))));
    let paths = Paths {
        base_dir: &base_dir,
        env,
    };
    let mut options = agent_config_options(&config.agent_config)?;
    options.name = Some(config.name.clone());
    options.description = (!config.description.is_empty()).then(|| config.description.clone());
    options.instructions = (!config.instructions.is_empty()).then(|| config.instructions.clone());
    options.model = Some(ModelSource::Id(config.model.clone()));
    options.effort = config.effort;
    set_mcp_servers(&mut options, &config.mcp_servers, &paths)?;
    options.builtin_tools = builtin_tools_option(&config.builtin_tools);
    options.caching = (!config.caching).then_some(false);
    options.context_manager = Some(match config.context_manager {
        HarnessConfigContextManager::Agentic => ContextManagerStrategy::Agentic,
        HarnessConfigContextManager::Off => ContextManagerStrategy::Disabled,
        _ => ContextManagerStrategy::Auto,
    });
    options.session = Some(session_option(&config.session, &paths));
    options.skills = Some(skills_option(&config.skills, &paths));
    options.memory = Some(memory_option(&config.memory, &paths));
    options.builtin_plugins =
        (config.builtin_plugins != DEFAULT_BUILTIN_PLUGINS).then(|| config.builtin_plugins.clone());
    options.interventions = interventions_option(config.interventions.as_ref(), &paths);
    Ok(options)
}

fn module_error(reference: &HarnessModuleReference) -> strands::Error {
    let language = reference
        .language
        .map(|language| format!(" (language {})", json_string(language.as_str())))
        .unwrap_or_default();
    strands::Error::other(format!("module references are not supported in Rust yet{language}"))
}

/// Fails on the first module reference, in module load order.
fn reject_module_references(config: &HarnessAgentConfig) -> strands::Result<()> {
    let web_fetch_model = match &config.builtin_tools {
        HarnessConfigBuiltinToolsOption::Mapping(HarnessConfigBuiltinTools {
            web_fetch: Some(Setting::Config(web_fetch)),
            ..
        }) => match &web_fetch.model {
            Some(HarnessConfigModel::Module(reference)) => Some(reference),
            _ => None,
        },
        _ => None,
    };
    let first = config
        .tools
        .iter()
        .chain(&config.subagents)
        .chain(&config.plugins)
        .chain(&config.sandbox)
        .chain(&config.memory_stores)
        .chain(&config.model_module)
        .chain(web_fetch_model)
        .chain(&config.intervention_modules)
        .chain(config.agent_config_modules.iter().map(|(_, reference)| reference))
        .next();
    first.map_or(Ok(()), |reference| Err(module_error(reference)))
}

/// The JSON `agentConfig` fields Rust can apply; the rest are warned about and ignored.
fn agent_config_options(agent_config: &JsonObject) -> strands::Result<HarnessAgentOptions> {
    let mut options = HarnessAgentOptions::default();
    for (key, value) in agent_config {
        match (key.as_str(), value) {
            ("id", Value::String(id)) => options.id = Some(id.clone()),
            ("systemPrompt", Value::String(prompt)) => options.system_prompt = Some(prompt.clone().into()),
            ("printer", Value::Bool(printer)) => options.printer = Some(*printer),
            ("appState", Value::Object(state)) => options.app_state = Some(state.clone()),
            ("modelState", Value::Object(state)) => options.model_state = Some(state.clone()),
            ("messages", Value::Array(_)) => {
                options.messages = serde_json::from_value(value.clone()).map_err(strands::Error::other)?;
            }
            _ => warn_once(&format!("agentConfig.{key} is not supported in Rust yet; ignoring it.")),
        }
    }
    Ok(options)
}

/// Where relative paths resolve.
struct Paths<'a> {
    base_dir: &'a Path,
    env: &'a Env,
}

impl Paths<'_> {
    /// Resolves a directory option against the project root, `~` against the home directory.
    fn resolve(&self, value: &str) -> PathBuf {
        let home = || {
            self.env
                .get("HOME")
                .or_else(|| self.env.get("USERPROFILE"))
                .map_or_else(|| PathBuf::from("~"), PathBuf::from)
        };
        if value == "~" {
            return home();
        }
        if let Some(rest) = value.strip_prefix("~/") {
            return normalize(&home().join(rest));
        }
        normalize(&self.base_dir.join(value))
    }

    fn resolve_text(&self, value: &str) -> String {
        self.resolve(value).to_string_lossy().into_owned()
    }
}

/// Removes `.` and folds `..` lexically, as `path.resolve` does.
fn normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other),
        }
    }
    normalized
}

fn builtin_tools_option(value: &HarnessConfigBuiltinToolsOption) -> Option<crate::types::BuiltinToolsOption> {
    let mapping = match value {
        HarnessConfigBuiltinToolsOption::List(names) if names[..] == DEFAULT_BUILTIN_TOOLS => return None,
        HarnessConfigBuiltinToolsOption::List(names) => return Some(names.clone().into()),
        HarnessConfigBuiltinToolsOption::Mapping(mapping) => mapping,
    };
    let web_fetch = mapping.web_fetch.as_ref().map(|setting| match setting {
        Setting::Config(config) => Setting::Config(WebFetchConfig {
            model: match &config.model {
                Some(HarnessConfigModel::Name(name)) => Some(ModelSource::Id(name.clone())),
                _ => None,
            },
            transport: config.transport,
        }),
        Setting::Enabled(enabled) => Setting::Enabled(*enabled),
    });
    Some(
        BuiltinToolsConfig {
            all: mapping.all,
            shell: mapping.shell.clone(),
            read: mapping.read.clone(),
            write: mapping.write,
            edit: mapping.edit,
            web_fetch,
            web_search: mapping.web_search,
            programmatic_tool_caller: mapping.programmatic_tool_caller.clone(),
            subagent: mapping.subagent.clone(),
        }
        .into(),
    )
}

fn session_option(value: &Setting<SessionConfig>, paths: &Paths<'_>) -> SessionOption {
    let config = match value {
        Setting::Enabled(false) => return SessionOption::Off,
        Setting::Config(config) => config.clone(),
        Setting::Enabled(true) => SessionConfig::default(),
    };
    let dir = config.dir.as_deref().map_or_else(
        || DEFAULT_SESSION_DIR.to_owned(),
        |dir| dir.to_string_lossy().into_owned(),
    );
    SessionOption::On(SessionConfig {
        dir: Some(paths.resolve(&dir)),
        ..config
    })
}

fn skills_option(value: &HarnessConfigSkills, paths: &Paths<'_>) -> SkillsOption {
    let sources = match value {
        HarnessConfigSkills::Enabled(enabled) => return (*enabled).into(),
        HarnessConfigSkills::Source(source) => std::slice::from_ref(source),
        HarnessConfigSkills::Sources(sources) => sources.as_slice(),
    };
    SkillsOption::Sources(
        sources
            .iter()
            .map(|source| {
                if source.starts_with("https://") {
                    SkillSource::Url(source.clone())
                } else {
                    SkillSource::Path(paths.resolve_text(source))
                }
            })
            .collect(),
    )
}

fn memory_option(value: &Setting<super::HarnessConfigMemory>, paths: &Paths<'_>) -> MemoryOption {
    let dir = match value {
        Setting::Enabled(false) => return MemoryOption::Off,
        Setting::Config(config) => config.dir.clone(),
        Setting::Enabled(true) => None,
    };
    MemoryOption::On(MemoryConfig {
        dir: Some(paths.resolve(dir.as_deref().unwrap_or(DEFAULT_MEMORY_DIR))),
        stores: Vec::new(),
    })
}

fn interventions_option(value: Option<&HarnessConfigInterventions>, paths: &Paths<'_>) -> Option<InterventionsOption> {
    let resolve = |value: &String| -> InterventionValue {
        let trimmed = value.trim();
        if trimmed.ends_with(".cedar") {
            paths.resolve_text(trimmed).into()
        } else {
            value.clone().into()
        }
    };
    match value? {
        HarnessConfigInterventions::One(value) => Some(InterventionsOption::Value(resolve(value))),
        HarnessConfigInterventions::Many(values) if values.is_empty() => None,
        HarnessConfigInterventions::Many(values) if values.len() == 1 => {
            Some(InterventionsOption::Value(resolve(&values[0])))
        }
        HarnessConfigInterventions::Many(values) => {
            Some(InterventionsOption::List(values.iter().map(resolve).collect()))
        }
    }
}

/// The server map: a JSON file is read and either form unwrapped from an `mcpServers` key.
fn mcp_server_map(value: &HarnessConfigMcpServers, paths: &Paths<'_>) -> strands::Result<JsonObject> {
    let servers = match value {
        HarnessConfigMcpServers::Servers(servers) => servers.clone(),
        HarnessConfigMcpServers::Path(path) => {
            let invalid = || strands::Error::other(format!("MCP config {} must be valid JSON.", json_string(path)));
            let text = std::fs::read_to_string(paths.base_dir.join(path)).map_err(|_| invalid())?;
            let loaded: Value = serde_json::from_str(&text).map_err(|_| invalid())?;
            let Value::Object(servers) = loaded else {
                return Err(strands::Error::other(format!(
                    "MCP config {} must contain a server map.",
                    json_string(path)
                )));
            };
            servers
        }
    };
    match servers.get("mcpServers") {
        None => Ok(servers),
        Some(Value::Object(nested)) => Ok(nested.clone()),
        Some(_) => Err(strands::Error::other("mcpServers must contain a server map.")),
    }
}

/// The servers with each stdio server's `cwd` resolved (default: the project root) and env
/// placeholders expanded.
fn mcp_servers(value: &HarnessConfigMcpServers, paths: &Paths<'_>) -> strands::Result<JsonObject> {
    let mut servers = mcp_server_map(value, paths)?;
    for server in servers.values_mut() {
        let Value::Object(entry) = server else {
            continue;
        };
        if !entry.get("command").is_some_and(Value::is_string) {
            continue;
        }
        let cwd = match entry.get("cwd") {
            Some(Value::String(cwd)) => paths.resolve_text(cwd),
            _ => paths.base_dir.to_string_lossy().into_owned(),
        };
        entry.insert("cwd".to_owned(), Value::String(cwd));
    }
    let expanded = expand_env(Value::Object(servers), paths.env)?;
    Ok(match expanded {
        Value::Object(servers) => servers,
        _ => JsonObject::new(),
    })
}

#[cfg(feature = "mcp")]
fn set_mcp_servers(
    options: &mut HarnessAgentOptions,
    value: &HarnessConfigMcpServers,
    paths: &Paths<'_>,
) -> strands::Result<()> {
    let servers = mcp_servers(value, paths)?;
    if !servers.is_empty() {
        options.mcp_servers = Some(crate::McpServersOption::Json(servers));
    }
    Ok(())
}

#[cfg(not(feature = "mcp"))]
fn set_mcp_servers(
    _options: &mut HarnessAgentOptions,
    value: &HarnessConfigMcpServers,
    paths: &Paths<'_>,
) -> strands::Result<()> {
    if mcp_servers(value, paths)?.is_empty() {
        return Ok(());
    }
    Err(strands::Error::other(
        "mcpServers needs the strands-harness feature \"mcp\"; enable it to connect MCP servers.",
    ))
}

/// The variable a `${VAR}` or `${env:VAR}` placeholder at the start of `text` names, and the
/// placeholder's length.
fn placeholder(text: &str) -> Option<(&str, usize)> {
    let inner = text.strip_prefix("${")?;
    let (inner, prefix) = inner.strip_prefix("env:").map_or((inner, 2), |rest| (rest, 6));
    let first = inner.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let len = inner
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(inner.len());
    inner[len..].starts_with('}').then(|| (&inner[..len], prefix + len + 1))
}

fn expand_text(text: &str, env: &Env) -> strands::Result<String> {
    let mut expanded = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        expanded.push_str(&rest[..start]);
        rest = &rest[start..];
        match placeholder(rest) {
            Some((name, len)) => {
                let value = env.raw(name).ok_or_else(|| {
                    strands::Error::other(format!("Environment variable {} is not set.", json_string(name)))
                })?;
                expanded.push_str(&value);
                rest = &rest[len..];
            }
            None => {
                expanded.push_str("${");
                rest = &rest[2..];
            }
        }
    }
    expanded.push_str(rest);
    Ok(expanded)
}

/// Expands `${VAR}` and `${env:VAR}` in every string; an unset variable fails.
fn expand_env(value: Value, env: &Env) -> strands::Result<Value> {
    Ok(match value {
        Value::String(text) => Value::String(expand_text(&text, env)?),
        Value::Array(entries) => Value::Array(
            entries
                .into_iter()
                .map(|entry| expand_env(entry, env))
                .collect::<strands::Result<_>>()?,
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, entry)| Ok((key, expand_env(entry, env)?)))
                .collect::<strands::Result<_>>()?,
        ),
        other => other,
    })
}
