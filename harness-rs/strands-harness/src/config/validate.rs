//! Normalization of a portable config, with the validation messages under each value's JSON path.

use std::path::PathBuf;

use serde_json::Value;
use strands::types::JsonObject;

use super::{
    BUILTIN_PLUGIN_NAMES, BUILTIN_TOOL_NAMES, BuiltinPluginName, BuiltinToolName, HarnessAgentConfig,
    HarnessConfigBuiltinTools, HarnessConfigBuiltinToolsOption, HarnessConfigContextManager,
    HarnessConfigInterventions, HarnessConfigMcpServers, HarnessConfigMemory, HarnessConfigModel, HarnessConfigSkills,
    HarnessConfigWebFetch, HarnessDependencies, HarnessModuleKind, HarnessModuleLanguage, HarnessModuleReference,
};
use crate::logging::warn_once;
use crate::types::{
    Effort, ProgrammaticToolCallerConfig, ReadConfig, SessionConfig, Setting, ShellConfig, SubagentConfig,
    WebFetchTransport, WebSearchSetting, json_string,
};

const NON_EMPTY: &str = "must be a non-empty string.";
const NON_EMPTY_STRINGS: &str = "must be an array of non-empty strings.";
const BOOLEAN: &str = "must be a boolean.";
const BOOLEAN_OR_CONFIG: &str = "must be a boolean or a config object.";
const BOOLEAN_OR_OBJECT: &str = "must be a boolean or an object.";
const OBJECT: &str = "must be an object.";
const NO_DUPLICATES: &str = "must not contain duplicates.";

/// The top-level keys, in schema order.
const CONFIG_KEYS: [&str; 24] = [
    "name",
    "description",
    "instructions",
    "model",
    "modelModule",
    "effort",
    "tools",
    "subagents",
    "mcpServers",
    "builtinTools",
    "caching",
    "contextManager",
    "session",
    "skills",
    "memory",
    "memoryStores",
    "plugins",
    "builtinPlugins",
    "interventions",
    "interventionModules",
    "sandbox",
    "agentConfigModules",
    "dependencies",
    "agentConfig",
];

const BUILTIN_TOOLS_KEYS: [&str; 9] = [
    "*",
    "shell",
    "read",
    "write",
    "edit",
    "web_fetch",
    "web_search",
    "programmatic_tool_caller",
    "subagent",
];

const MODULE_REFERENCE_KEYS: [&str; 6] = ["kind", "module", "export", "language", "files", "dependency"];

#[derive(Clone)]
enum Segment {
    Key(String),
    Index(usize),
}

/// A JSON path, formatted as `builtinTools.web_fetch.model` or `tools[0].module`.
#[derive(Clone, Default)]
struct Path(Vec<Segment>);

impl Path {
    fn key(&self, key: &str) -> Self {
        let mut segments = self.0.clone();
        segments.push(Segment::Key(key.to_owned()));
        Self(segments)
    }

    fn index(&self, index: usize) -> Self {
        let mut segments = self.0.clone();
        segments.push(Segment::Index(index));
        Self(segments)
    }

    fn format(&self) -> String {
        let text = self.0.iter().fold(String::new(), |text, segment| match segment {
            Segment::Index(index) => format!("{text}[{index}]"),
            Segment::Key(key) if text.is_empty() => key.clone(),
            Segment::Key(key) => format!("{text}.{key}"),
        });
        if text.is_empty() {
            "agent config".to_owned()
        } else {
            text
        }
    }
}

/// The issues found so far, one formatted line each.
#[derive(Default)]
struct Issues(Vec<String>);

impl Issues {
    fn push(&mut self, path: &Path, message: &str) {
        self.0.push(format!("{} {message}", path.format()));
    }

    fn count(&self) -> usize {
        self.0.len()
    }

    fn invalid_key(&mut self, path: &Path, key: &str) {
        self.0.push(format!(
            "{} has an invalid key {}: {NON_EMPTY}",
            path.format(),
            json_string(key)
        ));
    }

    fn unknown_keys(&mut self, path: &Path, object: &JsonObject, allowed: &[&str]) {
        let unknown: Vec<&str> = object
            .keys()
            .map(String::as_str)
            .filter(|key| !allowed.contains(key))
            .collect();
        if !unknown.is_empty() {
            self.push(
                path,
                &format!(
                    "has unknown keys: {}. Allowed: {}.",
                    unknown.join(", "),
                    allowed.join(", ")
                ),
            );
        }
    }
}

fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn is_blank(text: &str) -> bool {
    text.trim_matches(is_js_whitespace).is_empty()
}

fn non_empty(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) if !is_blank(text) => Some(text.clone()),
        _ => {
            issues.push(path, NON_EMPTY);
            None
        }
    }
}

fn optional_non_empty(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None => Some(None),
        Some(_) => non_empty(issues, path, value).map(Some),
    }
}

fn optional_bool(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<Option<bool>> {
    match value {
        None => Some(None),
        Some(Value::Bool(flag)) => Some(Some(*flag)),
        Some(_) => {
            issues.push(path, BOOLEAN);
            None
        }
    }
}

fn string_or_default(issues: &mut Issues, path: &Path, value: Option<&Value>, default: &str) -> Option<String> {
    match value {
        None => Some(default.to_owned()),
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            issues.push(path, "must be a string.");
            None
        }
    }
}

/// Each entry a non-empty string, reporting each failing entry under its index.
fn non_empty_entries(issues: &mut Issues, path: &Path, entries: &[Value]) -> Option<Vec<String>> {
    let before = issues.count();
    let strings: Vec<Option<String>> = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| non_empty(issues, &path.index(index), Some(entry)))
        .collect();
    (issues.count() == before).then(|| strings.into_iter().flatten().collect())
}

fn non_empty_strings(issues: &mut Issues, path: &Path, value: &Value, message: &str) -> Option<Vec<String>> {
    let Value::Array(entries) = value else {
        issues.push(path, message);
        return None;
    };
    non_empty_entries(issues, path, entries)
}

/// The entries that repeat an earlier one, in the order they first repeat.
fn repeated(entries: &[String]) -> Vec<&str> {
    let mut seen: Vec<&str> = Vec::new();
    let mut repeated: Vec<&str> = Vec::new();
    for entry in entries {
        if seen.contains(&entry.as_str()) {
            if !repeated.contains(&entry.as_str()) {
                repeated.push(entry);
            }
        } else {
            seen.push(entry);
        }
    }
    repeated
}

fn check_unique(issues: &mut Issues, path: &Path, entries: &[String]) -> bool {
    let repeated = repeated(entries);
    if repeated.is_empty() {
        return true;
    }
    issues.push(path, &format!("has duplicate entries: {}.", repeated.join(", ")));
    false
}

fn enum_list<T: Copy + PartialEq>(
    issues: &mut Issues,
    path: &Path,
    value: &Value,
    names: &[(T, &str)],
    not_array: &str,
) -> Option<Vec<T>> {
    let Value::Array(entries) = value else {
        issues.push(path, not_array);
        return None;
    };
    let allowed = names.iter().map(|(_, name)| *name).collect::<Vec<_>>().join(", ");
    let before = issues.count();
    let mut parsed = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match names.iter().find(|(_, name)| entry.as_str() == Some(name)) {
            Some((item, _)) => parsed.push(*item),
            None => issues.push(&path.index(index), &format!("must be one of: {allowed}.")),
        }
    }
    if issues.count() != before {
        return None;
    }
    let unique = parsed
        .iter()
        .enumerate()
        .all(|(index, item)| !parsed[..index].contains(item));
    if !unique {
        issues.push(path, NO_DUPLICATES);
        return None;
    }
    Some(parsed)
}

fn module_kind(text: &str) -> Option<HarnessModuleKind> {
    [
        HarnessModuleKind::Tool,
        HarnessModuleKind::Subagent,
        HarnessModuleKind::Plugin,
        HarnessModuleKind::Sandbox,
        HarnessModuleKind::MemoryStore,
        HarnessModuleKind::Model,
        HarnessModuleKind::Intervention,
        HarnessModuleKind::AgentConfig,
    ]
    .into_iter()
    .find(|kind| kind.as_str() == text)
}

fn module_language(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<Option<HarnessModuleLanguage>> {
    let Some(value) = value else {
        return Some(None);
    };
    let language = [HarnessModuleLanguage::Typescript, HarnessModuleLanguage::Python]
        .into_iter()
        .find(|language| value.as_str() == Some(language.as_str()));
    if language.is_none() {
        issues.push(path, "must be one of: typescript, python.");
        return None;
    }
    Some(language)
}

fn module_reference(
    issues: &mut Issues,
    path: &Path,
    value: &Value,
    kind: HarnessModuleKind,
) -> Option<HarnessModuleReference> {
    let Value::Object(object) = value else {
        issues.push(
            path,
            &format!("must be a module reference of kind {}.", json_string(kind.as_str())),
        );
        return None;
    };
    let before = issues.count();
    if let Some(given) = object.get("kind")
        && given.as_str().and_then(module_kind) != Some(kind)
    {
        issues.push(&path.key("kind"), &format!("must be {}.", json_string(kind.as_str())));
    }
    let module = non_empty(issues, &path.key("module"), object.get("module"));
    let export = optional_non_empty(issues, &path.key("export"), object.get("export"));
    let language = module_language(issues, &path.key("language"), object.get("language"));
    let files = object
        .get("files")
        .map(|files| non_empty_strings(issues, &path.key("files"), files, NON_EMPTY_STRINGS));
    let dependency = optional_non_empty(issues, &path.key("dependency"), object.get("dependency"));
    if issues.count() != before {
        return None;
    }
    let extra = object
        .iter()
        .filter(|(key, _)| !MODULE_REFERENCE_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Some(HarnessModuleReference {
        kind,
        module: module?,
        export: export?,
        language: language?,
        files: files.flatten(),
        dependency: dependency?,
        extra,
    })
}

fn module_references(
    issues: &mut Issues,
    path: &Path,
    value: Option<&Value>,
    kind: HarnessModuleKind,
) -> Vec<HarnessModuleReference> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Value::Array(entries) = value else {
        issues.push(
            path,
            &format!("must be an array of {} module references.", kind.as_str()),
        );
        return Vec::new();
    };
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| module_reference(issues, &path.index(index), entry, kind))
        .collect()
}

fn nullable_module_reference(
    issues: &mut Issues,
    path: &Path,
    value: Option<&Value>,
    kind: HarnessModuleKind,
) -> Option<HarnessModuleReference> {
    match value {
        None | Some(Value::Null) => None,
        Some(value) => module_reference(issues, path, value, kind),
    }
}

fn effort(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Effort {
    let Some(value) = value else {
        return Effort::default();
    };
    let parsed = value
        .as_str()
        .and_then(|text| Effort::ALL.into_iter().find(|effort| effort.as_str() == text));
    parsed.unwrap_or_else(|| {
        issues.push(path, &format!("must be one of: {}.", Effort::names()));
        Effort::default()
    })
}

fn mcp_servers(issues: &mut Issues, path: &Path, value: Option<&Value>) -> HarnessConfigMcpServers {
    match value {
        None => HarnessConfigMcpServers::default(),
        Some(Value::String(_)) => {
            non_empty(issues, path, value).map_or_else(HarnessConfigMcpServers::default, HarnessConfigMcpServers::Path)
        }
        Some(Value::Object(servers)) => HarnessConfigMcpServers::Servers(servers.clone()),
        Some(_) => {
            issues.push(path, "must be a path string or a mapping of server name to config.");
            HarnessConfigMcpServers::default()
        }
    }
}

fn tool_names() -> Vec<(BuiltinToolName, &'static str)> {
    BUILTIN_TOOL_NAMES.iter().map(|name| (*name, name.as_str())).collect()
}

fn builtin_tools(issues: &mut Issues, path: &Path, value: Option<&Value>) -> HarnessConfigBuiltinToolsOption {
    let default = || HarnessConfigBuiltinToolsOption::List(crate::defaults::DEFAULT_BUILTIN_TOOLS.to_vec());
    match value {
        None => default(),
        Some(list @ Value::Array(_)) => enum_list(issues, path, list, &tool_names(), "must be an array.")
            .map_or_else(default, HarnessConfigBuiltinToolsOption::List),
        Some(Value::Object(mapping)) => {
            HarnessConfigBuiltinToolsOption::Mapping(builtin_tools_mapping(issues, path, mapping))
        }
        Some(_) => {
            issues.push(
                path,
                "must be an array of tool names or a mapping of tool name to setting.",
            );
            default()
        }
    }
}

fn setting<C>(
    issues: &mut Issues,
    path: &Path,
    value: Option<&Value>,
    config: impl FnOnce(&mut Issues, &Path, &JsonObject) -> Option<C>,
) -> Option<Setting<C>> {
    match value? {
        Value::Bool(enabled) => Some(Setting::Enabled(*enabled)),
        Value::Object(object) => config(issues, path, object).map(Setting::Config),
        _ => {
            issues.push(path, BOOLEAN_OR_CONFIG);
            None
        }
    }
}

fn shell_config(issues: &mut Issues, path: &Path, object: &JsonObject) -> Option<ShellConfig> {
    let before = issues.count();
    let description = optional_non_empty(issues, &path.key("description"), object.get("description"));
    issues.unknown_keys(path, object, &["description"]);
    (issues.count() == before).then(|| ShellConfig {
        description: description.flatten(),
    })
}

fn read_config(issues: &mut Issues, path: &Path, object: &JsonObject) -> Option<ReadConfig> {
    let before = issues.count();
    let media = optional_bool(issues, &path.key("media"), object.get("media"));
    issues.unknown_keys(path, object, &["media"]);
    (issues.count() == before).then(|| ReadConfig { media: media.flatten() })
}

fn web_fetch_model(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<HarnessConfigModel> {
    match value? {
        Value::String(_) => non_empty(issues, path, value).map(HarnessConfigModel::Name),
        reference @ Value::Object(_) => {
            module_reference(issues, path, reference, HarnessModuleKind::Model).map(HarnessConfigModel::Module)
        }
        _ => {
            issues.push(path, "must be a \"provider/name\" string or a model module reference.");
            None
        }
    }
}

fn web_fetch_transport(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<WebFetchTransport> {
    match value?.as_str() {
        Some("curl") => Some(WebFetchTransport::Curl),
        Some("direct") => Some(WebFetchTransport::Direct),
        _ => {
            issues.push(path, "must be 'curl' or 'direct'.");
            None
        }
    }
}

fn web_fetch_config(issues: &mut Issues, path: &Path, object: &JsonObject) -> Option<HarnessConfigWebFetch> {
    let before = issues.count();
    let model = web_fetch_model(issues, &path.key("model"), object.get("model"));
    let transport = web_fetch_transport(issues, &path.key("transport"), object.get("transport"));
    issues.unknown_keys(path, object, &["model", "transport"]);
    (issues.count() == before).then_some(HarnessConfigWebFetch { model, transport })
}

fn web_search(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<WebSearchSetting> {
    match value? {
        Value::Bool(enabled) => Some((*enabled).into()),
        Value::String(text) if text == "exa" => Some(WebSearchSetting::Exa),
        _ => {
            issues.push(path, "must be a boolean or 'exa'.");
            None
        }
    }
}

fn allowed_tools(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<Vec<String>> {
    match value? {
        Value::Null => None,
        Value::Array(entries) => non_empty_entries(issues, path, entries),
        _ => {
            issues.push(path, "must be an array of non-empty strings or null.");
            None
        }
    }
}

fn caller_timeout(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<Option<f64>> {
    match value? {
        Value::Null => Some(None),
        Value::Number(number) if number.as_f64().is_some_and(|seconds| seconds > 0.0) => Some(number.as_f64()),
        _ => {
            issues.push(path, "must be a positive number or null.");
            None
        }
    }
}

fn caller_config(issues: &mut Issues, path: &Path, object: &JsonObject) -> Option<ProgrammaticToolCallerConfig> {
    let before = issues.count();
    let allowed_tools = allowed_tools(issues, &path.key("allowedTools"), object.get("allowedTools"));
    let timeout = caller_timeout(issues, &path.key("timeout"), object.get("timeout"));
    issues.unknown_keys(path, object, &["allowedTools", "timeout"]);
    (issues.count() == before).then_some(ProgrammaticToolCallerConfig { allowed_tools, timeout })
}

fn non_negative_integer(value: &Value) -> Option<usize> {
    if let Some(whole) = value.as_u64() {
        return usize::try_from(whole).ok();
    }
    let number = value.as_f64()?;
    let integral = number >= 0.0 && number.fract() == 0.0 && number <= f64::from(u32::MAX);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    integral.then_some(number as usize)
}

fn subagent_config(issues: &mut Issues, path: &Path, object: &JsonObject) -> Option<SubagentConfig> {
    let before = issues.count();
    let max_depth = object.get("maxDepth").and_then(|value| {
        let depth = non_negative_integer(value);
        if depth.is_none() {
            issues.push(&path.key("maxDepth"), "must be a non-negative integer.");
        }
        depth
    });
    issues.unknown_keys(path, object, &["maxDepth"]);
    (issues.count() == before).then_some(SubagentConfig { max_depth })
}

fn builtin_tools_mapping(issues: &mut Issues, path: &Path, mapping: &JsonObject) -> HarnessConfigBuiltinTools {
    let tools = HarnessConfigBuiltinTools {
        all: optional_bool(issues, &path.key("*"), mapping.get("*")).flatten(),
        shell: setting(issues, &path.key("shell"), mapping.get("shell"), shell_config),
        read: setting(issues, &path.key("read"), mapping.get("read"), read_config),
        write: optional_bool(issues, &path.key("write"), mapping.get("write")).flatten(),
        edit: optional_bool(issues, &path.key("edit"), mapping.get("edit")).flatten(),
        web_fetch: setting(
            issues,
            &path.key("web_fetch"),
            mapping.get("web_fetch"),
            web_fetch_config,
        ),
        web_search: web_search(issues, &path.key("web_search"), mapping.get("web_search")),
        programmatic_tool_caller: setting(
            issues,
            &path.key("programmatic_tool_caller"),
            mapping.get("programmatic_tool_caller"),
            caller_config,
        ),
        subagent: setting(issues, &path.key("subagent"), mapping.get("subagent"), subagent_config),
    };
    issues.unknown_keys(path, mapping, &BUILTIN_TOOLS_KEYS);
    tools
}

fn bool_or_default(issues: &mut Issues, path: &Path, value: Option<&Value>, default: bool) -> bool {
    optional_bool(issues, path, value).flatten().unwrap_or(default)
}

fn context_manager(issues: &mut Issues, path: &Path, value: Option<&Value>) -> HarnessConfigContextManager {
    match value {
        None => HarnessConfigContextManager::Auto,
        Some(Value::String(text)) if text == "auto" => HarnessConfigContextManager::Auto,
        Some(Value::String(text)) if text == "agentic" => HarnessConfigContextManager::Agentic,
        Some(Value::String(text)) if text == "off" => HarnessConfigContextManager::Off,
        Some(Value::Bool(false)) => HarnessConfigContextManager::Off,
        Some(_) => {
            issues.push(path, "must be one of: auto, agentic, off, false.");
            HarnessConfigContextManager::Auto
        }
    }
}

fn session(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Setting<SessionConfig> {
    match value {
        None => Setting::Enabled(true),
        Some(Value::Bool(enabled)) => Setting::Enabled(*enabled),
        Some(Value::Object(object)) => {
            let id = optional_non_empty(issues, &path.key("id"), object.get("id"));
            let dir = optional_non_empty(issues, &path.key("dir"), object.get("dir"));
            issues.unknown_keys(path, object, &["id", "dir"]);
            Setting::Config(SessionConfig {
                id: id.flatten(),
                dir: dir.flatten().map(PathBuf::from),
            })
        }
        Some(_) => {
            issues.push(path, BOOLEAN_OR_OBJECT);
            Setting::Enabled(true)
        }
    }
}

fn skills(issues: &mut Issues, path: &Path, value: Option<&Value>) -> HarnessConfigSkills {
    let default = HarnessConfigSkills::Enabled(true);
    match value {
        None => default,
        Some(Value::Bool(enabled)) => HarnessConfigSkills::Enabled(*enabled),
        Some(Value::String(_)) => non_empty(issues, path, value).map_or(default, HarnessConfigSkills::Source),
        Some(Value::Array(entries)) => match non_empty_entries(issues, path, entries) {
            Some(sources) if check_unique(issues, path, &sources) => HarnessConfigSkills::Sources(sources),
            _ => default,
        },
        Some(_) => {
            issues.push(path, "must be a boolean, a path string, or an array of path strings.");
            default
        }
    }
}

fn memory(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Setting<HarnessConfigMemory> {
    match value {
        None => Setting::Enabled(true),
        Some(Value::Bool(enabled)) => Setting::Enabled(*enabled),
        Some(Value::Object(object)) => {
            let dir = optional_non_empty(issues, &path.key("dir"), object.get("dir"));
            issues.unknown_keys(path, object, &["dir"]);
            Setting::Config(HarnessConfigMemory { dir: dir.flatten() })
        }
        Some(_) => {
            issues.push(path, BOOLEAN_OR_OBJECT);
            Setting::Enabled(true)
        }
    }
}

fn builtin_plugins(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Vec<BuiltinPluginName> {
    let default = || crate::defaults::DEFAULT_BUILTIN_PLUGINS.to_vec();
    let Some(value) = value else {
        return default();
    };
    let names: Vec<(BuiltinPluginName, &str)> =
        BUILTIN_PLUGIN_NAMES.iter().map(|name| (*name, name.as_str())).collect();
    enum_list(issues, path, value, &names, "must be an array.").unwrap_or_else(default)
}

fn interventions(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Option<HarnessConfigInterventions> {
    match value? {
        Value::Null => None,
        Value::String(_) => non_empty(issues, path, value).map(HarnessConfigInterventions::One),
        Value::Array(entries) => non_empty_entries(issues, path, entries).map(HarnessConfigInterventions::Many),
        _ => {
            issues.push(path, "must be a string, an array of strings, or null.");
            None
        }
    }
}

fn agent_config_modules(
    issues: &mut Issues,
    path: &Path,
    value: Option<&Value>,
) -> Vec<(String, HarnessModuleReference)> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Value::Object(object) = value else {
        issues.push(path, OBJECT);
        return Vec::new();
    };
    let mut modules = Vec::new();
    for (key, reference) in object {
        if is_blank(key) {
            issues.invalid_key(path, key);
            continue;
        }
        if let Some(reference) = module_reference(issues, &path.key(key), reference, HarnessModuleKind::AgentConfig) {
            modules.push((key.clone(), reference));
        }
    }
    modules
}

fn typescript_dependencies(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Vec<(String, String)> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Value::Object(object) = value else {
        issues.push(path, "must map package names to version strings.");
        return Vec::new();
    };
    let mut packages = Vec::new();
    for (name, version) in object {
        if is_blank(name) {
            issues.invalid_key(path, name);
            continue;
        }
        if let Some(version) = non_empty(issues, &path.key(name), Some(version)) {
            packages.push((name.clone(), version));
        }
    }
    packages
}

fn python_dependencies(issues: &mut Issues, path: &Path, value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(entries) = non_empty_strings(issues, path, value, NON_EMPTY_STRINGS) else {
        return Vec::new();
    };
    if entries.iter().any(|entry| entry.contains(['\r', '\n'])) {
        issues.push(path, "entries must not contain line breaks.");
    }
    check_unique(issues, path, &entries);
    entries
}

fn dependencies(issues: &mut Issues, path: &Path, value: Option<&Value>) -> HarnessDependencies {
    let Some(value) = value else {
        return HarnessDependencies::default();
    };
    let Value::Object(object) = value else {
        issues.push(path, OBJECT);
        return HarnessDependencies::default();
    };
    HarnessDependencies {
        typescript: typescript_dependencies(issues, &path.key("typescript"), object.get("typescript")),
        python: python_dependencies(issues, &path.key("python"), object.get("python")),
    }
}

fn agent_config(issues: &mut Issues, path: &Path, value: Option<&Value>) -> JsonObject {
    match value {
        None => JsonObject::new(),
        Some(Value::Object(object)) => object.clone(),
        Some(_) => {
            issues.push(path, OBJECT);
            JsonObject::new()
        }
    }
}

/// Validates a portable config: unknown keys are dropped with a
/// warning, absent keys take their defaults, and every invalid value is reported on its own
/// line under its JSON path.
pub(crate) fn normalize_harness_agent_config(value: &Value) -> strands::Result<HarnessAgentConfig> {
    let Value::Object(object) = value else {
        return Err(strands::Error::other("agent config must be an object."));
    };
    let mut unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !CONFIG_KEYS.contains(key))
        .collect();
    if !unknown.is_empty() {
        unknown.sort_unstable();
        warn_once(&format!("Ignoring unknown agent config keys: {}.", unknown.join(", ")));
    }
    let mut issues = Issues::default();
    let config = parse(&mut issues, object);
    if !issues.0.is_empty() {
        return Err(strands::Error::other(format!(
            "Invalid agent config:\n{}",
            issues.0.join("\n")
        )));
    }
    if config.memory == Setting::Enabled(false) && !config.memory_stores.is_empty() {
        warn_once("Ignoring memoryStores because memory is false.");
    }
    Ok(config)
}

fn parse(issues: &mut Issues, object: &JsonObject) -> HarnessAgentConfig {
    let root = Path::default();
    let field = |key: &str| (root.key(key), object.get(key));
    let defaults = HarnessAgentConfig::default();
    let (path, value) = field("name");
    let name = match value {
        None => defaults.name,
        Some(_) => non_empty(issues, &path, value).unwrap_or_default(),
    };
    let (path, value) = field("description");
    let description = string_or_default(issues, &path, value, "").unwrap_or_default();
    let (path, value) = field("instructions");
    let instructions = string_or_default(issues, &path, value, "").unwrap_or_default();
    let (path, value) = field("model");
    let model = match value {
        None => defaults.model,
        Some(_) => non_empty(issues, &path, value).unwrap_or_default(),
    };
    let (path, value) = field("modelModule");
    let model_module = nullable_module_reference(issues, &path, value, HarnessModuleKind::Model);
    let (path, value) = field("effort");
    let effort = effort(issues, &path, value);
    let (path, value) = field("tools");
    let tools = module_references(issues, &path, value, HarnessModuleKind::Tool);
    let (path, value) = field("subagents");
    let subagents = module_references(issues, &path, value, HarnessModuleKind::Subagent);
    let (path, value) = field("mcpServers");
    let mcp_servers = mcp_servers(issues, &path, value);
    let (path, value) = field("builtinTools");
    let builtin_tools = builtin_tools(issues, &path, value);
    let (path, value) = field("caching");
    let caching = bool_or_default(issues, &path, value, true);
    let (path, value) = field("contextManager");
    let context_manager = context_manager(issues, &path, value);
    let (path, value) = field("session");
    let session = session(issues, &path, value);
    let (path, value) = field("skills");
    let skills = skills(issues, &path, value);
    let (path, value) = field("memory");
    let memory = memory(issues, &path, value);
    let (path, value) = field("memoryStores");
    let memory_stores = module_references(issues, &path, value, HarnessModuleKind::MemoryStore);
    let (path, value) = field("plugins");
    let plugins = module_references(issues, &path, value, HarnessModuleKind::Plugin);
    let (path, value) = field("builtinPlugins");
    let builtin_plugins = builtin_plugins(issues, &path, value);
    let (path, value) = field("interventions");
    let interventions = interventions(issues, &path, value);
    let (path, value) = field("interventionModules");
    let intervention_modules = module_references(issues, &path, value, HarnessModuleKind::Intervention);
    let (path, value) = field("sandbox");
    let sandbox = nullable_module_reference(issues, &path, value, HarnessModuleKind::Sandbox);
    let (path, value) = field("agentConfigModules");
    let agent_config_modules = agent_config_modules(issues, &path, value);
    let (path, value) = field("dependencies");
    let dependencies = dependencies(issues, &path, value);
    let (path, value) = field("agentConfig");
    let agent_config = agent_config(issues, &path, value);
    HarnessAgentConfig {
        name,
        description,
        instructions,
        model,
        model_module,
        effort,
        tools,
        subagents,
        mcp_servers,
        builtin_tools,
        caching,
        context_manager,
        session,
        skills,
        memory,
        memory_stores,
        plugins,
        builtin_plugins,
        interventions,
        intervention_modules,
        sandbox,
        agent_config_modules,
        dependencies,
        agent_config,
    }
}
