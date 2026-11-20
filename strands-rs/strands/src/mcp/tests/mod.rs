//! MCP client tests against local MCP servers: in-memory duplex streams, and streamable HTTP and
//! legacy SSE on localhost.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::io::DuplexStream;
use tokio::sync::Semaphore;

use super::{McpClient, McpClientConfig, McpClientOptions, McpTool, McpTransport};
use crate::cancel::{CancelHandle, CancelOptions, CancelSignal};
use crate::error::BoxError;
use crate::tools::Tool;
use crate::types::JsonValue;

#[path = "../../../tests/support/mcp_server.rs"]
pub(crate) mod server;

mod agent;
mod annotations;
mod client;
mod config;
mod elicitation;
mod lifecycle;
mod listing;
mod logging;
mod output_schema;
mod progress;
mod prompts;
mod tool;
mod tools_changed;
mod transports;

pub(super) use server::{PNG_BASE64, TestServer, serve_duplex, serve_http};

/// A transport that serves `server` over a fresh duplex stream on every connect, and counts the
/// connects.
pub(super) fn duplex_transport(server: TestServer) -> (McpTransport, Arc<AtomicUsize>) {
    let starts = Arc::new(AtomicUsize::new(0));
    let counter = starts.clone();
    let transport = McpTransport::from_fn(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        let server = server.clone();
        async move { Ok::<DuplexStream, BoxError>(serve_duplex(server)) }
    });
    (transport, starts)
}

pub(super) fn client_with(server: TestServer, options: McpClientOptions) -> McpClient {
    let (transport, _) = duplex_transport(server);
    McpClient::new(McpClientConfig {
        transport: Some(transport),
        options,
        ..McpClientConfig::default()
    })
    .unwrap()
}

pub(super) fn client(server: TestServer) -> McpClient {
    client_with(
        server,
        McpClientOptions {
            application_name: Some("TestApp".to_owned()),
            ..McpClientOptions::default()
        },
    )
}

/// A transport whose connects wait for a permit on the returned semaphore. Connect `n` fails
/// with `handshake failed` when `outcomes[n]` is `false`; later connects succeed.
pub(super) fn gated_transport(
    server: TestServer,
    outcomes: Vec<bool>,
) -> (McpTransport, Arc<Semaphore>, Arc<AtomicUsize>) {
    let gate = Arc::new(Semaphore::new(0));
    let starts = Arc::new(AtomicUsize::new(0));
    let outcomes = Arc::new(Mutex::new(VecDeque::from(outcomes)));
    let (factory_gate, counter) = (gate.clone(), starts.clone());
    let transport = McpTransport::from_fn(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        let (gate, server) = (factory_gate.clone(), server.clone());
        let succeed = outcomes.lock().unwrap().pop_front().unwrap_or(true);
        async move {
            gate.acquire().await.unwrap().forget();
            if succeed {
                Ok::<DuplexStream, BoxError>(serve_duplex(server))
            } else {
                Err("handshake failed".into())
            }
        }
    });
    (transport, gate, starts)
}

/// A transport whose connects fail with `connection refused`, and counts them.
pub(super) fn failing_transport() -> (McpTransport, Arc<AtomicUsize>) {
    let starts = Arc::new(AtomicUsize::new(0));
    let counter = starts.clone();
    let transport = McpTransport::from_fn(move || {
        counter.fetch_add(1, Ordering::SeqCst);
        async { Err::<DuplexStream, BoxError>("connection refused".into()) }
    });
    (transport, starts)
}

pub(super) fn names(tools: &[McpTool]) -> Vec<String> {
    tools.iter().map(|tool| tool.name().to_owned()).collect()
}

/// The text of the first content item of a raw `tools/call` result.
pub(super) fn first_text(result: &JsonValue) -> String {
    result["content"][0]["text"].as_str().unwrap_or_default().to_owned()
}

pub(super) fn cancelled(message: &str) -> (CancelHandle, CancelSignal) {
    let handle = CancelHandle::new();
    let signal = handle.signal();
    handle.cancel(CancelOptions {
        message: Some(message.to_owned()),
        ..CancelOptions::default()
    });
    (handle, signal)
}

pub(super) fn cancel(handle: &CancelHandle, message: &str) {
    handle.cancel(CancelOptions {
        message: Some(message.to_owned()),
        ..CancelOptions::default()
    });
}

pub(super) async fn tool_named(client: &McpClient, name: &str) -> McpTool {
    client
        .list_tools()
        .await
        .unwrap()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap()
}

pub(super) fn empty_args() -> JsonValue {
    json!({})
}
