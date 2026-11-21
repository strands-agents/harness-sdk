//! Progress and request options, over a real transport.

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::mcp::{McpCallToolOptions, McpProgress, McpProgressCallback};
use crate::test_support::record_logs;

fn recorder() -> (McpProgressCallback, Arc<Mutex<Vec<McpProgress>>>) {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink = updates.clone();
    let callback = McpProgressCallback::from(move |progress: McpProgress| sink.lock().unwrap().push(progress));
    (callback, updates)
}

fn progress(progress: f64, total: Option<f64>) -> McpProgress {
    McpProgress::new(progress, total, None)
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

async fn call(client: &McpClient, name: &str, args: JsonValue, options: McpCallToolOptions) -> JsonValue {
    let tool = tool_named(client, name).await;
    let result = client.call_tool(&tool, args, options).await.unwrap();
    settle().await;
    result
}

#[tokio::test(start_paused = true)]
async fn reset_timeout_on_progress_still_resets_the_request_timer_when_the_user_callback_owns_the_onprogress_slot() {
    let (callback, updates) = recorder();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
    );
    let options = McpCallToolOptions {
        timeout: Some(Duration::from_millis(1500)),
        ..McpCallToolOptions::default()
    };

    call(&client, "slow", json!({"steps": 5, "delay_ms": 200}), options).await;

    let expected: Vec<McpProgress> = (1..=5).map(|step| progress(f64::from(step), Some(5.0))).collect();
    assert_eq!(*updates.lock().unwrap(), expected);
}

#[tokio::test(start_paused = true)]
async fn times_out_a_call_without_progress() {
    let client = client(TestServer::new());
    let tool = tool_named(&client, "wait").await;
    let options = McpCallToolOptions {
        timeout: Some(Duration::from_millis(300)),
        ..McpCallToolOptions::default()
    };
    let error = client.call_tool(&tool, json!({}), options).await.unwrap_err();
    assert_eq!(error.to_string(), "Request timed out after 300ms");
}

#[tokio::test(start_paused = true)]
async fn sends_no_progress_token_when_no_callback_is_registered() {
    let client = client(TestServer::new());
    let result = call(&client, "slow", json!({"steps": 1}), McpCallToolOptions::default()).await;
    assert_eq!(first_text(&result), "done without token");
}

#[tokio::test]
async fn calls_the_tool_with_no_request_options_by_default() {
    let client = client(TestServer::new());
    let result = call(&client, "meta", json!({"op": "add"}), McpCallToolOptions::default()).await;
    let meta: JsonValue = serde_json::from_str(&first_text(&result)).unwrap();
    assert!(meta.get("progressToken").is_none(), "{meta}");
}

#[tokio::test(start_paused = true)]
async fn forwards_the_client_progress_callback_to_sdk_call_tool_and_delivers_progress_updates() {
    let (callback, updates) = recorder();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
    );
    call(
        &client,
        "slow",
        json!({"steps": 1, "message": "halfway"}),
        McpCallToolOptions::default(),
    )
    .await;
    assert_eq!(
        *updates.lock().unwrap(),
        [McpProgress::new(1.0, Some(1.0), Some("halfway".to_owned()))]
    );
}

#[tokio::test(start_paused = true)]
async fn per_call_progress_callback_takes_precedence_over_the_client_callback() {
    let (client_callback, client_updates) = recorder();
    let (call_callback, call_updates) = recorder();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(client_callback),
            ..McpClientOptions::default()
        },
    );
    let options = McpCallToolOptions {
        progress_callback: Some(call_callback),
        ..McpCallToolOptions::default()
    };
    call(&client, "slow", json!({"steps": 1, "no_total": true}), options).await;
    assert_eq!(*call_updates.lock().unwrap(), [progress(1.0, None)]);
    assert!(client_updates.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn delivers_progress_to_the_user_callback_when_a_call_timeout_is_also_set() {
    let (callback, updates) = recorder();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
    );
    let options = McpCallToolOptions {
        timeout: Some(Duration::from_secs(60)),
        ..McpCallToolOptions::default()
    };
    call(&client, "slow", json!({"steps": 2}), options).await;
    assert_eq!(
        *updates.lock().unwrap(),
        [progress(1.0, Some(2.0)), progress(2.0, Some(2.0))]
    );
}

async fn warns_when_the_callback_fails(callback: McpProgressCallback) {
    let (logs, _guard) = record_logs();
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
    );
    let result = call(&client, "slow", json!({"steps": 1}), McpCallToolOptions::default()).await;
    assert_eq!(first_text(&result), "done with token");
    assert!(logs.text().contains("progress callback failed"), "{}", logs.text());
}

#[tokio::test(start_paused = true)]
async fn logs_a_warning_when_the_progress_callback_throws() {
    warns_when_the_callback_fails(McpProgressCallback::new(|_| async { Err("boom".into()) })).await;
}

#[tokio::test(start_paused = true)]
async fn logs_a_warning_when_an_async_progress_callback_rejects() {
    warns_when_the_callback_fails(McpProgressCallback::new(|_| async {
        tokio::task::yield_now().await;
        Err("socket closed".into())
    }))
    .await;
}

#[tokio::test]
async fn forwards_abort_signal_to_sdk_call_tool() {
    let server = TestServer::new();
    let client = client(server.clone());
    let tool = tool_named(&client, "wait").await;
    let handle = CancelHandle::new();
    let options = McpCallToolOptions {
        cancel_signal: Some(handle.signal()),
        ..McpCallToolOptions::default()
    };
    let pending = {
        let client = client.clone();
        tokio::spawn(async move { client.call_tool(&tool, json!({}), options).await })
    };
    while server.calls().is_empty() {
        tokio::task::yield_now().await;
    }
    cancel(&handle, "stop waiting");
    assert_eq!(pending.await.unwrap().unwrap_err().to_string(), "stop waiting");
    while server.cancelled() == 0 {
        tokio::task::yield_now().await;
    }
    assert_eq!(server.cancelled(), 1);
}
