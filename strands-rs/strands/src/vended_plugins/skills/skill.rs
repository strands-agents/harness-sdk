//! The skill data model and its loaders.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use regex::Regex;
use yaml_rust2::{Yaml, YamlLoader};

use crate::error::{Error, Result};
use crate::models::is_js_whitespace;
use crate::types::{JsonObject, JsonValue};

static SKILL_NAME_PATTERN: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$").ok());
static YAML_KEY_VALUE_LINE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"^(\s*[A-Za-z0-9_][A-Za-z0-9_-]*):\s+([^\n\r\u{2028}\u{2029}]+)$").ok());

const MAX_SKILL_NAME_LENGTH: usize = 64;
const SKILL_MD_NAMES: [&str; 2] = ["SKILL.md", "skill.md"];

/// Configuration for a [`Skill`] (`SkillConfig`).
///
/// ```
/// use strands::vended_plugins::skills::{Skill, SkillConfig};
///
/// let skill = Skill::new(SkillConfig {
///     name: "my-skill".into(),
///     description: "A custom skill".into(),
///     instructions: Some("Do the thing".into()),
///     ..Default::default()
/// });
/// assert_eq!(skill.instructions(), "Do the thing");
/// ```
#[derive(Debug, Clone, Default, PartialEq, bon::Builder)]
pub struct SkillConfig {
    /// Unique identifier for the skill (1-64 chars, lowercase alphanumeric and hyphens).
    #[builder(into)]
    pub name: String,
    /// What the skill does.
    #[builder(into)]
    pub description: String,
    /// Full markdown instructions from the SKILL.md body. Defaults to empty.
    #[builder(into)]
    pub instructions: Option<String>,
    /// Path to the skill directory, if loaded from disk.
    #[builder(into)]
    pub path: Option<String>,
    /// Tool names the skill may use (experimental, not enforced).
    pub allowed_tools: Option<Vec<String>>,
    /// Additional key-value metadata from the SKILL.md frontmatter. Defaults to empty.
    pub metadata: Option<JsonObject>,
    /// License identifier, such as `Apache-2.0`.
    #[builder(into)]
    pub license: Option<String>,
    /// Compatibility information.
    #[builder(into)]
    pub compatibility: Option<String>,
}

/// Options for loading a skill (`{ strict }`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, bon::Builder)]
pub struct SkillLoadOptions {
    /// Fail on any validation issue instead of logging a warning and loading anyway.
    #[builder(default)]
    pub strict: bool,
}

impl SkillLoadOptions {
    /// Options with strict validation.
    #[must_use]
    pub fn strict() -> Self {
        Self { strict: true }
    }
}

/// An agent skill: metadata shown in the system prompt up front, and instructions the agent loads
/// on demand through the `skills` tool (`Skill`).
///
/// Skills are directories holding a `SKILL.md` file: YAML frontmatter (`name`, `description`,
/// optional `allowed-tools`, `metadata`, `license`, `compatibility`) followed by the markdown
/// instructions.
///
/// ```
/// use strands::vended_plugins::skills::{Skill, SkillLoadOptions};
///
/// let skill = Skill::from_content(
///     "---\nname: my-skill\ndescription: Does something useful\n---\n# Instructions\nFollow these steps...",
///     SkillLoadOptions::default(),
/// )?;
/// assert_eq!(skill.name(), "my-skill");
/// assert_eq!(skill.instructions(), "# Instructions\nFollow these steps...");
/// # Ok::<(), strands::Error>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    name: String,
    description: String,
    instructions: String,
    path: Option<String>,
    allowed_tools: Option<Vec<String>>,
    metadata: JsonObject,
    license: Option<String>,
    compatibility: Option<String>,
}

impl From<SkillConfig> for Skill {
    fn from(config: SkillConfig) -> Self {
        Self::new(config)
    }
}

impl Skill {
    /// Creates a skill from its configuration (`new Skill(config)`); nothing is validated.
    #[must_use]
    pub fn new(config: SkillConfig) -> Self {
        Self {
            name: config.name,
            description: config.description,
            instructions: config.instructions.unwrap_or_default(),
            path: config.path,
            allowed_tools: config.allowed_tools,
            metadata: config.metadata.unwrap_or_default(),
            license: config.license,
            compatibility: config.compatibility,
        }
    }

    /// The skill's unique name.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// What the skill does.
    #[must_use]
    pub fn description(&self) -> &str {
        &self.description
    }

    /// The full markdown instructions; empty when there are none.
    #[must_use]
    pub fn instructions(&self) -> &str {
        &self.instructions
    }

    /// The skill directory, if loaded from disk.
    #[must_use]
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Tool names the skill may use (experimental, not enforced).
    #[must_use]
    pub fn allowed_tools(&self) -> Option<&[String]> {
        self.allowed_tools.as_deref()
    }

    /// Additional frontmatter metadata.
    #[must_use]
    pub fn metadata(&self) -> &JsonObject {
        &self.metadata
    }

    /// The license identifier.
    #[must_use]
    pub fn license(&self) -> Option<&str> {
        self.license.as_deref()
    }

    /// The compatibility information.
    #[must_use]
    pub fn compatibility(&self) -> Option<&str> {
        self.compatibility.as_deref()
    }

    /// Loads a skill from a directory holding `SKILL.md` (or `skill.md`), or from the `SKILL.md`
    /// file itself. The skill's path is the absolute skill directory.
    ///
    /// # Errors
    ///
    /// A path that is neither, a directory without `SKILL.md`, an unreadable file, or the
    /// [`from_content`](Self::from_content) errors, including the directory-name check in strict
    /// mode.
    pub fn from_file(skill_path: impl AsRef<Path>, options: SkillLoadOptions) -> Result<Self> {
        let resolved = resolve_path(skill_path.as_ref());
        let is_skill_md = resolved
            .file_name()
            .is_some_and(|name| name.to_string_lossy().to_lowercase() == "skill.md");
        let (skill_md, skill_dir) = if resolved.is_file() && is_skill_md {
            let dir = resolved.parent().map(Path::to_path_buf).unwrap_or_default();
            (resolved, dir)
        } else if resolved.is_dir() {
            (find_skill_md(&resolved)?, resolved)
        } else {
            return Err(Error::other(format!(
                "path=<{}> | skill path does not exist or is not a valid skill directory",
                resolved.display()
            )));
        };

        tracing::debug!("path=<{}> | loading skill", skill_md.display());
        let content = std::fs::read_to_string(&skill_md)?;
        let skill = Self::from_content_at(&content, options, Some(skill_dir.to_string_lossy().into_owned()))?;
        tracing::debug!(
            "name=<{}>, path=<{}> | skill loaded successfully",
            skill.name,
            skill.path.as_deref().unwrap_or_default()
        );
        Ok(skill)
    }

    /// Parses `SKILL.md` content (YAML frontmatter and markdown body) into a skill. In lenient
    /// mode (the default) a name that breaks the naming rules logs a warning; strict mode fails
    /// instead.
    ///
    /// # Errors
    ///
    /// Content without `---` frontmatter delimiters, YAML that does not parse (after retrying
    /// with unquoted colons quoted), a missing or empty `name` or `description`, or, in strict
    /// mode, an invalid name.
    pub fn from_content(content: &str, options: SkillLoadOptions) -> Result<Self> {
        Self::from_content_at(content, options, None)
    }

    /// [`from_content`](Self::from_content) for a skill whose directory is `path`: the path is
    /// recorded and the name is checked against the directory name.
    pub(crate) fn from_content_at(content: &str, options: SkillLoadOptions, path: Option<String>) -> Result<Self> {
        let (frontmatter, body) = parse_frontmatter(content)?;
        let Some(name) = non_empty_string(frontmatter.get("name")) else {
            return Err(Error::other("SKILL.md content must have a 'name' field in frontmatter"));
        };
        if non_empty_string(frontmatter.get("description")).is_none() {
            return Err(Error::other(
                "SKILL.md content must have a 'description' field in frontmatter",
            ));
        }
        validate_skill_name(name, path.as_deref(), options.strict)?;
        Ok(build_skill_from_frontmatter(&frontmatter, body, path))
    }

    /// Fetches raw `SKILL.md` content from an `https://` URL and parses it. The
    /// request sends `User-Agent: strands-agents-sdk` and times out after 30 seconds.
    ///
    /// # Errors
    ///
    /// A URL that is not `https://` (`url=<url> | not a valid HTTPS URL`), an HTTP error status
    /// (`url=<url> | HTTP 404: Not Found`), any other fetch failure
    /// (`url=<url> | failed to fetch skill: ..`), or the [`from_content`](Self::from_content)
    /// errors.
    pub async fn from_url(url: &str, options: SkillLoadOptions) -> Result<Self> {
        Self::from_url_with(url, options, &UrlFetcher::default()).await
    }

    pub(crate) async fn from_url_with(url: &str, options: SkillLoadOptions, fetcher: &UrlFetcher) -> Result<Self> {
        if !url.starts_with("https://") {
            return Err(Error::other(format!("url=<{url}> | not a valid HTTPS URL")));
        }
        tracing::info!("url=<{url}> | fetching skill content");
        let content = match fetcher.fetch(url.to_owned()).await {
            Ok(content) => content,
            Err(FetchError::Status { status, status_text }) => {
                return Err(Error::other(format!("url=<{url}> | HTTP {status}: {status_text}")));
            }
            Err(FetchError::Failed(message)) => {
                return Err(Error::other(format!("url=<{url}> | failed to fetch skill: {message}")));
            }
        };
        Self::from_content(&content, options)
    }

    /// Loads every skill in the subdirectories of `skills_dir`, in name order.
    /// Subdirectories without `SKILL.md` are skipped; a skill that fails to load logs a warning
    /// and is skipped.
    ///
    /// # Errors
    ///
    /// `skills_dir` is not a directory (`path=<dir> | skills directory does not exist`), or it
    /// cannot be listed.
    pub fn from_directory(skills_dir: impl AsRef<Path>, options: SkillLoadOptions) -> Result<Vec<Self>> {
        let resolved = resolve_path(skills_dir.as_ref());
        if !resolved.is_dir() {
            return Err(Error::other(format!(
                "path=<{}> | skills directory does not exist",
                resolved.display()
            )));
        }
        let mut children = std::fs::read_dir(&resolved)?
            .filter_map(|entry| entry.ok().map(|entry| entry.file_name().to_string_lossy().into_owned()))
            .collect::<Vec<_>>();
        crate::storage::sort_keys(&mut children);

        let mut skills = Vec::new();
        for child in children {
            let child_path = resolved.join(&child);
            if !child_path.is_dir() {
                continue;
            }
            if find_skill_md(&child_path).is_err() {
                tracing::debug!("path=<{}> | skipping directory without SKILL.md", child_path.display());
                continue;
            }
            match Self::from_file(&child_path, options) {
                Ok(skill) => skills.push(skill),
                Err(error) => tracing::warn!(
                    "path=<{}> | skipping skill due to error: Error: {error}",
                    child_path.display()
                ),
            }
        }
        tracing::debug!(
            "path=<{}>, count=<{}> | loaded skills from directory",
            resolved.display(),
            skills.len()
        );
        Ok(skills)
    }
}

/// Why fetching a skill URL failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FetchError {
    /// The server answered with a non-success status.
    Status { status: u16, status_text: String },
    /// The request did not complete.
    Failed(String),
}

type FetchFn = dyn Fn(String) -> BoxFuture<'static, std::result::Result<String, FetchError>> + Send + Sync;

/// Fetches the text of a skill URL; tests swap in a scripted one.
#[derive(Clone)]
pub(crate) struct UrlFetcher(Arc<FetchFn>);

impl UrlFetcher {
    #[cfg(test)]
    pub(crate) fn new(
        fetch: impl Fn(String) -> BoxFuture<'static, std::result::Result<String, FetchError>> + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(fetch))
    }

    pub(crate) fn fetch(&self, url: String) -> BoxFuture<'static, std::result::Result<String, FetchError>> {
        (self.0)(url)
    }
}

impl Default for UrlFetcher {
    fn default() -> Self {
        Self(Arc::new(|url| Box::pin(http_get_text(url))))
    }
}

impl std::fmt::Debug for UrlFetcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UrlFetcher")
    }
}

async fn http_get_text(url: String) -> std::result::Result<String, FetchError> {
    const SKILL_HTTPS_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    let client = reqwest::Client::builder()
        .timeout(SKILL_HTTPS_FETCH_TIMEOUT)
        .build()
        .map_err(|error| FetchError::Failed(error.to_string()))?;
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, "strands-agents-sdk")
        .send()
        .await
        .map_err(|error| FetchError::Failed(error.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(FetchError::Status {
            status: status.as_u16(),
            status_text: status.canonical_reason().unwrap_or_default().to_owned(),
        });
    }
    response
        .text()
        .await
        .map_err(|error| FetchError::Failed(error.to_string()))
}

/// `path` made absolute against the working directory, with `.` and `..` folded lexically.
fn resolve_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            other => resolved.push(other),
        }
    }
    resolved
}

/// The `SKILL.md` (preferred) or `skill.md` file of a skill directory.
fn find_skill_md(skill_dir: &Path) -> Result<PathBuf> {
    SKILL_MD_NAMES
        .iter()
        .map(|name| skill_dir.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            Error::other(format!(
                "path=<{}> | no SKILL.md found in skill directory",
                skill_dir.display()
            ))
        })
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Where the closing delimiter of `rest` (the content after the opening `---`) starts and where
/// its `---` ends: the first `\n---` whose line holds only whitespace after the dashes.
fn find_closing_delimiter(rest: &str) -> Option<(usize, usize)> {
    rest.match_indices("\n---").find_map(|(start, _)| {
        let after = start + "\n---".len();
        let line_end = rest[after..]
            .find(is_line_terminator)
            .map_or(rest.len(), |offset| after + offset);
        rest[after..line_end]
            .chars()
            .all(is_js_whitespace)
            .then_some((start, after))
    })
}

/// Splits `SKILL.md` content into parsed frontmatter and the trimmed body.
fn parse_frontmatter(content: &str) -> Result<(JsonObject, String)> {
    let stripped = js_trim(content);
    let Some(rest) = stripped.strip_prefix("---") else {
        return Err(Error::other("SKILL.md must start with --- frontmatter delimiter"));
    };
    let Some((start, after)) = find_closing_delimiter(rest) else {
        return Err(Error::other("SKILL.md frontmatter missing closing --- delimiter"));
    };
    let frontmatter_text = js_trim(&rest[..start]);
    let body = js_trim(&rest[after..]).to_owned();

    let parsed = match parse_yaml(frontmatter_text) {
        Ok(parsed) => parsed,
        Err(_) => {
            tracing::warn!("YAML parse failed, retrying with colon-quoting fallback");
            parse_yaml(&fix_yaml_colons(frontmatter_text))?
        }
    };
    let frontmatter = match parsed {
        JsonValue::Object(map) => map,
        _ => JsonObject::new(),
    };
    Ok((frontmatter, body))
}

/// Parses one YAML document into JSON, as the `yaml` package's `parse` does for frontmatter: an
/// empty document is `null` and more than one document is an error.
fn parse_yaml(text: &str) -> Result<JsonValue> {
    let mut documents = YamlLoader::load_from_str(text).map_err(|error| Error::other(error.to_string()))?;
    if documents.len() > 1 {
        return Err(Error::other(
            "Source contains multiple documents; please use YAML.parseAllDocuments()",
        ));
    }
    Ok(documents.pop().map_or(JsonValue::Null, yaml_to_json))
}

fn yaml_to_json(yaml: Yaml) -> JsonValue {
    match yaml {
        Yaml::String(text) => JsonValue::String(text),
        Yaml::Integer(number) => JsonValue::from(number),
        Yaml::Real(text) => yaml_real(&text),
        Yaml::Boolean(flag) => JsonValue::Bool(flag),
        Yaml::Array(items) => JsonValue::Array(items.into_iter().map(yaml_to_json).collect()),
        Yaml::Hash(entries) => JsonValue::Object(
            entries
                .into_iter()
                .map(|(key, value)| (yaml_key(key), yaml_to_json(value)))
                .collect(),
        ),
        Yaml::Null | Yaml::Alias(_) | Yaml::BadValue => JsonValue::Null,
    }
}

/// A YAML float as JSON; infinities and NaN, which JSON cannot hold, become `null`.
fn yaml_real(text: &str) -> JsonValue {
    Yaml::Real(text.to_owned())
        .as_f64()
        .and_then(serde_json::Number::from_f64)
        .map_or(JsonValue::Null, JsonValue::Number)
}

/// A mapping key as a string: a string as it is, `null` as empty, anything else as `js_string`
/// writes it.
fn yaml_key(key: Yaml) -> String {
    match yaml_to_json(key) {
        JsonValue::String(text) => text,
        JsonValue::Null => String::new(),
        other => js_string(&other),
    }
}

/// Quotes values that hold unquoted colons, such as
/// `description: Use this skill when: the user asks about PDFs`.
fn fix_yaml_colons(yaml: &str) -> String {
    let Some(pattern) = YAML_KEY_VALUE_LINE.as_ref() else {
        return yaml.to_owned();
    };
    yaml.split('\n')
        .map(|line| {
            let Some(captures) = pattern.captures(line) else {
                return line.to_owned();
            };
            let (key, value) = (&captures[1], &captures[2]);
            if !value.contains(':') || value.starts_with('"') || value.starts_with('\'') {
                return line.to_owned();
            }
            let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
            format!("{key}: \"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A JSON value as text: whole numbers without a fraction, arrays joined by commas with `null`
/// items empty, and objects as `[object Object]`.
fn js_string(value: &JsonValue) -> String {
    const MAX_PLAIN_INTEGER: f64 = 1e21;
    match value {
        JsonValue::String(text) => text.clone(),
        JsonValue::Null => "null".to_owned(),
        JsonValue::Bool(flag) => flag.to_string(),
        JsonValue::Number(number) => match number.as_f64() {
            Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < MAX_PLAIN_INTEGER => {
                format!("{float:.0}")
            }
            _ => number.to_string(),
        },
        JsonValue::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        JsonValue::Object(_) => "[object Object]".to_owned(),
    }
}

fn non_empty_string(value: Option<&JsonValue>) -> Option<&str> {
    value.and_then(JsonValue::as_str).filter(|text| !text.is_empty())
}

/// The last component of a path string, ignoring trailing separators.
fn basename(path: &str) -> &str {
    let is_separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let trimmed = path.trim_end_matches(is_separator);
    trimmed.rsplit(is_separator).next().unwrap_or(trimmed)
}

/// Checks a skill name against the AgentSkills.io rules: warns in lenient
/// mode, fails in strict mode.
fn validate_skill_name(name: &str, dir_path: Option<&str>, strict: bool) -> Result<()> {
    if name.is_empty() {
        return Err(Error::other("Skill name cannot be empty"));
    }
    let report = |message: String| -> Result<()> {
        if strict {
            return Err(Error::other(message));
        }
        tracing::warn!("{message}");
        Ok(())
    };
    if name.encode_utf16().count() > MAX_SKILL_NAME_LENGTH {
        report(format!(
            "name=<{name}> | skill name exceeds {MAX_SKILL_NAME_LENGTH} character limit"
        ))?;
    }
    let matches_pattern = SKILL_NAME_PATTERN
        .as_ref()
        .is_some_and(|pattern| pattern.is_match(name));
    if !matches_pattern {
        report(format!(
            "name=<{name}> | skill name should be 1-64 lowercase alphanumeric characters or hyphens, should not start/end with hyphen"
        ))?;
    }
    if name.contains("--") {
        report(format!("name=<{name}> | skill name contains consecutive hyphens"))?;
    }
    if let Some(dir_path) = dir_path {
        let directory = basename(dir_path);
        if directory != name {
            report(format!(
                "name=<{name}>, directory=<{directory}> | skill name does not match parent directory name"
            ))?;
        }
    }
    Ok(())
}

/// Builds the skill from parsed frontmatter.
fn build_skill_from_frontmatter(frontmatter: &JsonObject, body: String, path: Option<String>) -> Skill {
    let allowed_tools = match frontmatter
        .get("allowed-tools")
        .or_else(|| frontmatter.get("allowed_tools"))
    {
        Some(JsonValue::String(text)) if !js_trim(text).is_empty() => Some(
            js_trim(text)
                .split(is_js_whitespace)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect(),
        ),
        Some(JsonValue::Array(items)) => Some(items.iter().filter(|item| !item.is_null()).map(js_string).collect()),
        _ => None,
    };
    let metadata = match frontmatter.get("metadata") {
        Some(JsonValue::Object(map)) => map.clone(),
        _ => JsonObject::new(),
    };
    let optional_string = |key: &str| frontmatter.get(key).filter(|value| !value.is_null()).map(js_string);
    Skill {
        name: frontmatter
            .get("name")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
        description: frontmatter
            .get("description")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_owned(),
        instructions: body,
        path,
        allowed_tools,
        metadata,
        license: optional_string("license"),
        compatibility: optional_string("compatibility"),
    }
}

#[cfg(test)]
mod tests;
