//! The transports against localhost servers: streamable HTTP with headers, a token provider and
//! OAuth client credentials, and the legacy HTTP+SSE protocol, with transport resolution.

use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use crate::mcp::http::HttpAuth;
use crate::mcp::{
    McpAuthProvider, McpCallToolOptions, McpClientCredentials, McpConnectionState, StdioServerParameters,
};

/// A provider that always supplies the same token.
pub(super) struct StaticToken(pub(super) String);

#[crate::async_trait]
impl McpAuthProvider for StaticToken {
    async fn token(&self) -> Result<Option<String>, BoxError> {
        Ok(Some(self.0.clone()))
    }
}

async fn echo(client: &McpClient, value: &str) -> String {
    let tool = tool_named(client, "echo").await;
    let result = client
        .call_tool(&tool, json!({"value": value}), McpCallToolOptions::default())
        .await
        .unwrap();
    first_text(&result)
}

fn url_client(config: McpClientConfig) -> McpClient {
    McpClient::new(config).unwrap()
}

fn headers() -> BTreeMap<String, String> {
    BTreeMap::from([("X-Api-Key".to_owned(), "secret".to_owned())])
}

#[tokio::test]
async fn connects_over_streamable_http() {
    let http = serve_http(TestServer::new(), None).await;
    let client = url_client(McpClientConfig {
        url: Some(http.url("/mcp")),
        ..McpClientConfig::default()
    });
    assert_eq!(echo(&client, "over http").await, "over http");
    client.disconnect().await.unwrap();
}

#[tokio::test]
async fn passes_headers_as_request_init_to_transport() {
    let http = serve_http(TestServer::new(), None).await;
    let client = url_client(McpClientConfig {
        url: Some(http.url("/mcp")),
        headers: Some(headers()),
        ..McpClientConfig::default()
    });
    echo(&client, "hi").await;
    let keys = http.recorded.header("/mcp", "x-api-key");
    assert!(!keys.is_empty());
    assert!(keys.iter().all(|key| key.as_deref() == Some("secret")), "{keys:?}");
}

#[tokio::test]
async fn passes_custom_auth_provider_to_transport() {
    let http = serve_http(TestServer::new(), Some("provided")).await;
    let client = url_client(McpClientConfig {
        url: Some(http.url("/mcp")),
        auth_provider: Some(Arc::new(StaticToken("provided".to_owned()))),
        ..McpClientConfig::default()
    });
    assert_eq!(echo(&client, "authorized").await, "authorized");
}

#[tokio::test]
async fn passes_both_auth_and_headers_to_transport() {
    let http = serve_http(TestServer::new(), Some("provided")).await;
    let client = url_client(McpClientConfig {
        url: Some(http.url("/mcp")),
        auth_provider: Some(Arc::new(StaticToken("provided".to_owned()))),
        headers: Some(headers()),
        ..McpClientConfig::default()
    });
    echo(&client, "both").await;
    assert!(http.recorded.header("/mcp", "x-api-key").iter().all(Option::is_some));
    assert!(
        http.recorded
            .header("/mcp", "authorization")
            .iter()
            .all(|value| value.as_deref() == Some("Bearer provided"))
    );
}

#[tokio::test]
async fn fails_to_connect_without_the_required_token() {
    let http = serve_http(TestServer::new(), Some("provided")).await;
    let client = url_client(McpClientConfig {
        url: Some(http.url("/mcp")),
        ..McpClientConfig::default()
    });
    assert!(client.connect(false).await.is_err());
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
}

#[tokio::test]
async fn reacquires_a_client_credentials_token_after_it_expires() {
    let options = server::HttpOptions {
        bearer: Some("token-123".to_owned()),
        token_expires_in: 1,
        ..server::HttpOptions::default()
    };
    let http = server::serve_http_with(TestServer::new(), options).await;
    let client = credentials_client(&http.url("/mcp"), None);
    assert_eq!(echo(&client, "first").await, "first");
    let grants = token_requests(&http);
    assert_eq!(echo(&client, "second").await, "second");
    assert!(token_requests(&http) > grants, "{:?}", http.recorded.paths());
}

fn token_requests(http: &server::HttpServer) -> usize {
    http.recorded.paths().iter().filter(|path| *path == "/token").count()
}

fn credentials_client(url: &str, scopes: Option<Vec<String>>) -> McpClient {
    let credentials = McpClientCredentials {
        client_id: "client".to_owned(),
        client_secret: "secret".to_owned(),
        scopes,
        allow_private_addresses: false,
    };
    let auth = HttpAuth::Credentials(credentials);
    let transport = crate::mcp::http::streamable_http(url, &BTreeMap::new(), auth).unwrap();
    McpClient::with_transport(transport)
}

#[tokio::test]
async fn constructs_client_credentials_provider_when_auth_is_provided() {
    let http = serve_http(TestServer::new(), Some("token-123")).await;
    let client = credentials_client(&http.url("/mcp"), None);
    assert_eq!(echo(&client, "machine").await, "machine");
    assert!(http.recorded.paths().contains(&"/token".to_owned()));
}

#[tokio::test]
async fn passes_scopes_as_space_separated_string() {
    let http = serve_http(TestServer::new(), Some("token-123")).await;
    let client = credentials_client(&http.url("/mcp"), Some(vec!["read".to_owned(), "write".to_owned()]));
    assert_eq!(echo(&client, "scoped").await, "scoped");
}

#[tokio::test]
async fn connects_over_the_legacy_sse_transport() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::with_transport(McpTransport::sse(&http.url("/sse"), Some(headers())).unwrap());
    assert_eq!(echo(&client, "over sse").await, "over sse");
    assert_eq!(client.server_version().unwrap().name, "test-server");
    assert!(http.recorded.header("/sse", "x-api-key").iter().all(Option::is_some));
    assert!(
        http.recorded
            .header("/messages", "x-api-key")
            .iter()
            .all(|value| value.as_deref() == Some("secret"))
    );
}

#[tokio::test]
async fn reconnects_the_legacy_sse_transport_on_a_fresh_stream() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::with_transport(McpTransport::sse(&http.url("/sse"), None).unwrap());
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(echo(&client, "again").await, "again");
    assert_eq!(http.recorded.header("/sse", "accept").len(), 2);
}

#[tokio::test]
async fn reopens_an_ended_sse_stream_and_follows_the_new_endpoint() {
    let options = server::HttpOptions {
        sse_messages_per_stream: Some(1),
        ..server::HttpOptions::default()
    };
    let http = server::serve_http_with(TestServer::new(), options).await;
    let client = McpClient::with_transport(McpTransport::sse(&http.url("/sse"), None).unwrap());

    assert_eq!(echo(&client, "after reopening").await, "after reopening");

    let last_event_ids = http.recorded.header("/sse", "last-event-id");
    assert!(last_event_ids.len() >= 2, "{last_event_ids:?}");
    assert_eq!(last_event_ids[0], None);
    assert!(
        last_event_ids[1].as_deref().is_some_and(|id| id.ends_with(":1")),
        "{last_event_ids:?}"
    );
    assert!(http.recorded.paths().contains(&"/messages2".to_owned()));
}

#[tokio::test]
async fn sends_the_negotiated_protocol_version_on_sse_requests() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::with_transport(McpTransport::sse(&http.url("/sse"), None).unwrap());
    echo(&client, "versioned").await;
    let versions = http.recorded.header("/messages", "mcp-protocol-version");
    assert_eq!(versions[0], None, "the initialize request goes out before negotiation");
    assert!(
        versions[1..]
            .iter()
            .all(|version| version.as_deref() == Some("2025-11-25")),
        "{versions:?}"
    );
}

#[tokio::test]
async fn reports_a_failed_sse_stream() {
    let http = serve_http(TestServer::new(), None).await;
    let client = McpClient::with_transport(McpTransport::sse(&http.url("/missing"), None).unwrap());
    let error = client.connect(false).await.unwrap_err();
    assert_eq!(error.to_string(), "SSE error: Non-200 status code (404)");
}

#[tokio::test]
async fn fails_to_spawn_a_missing_stdio_command() {
    let client = McpClient::with_transport(McpTransport::stdio(StdioServerParameters::new(
        "strands-definitely-not-a-real-binary",
        Vec::<String>::new(),
    )));
    assert!(client.connect(false).await.is_err());
}
