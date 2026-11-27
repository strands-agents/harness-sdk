//! The `AgentSkills` plugin.

use std::cmp::Ordering;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, RwLock, Weak};

use async_trait::async_trait;
use futures::future::{BoxFuture, join_all};
use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::Deserialize;
use tokio::sync::OnceCell;

use super::skill::{Skill, SkillLoadOptions, UrlFetcher};
use crate::agent::{LocalAgent, ToolAgent};
use crate::error::{Error, Result};
use crate::hooks::BeforeInvocationEvent;
use crate::plugins::Plugin;
use crate::sandbox::{FileInfo, Sandbox};
use crate::state_store::StateStore;
use crate::tools::{FunctionTool, ToolContext, ToolError, ToolSource};
use crate::types::{JsonObject, JsonValue, SystemContentBlock, SystemPrompt};

const AGENT_SKILLS_NAME: &str = "strands:agent-skills";
const DEFAULT_STATE_KEY: &str = "agent_skills";
const RESOURCE_DIRS: [&str; 3] = ["scripts", "references", "assets"];
const DEFAULT_MAX_RESOURCE_FILES: usize = 20;
const MAX_RESOURCE_DEPTH: usize = 3;
const SKILL_MD_NAMES: [&str; 2] = ["SKILL.md", "skill.md"];
const SKILLS_TOOL_DESCRIPTION: &str = "Activate a skill to load its full instructions. Use this tool to load the complete instructions for a skill listed in the available_skills section of your system prompt.";
const NO_SKILLS_XML: &str = "<available_skills>\nNo skills are currently available.\n</available_skills>";

type SkillMap = IndexMap<String, Skill>;

/// One skill source (`SkillSource`): a [`Skill`], a filesystem path (a skill directory, its
/// `SKILL.md`, or a parent directory of skill directories), or an `https://` URL of raw
/// `SKILL.md` content.
///
/// Strings convert by prefix: `https://` is a URL, anything else a path.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum SkillSource {
    /// A skill instance.
    Skill(Box<Skill>),
    /// A filesystem path, read through the agent's sandbox when the plugin initializes.
    Path(String),
    /// An `https://` URL of raw `SKILL.md` content.
    Url(String),
}

impl From<Skill> for SkillSource {
    fn from(skill: Skill) -> Self {
        Self::Skill(Box::new(skill))
    }
}

impl From<String> for SkillSource {
    fn from(source: String) -> Self {
        if source.starts_with("https://") {
            Self::Url(source)
        } else {
            Self::Path(source)
        }
    }
}

impl From<&str> for SkillSource {
    fn from(source: &str) -> Self {
        Self::from(source.to_owned())
    }
}

impl From<&String> for SkillSource {
    fn from(source: &String) -> Self {
        Self::from(source.clone())
    }
}

/// Always a [`Path`](SkillSource::Path), whatever its text; a path that is not UTF-8 is converted
/// lossily.
impl From<&Path> for SkillSource {
    fn from(path: &Path) -> Self {
        Self::Path(path.to_string_lossy().into_owned())
    }
}

/// Always a [`Path`](SkillSource::Path); see `From<&Path>`.
impl From<PathBuf> for SkillSource {
    fn from(path: PathBuf) -> Self {
        Self::from(path.as_path())
    }
}

/// Always a [`Path`](SkillSource::Path); see `From<&Path>`.
impl From<&PathBuf> for SkillSource {
    fn from(path: &PathBuf) -> Self {
        Self::from(path.as_path())
    }
}

/// Configuration for [`AgentSkills`] (`AgentSkillsConfig`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct AgentSkillsConfig {
    /// The skill sources.
    #[builder(default, with = |skills: impl IntoIterator<Item = impl Into<SkillSource>>| {
        skills.into_iter().map(Into::into).collect()
    })]
    pub skills: Vec<SkillSource>,
    /// Maximum number of resource files listed in a skill response. Defaults to 20.
    pub max_resource_files: Option<usize>,
    /// Fail on skill validation issues instead of warning and loading anyway. Defaults to
    /// `false`.
    pub strict: Option<bool>,
    /// The `app_state` key holding the plugin's per-agent state. Defaults to `agent_skills`.
    #[builder(into)]
    pub state_key: Option<String>,
}

/// Adds [AgentSkills.io](https://agentskills.io) skills to an agent (`AgentSkills`).
///
/// The plugin gives the agent a `skills` tool that loads a skill's full instructions on demand,
/// lists the available skills (name, description, location) in the system prompt before each
/// invocation, and records the activated skills in `app_state` under its state key.
///
/// Skill instances and URLs resolve once for the plugin; paths are read through the agent's
/// sandbox when the plugin initializes on an agent, so one plugin shared by several agents loads
/// each agent's skills from its own filesystem.
///
/// ```
/// use strands::Agent;
/// use strands::testing::MockModel;
/// use strands::vended_plugins::skills::{AgentSkills, AgentSkillsConfig, Skill, SkillConfig};
///
/// let skill = Skill::new(SkillConfig {
///     name: "my-skill".into(),
///     description: "A custom skill".into(),
///     instructions: Some("Do the thing".into()),
///     ..Default::default()
/// });
/// let skills = AgentSkills::new(AgentSkillsConfig::builder().skills([skill]).build());
/// let agent = Agent::builder()
///     .model(MockModel::new())
///     .plugins([skills])
///     .printer(false)
///     .build()?;
/// # let _ = agent;
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Clone)]
pub struct AgentSkills {
    inner: Arc<Inner>,
}

struct Inner {
    strict: bool,
    max_resource_files: usize,
    state_key: String,
    fetcher: UrlFetcher,
    resolved: RwLock<Arc<Resolved>>,
    agent_skills: Mutex<Vec<AgentEntry>>,
}

/// The skill set of the current sources: instances now, URLs once fetched, paths per agent.
struct Resolved {
    instances: SkillMap,
    urls: Vec<String>,
    paths: Vec<String>,
    base: OnceCell<Arc<SkillMap>>,
}

/// One agent's loaded skills, keyed by its `app_state`.
struct AgentEntry {
    state: Weak<RwLock<JsonObject>>,
    resolved: Weak<Resolved>,
    skills: Arc<SkillMap>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SkillsInput {
    /// Name of the skill to activate
    #[schemars(length(min = 1))]
    skill_name: String,
}

impl AgentSkills {
    /// Creates the plugin (`new AgentSkills(config)`). URL sources are fetched when the plugin
    /// first needs them; paths are read when it initializes on an agent.
    #[must_use]
    pub fn new(config: AgentSkillsConfig) -> Self {
        Self::with_fetcher(config, UrlFetcher::default())
    }

    pub(crate) fn with_fetcher(config: AgentSkillsConfig, fetcher: UrlFetcher) -> Self {
        let resolved = Arc::new(resolve_sources(config.skills));
        Self {
            inner: Arc::new(Inner {
                strict: config.strict.unwrap_or(false),
                max_resource_files: config.max_resource_files.unwrap_or(DEFAULT_MAX_RESOURCE_FILES),
                state_key: config.state_key.unwrap_or_else(|| DEFAULT_STATE_KEY.to_owned()),
                fetcher,
                resolved: RwLock::new(resolved),
                agent_skills: Mutex::new(Vec::new()),
            }),
        }
    }

    /// The available skills: with an agent, that agent's full set (the
    /// plugin's skills plus those loaded from its paths); without one, the skill instances and
    /// URL skills only.
    pub async fn get_available_skills(&self, agent: Option<&LocalAgent>) -> Vec<Skill> {
        let resolved = self.inner.current();
        let base = self.inner.base(&resolved).await;
        let skills = agent
            .and_then(|agent| self.inner.agent_entry(agent.app_state(), &resolved))
            .unwrap_or(base);
        skills.values().cloned().collect()
    }

    /// Replaces every skill source. Agents load their skills again on
    /// their next invocation or `skills` call; their activated-skill state is kept.
    pub fn set_available_skills(&self, skills: impl IntoIterator<Item = impl Into<SkillSource>>) {
        let resolved = Arc::new(resolve_sources(skills.into_iter().map(Into::into).collect()));
        *self.inner.resolved.write().unwrap_or_else(PoisonError::into_inner) = resolved;
        self.inner
            .agent_skills
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// The skills `agent` activated, most recent last.
    #[must_use]
    pub fn get_activated_skills(&self, agent: &LocalAgent) -> Vec<String> {
        self.inner.activated_skills(agent.app_state())
    }

    fn skills_tool(&self) -> FunctionTool {
        let inner = self.inner.clone();
        FunctionTool::builder("skills", SKILLS_TOOL_DESCRIPTION)
            .input_schema_for::<SkillsInput>()
            .callback(move |input, context| {
                let inner = inner.clone();
                async move {
                    let input: SkillsInput = serde_json::from_value(input)?;
                    inner.activate_skill(&input.skill_name, &context).await
                }
            })
    }
}

impl fmt::Debug for AgentSkills {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AgentSkills")
            .field("strict", &self.inner.strict)
            .field("max_resource_files", &self.inner.max_resource_files)
            .field("state_key", &self.inner.state_key)
            .finish_non_exhaustive()
    }
}

#[async_trait]
impl Plugin for AgentSkills {
    fn name(&self) -> &str {
        AGENT_SKILLS_NAME
    }

    async fn init_agent(&self, agent: &mut LocalAgent) -> Result<()> {
        let resolved = self.inner.current();
        self.inner.base(&resolved).await;
        let skills = self.inner.load_skill_paths(agent, &resolved).await;
        if skills.is_empty() {
            tracing::warn!("no skills were loaded, the agent will have no skills available");
        }
        tracing::debug!("skill_count=<{}> | skills plugin initialized", skills.len());

        let inner = self.inner.clone();
        agent.add_async_hook::<BeforeInvocationEvent<'_>>(move |event| {
            let inner = inner.clone();
            Box::pin(async move { inner.before_invocation(event.agent_mut()).await })
        });
        Ok(())
    }

    fn get_tools(&self) -> Vec<ToolSource> {
        vec![ToolSource::from(self.skills_tool())]
    }
}

/// The sandbox the agent reads skill files through (`agent.sandbox`).
fn agent_sandbox(agent: &LocalAgent) -> Arc<dyn Sandbox> {
    Arc::clone(agent.sandbox())
}

/// The sandbox a tool call reads skill resources through (`context.agent.sandbox`).
fn tool_agent_sandbox(agent: &ToolAgent) -> Arc<dyn Sandbox> {
    Arc::clone(agent.sandbox())
}

fn insert_skill(skills: &mut SkillMap, skill: Skill) {
    if skills.contains_key(skill.name()) {
        tracing::warn!(
            "name=<{}> | duplicate skill name, overwriting previous skill",
            skill.name()
        );
    }
    skills.insert(skill.name().to_owned(), skill);
}

/// Sorts the sources: instances into the map, URLs and paths for later.
fn resolve_sources(sources: Vec<SkillSource>) -> Resolved {
    let source_count = sources.len();
    let mut resolved = Resolved {
        instances: SkillMap::new(),
        urls: Vec::new(),
        paths: Vec::new(),
        base: OnceCell::new(),
    };
    for source in sources {
        match source {
            SkillSource::Skill(skill) => insert_skill(&mut resolved.instances, *skill),
            SkillSource::Url(url) => resolved.urls.push(url),
            SkillSource::Path(path) => resolved.paths.push(path),
        }
    }
    if resolved.urls.is_empty() {
        tracing::debug!(
            "source_count=<{source_count}>, resolved_count=<{}> | skills resolved",
            resolved.instances.len()
        );
    }
    resolved
}

/// Orders directory names: letters case-insensitively, then lowercase first.
fn locale_compare(a: &str, b: &str) -> Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a))
}

/// The `SKILL.md` (preferred) or `skill.md` file among directory entries.
fn find_skill_md_name(entries: &[FileInfo]) -> Option<&'static str> {
    SKILL_MD_NAMES.into_iter().find(|name| {
        entries
            .iter()
            .any(|entry| !entry.is_dir.unwrap_or(false) && entry.name == *name)
    })
}

/// The type name of a JSON value that is not `null`: `string`, `number`, `boolean` or `object`.
fn js_typeof(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::String(_) => "string",
        JsonValue::Number(_) => "number",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Null | JsonValue::Array(_) | JsonValue::Object(_) => "object",
    }
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

impl Inner {
    fn current(&self) -> Arc<Resolved> {
        self.resolved.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The instances plus the URL skills, fetched once per source set (`_ready`).
    async fn base(&self, resolved: &Resolved) -> Arc<SkillMap> {
        resolved
            .base
            .get_or_init(|| async {
                let mut skills = resolved.instances.clone();
                if resolved.urls.is_empty() {
                    return Arc::new(skills);
                }
                let options = SkillLoadOptions { strict: self.strict };
                let fetches = resolved
                    .urls
                    .iter()
                    .map(|url| Skill::from_url_with(url, options, &self.fetcher));
                for (url, result) in resolved.urls.iter().zip(join_all(fetches).await) {
                    match result {
                        Ok(skill) => insert_skill(&mut skills, skill),
                        Err(error) => tracing::warn!("url=<{url}> | failed to load skill from URL: Error: {error}"),
                    }
                }
                tracing::debug!(
                    "source_count=<{}>, resolved_count=<{}> | skills resolved (including async)",
                    resolved.instances.len() + resolved.urls.len() + resolved.paths.len(),
                    skills.len()
                );
                Arc::new(skills)
            })
            .await
            .clone()
    }

    fn agent_entry(&self, state: &StateStore, resolved: &Arc<Resolved>) -> Option<Arc<SkillMap>> {
        let key = state.downgrade();
        let resolved = Arc::downgrade(resolved);
        self.agent_skills
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .find(|entry| entry.state.ptr_eq(&key) && entry.resolved.ptr_eq(&resolved))
            .map(|entry| entry.skills.clone())
    }

    fn store_agent_entry(&self, state: &StateStore, resolved: &Arc<Resolved>, skills: Arc<SkillMap>) {
        let key = state.downgrade();
        let mut entries = self.agent_skills.lock().unwrap_or_else(PoisonError::into_inner);
        entries.retain(|entry| entry.state.strong_count() > 0 && !entry.state.ptr_eq(&key));
        if !Arc::ptr_eq(resolved, &self.current()) {
            return;
        }
        entries.push(AgentEntry {
            state: key,
            resolved: Arc::downgrade(resolved),
            skills,
        });
    }

    /// The agent's skills: the base set plus its paths read through its sandbox. Failures log a
    /// warning and skip the source.
    async fn load_skill_paths(&self, agent: &LocalAgent, resolved: &Arc<Resolved>) -> Arc<SkillMap> {
        let mut skills = (*self.base(resolved).await).clone();
        if !resolved.paths.is_empty() {
            let sandbox = agent_sandbox(agent);
            for path in &resolved.paths {
                self.load_skill_path(sandbox.as_ref(), path, &mut skills).await;
            }
        }
        let skills = Arc::new(skills);
        self.store_agent_entry(agent.app_state(), resolved, skills.clone());
        skills
    }

    async fn load_skill_path(&self, sandbox: &dyn Sandbox, skill_path: &str, skills: &mut SkillMap) {
        let Ok(entries) = sandbox.list_files(skill_path).await else {
            if skill_path.to_lowercase().ends_with("skill.md") {
                let skill_dir = skill_path.rfind('/').map_or(".", |index| &skill_path[..index]);
                self.load_skill(sandbox, skill_dir, skill_path, skills).await;
            } else {
                tracing::warn!("path=<{skill_path}> | skill source does not exist or is not a valid path");
            }
            return;
        };
        if let Some(md_name) = find_skill_md_name(&entries) {
            self.load_skill(sandbox, skill_path, &format!("{skill_path}/{md_name}"), skills)
                .await;
            return;
        }
        let mut child_dirs = entries
            .iter()
            .filter(|entry| entry.is_dir.unwrap_or(false))
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        child_dirs.sort_by(|a, b| locale_compare(a, b));
        for child in child_dirs {
            let child_dir = format!("{skill_path}/{child}");
            let child_entries = match sandbox.list_files(&child_dir).await {
                Ok(child_entries) => child_entries,
                Err(error) => {
                    tracing::warn!("path=<{child_dir}> | failed to load skill from sandbox: Error: {error}");
                    continue;
                }
            };
            if let Some(md_name) = find_skill_md_name(&child_entries) {
                self.load_skill(sandbox, &child_dir, &format!("{child_dir}/{md_name}"), skills)
                    .await;
            }
        }
    }

    async fn load_skill(&self, sandbox: &dyn Sandbox, skill_dir: &str, md_path: &str, skills: &mut SkillMap) {
        let options = SkillLoadOptions { strict: self.strict };
        let loaded = match sandbox.read_text(md_path).await {
            Ok(content) => Skill::from_content_at(&content, options, Some(skill_dir.to_owned())),
            Err(error) => Err(error),
        };
        match loaded {
            Ok(skill) => insert_skill(skills, skill),
            Err(error) => tracing::warn!("path=<{skill_dir}> | failed to load skill: Error: {error}"),
        }
    }

    async fn before_invocation(&self, agent: &mut LocalAgent) -> Result<()> {
        let resolved = self.current();
        self.base(&resolved).await;
        let skills = match self.agent_entry(agent.app_state(), &resolved) {
            Some(skills) => skills,
            None => self.load_skill_paths(agent, &resolved).await,
        };
        self.inject_skills_xml(agent, &skills)
    }

    fn state_field(&self, state: &StateStore, key: &str) -> Option<JsonValue> {
        match state.get_value(&self.state_key) {
            Some(JsonValue::Object(data)) => data.get(key).cloned(),
            _ => None,
        }
    }

    fn set_state_field(&self, state: &StateStore, key: &str, value: JsonValue) -> Result<()> {
        let mut record = match state.get_value(&self.state_key) {
            None | Some(JsonValue::Null) => JsonObject::new(),
            Some(JsonValue::Object(data)) => data,
            Some(other) => {
                return Err(Error::other(format!(
                    "expected object for state key '{}', got {}",
                    self.state_key,
                    js_typeof(&other)
                )));
            }
        };
        record.insert(key.to_owned(), value);
        state.set(self.state_key.clone(), record)
    }

    fn activated_skills(&self, state: &StateStore) -> Vec<String> {
        self.state_field(state, "activatedSkills")
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default()
    }

    /// Lists the skills in the system prompt, replacing the block injected last.
    fn inject_skills_xml(&self, agent: &mut LocalAgent, skills: &SkillMap) -> Result<()> {
        let skills_xml = generate_skills_xml(skills);
        let last_injected = self
            .state_field(agent.app_state(), "lastInjectedXml")
            .and_then(|value| value.as_str().map(str::to_owned));
        let (prompt, injected) = match agent.system_prompt() {
            Some(SystemPrompt::Blocks(blocks)) => inject_into_blocks(blocks, last_injected.as_deref(), skills_xml),
            Some(SystemPrompt::Text(text)) => inject_into_text(text, last_injected.as_deref(), &skills_xml),
            None => inject_into_text("", last_injected.as_deref(), &skills_xml),
        };
        self.set_state_field(agent.app_state(), "lastInjectedXml", JsonValue::String(injected))?;
        agent.set_system_prompt(Some(prompt));
        Ok(())
    }

    async fn activate_skill(
        &self,
        skill_name: &str,
        context: &ToolContext,
    ) -> std::result::Result<JsonValue, ToolError> {
        let resolved = self.current();
        let base = self.base(&resolved).await;
        let state = context.agent().app_state();
        let skills = self.agent_entry(state, &resolved).unwrap_or(base);
        let Some(skill) = skills.get(skill_name) else {
            let available = skills.keys().map(String::as_str).collect::<Vec<_>>().join(", ");
            return Ok(JsonValue::String(format!(
                "Skill '{skill_name}' not found. Available skills: {available}"
            )));
        };
        tracing::debug!("skill_name=<{skill_name}> | skill activated");
        let mut activated = self.activated_skills(state);
        activated.retain(|name| name != skill_name);
        activated.push(skill_name.to_owned());
        self.set_state_field(state, "activatedSkills", serde_json::to_value(activated)?)?;
        let sandbox = tool_agent_sandbox(context.agent());
        Ok(JsonValue::String(
            self.format_skill_response(skill, sandbox.as_ref()).await,
        ))
    }

    /// The `skills` tool's answer: instructions, metadata and resource files.
    async fn format_skill_response(&self, skill: &Skill, sandbox: &dyn Sandbox) -> String {
        if skill.instructions().is_empty() {
            return format!("Skill '{}' activated (no instructions available).", skill.name());
        }
        let mut parts = vec![skill.instructions().to_owned()];
        let mut metadata_lines = Vec::new();
        if let Some(tools) = skill.allowed_tools().filter(|tools| !tools.is_empty()) {
            metadata_lines.push(format!("Allowed tools: {}", tools.join(", ")));
        }
        if let Some(compatibility) = skill.compatibility() {
            metadata_lines.push(format!("Compatibility: {compatibility}"));
        }
        if let Some(path) = skill.path() {
            metadata_lines.push(format!("Location: {path}/SKILL.md"));
        }
        if !metadata_lines.is_empty() {
            parts.push(format!("\n---\n{}", metadata_lines.join("\n")));
        }
        if let Some(path) = skill.path() {
            let resources = self.list_skill_resources(sandbox, path).await;
            if !resources.is_empty() {
                let listing = resources
                    .iter()
                    .map(|resource| format!("  {resource}"))
                    .collect::<Vec<_>>();
                parts.push(format!("\nAvailable resources:\n{}", listing.join("\n")));
            }
        }
        parts.join("\n")
    }

    /// Files under the skill's `scripts/`, `references/` and `assets/`, capped at
    /// `max_resource_files`.
    async fn list_skill_resources(&self, sandbox: &dyn Sandbox, skill_path: &str) -> Vec<String> {
        let mut files = Vec::new();
        for dir_name in RESOURCE_DIRS {
            let Ok(mut entries) = list_files_recursive(sandbox, format!("{skill_path}/{dir_name}"), 0).await else {
                continue;
            };
            crate::storage::sort_keys(&mut entries);
            for entry in entries {
                files.push(format!("{dir_name}/{entry}"));
                if files.len() >= self.max_resource_files {
                    files.push(format!("... (truncated at {} files)", self.max_resource_files));
                    return files;
                }
            }
        }
        files
    }
}

/// Lists a directory through the sandbox, recursing up to three levels, as paths relative to it.
fn list_files_recursive(sandbox: &dyn Sandbox, dir: String, depth: usize) -> BoxFuture<'_, Result<Vec<String>>> {
    Box::pin(async move {
        if depth >= MAX_RESOURCE_DEPTH {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        for entry in sandbox.list_files(&dir).await? {
            if !entry.is_dir.unwrap_or(false) {
                result.push(entry.name);
                continue;
            }
            let nested = list_files_recursive(sandbox, format!("{dir}/{}", entry.name), depth + 1).await?;
            result.extend(nested.into_iter().map(|path| format!("{}/{path}", entry.name)));
        }
        Ok(result)
    })
}

/// The `<available_skills>` block of the system prompt.
fn generate_skills_xml(skills: &SkillMap) -> String {
    if skills.is_empty() {
        return NO_SKILLS_XML.to_owned();
    }
    let mut lines = vec!["<available_skills>".to_owned()];
    for skill in skills.values() {
        lines.push("<skill>".to_owned());
        lines.push(format!("<name>{}</name>", escape_xml(skill.name())));
        lines.push(format!(
            "<description>{}</description>",
            escape_xml(skill.description())
        ));
        if let Some(path) = skill.path() {
            lines.push(format!(
                "<location>{}</location>",
                escape_xml(&format!("{path}/SKILL.md"))
            ));
        }
        lines.push("</skill>".to_owned());
    }
    lines.push("</available_skills>".to_owned());
    lines.join("\n")
}

/// A string prompt with the previous injection removed and the new one appended; returns the
/// prompt and the injected text.
fn inject_into_text(prompt: &str, last_injected: Option<&str>, skills_xml: &str) -> (SystemPrompt, String) {
    let mut current = prompt.to_owned();
    if let Some(last) = last_injected {
        if current.contains(last) {
            current = current.replacen(last, "", 1);
        } else {
            tracing::warn!("unable to find previously injected skills XML in system prompt, re-appending");
        }
    }
    if current.is_empty() {
        return (SystemPrompt::Text(skills_xml.to_owned()), skills_xml.to_owned());
    }
    let injection = format!("\n\n{skills_xml}");
    (SystemPrompt::Text(format!("{current}{injection}")), injection)
}

/// A block prompt with the previous skills block removed and a new text block appended.
fn inject_into_blocks(
    blocks: &[SystemContentBlock],
    last_injected: Option<&str>,
    skills_xml: String,
) -> (SystemPrompt, String) {
    let mut filtered = blocks.to_vec();
    if let Some(last) = last_injected {
        filtered.retain(|block| !matches!(block, SystemContentBlock::Text(text) if text.text == last));
        if filtered.len() == blocks.len() {
            tracing::warn!("unable to find previously injected skills XML in system prompt, re-appending");
        }
    }
    filtered.push(SystemContentBlock::text(skills_xml.clone()));
    (SystemPrompt::Blocks(filtered), skills_xml)
}

#[cfg(test)]
mod tests;
