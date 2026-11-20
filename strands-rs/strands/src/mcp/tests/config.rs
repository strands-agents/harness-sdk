//! Server configs, resolved against a substitute environment: the resolved transports, and tool
//! listing through an in-memory server with the resolved options.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde_json::json;

use super::*;
use crate::mcp::config::{LoadEnv, ResolvedServer, ResolvedTransport, clients_from, resolve_server_configs};
use crate::mcp::{
    McpLoadServersOptions, McpServerConfig, McpServersSource, StdioServerParameters, default_environment,
};
use crate::test_support::record_logs;
use crate::types::JsonObject;

struct Env(HashMap<&'static str, &'static str>);

impl Env {
    fn new(vars: &[(&'static str, &'static str)]) -> Self {
        Self(vars.iter().copied().collect())
    }
}

async fn resolve_with(
    source: impl Into<McpServersSource>,
    defaults: McpClientOptions,
    options: McpLoadServersOptions,
    env: &Env,
) -> crate::Result<Vec<ResolvedServer>> {
    let lookup = |key: &str| env.0.get(key).map(|value| (*value).to_owned());
    let load_env = LoadEnv {
        var: &lookup,
        home: Some(PathBuf::from("/home/user")),
    };
    resolve_server_configs(source.into(), &defaults, &options, &load_env).await
}

async fn resolve(source: impl Into<McpServersSource>) -> crate::Result<Vec<ResolvedServer>> {
    resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &Env::new(&[]),
    )
    .await
}

fn json_source(value: JsonValue) -> JsonObject {
    match value {
        JsonValue::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

fn stdio(server: &ResolvedServer) -> &StdioServerParameters {
    match &server.transport {
        ResolvedTransport::Stdio(params) => params,
        other => panic!("not stdio: {other:?}"),
    }
}

fn with_default_env(extra: &[(&str, &str)]) -> BTreeMap<String, String> {
    let mut env = default_environment();
    env.extend(
        extra
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned())),
    );
    env
}

fn names_of(servers: &[ResolvedServer]) -> Vec<String> {
    servers
        .iter()
        .map(|server| server.options.application_name.clone().unwrap_or_default())
        .collect()
}

async fn listed_names(server: ResolvedServer, tools: &[&str]) -> Vec<String> {
    let tools = tools
        .iter()
        .map(|name| rmcp::model::Tool::new_with_raw((*name).to_owned(), None, Arc::new(serde_json::Map::new())))
        .collect();
    let client = client_with(TestServer::with_tools(tools), server.options);
    names(&client.list_tools().await.unwrap())
}

fn error_text(result: crate::Result<Vec<ResolvedServer>>) -> String {
    match result {
        Ok(_) => panic!("expected an error"),
        Err(error) => error.to_string(),
    }
}

// describe('transport detection')

#[tokio::test]
async fn creates_stdio_client_transport_when_command_is_present() {
    let servers = resolve(json_source(
        json!({"my-server": {"command": "node", "args": ["server.js"]}}),
    ))
    .await
    .unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(*stdio(&servers[0]), StdioServerParameters::new("node", ["server.js"]));
}

#[tokio::test]
async fn creates_mcp_client_with_url_when_url_is_present() {
    let servers = resolve(json_source(
        json!({"remote-server": {"url": "https://example.com/mcp"}}),
    ))
    .await
    .unwrap();
    assert_eq!(
        servers[0].transport,
        ResolvedTransport::StreamableHttp {
            url: "https://example.com/mcp".to_owned(),
            headers: None,
            auth: None
        }
    );
    let clients = clients_from(servers).unwrap();
    assert!(format!("{:?}", clients[0]).contains("streamable-http"));
}

#[tokio::test]
async fn creates_sse_client_transport_when_transport_is_sse() {
    let servers = resolve(json_source(
        json!({"sse-server": {"url": "https://example.com/sse", "transport": "sse"}}),
    ))
    .await
    .unwrap();
    assert_eq!(
        servers[0].transport,
        ResolvedTransport::Sse {
            url: "https://example.com/sse".to_owned(),
            headers: None
        }
    );
    let clients = clients_from(servers).unwrap();
    assert!(format!("{:?}", clients[0]).contains("\"sse\""));
}

#[tokio::test]
async fn explicit_transport_overrides_auto_detection() {
    let servers = resolve(json_source(
        json!({"server": {"url": "https://example.com/mcp", "transport": "sse"}}),
    ))
    .await
    .unwrap();
    assert!(matches!(servers[0].transport, ResolvedTransport::Sse { .. }));
}

#[tokio::test]
async fn interpolates_auth_credentials_for_streamable_http() {
    let env = Env::new(&[("CLIENT_ID", "my-id"), ("CLIENT_SECRET", "my-secret")]);
    let source = json_source(json!({"server": {
        "url": "https://example.com/mcp",
        "auth": {"clientId": "${CLIENT_ID}", "clientSecret": "${CLIENT_SECRET}"}
    }}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    let ResolvedTransport::StreamableHttp { auth: Some(auth), .. } = &servers[0].transport else {
        panic!("no auth");
    };
    assert_eq!(
        (auth.client_id.as_str(), auth.client_secret.as_str()),
        ("my-id", "my-secret")
    );
    assert_eq!(clients_from(servers).unwrap().len(), 1);
}

#[tokio::test]
async fn throws_when_auth_credential_references_missing_env_var() {
    let source = json_source(json!({"server": {
        "url": "https://example.com/mcp",
        "auth": {"clientId": "${MISSING_ID}", "clientSecret": "literal"}
    }}));
    assert_eq!(
        error_text(resolve(source).await),
        "Environment variable \"MISSING_ID\" is not set"
    );
}

// describe('env interpolation')

#[tokio::test]
async fn interpolates_var_in_env_values() {
    let env = Env::new(&[("MY_SECRET", "secret123")]);
    let source = json_source(json!({"server": {"command": "node", "env": {"SECRET": "${MY_SECRET}"}}}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    assert_eq!(
        stdio(&servers[0]).env,
        Some(with_default_env(&[("SECRET", "secret123")]))
    );
}

#[tokio::test]
async fn interpolates_var_in_headers() {
    let env = Env::new(&[("API_TOKEN", "tok_abc")]);
    let source = json_source(json!({"server": {
        "url": "https://example.com/mcp",
        "headers": {"Authorization": "Bearer ${API_TOKEN}"}
    }}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    let ResolvedTransport::StreamableHttp { headers, .. } = &servers[0].transport else {
        panic!("not http");
    };
    assert_eq!(headers.as_ref().unwrap()["Authorization"], "Bearer tok_abc");
}

#[tokio::test]
async fn interpolates_var_in_url() {
    let env = Env::new(&[("MCP_HOST", "api.example.com")]);
    let source = json_source(json!({"server": {"url": "https://${MCP_HOST}/mcp"}}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    assert!(matches!(
        &servers[0].transport,
        ResolvedTransport::StreamableHttp { url, .. } if url == "https://api.example.com/mcp"
    ));
}

#[tokio::test]
async fn throws_when_env_var_is_not_set() {
    let source = json_source(json!({"server": {"command": "node", "env": {"VAL": "${NONEXISTENT_VAR}"}}}));
    assert_eq!(
        error_text(resolve(source).await),
        "Environment variable \"NONEXISTENT_VAR\" is not set"
    );
}

#[tokio::test]
async fn skips_server_with_missing_env_var_when_continue_on_error_is_true() {
    let (logs, _guard) = record_logs();
    let source = json_source(json!({
        "broken": {"command": "node", "env": {"VAL": "${NONEXISTENT_VAR}"}, "continueOnError": true},
        "working": {"command": "node"}
    }));
    let servers = resolve(source).await.unwrap();
    assert_eq!(names_of(&servers), ["working"]);
    assert!(logs.text().contains(
        "server=<broken>, error=<Environment variable \"NONEXISTENT_VAR\" is not set> | MCP server config failed, skipping (continueOnError)"
    ));
}

#[tokio::test]
async fn throws_on_a_non_object_entry_even_when_continue_on_error_is_true() {
    let defaults = McpClientOptions {
        continue_on_error: true,
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"bad": "oops"}));
    let error = error_text(resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[])).await);
    assert_eq!(error, "Server \"bad\" must be an object, got string");
}

#[tokio::test]
async fn interpolates_var_in_cwd() {
    let env = Env::new(&[("PROJECT_DIR", "/home/user/projects")]);
    let source = json_source(json!({"server": {"command": "node", "cwd": "${PROJECT_DIR}/my-server"}}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    assert_eq!(
        stdio(&servers[0]).cwd,
        Some(PathBuf::from("/home/user/projects/my-server"))
    );
}

#[tokio::test]
async fn merges_env_with_default_environment() {
    let source = json_source(json!({"server": {"command": "node", "env": {"CUSTOM": "value"}}}));
    let servers = resolve(source).await.unwrap();
    assert_eq!(stdio(&servers[0]).env, Some(with_default_env(&[("CUSTOM", "value")])));
}

// describe('file config loading')

fn write_config(dir: &tempfile::TempDir, name: &str, contents: &str) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, contents).unwrap();
    path
}

#[tokio::test]
async fn reads_and_parses_a_json_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        &dir,
        "config.json",
        &json!({"my-server": {"command": "node", "args": ["server.js"]}}).to_string(),
    );
    assert_eq!(resolve(path).await.unwrap().len(), 1);
}

#[tokio::test]
async fn extracts_mcp_servers_key_when_present() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        &dir,
        "config.json",
        &json!({"mcpServers": {"server-a": {"command": "node"}, "server-b": {"url": "https://example.com"}}})
            .to_string(),
    );
    let servers = resolve(path).await.unwrap();
    assert_eq!(servers.len(), 2);
    assert_eq!(
        *stdio(&servers[0]),
        StdioServerParameters::new("node", Vec::<String>::new())
    );
    assert!(matches!(servers[1].transport, ResolvedTransport::StreamableHttp { .. }));
}

#[tokio::test]
async fn uses_whole_object_when_mcp_servers_key_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(
        &dir,
        "config.json",
        &json!({"server-a": {"command": "node"}}).to_string(),
    );
    assert_eq!(resolve(path).await.unwrap().len(), 1);
}

#[tokio::test]
async fn expands_tilde_to_home_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("config")).unwrap();
    write_config(
        &dir,
        "config/mcp.json",
        &json!({"server": {"command": "node"}}).to_string(),
    );
    let lookup = |_: &str| None;
    let load_env = LoadEnv {
        var: &lookup,
        home: Some(dir.path().to_path_buf()),
    };
    let servers = resolve_server_configs(
        McpServersSource::from("~/config/mcp.json"),
        &McpClientOptions::default(),
        &McpLoadServersOptions::default(),
        &load_env,
    )
    .await
    .unwrap();
    assert_eq!(servers.len(), 1);
}

// describe('defaults and per-server overrides')

#[tokio::test]
async fn per_server_continue_on_error_overrides_defaults() {
    let defaults = McpClientOptions {
        continue_on_error: true,
        ..McpClientOptions::default()
    };
    let source = json_source(json!({
        "strict-server": {"command": "node", "continueOnError": false},
        "lenient-server": {"command": "node", "continueOnError": true}
    }));
    let servers = resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[]))
        .await
        .unwrap();
    assert!(!servers[0].options.continue_on_error);
    assert!(servers[1].options.continue_on_error);
}

#[tokio::test]
async fn applies_default_continue_on_error_when_server_does_not_override() {
    let defaults = McpClientOptions {
        continue_on_error: true,
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"server": {"command": "node"}}));
    let clients = clients_from(
        resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[]))
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(clients[0].continue_on_error());
}

#[tokio::test]
async fn compiles_config_filter_strings_as_regexes_and_preserves_prefix() {
    let source = json_source(json!({"server": {
        "command": "node",
        "prefix": "configured",
        "toolFilters": {"allowed": ["search_.*"], "rejected": ["^search_delete$"]}
    }}));
    let server = resolve(source).await.unwrap().remove(0);
    assert_eq!(
        listed_names(server, &["search_docs", "xsearch_docs", "search_delete"]).await,
        ["configured_search_docs"]
    );
}

#[tokio::test]
async fn interpolates_environment_variables_in_prefix_and_filter_patterns() {
    let env = Env::new(&[("MCP_PREFIX", "docs"), ("MCP_PATTERN", "search_.*")]);
    let source = json_source(json!({"server": {
        "command": "node",
        "prefix": "${MCP_PREFIX}",
        "toolFilters": {"allowed": ["${env:MCP_PATTERN}"]}
    }}));
    let server = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap()
    .remove(0);
    assert_eq!(
        listed_names(server, &["search_docs", "read_docs"]).await,
        ["docs_search_docs"]
    );
}

#[tokio::test]
async fn reports_and_optionally_skips_missing_environment_variables_in_new_config_fields() {
    let source = json_source(json!({"bad": {"command": "node", "prefix": "${NONEXISTENT_PREFIX}"}}));
    assert_eq!(
        error_text(resolve(source).await),
        "Environment variable \"NONEXISTENT_PREFIX\" is not set"
    );
    let source = json_source(json!({
        "bad": {"command": "node", "toolFilters": {"allowed": ["${NONEXISTENT_PATTERN}"]}, "continueOnError": true},
        "good": {"command": "node"}
    }));
    assert_eq!(names_of(&resolve(source).await.unwrap()), ["good"]);
}

#[tokio::test]
async fn preserves_explicit_empty_server_prefix_and_filters_over_defaults() {
    let defaults = McpClientOptions {
        prefix: Some("default".to_owned()),
        tool_filters: Some(crate::mcp::McpToolFilters {
            allowed: Some(Vec::new()),
            rejected: None,
        }),
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"server": {"command": "node", "prefix": "", "toolFilters": {}}}));
    let server = resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[]))
        .await
        .unwrap()
        .remove(0);
    assert_eq!(listed_names(server, &["echo"]).await, ["echo"]);
}

#[tokio::test]
async fn preserves_continue_on_error_while_applying_filter_and_prefix_defaults() {
    let defaults = McpClientOptions {
        prefix: Some("default".to_owned()),
        tool_filters: Some(crate::mcp::McpToolFilters {
            allowed: Some(vec!["echo".into()]),
            rejected: None,
        }),
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"server": {"command": "node", "continueOnError": true}}));
    let server = resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[]))
        .await
        .unwrap()
        .remove(0);
    assert!(server.options.continue_on_error);
    assert_eq!(listed_names(server, &["echo"]).await, ["default_echo"]);
}

fn by_server_name() -> McpLoadServersOptions {
    McpLoadServersOptions {
        prefix_with_server_name: true,
    }
}

#[tokio::test]
async fn prefixes_tools_with_the_server_name_when_prefix_with_server_name_is_set() {
    let source = json_source(json!({"slack": {"command": "node"}}));
    let server = resolve_with(source, McpClientOptions::default(), by_server_name(), &Env::new(&[]))
        .await
        .unwrap()
        .remove(0);
    assert_eq!(listed_names(server, &["search"]).await, ["slack_search"]);
}

#[tokio::test]
async fn replaces_unsupported_tool_name_characters_in_the_server_name_when_prefix_with_server_name_is_set() {
    let source = json_source(json!({"awslabs.aws-docs mcp/server": {"command": "node"}}));
    let server = resolve_with(source, McpClientOptions::default(), by_server_name(), &Env::new(&[]))
        .await
        .unwrap()
        .remove(0);
    assert_eq!(
        listed_names(server, &["search"]).await,
        ["awslabs_aws-docs_mcp_server_search"]
    );
}

#[tokio::test]
async fn prefers_the_server_name_over_a_default_prefix_when_prefix_with_server_name_is_set() {
    let defaults = McpClientOptions {
        prefix: Some("global".to_owned()),
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"slack": {"command": "node"}}));
    let server = resolve_with(source, defaults, by_server_name(), &Env::new(&[]))
        .await
        .unwrap()
        .remove(0);
    assert_eq!(listed_names(server, &["search"]).await, ["slack_search"]);
}

#[tokio::test]
async fn lets_an_explicit_server_prefix_win_over_prefix_with_server_name() {
    let source = json_source(json!({
        "slack": {"command": "node", "prefix": "chat.v2"},
        "chorus": {"command": "node", "prefix": ""}
    }));
    let mut servers = resolve_with(source, McpClientOptions::default(), by_server_name(), &Env::new(&[]))
        .await
        .unwrap();
    let chorus = servers.remove(1);
    let slack = servers.remove(0);
    assert_eq!(listed_names(slack, &["search"]).await, ["chat.v2_search"]);
    assert_eq!(listed_names(chorus, &["search"]).await, ["search"]);
}

#[tokio::test]
async fn uses_server_name_as_application_name_when_not_in_defaults() {
    let clients = clients_from(
        resolve(json_source(json!({"my-named-server": {"command": "node"}})))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(clients[0].client_name(), "my-named-server");
}

#[tokio::test]
async fn uses_defaults_application_name_over_server_name() {
    let defaults = McpClientOptions {
        application_name: Some("my-app".to_owned()),
        ..McpClientOptions::default()
    };
    let source = json_source(json!({"server": {"command": "node"}}));
    let clients = clients_from(
        resolve_with(source, defaults, McpLoadServersOptions::default(), &Env::new(&[]))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(clients[0].client_name(), "my-app");
}

// describe('error cases')

#[tokio::test]
async fn throws_a_contextual_syntax_error_for_an_invalid_config_regex() {
    let source = json_source(json!({"bad": {"command": "node", "toolFilters": {"allowed": ["([unclosed"]}}}));
    let error = error_text(resolve(source).await);
    assert!(
        error.starts_with("Server \"bad\": invalid regex in toolFilters.allowed: \"([unclosed\""),
        "{error}"
    );
}

#[tokio::test]
async fn skips_an_invalid_config_regex_when_continue_on_error_is_true() {
    let source = json_source(json!({
        "bad": {"command": "node", "toolFilters": {"rejected": ["([unclosed"]}, "continueOnError": true},
        "good": {"command": "node"}
    }));
    assert_eq!(names_of(&resolve(source).await.unwrap()), ["good"]);
}

#[tokio::test]
async fn throws_when_server_has_neither_command_nor_url() {
    assert_eq!(
        error_text(resolve(json_source(json!({"bad": {}}))).await),
        "Server config must include either \"command\" (stdio) or \"url\" (http)"
    );
}

#[tokio::test]
async fn throws_when_stdio_transport_specified_without_command() {
    assert_eq!(
        error_text(resolve(json_source(json!({"bad": {"transport": "stdio"}}))).await),
        "Stdio transport requires \"command\" field"
    );
}

#[tokio::test]
async fn throws_when_streamable_http_transport_specified_without_url() {
    assert_eq!(
        error_text(resolve(json_source(json!({"bad": {"transport": "streamable-http"}}))).await),
        "Streamable HTTP transport requires \"url\" field"
    );
}

#[tokio::test]
async fn throws_when_sse_transport_specified_without_url() {
    assert_eq!(
        error_text(resolve(json_source(json!({"bad": {"transport": "sse"}}))).await),
        "SSE transport requires \"url\" field"
    );
}

#[tokio::test]
async fn throws_on_invalid_file_path() {
    let error = error_text(resolve("/nonexistent/path.json").await);
    assert!(error.contains("No such file or directory"), "{error}");
}

#[tokio::test]
async fn throws_on_malformed_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, "bad.json", "not json{{{");
    assert!(resolve(path).await.is_err());
}

#[tokio::test]
async fn throws_when_auth_is_used_with_sse_transport() {
    let source = json_source(json!({"server": {
        "url": "https://example.com",
        "transport": "sse",
        "auth": {"clientId": "id", "clientSecret": "secret"}
    }}));
    assert!(error_text(resolve(source).await).starts_with("SSE transport does not support auth"));
}

#[tokio::test]
async fn throws_on_invalid_config_shape() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_config(&dir, "bad.json", "[1, 2, 3]");
    assert!(error_text(resolve(path).await).starts_with("MCP config must be a JSON object"));
}

#[tokio::test]
async fn throws_when_server_has_both_command_and_url_without_explicit_transport() {
    let source = json_source(json!({"bad": {"command": "node", "url": "https://example.com"}}));
    assert!(error_text(resolve(source).await).starts_with("Server config has both \"command\" and \"url\""));
}

// describe('disabled')

#[tokio::test]
async fn skips_disabled_servers() {
    let source = json_source(json!({
        "active": {"command": "node"},
        "inactive": {"command": "node", "disabled": true}
    }));
    assert_eq!(names_of(&resolve(source).await.unwrap()), ["active"]);
}

// describe('env interpolation syntax')

#[tokio::test]
async fn supports_env_var_namespaced_syntax() {
    let env = Env::new(&[("MY_TOKEN", "token123")]);
    let source = json_source(json!({"server": {"command": "node", "env": {"TOKEN": "${env:MY_TOKEN}"}}}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    assert_eq!(stdio(&servers[0]).env, Some(with_default_env(&[("TOKEN", "token123")])));
}

#[tokio::test]
async fn interpolates_var_in_command_and_args() {
    let env = Env::new(&[("MY_CMD", "/usr/local/bin/server"), ("MY_ARG", "3000")]);
    let source = json_source(json!({"server": {"command": "${MY_CMD}", "args": ["--port=${MY_ARG}"]}}));
    let servers = resolve_with(
        source,
        McpClientOptions::default(),
        McpLoadServersOptions::default(),
        &env,
    )
    .await
    .unwrap();
    assert_eq!(
        *stdio(&servers[0]),
        StdioServerParameters::new("/usr/local/bin/server", ["--port=3000"])
    );
}

// The typed and file sources.

#[tokio::test]
async fn loads_typed_server_configs() {
    let servers = vec![
        (
            "docs".to_owned(),
            McpServerConfig::builder().url("https://example.com/mcp").build(),
        ),
        (
            "off".to_owned(),
            McpServerConfig::builder().command("node").disabled(true).build(),
        ),
    ];
    let clients = McpClient::load_servers(servers, McpClientOptions::default(), McpLoadServersOptions::default())
        .await
        .unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].client_name(), "docs");
}

#[tokio::test]
async fn skips_a_client_that_fails_to_build_under_continue_on_error() {
    let (logs, _guard) = record_logs();
    let source = json_source(json!({
        "bad": {"url": "not a url", "continueOnError": true},
        "good": {"url": "https://example.com/mcp"}
    }));
    let clients = clients_from(resolve(source).await.unwrap()).unwrap();
    assert_eq!(clients.len(), 1);
    assert!(
        logs.text().contains("server=<bad>") && logs.text().contains("MCP client config failed, skipping"),
        "{}",
        logs.text()
    );
}

#[tokio::test]
async fn throws_on_an_unsupported_transport_type() {
    let source = json_source(json!({"bad": {"url": "http://127.0.0.1:1/mcp", "transport": "http"}}));
    assert_eq!(error_text(resolve(source).await), "Unsupported transport type: http");
}

#[tokio::test]
async fn skips_an_unsupported_transport_type_when_continue_on_error_is_true() {
    let source = json_source(json!({
        "bad": {"url": "http://127.0.0.1:1/mcp", "transport": "http", "continueOnError": true},
        "good": {"command": "node"}
    }));
    assert_eq!(names_of(&resolve(source).await.unwrap()), ["good"]);
}

#[tokio::test]
async fn reads_allow_private_addresses_from_auth() {
    let source = json_source(json!({"server": {
        "url": "https://example.com/mcp",
        "auth": {"clientId": "id", "clientSecret": "secret", "allowPrivateAddresses": true}
    }}));
    let servers = resolve(source).await.unwrap();
    let ResolvedTransport::StreamableHttp { auth: Some(auth), .. } = &servers[0].transport else {
        panic!("no auth");
    };
    assert!(auth.allow_private_addresses);
}

#[tokio::test]
async fn accepts_a_btree_map_of_servers() {
    let servers = BTreeMap::from([("local".to_owned(), McpServerConfig::builder().command("node").build())]);
    assert_eq!(names_of(&resolve(servers).await.unwrap()), ["local"]);
}
