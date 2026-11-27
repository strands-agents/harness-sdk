//! MCP clients end to end: a stdio server process (the `mcp_test_server` example, built on
//! demand), servers from an `mcp.json` file, agents that take an `McpClient` in `.tools(..)`
//! (listing its tools and following list changes), and the stdio child's lifetime: it ends when
//! the last client handle is dropped.

#![cfg(feature = "mcp")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "tests report failures by panicking"
)]

#[path = "support/mcp_server.rs"]
mod mcp_server;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use mcp_server::{TestServer, serve_duplex};
use serde_json::json;
use strands::mcp::{
    McpCallToolOptions, McpClient, McpClientConfig, McpClientOptions, McpConnectionState, McpLoadServersOptions,
    McpProgress, McpProgressCallback, McpTransport, StdioServerParameters,
};
use strands::testing::{MockModel, MockTurn};
use strands::{Agent, BoxError, ContentBlock, Tool, ToolResultContent, ToolUseBlock};
use tokio::io::DuplexStream;

const SERVER_SOURCES: [&str; 3] = [
    "examples/mcp_test_server.rs",
    "tests/support/mcp_server.rs",
    "../../Cargo.lock",
];

/// The `mcp_test_server` example: the copy `cargo test` builds next to this test binary when it
/// is newer than its sources, otherwise built here with the features this test was built with.
fn server_binary() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| prebuilt_server().unwrap_or_else(build_server))
        .clone()
}

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|metadata| metadata.modified()).ok()
}

fn prebuilt_server() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let target = exe.parent()?.parent()?;
    let binary = target
        .join("examples")
        .join(format!("mcp_test_server{}", std::env::consts::EXE_SUFFIX));
    let built = modified(&binary)?;
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fresh = SERVER_SOURCES
        .iter()
        .all(|source| modified(&manifest.join(source)).is_some_and(|changed| changed <= built));
    fresh.then_some(binary)
}

fn build_server() -> PathBuf {
    let features: Vec<&str> = [
        ("bedrock", cfg!(feature = "bedrock")),
        ("anthropic", cfg!(feature = "anthropic")),
        ("openai", cfg!(feature = "openai")),
        ("mcp", true),
        ("otel", cfg!(feature = "otel")),
    ]
    .into_iter()
    .filter_map(|(feature, enabled)| enabled.then_some(feature))
    .collect();
    let output = Command::new(env!("CARGO"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "build",
            "--quiet",
            "--example",
            "mcp_test_server",
            "--message-format=json",
            "--no-default-features",
            "--features",
            &features.join(","),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "building mcp_test_server failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| message["target"]["name"] == "mcp_test_server")
        .find_map(|message| message["executable"].as_str().map(PathBuf::from))
        .unwrap()
}

fn stdio_client(env: Option<BTreeMap<String, String>>) -> McpClient {
    let params = StdioServerParameters {
        command: server_binary().to_string_lossy().into_owned(),
        args: Vec::new(),
        env,
        cwd: None,
    };
    McpClient::with_transport(McpTransport::stdio(params))
}

async fn call_text(client: &McpClient, name: &str, args: serde_json::Value) -> String {
    let tool = client
        .list_tools()
        .await
        .unwrap()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap();
    let result = client
        .call_tool(&tool, args, McpCallToolOptions::default())
        .await
        .unwrap();
    result["content"][0]["text"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn talks_to_a_stdio_server() {
    let client = stdio_client(None);
    assert_eq!(
        call_text(&client, "echo", json!({"value": "over stdio"})).await,
        "over stdio"
    );
    assert_eq!(client.server_version().unwrap().name, "test-server");
    client.disconnect().await.unwrap();
    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
}

#[tokio::test]
async fn reconnects_a_stdio_server_on_a_new_process() {
    let client = stdio_client(None);
    client.connect(false).await.unwrap();
    client.connect(true).await.unwrap();
    assert_eq!(call_text(&client, "echo", json!({"value": "again"})).await, "again");
}

#[tokio::test]
async fn passes_only_the_default_environment_and_the_configured_variables() {
    let env = BTreeMap::from([("STRANDS_MCP_TOKEN".to_owned(), "token123".to_owned())]);
    let client = stdio_client(Some(env));
    assert_eq!(
        call_text(&client, "env", json!({"name": "STRANDS_MCP_TOKEN"})).await,
        "token123"
    );
    assert_eq!(
        call_text(&client, "env", json!({"name": "CARGO_MANIFEST_DIR"})).await,
        "<unset>"
    );
    assert_ne!(call_text(&client, "env", json!({"name": "PATH"})).await, "<unset>");
}

#[tokio::test]
async fn loads_servers_from_a_config_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mcp.json");
    let config = json!({"mcpServers": {
        "local": {"command": server_binary(), "args": []},
        "off": {"command": "missing", "disabled": true}
    }});
    std::fs::write(&path, config.to_string()).unwrap();

    let clients = McpClient::load_servers(
        path,
        McpClientOptions::default(),
        McpLoadServersOptions {
            prefix_with_server_name: true,
        },
    )
    .await
    .unwrap();

    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].client_name(), "local");
    let names: Vec<String> = clients[0]
        .list_tools()
        .await
        .unwrap()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert!(names.contains(&"local_echo".to_owned()), "{names:?}");
}

fn duplex_client(server: TestServer, options: McpClientOptions) -> McpClient {
    let transport = McpTransport::from_fn(move || {
        let server = server.clone();
        async move { Ok::<DuplexStream, BoxError>(serve_duplex(server)) }
    });
    McpClient::new(McpClientConfig {
        transport: Some(transport),
        options,
        ..McpClientConfig::default()
    })
    .unwrap()
}

fn tool_use(name: &str, id: &str, input: serde_json::Value) -> MockTurn {
    MockTurn::content([ContentBlock::from(ToolUseBlock::new(name, id, input))])
}

fn last_tool_result(agent: &Agent) -> Vec<ToolResultContent> {
    agent
        .messages()
        .iter()
        .rev()
        .flat_map(|message| message.content.iter())
        .find_map(|block| match block {
            ContentBlock::ToolResult(result) => Some(result.content.clone()),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn an_agent_lists_mcp_tools_at_initialization_and_calls_them() {
    let client = duplex_client(
        TestServer::new(),
        McpClientOptions {
            prefix: Some("srv".to_owned()),
            ..McpClientOptions::default()
        },
    );
    let model = MockModel::new()
        .with_turn(tool_use("srv_echo", "t-1", json!({"value": "from the agent"})))
        .with_turn("done");
    let mut agent = Agent::builder()
        .model(model.clone())
        .tools([client.clone()])
        .printer(false)
        .build()
        .unwrap();
    assert!(agent.tool_registry().get("srv_echo").is_none());

    agent.invoke("echo something").await.unwrap();

    assert!(agent.tool_registry().get("srv_echo").is_some());
    assert_eq!(last_tool_result(&agent), [ToolResultContent::text("from the agent")]);
    let specs: Vec<String> = model.requests()[0]
        .tool_specs
        .iter()
        .map(|spec| spec.name.clone())
        .collect();
    assert!(specs.contains(&"srv_echo".to_owned()), "{specs:?}");
}

#[tokio::test]
async fn an_agent_mixes_mcp_clients_with_other_tools() {
    let client = duplex_client(TestServer::new(), McpClientOptions::default());
    let ping =
        strands::tools::FunctionTool::builder("ping", "Replies pong").callback(|_, _| async { Ok("pong".into()) });
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .tools(strands::tool_list![ping, vec![client]])
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
    assert!(agent.tool_registry().get("ping").is_some());
    assert!(agent.tool_registry().get("echo").is_some());
}

#[tokio::test]
async fn a_failed_client_under_continue_on_error_contributes_no_tools() {
    let transport = McpTransport::from_fn(|| async { Err::<DuplexStream, BoxError>("connection refused".into()) });
    let client = McpClient::new(McpClientConfig {
        transport: Some(transport),
        options: McpClientOptions {
            continue_on_error: true,
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap();
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .tools([client])
        .printer(false)
        .build()
        .unwrap();
    agent.invoke("hi").await.unwrap();
    assert!(agent.tool_registry().is_empty());
}

#[tokio::test]
async fn an_agent_fails_to_initialize_when_a_client_cannot_connect() {
    let transport = McpTransport::from_fn(|| async { Err::<DuplexStream, BoxError>("connection refused".into()) });
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .tools([McpClient::with_transport(transport)])
        .printer(false)
        .build()
        .unwrap();
    assert_eq!(agent.invoke("hi").await.unwrap_err().to_string(), "connection refused");
}

#[tokio::test]
async fn a_registry_rejects_an_mcp_client() {
    let client = duplex_client(TestServer::new(), McpClientOptions::default());
    let mut registry = strands::tools::ToolRegistry::new();
    let error = registry.add(client).unwrap_err();
    assert!(error.to_string().starts_with("An MCP client is not a tool"), "{error}");
}

#[tokio::test(start_paused = true)]
async fn an_agent_swaps_in_the_tools_of_a_list_change_before_the_next_model_call() {
    let server = TestServer::new();
    let client = duplex_client(server.clone(), McpClientOptions::default());
    let model = MockModel::new()
        .with_turn(tool_use("add_tool", "t-1", json!({"name": "late_tool"})))
        .with_turn("added")
        .with_turn("second");
    let mut agent = Agent::builder()
        .model(model.clone())
        .tools([client])
        .printer(false)
        .build()
        .unwrap();

    agent.invoke("add a tool").await.unwrap();
    assert!(agent.tool_registry().get("late_tool").is_none());
    tokio::time::sleep(Duration::from_millis(400)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    agent.invoke("again").await.unwrap();

    assert!(agent.tool_registry().get("late_tool").is_some());
    let last = model.requests().last().unwrap().clone();
    assert!(last.tool_specs.iter().any(|spec| spec.name == "late_tool"));
    assert!(agent.tool_registry().get("echo").is_some());
}

#[tokio::test]
async fn an_agent_retries_initialization_after_an_mcp_listing_fails() {
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = attempts.clone();
    let flaky = McpTransport::from_fn(move || {
        let first = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0;
        async move {
            if first {
                Err::<DuplexStream, BoxError>("connection refused".into())
            } else {
                Ok(serve_duplex(TestServer::with_tools(Vec::new())))
            }
        }
    });
    let steady = duplex_client(TestServer::new(), McpClientOptions::default());
    let mut agent = Agent::builder()
        .model(MockModel::new().with_turn("hi"))
        .tools([steady, McpClient::with_transport(flaky)])
        .printer(false)
        .build()
        .unwrap();

    assert!(agent.initialize().await.is_err());
    agent.initialize().await.unwrap();

    assert!(agent.tool_registry().get("echo").is_some());
}

/// A pid file for one test's stdio server, and the server wrapped in `/bin/sh` that writes it.
/// `None` where `/bin/sh` or `ps` is unavailable; the process tests skip there.
fn pid_tracked(dir: &tempfile::TempDir, append: bool) -> Option<(PathBuf, StdioServerParameters)> {
    let ps = Command::new("ps")
        .args(["-o", "stat=", "-p", &std::process::id().to_string()])
        .output();
    if !Path::new("/bin/sh").exists() || !ps.is_ok_and(|output| output.status.success()) {
        eprintln!("skipping: /bin/sh or ps is unavailable");
        return None;
    }
    let pidfile = dir.path().join("pid");
    let redirect = if append { ">>" } else { ">" };
    let params = StdioServerParameters {
        command: "/bin/sh".to_owned(),
        args: vec![
            "-c".to_owned(),
            format!(
                "echo $$ {redirect} '{}'; exec '{}'",
                pidfile.display(),
                server_binary().display()
            ),
        ],
        env: Some(BTreeMap::new()),
        cwd: None,
    };
    Some((pidfile, params))
}

fn read_pid(pidfile: &Path) -> String {
    std::fs::read_to_string(pidfile).unwrap().trim().to_owned()
}

/// The `ps` state of `pid`, empty once the process is gone and reaped.
fn process_state(pid: &str) -> String {
    let output = Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// Polls until `pid` is gone. Process exit and reaping happen in the OS, so this waits in real
/// time, bounded by a deadline.
async fn wait_gone(pid: &str) -> String {
    for _ in 0..100 {
        let state = process_state(pid);
        if state.is_empty() {
            return state;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    process_state(pid)
}

async fn tool(client: &McpClient, name: &str) -> strands::mcp::McpTool {
    client
        .list_tools()
        .await
        .unwrap()
        .into_iter()
        .find(|tool| tool.name() == name)
        .unwrap()
}

/// Calls `add_tool` and waits, in real time as the server is another process, past the 300 ms
/// list-changed debounce so the refresh has run.
async fn change_tools(client: &McpClient) -> strands::mcp::McpTool {
    let add = tool(client, "add_tool").await;
    client
        .call_tool(&add, json!({"name": "late"}), McpCallToolOptions::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    add
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_stdio_server_on_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    call_text(&client, "echo", json!({"value": "x"})).await;
    let pid = read_pid(&pidfile);
    assert!(!process_state(&pid).is_empty());

    client.disconnect().await.unwrap();

    assert_eq!(wait_gone(&pid).await, "", "pid {pid}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_stdio_server_when_the_last_client_handle_drops() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    call_text(&client, "echo", json!({"value": "x"})).await;
    let pid = read_pid(&pidfile);

    drop(client);

    assert_eq!(wait_gone(&pid).await, "", "pid {pid}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_previous_stdio_server_on_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    call_text(&client, "echo", json!({"value": "x"})).await;
    let first = read_pid(&pidfile);

    client.connect(true).await.unwrap();

    assert_eq!(wait_gone(&first).await, "", "old pid {first}");
    let second = read_pid(&pidfile);
    assert_ne!(first, second);
    drop(client);
    assert_eq!(wait_gone(&second).await, "", "new pid {second}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_stdio_server_when_an_agent_holding_a_tool_change_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([client.clone()])
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
    let pid = read_pid(&pidfile);
    let add = change_tools(&client).await;

    drop(agent);
    drop(add);
    drop(client);

    assert_eq!(wait_gone(&pid).await, "", "pid {pid}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ends_the_stdio_server_when_a_tool_change_arrives_after_the_agent_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    let mut agent = Agent::builder()
        .model(MockModel::new())
        .tools([client.clone()])
        .printer(false)
        .build()
        .unwrap();
    agent.initialize().await.unwrap();
    drop(agent);
    let pid = read_pid(&pidfile);
    let add = change_tools(&client).await;

    drop(add);
    drop(client);

    assert_eq!(wait_gone(&pid).await, "", "pid {pid}");
}

#[tokio::test(flavor = "multi_thread")]
async fn does_not_restart_the_stdio_server_for_a_list_change_after_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, false) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    let add = tool(&client, "add_tool").await;
    let first = read_pid(&pidfile);
    client
        .call_tool(&add, json!({"name": "late"}), McpCallToolOptions::default())
        .await
        .unwrap();

    client.disconnect().await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;

    assert_eq!(client.connection_state(), McpConnectionState::Disconnected);
    assert_eq!(read_pid(&pidfile), first);
}

#[tokio::test(flavor = "multi_thread")]
async fn spawns_one_stdio_server_for_concurrent_lazy_connects() {
    let dir = tempfile::tempdir().unwrap();
    let Some((pidfile, params)) = pid_tracked(&dir, true) else {
        return;
    };
    let client = McpClient::with_transport(McpTransport::stdio(params));
    let listings: Vec<_> = (0..16)
        .map(|_| {
            let client = client.clone();
            tokio::spawn(async move { client.list_tools().await.map(|tools| tools.len()) })
        })
        .collect();
    for listing in listings {
        listing.await.unwrap().unwrap();
    }

    let spawned = std::fs::read_to_string(&pidfile).unwrap().lines().count();
    client.disconnect().await.unwrap();
    assert_eq!(spawned, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn delivers_stdio_progress_in_order_before_the_call_returns() {
    let updates = Arc::new(Mutex::new(Vec::new()));
    let sink = updates.clone();
    let callback = McpProgressCallback::from(move |progress: McpProgress| sink.lock().unwrap().push(progress.progress));
    let client = McpClient::new(McpClientConfig {
        transport: Some(stdio_client_transport()),
        options: McpClientOptions {
            progress_callback: Some(callback),
            ..McpClientOptions::default()
        },
        ..McpClientConfig::default()
    })
    .unwrap();
    let slow = tool(&client, "slow").await;
    let expected: Vec<f64> = (1..=100).map(f64::from).collect();

    for _ in 0..50 {
        updates.lock().unwrap().clear();
        client
            .call_tool(
                &slow,
                json!({"steps": 100, "delay_ms": 0}),
                McpCallToolOptions::default(),
            )
            .await
            .unwrap();
        assert_eq!(*updates.lock().unwrap(), expected);
    }
    client.disconnect().await.unwrap();
}

fn stdio_client_transport() -> McpTransport {
    McpTransport::stdio(StdioServerParameters::new(
        server_binary().to_string_lossy().into_owned(),
        Vec::<String>::new(),
    ))
}
