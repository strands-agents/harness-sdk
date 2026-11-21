//! Tool annotations pass through a real transport.

use rmcp::model::ToolAnnotations;
use serde_json::json;

use super::*;

async fn listed_spec(annotations: Option<ToolAnnotations>) -> JsonValue {
    let tool = match annotations {
        Some(annotations) => server::annotated("echo", annotations),
        None => rmcp::model::Tool::new("echo", "Echoes input", Arc::new(serde_json::Map::new())),
    };
    let client = client(TestServer::with_tools(vec![tool]));
    let tools = client.list_tools().await.unwrap();
    serde_json::to_value(tools[0].tool_spec()).unwrap()
}

fn annotations(value: JsonValue) -> ToolAnnotations {
    serde_json::from_value(value).unwrap()
}

#[tokio::test]
async fn surfaces_known_annotation_keys_from_the_server() {
    let spec = listed_spec(Some(annotations(
        json!({"title": "Echo", "readOnlyHint": true, "openWorldHint": false}),
    )))
    .await;
    assert_eq!(
        spec["annotations"],
        json!({"title": "Echo", "readOnlyHint": true, "openWorldHint": false})
    );
}

#[tokio::test]
async fn preserves_explicitly_false_hints() {
    let spec = listed_spec(Some(annotations(
        json!({"readOnlyHint": false, "destructiveHint": false}),
    )))
    .await;
    assert_eq!(
        spec["annotations"],
        json!({"readOnlyHint": false, "destructiveHint": false})
    );
}

#[tokio::test]
async fn strips_unknown_annotation_keys_at_the_mcp_sdk_boundary() {
    let spec = listed_spec(Some(annotations(json!({"readOnlyHint": true, "futureSepKey": "x"})))).await;
    assert_eq!(spec["annotations"], json!({"readOnlyHint": true}));
}

#[tokio::test]
async fn omits_annotations_when_the_server_declares_none() {
    let spec = listed_spec(None).await;
    assert!(spec.get("annotations").is_none(), "{spec}");
}

#[tokio::test]
async fn surfaces_tool_annotations_in_the_tool_spec() {
    let spec = listed_spec(Some(annotations(json!({"title": "Get Weather", "readOnlyHint": true})))).await;
    assert_eq!(
        spec["annotations"],
        json!({"title": "Get Weather", "readOnlyHint": true})
    );
}

#[tokio::test]
async fn omits_annotations_from_the_tool_spec_when_the_server_provides_none() {
    assert!(listed_spec(None).await.get("annotations").is_none());
}

#[tokio::test]
async fn omits_annotations_from_the_tool_spec_when_the_server_provides_an_empty_annotations_object() {
    let spec = listed_spec(Some(ToolAnnotations::default())).await;
    assert!(spec.get("annotations").is_none(), "{spec}");
}
