//! Prompts and resources.

use serde_json::json;

use super::*;
use crate::mcp::{McpConnectionState, McpListOptions};

fn page(token: &str) -> McpListOptions {
    McpListOptions {
        pagination_token: Some(token.to_owned()),
    }
}

#[tokio::test]
async fn connects_lazily_and_lists_prompts_with_the_raw_result_returned() {
    let client = client(TestServer::new().paged(1));
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
    let result = client.list_prompts(McpListOptions::default()).await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Connected);
    let names: Vec<&str> = result.prompts.iter().map(|prompt| prompt.name.as_str()).collect();
    assert_eq!(names, ["greet", "farewell"]);
    assert!(result.next_cursor.is_none());
}

#[tokio::test]
async fn fetches_a_single_prompts_page_when_pagination_token_is_set() {
    let client = client(TestServer::new().paged(1));
    let result = client.list_prompts(page("0")).await.unwrap();
    assert_eq!(result.prompts.len(), 1);
    assert_eq!(result.prompts[0].name, "greet");
    assert_eq!(result.next_cursor.as_deref(), Some("1"));
}

#[tokio::test]
async fn gets_a_prompt_by_name_with_arguments() {
    let client = client(TestServer::new());
    let args = json!({"name": "Ada"}).as_object().cloned();
    let result = client.get_prompt("greet", args).await.unwrap();
    assert_eq!(
        serde_json::to_value(&result.messages).unwrap(),
        json!([{"role": "user", "content": {"type": "text", "text": "greet: hello Ada"}}])
    );
}

#[tokio::test]
async fn gets_a_prompt_by_name_without_arguments() {
    let client = client(TestServer::new());
    let result = client.get_prompt("greet", None).await.unwrap();
    assert_eq!(
        serde_json::to_value(&result.messages[0].content).unwrap(),
        json!({"type": "text", "text": "greet: hello world"})
    );
}

#[tokio::test]
async fn lists_resources_with_the_raw_result_returned() {
    let client = client(TestServer::new().paged(1));
    let result = client.list_resources(McpListOptions::default()).await.unwrap();
    let uris: Vec<&str> = result.resources.iter().map(|resource| resource.uri.as_str()).collect();
    assert_eq!(uris, ["file:///a.txt", "file:///b.txt"]);
}

#[tokio::test]
async fn fetches_a_single_resources_page_when_pagination_token_is_set() {
    let client = client(TestServer::new().paged(1));
    let result = client.list_resources(page("1")).await.unwrap();
    assert_eq!(result.resources.len(), 1);
    assert_eq!(result.resources[0].uri, "file:///b.txt");
    assert!(result.next_cursor.is_none());
}

#[tokio::test]
async fn reads_a_resource_by_string_uri() {
    let client = client(TestServer::new());
    let result = client.read_resource("file:///a.txt").await.unwrap();
    assert_eq!(
        serde_json::to_value(&result.contents).unwrap(),
        json!([{"uri": "file:///a.txt", "mimeType": "text/plain", "text": "contents of file:///a.txt"}])
    );
}

#[tokio::test]
async fn reads_a_resource_by_url_instance() {
    let client = client(TestServer::new());
    let uri = String::from("file:///b.txt");
    let result = client.read_resource(&uri).await.unwrap();
    assert_eq!(result.contents.len(), 1);
}

#[tokio::test]
async fn lists_resource_templates_with_pagination() {
    let client = client(TestServer::new());
    let result = client.list_resource_templates(McpListOptions::default()).await.unwrap();
    assert_eq!(result.resource_templates[0].uri_template, "file:///{path}");
}

#[tokio::test]
async fn throws_when_the_connection_previously_failed_under_continue_on_error() {
    let (transport, _) = failing_transport();
    let client = McpClient::new(McpClientConfig {
        transport: Some(transport),
        options: McpClientOptions {
            continue_on_error: true,
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap();
    let expected = "MCP server failed to connect. Call connect(true) to retry.";
    assert_eq!(
        client
            .list_prompts(McpListOptions::default())
            .await
            .unwrap_err()
            .to_string(),
        expected
    );
    assert_eq!(
        client.get_prompt("greet", None).await.unwrap_err().to_string(),
        expected
    );
    assert_eq!(
        client
            .list_resources(McpListOptions::default())
            .await
            .unwrap_err()
            .to_string(),
        expected
    );
    assert_eq!(
        client.read_resource("file:///a.txt").await.unwrap_err().to_string(),
        expected
    );
    assert_eq!(
        client
            .list_resource_templates(McpListOptions::default())
            .await
            .unwrap_err()
            .to_string(),
        expected
    );
}

#[tokio::test]
async fn lists_no_prompts_when_the_server_lacks_the_capability() {
    let client = client(TestServer::new().without_prompts());
    let result = client.list_prompts(McpListOptions::default()).await.unwrap();
    assert_eq!(serde_json::to_value(&result).unwrap(), json!({"prompts": []}));
}
