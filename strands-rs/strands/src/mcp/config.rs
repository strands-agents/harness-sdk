//! [`McpClient::load_servers`]: MCP clients from an `mcp.json`-style server map.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::Deserialize;

use super::client::{McpClient, McpClientConfig, McpClientOptions};
use super::error::McpError;
use super::filters::{McpToolFilters, McpToolMatcher};
use super::http::McpClientCredentials;
use super::transport::{McpTransport, StdioServerParameters, default_environment};
use crate::error::{Error, Result};
use crate::types::{JsonObject, JsonValue};

static PLACEHOLDER: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}").ok());

/// Tool filters in a config file (`SerializableMcpToolFilters`): each pattern is a regex
/// matched from the start of the server-side tool name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, bon::Builder)]
pub struct SerializableMcpToolFilters {
    /// When present, only tools whose names match one of these patterns are exposed.
    #[serde(default)]
    pub allowed: Option<Vec<String>>,
    /// Tools whose names match one of these patterns are excluded, even when also allowed.
    #[serde(default)]
    pub rejected: Option<Vec<String>>,
}

/// The transport of a config entry (`'stdio' | 'sse' | 'streamable-http'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub enum McpServerTransport {
    /// A child process (`stdio`).
    #[serde(rename = "stdio")]
    Stdio,
    /// The legacy HTTP+SSE protocol (`sse`).
    #[serde(rename = "sse")]
    Sse,
    /// Streamable HTTP (`streamable-http`).
    #[serde(rename = "streamable-http")]
    StreamableHttp,
}

const TRANSPORT_NAMES: [&str; 3] = ["stdio", "sse", "streamable-http"];

/// One server entry of a config file or map (`McpServerConfig`).
///
/// Give `command` (stdio) or `url` (streamable HTTP or SSE). Without `transport` it is detected
/// from the fields present. String fields support `${VAR}` and `${env:VAR}` placeholders.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase")]
#[builder(on(String, into))]
pub struct McpServerConfig {
    /// The command to spawn (stdio).
    pub command: Option<String>,
    /// Its arguments.
    pub args: Option<Vec<String>>,
    /// Variables for the child process, over the default environment.
    pub env: Option<BTreeMap<String, String>>,
    /// The working directory of the child process.
    pub cwd: Option<String>,
    /// The server URL (streamable HTTP or SSE).
    pub url: Option<String>,
    /// Headers sent with every request.
    pub headers: Option<BTreeMap<String, String>>,
    /// The transport; detected from `command` or `url` when absent.
    pub transport: Option<McpServerTransport>,
    /// OAuth client credentials (streamable HTTP only).
    pub auth: Option<McpClientCredentials>,
    /// Prefix for agent-facing tool names.
    pub prefix: Option<String>,
    /// Filters applied to tool names.
    pub tool_filters: Option<SerializableMcpToolFilters>,
    /// Skips this server.
    #[serde(default)]
    #[builder(default)]
    pub disabled: bool,
    /// Skips config and connection failures and overlong prefixed names with warnings.
    pub continue_on_error: Option<bool>,
}

/// How [`McpClient::load_servers`] turns entries into clients (`McpLoadServersOptions`).
#[derive(Debug, Clone, Default, bon::Builder)]
pub struct McpLoadServersOptions {
    /// Servers without an explicit `prefix` use their config key as the tool name prefix, with
    /// characters outside `[A-Za-z0-9_-]` replaced by `_`. Takes precedence over a default
    /// `prefix`; a server opts out with `prefix: ""`.
    #[builder(default)]
    pub prefix_with_server_name: bool,
}

/// Where [`McpClient::load_servers`] reads servers from: a JSON file (flat or under
/// `mcpServers`, `~/` expanded), a typed map, or a JSON object of entries.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum McpServersSource {
    /// A JSON config file.
    Path(PathBuf),
    /// Server entries by name, in order; a repeated name replaces the earlier entry in its place.
    Servers(Vec<(String, McpServerConfig)>),
    /// Server entries by name, as JSON.
    Json(JsonObject),
}

impl From<&str> for McpServersSource {
    fn from(path: &str) -> Self {
        Self::Path(PathBuf::from(path))
    }
}

impl From<String> for McpServersSource {
    fn from(path: String) -> Self {
        Self::Path(PathBuf::from(path))
    }
}

impl From<PathBuf> for McpServersSource {
    fn from(path: PathBuf) -> Self {
        Self::Path(path)
    }
}

impl From<&Path> for McpServersSource {
    fn from(path: &Path) -> Self {
        Self::Path(path.to_path_buf())
    }
}

impl From<Vec<(String, McpServerConfig)>> for McpServersSource {
    fn from(servers: Vec<(String, McpServerConfig)>) -> Self {
        Self::Servers(servers)
    }
}

impl From<BTreeMap<String, McpServerConfig>> for McpServersSource {
    fn from(servers: BTreeMap<String, McpServerConfig>) -> Self {
        Self::Servers(servers.into_iter().collect())
    }
}

impl<const N: usize> From<[(&str, McpServerConfig); N]> for McpServersSource {
    fn from(servers: [(&str, McpServerConfig); N]) -> Self {
        Self::Servers(
            servers
                .into_iter()
                .map(|(name, config)| (name.to_owned(), config))
                .collect(),
        )
    }
}

impl From<JsonObject> for McpServersSource {
    fn from(servers: JsonObject) -> Self {
        Self::Json(servers)
    }
}

/// Process state the loader reads; tests substitute it.
pub(crate) struct LoadEnv<'a> {
    pub(crate) var: &'a (dyn Fn(&str) -> Option<String> + Sync),
    pub(crate) home: Option<PathBuf>,
}

impl LoadEnv<'static> {
    fn process() -> Self {
        Self {
            var: &|key| std::env::var(key).ok(),
            home: std::env::home_dir(),
        }
    }
}

/// A transport a config entry resolved to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResolvedTransport {
    Stdio(StdioServerParameters),
    StreamableHttp {
        url: String,
        headers: Option<BTreeMap<String, String>>,
        auth: Option<McpClientCredentials>,
    },
    Sse {
        url: String,
        headers: Option<BTreeMap<String, String>>,
    },
}

pub(crate) struct ResolvedServer {
    pub(crate) transport: ResolvedTransport,
    pub(crate) options: McpClientOptions,
}

impl ResolvedServer {
    fn into_client_config(self) -> Result<McpClientConfig> {
        let mut config = McpClientConfig {
            options: self.options,
            ..McpClientConfig::default()
        };
        match self.transport {
            ResolvedTransport::Stdio(params) => config.transport = Some(McpTransport::stdio(params)),
            ResolvedTransport::StreamableHttp { url, headers, auth } => {
                config.url = Some(url);
                config.headers = headers;
                config.auth = auth;
            }
            ResolvedTransport::Sse { url, headers } => {
                config.transport = Some(McpTransport::sse(&url, headers)?);
            }
        }
        Ok(config)
    }
}

fn interpolate(value: &str, env: &LoadEnv<'_>) -> Result<String> {
    let Some(placeholder) = PLACEHOLDER.as_ref() else {
        return Ok(value.to_owned());
    };
    let mut output = String::with_capacity(value.len());
    let mut last = 0;
    for captures in placeholder.captures_iter(value) {
        let (Some(whole), Some(key)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        let key = key.as_str();
        let resolved =
            (env.var)(key).ok_or_else(|| McpError::other(format!("Environment variable \"{key}\" is not set")))?;
        output.push_str(&value[last..whole.start()]);
        output.push_str(&resolved);
        last = whole.end();
    }
    output.push_str(&value[last..]);
    Ok(output)
}

fn interpolate_all(values: &[String], env: &LoadEnv<'_>) -> Result<Vec<String>> {
    values.iter().map(|value| interpolate(value, env)).collect()
}

fn interpolate_record(record: &BTreeMap<String, String>, env: &LoadEnv<'_>) -> Result<BTreeMap<String, String>> {
    record
        .iter()
        .map(|(key, value)| Ok((key.clone(), interpolate(value, env)?)))
        .collect()
}

fn non_empty(value: Option<&String>) -> Option<&String> {
    value.filter(|value| !value.is_empty())
}

fn build_stdio(server: &McpServerConfig, env: &LoadEnv<'_>) -> Result<ResolvedTransport> {
    let Some(command) = non_empty(server.command.as_ref()) else {
        return Err(McpError::other("Stdio transport requires \"command\" field").into());
    };
    let mut params = StdioServerParameters::new(interpolate(command, env)?, Vec::<String>::new());
    if let Some(args) = &server.args {
        params.args = interpolate_all(args, env)?;
    }
    if let Some(vars) = &server.env {
        let mut merged = default_environment();
        merged.extend(interpolate_record(vars, env)?);
        params.env = Some(merged);
    }
    if let Some(cwd) = non_empty(server.cwd.as_ref()) {
        params.cwd = Some(PathBuf::from(interpolate(cwd, env)?));
    }
    Ok(ResolvedTransport::Stdio(params))
}

fn build_http(server: &McpServerConfig, env: &LoadEnv<'_>) -> Result<ResolvedTransport> {
    let Some(url) = non_empty(server.url.as_ref()) else {
        return Err(McpError::other("Streamable HTTP transport requires \"url\" field").into());
    };
    let headers = server
        .headers
        .as_ref()
        .map(|headers| interpolate_record(headers, env))
        .transpose()?;
    let auth = server
        .auth
        .as_ref()
        .map(|auth| -> Result<McpClientCredentials> {
            Ok(McpClientCredentials {
                client_id: interpolate(&auth.client_id, env)?,
                client_secret: interpolate(&auth.client_secret, env)?,
                scopes: auth
                    .scopes
                    .as_ref()
                    .map(|scopes| interpolate_all(scopes, env))
                    .transpose()?,
                allow_private_addresses: auth.allow_private_addresses,
            })
        })
        .transpose()?;
    Ok(ResolvedTransport::StreamableHttp {
        url: interpolate(url, env)?,
        headers,
        auth,
    })
}

fn build_sse(server: &McpServerConfig, env: &LoadEnv<'_>) -> Result<ResolvedTransport> {
    let Some(url) = non_empty(server.url.as_ref()) else {
        return Err(McpError::other("SSE transport requires \"url\" field").into());
    };
    if server.auth.is_some() {
        return Err(McpError::other(
            "SSE transport does not support auth — use streamable-http or provide a pre-configured transport",
        )
        .into());
    }
    let headers = server
        .headers
        .as_ref()
        .map(|headers| interpolate_record(headers, env))
        .transpose()?;
    let url = interpolate(url, env)?;
    McpTransport::sse(&url, headers.clone())?;
    Ok(ResolvedTransport::Sse { url, headers })
}

fn build_transport(server: &McpServerConfig, env: &LoadEnv<'_>) -> Result<ResolvedTransport> {
    let command = non_empty(server.command.as_ref());
    let url = non_empty(server.url.as_ref());
    if command.is_some() && url.is_some() && server.transport.is_none() {
        return Err(McpError::other(
            "Server config has both \"command\" and \"url\" — set \"transport\" explicitly or remove one",
        )
        .into());
    }
    let detected = match (command, url) {
        (Some(_), _) => Some(McpServerTransport::Stdio),
        (None, Some(_)) => Some(McpServerTransport::StreamableHttp),
        (None, None) => None,
    };
    match server.transport.or(detected) {
        Some(McpServerTransport::Stdio) => build_stdio(server, env),
        Some(McpServerTransport::StreamableHttp) => build_http(server, env),
        Some(McpServerTransport::Sse) => build_sse(server, env),
        None => Err(McpError::other("Server config must include either \"command\" (stdio) or \"url\" (http)").into()),
    }
}

/// `name.replace(/[^A-Za-z0-9_-]/g, '_')`.
pub(crate) fn sanitize_prefix(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn compile_matchers(name: &str, key: &str, patterns: &[String], env: &LoadEnv<'_>) -> Result<Vec<McpToolMatcher>> {
    interpolate_all(patterns, env)?
        .into_iter()
        .map(|pattern| {
            Regex::new(&pattern).map(McpToolMatcher::Regex).map_err(|error| {
                Error::from(McpError::other(format!(
                    "Server \"{name}\": invalid regex in toolFilters.{key}: \"{pattern}\": {error}"
                )))
            })
        })
        .collect()
}

fn compile_filters(name: &str, filters: &SerializableMcpToolFilters, env: &LoadEnv<'_>) -> Result<McpToolFilters> {
    Ok(McpToolFilters {
        allowed: filters
            .allowed
            .as_ref()
            .map(|patterns| compile_matchers(name, "allowed", patterns, env))
            .transpose()?,
        rejected: filters
            .rejected
            .as_ref()
            .map(|patterns| compile_matchers(name, "rejected", patterns, env))
            .transpose()?,
    })
}

fn base_options(
    name: &str,
    server: &McpServerConfig,
    defaults: &McpClientOptions,
    options: &McpLoadServersOptions,
    env: &LoadEnv<'_>,
) -> Result<McpClientOptions> {
    let mut resolved = defaults.clone();
    resolved.application_name = Some(defaults.application_name.clone().unwrap_or_else(|| name.to_owned()));
    if options.prefix_with_server_name {
        resolved.prefix = Some(sanitize_prefix(name));
    }
    if let Some(continue_on_error) = server.continue_on_error {
        resolved.continue_on_error = continue_on_error;
    }
    if let Some(prefix) = &server.prefix {
        resolved.prefix = Some(interpolate(prefix, env)?);
    }
    if let Some(filters) = &server.tool_filters {
        resolved.tool_filters = Some(compile_filters(name, filters, env)?);
    }
    Ok(resolved)
}

fn resolve_server(
    name: &str,
    server: &McpServerConfig,
    defaults: &McpClientOptions,
    options: &McpLoadServersOptions,
    env: &LoadEnv<'_>,
) -> Result<ResolvedServer> {
    let transport = build_transport(server, env)?;
    let options = base_options(name, server, defaults, options, env)?;
    Ok(ResolvedServer { transport, options })
}

fn js_type_of(value: &JsonValue) -> &'static str {
    match value {
        JsonValue::Array(_) => "array",
        JsonValue::Bool(_) => "boolean",
        JsonValue::Number(_) => "number",
        JsonValue::String(_) => "string",
        JsonValue::Null | JsonValue::Object(_) => "object",
    }
}

fn entry_config(name: &str, entry: &JsonValue) -> Result<std::result::Result<McpServerConfig, Error>> {
    if !entry.is_object() {
        return Err(McpError::other(format!(
            "Server \"{name}\" must be an object, got {}",
            js_type_of(entry)
        ))
        .into());
    }
    if let Some(JsonValue::String(kind)) = entry.get("transport")
        && !TRANSPORT_NAMES.contains(&kind.as_str())
    {
        return Ok(Err(
            McpError::other(format!("Unsupported transport type: {kind}")).into()
        ));
    }
    Ok(McpServerConfig::deserialize(entry).map_err(Error::from))
}

struct Entry {
    name: String,
    config: std::result::Result<McpServerConfig, Error>,
    continue_on_error: Option<bool>,
}

fn json_entries(servers: JsonObject) -> Result<Vec<Entry>> {
    servers
        .into_iter()
        .filter(|(_, entry)| !entry.get("disabled").is_some_and(is_truthy))
        .map(|(name, entry)| {
            let config = entry_config(&name, &entry)?;
            let continue_on_error = entry.get("continueOnError").and_then(JsonValue::as_bool);
            Ok(Entry {
                name,
                config,
                continue_on_error,
            })
        })
        .collect()
}

fn is_truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(value) => *value,
        JsonValue::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        JsonValue::String(text) => !text.is_empty(),
        JsonValue::Array(_) | JsonValue::Object(_) => true,
    }
}

async fn read_servers(path: &Path, env: &LoadEnv<'_>) -> Result<JsonObject> {
    let expanded = match (path.to_str().and_then(|text| text.strip_prefix("~/")), &env.home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => path.to_path_buf(),
    };
    let text = tokio::fs::read_to_string(&expanded).await?;
    let mut parsed: JsonValue = serde_json::from_str(&text)?;
    let servers = match parsed.get_mut("mcpServers") {
        Some(servers) if !servers.is_null() => servers.take(),
        _ => parsed,
    };
    match servers {
        JsonValue::Object(servers) => Ok(servers),
        _ => Err(McpError::other(
            "MCP config must be a JSON object mapping server names to configs, e.g. { \"my-server\": { \"command\": \"node\" } }",
        )
        .into()),
    }
}

/// Resolves every enabled entry. A non-object entry always fails;
/// another failure skips the server with a warning under its `continue_on_error`.
pub(crate) async fn resolve_server_configs(
    source: McpServersSource,
    defaults: &McpClientOptions,
    options: &McpLoadServersOptions,
    env: &LoadEnv<'_>,
) -> Result<Vec<ResolvedServer>> {
    let entries = match source {
        McpServersSource::Path(path) => json_entries(read_servers(&path, env).await?)?,
        McpServersSource::Json(servers) => json_entries(servers)?,
        McpServersSource::Servers(servers) => servers
            .into_iter()
            .collect::<IndexMap<_, _>>()
            .into_iter()
            .map(|(name, config)| Entry {
                continue_on_error: config.continue_on_error,
                name,
                config: Ok(config),
            })
            .collect(),
    };
    let mut resolved = Vec::new();
    for entry in entries {
        let continue_on_error = entry.continue_on_error.unwrap_or(defaults.continue_on_error);
        let result = entry.config.and_then(|config| {
            if config.disabled {
                return Ok(None);
            }
            resolve_server(&entry.name, &config, defaults, options, env).map(Some)
        });
        match result {
            Ok(Some(server)) => resolved.push(server),
            Ok(None) => {}
            Err(error) if continue_on_error => skip_server(&entry.name, &error),
            Err(error) => return Err(error),
        }
    }
    Ok(resolved)
}

fn skip_server(name: &str, error: &Error) {
    tracing::warn!("server=<{name}>, error=<{error}> | MCP server config failed, skipping (continueOnError)");
}

pub(crate) fn clients_from(resolved: Vec<ResolvedServer>) -> Result<Vec<McpClient>> {
    let mut clients = Vec::new();
    for server in resolved {
        let continue_on_error = server.options.continue_on_error;
        let name = server.options.application_name.clone().unwrap_or_default();
        match server.into_client_config().and_then(McpClient::new) {
            Ok(client) => clients.push(client),
            Err(error) if continue_on_error => {
                tracing::warn!(
                    "server=<{name}>, error=<{error}> | MCP client config failed, skipping (continueOnError)"
                );
            }
            Err(error) => return Err(error),
        }
    }
    Ok(clients)
}

impl McpClient {
    /// Creates one client per enabled server of an `mcp.json`-style config.
    ///
    /// `defaults` apply to every client unless the entry overrides them; each client is named
    /// after its config key unless `defaults` names the application.
    ///
    /// ```
    /// use strands::mcp::{McpClient, McpClientOptions, McpLoadServersOptions, McpServerConfig};
    ///
    /// # tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
    /// let clients = McpClient::load_servers(
    ///     [("docs", McpServerConfig::builder().url("https://example.com/mcp").build())],
    ///     McpClientOptions::default(),
    ///     McpLoadServersOptions::default(),
    /// )
    /// .await?;
    /// assert_eq!(clients[0].client_name(), "docs");
    /// # Ok::<(), strands::Error>(())
    /// # });
    /// ```
    ///
    /// # Errors
    ///
    /// An unreadable or malformed file, a non-object entry, or an entry that fails to resolve
    /// (missing fields, an unset variable, an invalid regex or URL) unless `continue_on_error`
    /// applies to it.
    pub async fn load_servers(
        source: impl Into<McpServersSource>,
        defaults: McpClientOptions,
        options: McpLoadServersOptions,
    ) -> Result<Vec<Self>> {
        let resolved = resolve_server_configs(source.into(), &defaults, &options, &LoadEnv::process()).await?;
        clients_from(resolved)
    }
}
