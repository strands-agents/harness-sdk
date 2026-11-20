//! Elicitation: a server's `elicitation/create` request reaches the callback over a real
//! transport.

use rmcp::model::{ElicitRequestParams, ElicitResult, ElicitationAction};
use serde_json::json;

use super::*;
use crate::mcp::{ElicitationCallback, ElicitationContext, McpCallToolOptions};

type Seen = Arc<Mutex<Vec<(ElicitationContext, ElicitRequestParams)>>>;

fn answering(result: Result<ElicitResult, &'static str>) -> (Arc<dyn ElicitationCallback>, Seen) {
    let seen: Seen = Arc::default();
    let recorder = seen.clone();
    let callback: Arc<dyn ElicitationCallback> = Arc::new(move |context, params| {
        recorder.lock().unwrap().push((context, params));
        let result = result.clone().map_err(BoxError::from);
        async move { result }
    });
    (callback, seen)
}

fn elicit_client(callback: Option<Arc<dyn ElicitationCallback>>) -> McpClient {
    client_with(
        TestServer::new(),
        McpClientOptions {
            elicitation_callback: callback,
            ..McpClientOptions::default()
        },
    )
}

async fn ask(client: &McpClient, tool: &str) -> String {
    let tool = tool_named(client, tool).await;
    let result = client
        .call_tool(&tool, json!({}), McpCallToolOptions::default())
        .await
        .unwrap();
    first_text(&result)
}

#[tokio::test]
async fn registers_elicitation_handler_before_connecting_when_callback_is_provided() {
    let (callback, seen) = answering(Ok(ElicitResult::new(ElicitationAction::Decline)));
    let client = elicit_client(Some(callback));
    assert_eq!(ask(&client, "ask").await, r#"{"action":"decline"}"#);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn does_not_register_elicitation_handler_when_no_callback_is_provided() {
    let client = elicit_client(None);
    assert!(ask(&client, "ask").await.starts_with("elicitation failed:"));
}

#[tokio::test]
async fn passes_elicitation_capabilities_to_client_when_callback_is_provided() {
    let (callback, _) = answering(Ok(ElicitResult::new(ElicitationAction::Decline)));
    let client = elicit_client(Some(callback));
    let info: JsonValue = serde_json::from_str(&ask(&client, "client_info").await).unwrap();
    assert_eq!(info["capabilities"], json!({"elicitation": {"form": {}, "url": {}}}));
}

#[tokio::test]
async fn elicitation_handler_returns_accepted_result_with_content_and_exposes_the_abort_signal_at_mcp_req_signal() {
    let accepted = ElicitResult::new(ElicitationAction::Accept).with_content(json!({"username": "alice"}));
    let (callback, seen) = answering(Ok(accepted));
    let client = elicit_client(Some(callback));

    let answer = ask(&client, "ask").await;

    assert_eq!(answer, r#"{"action":"accept","content":{"username":"alice"}}"#);
    let seen = seen.lock().unwrap();
    let (context, params) = &seen[0];
    assert!(!context.cancel_signal().is_cancelled());
    assert!(context.request_id().is_number(), "{:?}", context.request_id());
    assert!(matches!(
        params,
        ElicitRequestParams::FormElicitationParams { message, .. } if message == "Your name?"
    ));
}

async fn returns_action(action: ElicitationAction, expected: &str) {
    let (callback, _) = answering(Ok(ElicitResult::new(action)));
    let client = elicit_client(Some(callback));
    assert_eq!(ask(&client, "ask").await, expected);
}

#[tokio::test]
async fn elicitation_handler_returns_decline_result() {
    returns_action(ElicitationAction::Decline, r#"{"action":"decline"}"#).await;
}

#[tokio::test]
async fn elicitation_handler_returns_cancel_result() {
    returns_action(ElicitationAction::Cancel, r#"{"action":"cancel"}"#).await;
}

#[tokio::test]
async fn elicitation_handler_works_for_url_mode_params() {
    let (callback, seen) = answering(Ok(ElicitResult::new(ElicitationAction::Accept)));
    let client = elicit_client(Some(callback));
    assert_eq!(ask(&client, "ask_url").await, r#"{"action":"accept"}"#);
    let seen = seen.lock().unwrap();
    assert!(matches!(
        &seen[0].1,
        ElicitRequestParams::UrlElicitationParams { url, elicitation_id, .. }
            if url == "https://example.com/authorize" && elicitation_id == "e-1"
    ));
}

#[tokio::test]
async fn elicitation_callback_errors_propagate() {
    let (callback, _) = answering(Err("User cancelled"));
    let client = elicit_client(Some(callback));
    let answer = ask(&client, "ask").await;
    assert!(answer.starts_with("elicitation failed:"), "{answer}");
    assert!(answer.contains("User cancelled"), "{answer}");
}
