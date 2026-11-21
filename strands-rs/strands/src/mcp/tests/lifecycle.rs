//! The client lifecycle: dropping every handle frees the client even after a list change reached an agent, a pending
//! list-changed refresh does not outlive a disconnect or reconnect, and progress reaches the
//! callback complete and in order before `call_tool` returns.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::Agent;
use crate::mcp::{McpCallToolOptions, McpConnectionState, McpProgress, McpProgressCallback};
use crate::testing::MockModel;

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

/// Lets the 300 ms list-changed debounce fire and the refresh finish (paused time).
async fn past_debounce() {
    settle().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    settle().await;
}

async fn agent_with(client: &McpClient) -> Agent {
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([client.clone()])
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
    agent
}

async fn add_tool(client: &McpClient) -> McpTool {
    let add = tool_named(client, "add_tool").await;
    client
        .call_tool(&add, json!({"name": "late"}), McpCallToolOptions::default())
        .await
        .unwrap();
    add
}

#[tokio::test(start_paused = true)]
async fn frees_the_client_when_an_agent_holding_a_reported_tool_change_is_dropped() {
    let client = client(TestServer::new());
    let state = client.downgrade();
    let agent = agent_with(&client).await;
    let add = add_tool(&client).await;
    past_debounce().await;

    drop(agent);
    drop(add);
    drop(client);

    assert!(state.upgrade().is_none());
}

#[tokio::test(start_paused = true)]
async fn frees_the_client_when_a_tool_change_arrives_after_the_agent_is_dropped() {
    let client = client(TestServer::new());
    let state = client.downgrade();
    drop(agent_with(&client).await);
    let add = add_tool(&client).await;
    past_debounce().await;

    drop(add);
    drop(client);

    assert!(state.upgrade().is_none());
}

#[tokio::test(start_paused = true)]
async fn cancels_a_pending_list_changed_refresh_on_disconnect() {
    let server = TestServer::new();
    let (transport, starts) = duplex_transport(server.clone());
    let client = McpClient::with_transport(transport);
    add_tool(&client).await;

    client.disconnect().await.unwrap();
    past_debounce().await;

    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(server.lists(), 1);
}

#[tokio::test(start_paused = true)]
async fn cancels_a_pending_list_changed_refresh_on_reconnect() {
    let server = TestServer::new();
    let client = client(server.clone());
    add_tool(&client).await;

    client.connect(true).await.unwrap();
    past_debounce().await;

    assert_eq!(server.lists(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn delivers_every_progress_update_in_order_before_the_call_returns() {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink = updates.clone();
    let callback = McpProgressCallback::new(move |progress: McpProgress| {
        let sink = sink.clone();
        async move {
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            sink.lock().unwrap().push(progress.progress);
            Ok(())
        }
    });
    let client = client_with(
        TestServer::new(),
        McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
    );
    let slow = tool_named(&client, "slow").await;
    let expected: Vec<f64> = (1..=50).map(f64::from).collect();

    for _ in 0..40 {
        updates.lock().unwrap().clear();
        client
            .call_tool(
                &slow,
                json!({"steps": 50, "delay_ms": 0}),
                McpCallToolOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(*updates.lock().unwrap(), expected);
    }
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_progress_callbacks_before_the_call_returns() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let updates = Arc::new(Mutex::new(Vec::new()));
    let (sink, wait) = (updates.clone(), gate.clone());
    let callback = McpProgressCallback::new(move |progress: McpProgress| {
        let (sink, wait) = (sink.clone(), wait.clone());
        async move {
            if progress.progress >= 3.0 {
                wait.acquire().await?.forget();
            }
            sink.lock().unwrap().push(progress.progress);
            Ok(())
        }
    });
    let client = client(TestServer::new());
    let slow = tool_named(&client, "slow").await;
    let options = McpCallToolOptions {
        progress_callback: Some(callback),
        ..McpCallToolOptions::default()
    };
    let mut call = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .call_tool(&slow, json!({"steps": 3, "delay_ms": 0}), options)
                .await
        })
    };

    assert!(tokio::time::timeout(Duration::from_secs(5), &mut call).await.is_err());
    assert_eq!(*updates.lock().unwrap(), [1.0, 2.0]);
    gate.add_permits(1);
    call.await.unwrap().unwrap();
    assert_eq!(*updates.lock().unwrap(), [1.0, 2.0, 3.0]);
}
