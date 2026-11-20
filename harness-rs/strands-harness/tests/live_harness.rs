//! Live harness end-to-end tests against real providers: `#[ignore]`, run through the project's
//! key wrapper:
//!
//! ```text
//! cargo test -p strands-harness --all-features --test live_harness -- --ignored live_
//! ```
//!
//! Each provider runs the same four scenarios through `create_harness` with a model string: a
//! built-in tool round trip (`write` then `read` in a temp dir), an MCP tool (the SDK's stdio
//! `mcp_test_server` through an inline `mcp_servers` map), an `interventions("ask")` interrupt
//! and resume, and a session resumed by a second `create_harness` with the same id and dir.
//! Each test skips with a message when its credentials are missing.

#![cfg(feature = "mcp")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stderr,
    reason = "live tests report failures by panicking and print skips"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::json;
use strands::mcp::McpServersSource;
use strands::{InterruptResponse, StopReason};
use strands_harness::{
    BuiltinToolName, HarnessAgentOptions, MemoryOption, SessionConfig, SessionOption, SkillsOption, create_harness,
};

fn has_env(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| !value.is_empty())
}

fn has_aws() -> bool {
    ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_CONTAINER_CREDENTIALS_FULL_URI"]
        .iter()
        .any(|name| has_env(name))
        || std::env::var("HOME").is_ok_and(|home| Path::new(&home).join(".aws").exists())
}

/// Whether the provider of `model` has credentials; prints a skip line when not.
fn credentials(model: &str) -> bool {
    let present = match model.split_once('/').map(|(provider, _)| provider) {
        Some("anthropic") => has_env("ANTHROPIC_API_KEY"),
        Some("openai") => has_env("OPENAI_API_KEY"),
        Some("bedrock-mantle") => has_aws() && (has_env("AWS_REGION") || has_env("AWS_DEFAULT_REGION")),
        _ => has_aws(),
    };
    if !present {
        eprintln!("skipping: no credentials for {model}");
    }
    present
}

fn options(model: &str) -> HarnessAgentOptions {
    HarnessAgentOptions {
        model: Some(model.into()),
        session: Some(SessionOption::Off),
        memory: Some(MemoryOption::Off),
        skills: Some(SkillsOption::Off),
        printer: Some(false),
        ..Default::default()
    }
}

/// The SDK's stdio MCP test server, built once with the `mcp` feature.
fn mcp_server() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| {
            let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            let output = Command::new(env!("CARGO"))
                .current_dir(workspace)
                .args([
                    "build",
                    "--quiet",
                    "-p",
                    "strands",
                    "--example",
                    "mcp_test_server",
                    "--no-default-features",
                    "--features",
                    "mcp",
                    "--message-format=json",
                ])
                .output()
                .unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                .filter(|message| message["target"]["name"] == "mcp_test_server")
                .find_map(|message| message["executable"].as_str().map(PathBuf::from))
                .unwrap()
        })
        .clone()
}

async fn builtin_tool_round_trip(model: &str) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("note.txt");
    let options = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Read, BuiltinToolName::Write].into()),
        ..options(model)
    };
    let mut agent = create_harness(options).await.unwrap();
    let prompt = format!(
        "Use the write tool to create the file {} containing exactly harness-live-ok, then use the read tool to read it back and reply with what it contains.",
        file.display()
    );
    let result = agent.invoke(prompt).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), "harness-live-ok");
    assert!(result.to_string().contains("harness-live-ok"), "{result}");
    agent.shutdown().await.unwrap();
}

async fn mcp_tool(model: &str) {
    let servers = json!({ "local": { "command": mcp_server().to_string_lossy() } });
    let options = HarnessAgentOptions {
        mcp_servers: Some(McpServersSource::Json(servers.as_object().unwrap().clone()).into()),
        builtin_tools: Some(Vec::new().into()),
        ..options(model)
    };
    let mut agent = create_harness(options).await.unwrap();
    let result = agent
        .invoke("Call the local_echo tool with value set to ping-4711 and reply with exactly what it returned.")
        .await
        .unwrap();
    let history = serde_json::to_string(agent.messages()).unwrap();
    assert!(history.contains("local_echo"), "{history}");
    assert!(result.to_string().contains("ping-4711"), "{result}");
    agent.shutdown().await.unwrap();
}

async fn interrupt_and_resume(model: &str) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("approved.txt");
    let options = HarnessAgentOptions {
        builtin_tools: Some([BuiltinToolName::Write].into()),
        interventions: Some("ask".into()),
        ..options(model)
    };
    let mut agent = create_harness(options).await.unwrap();
    let prompt = format!(
        "Use the write tool to create the file {} containing approved. Reply done when finished.",
        file.display()
    );
    let mut result = agent.invoke(prompt).await.unwrap();
    assert_eq!(result.stop_reason(), StopReason::Interrupt, "{result}");
    assert!(!file.exists());
    for _ in 0..3 {
        if result.stop_reason() != StopReason::Interrupt {
            break;
        }
        let answers: Vec<InterruptResponse> = result
            .interrupts()
            .iter()
            .map(|interrupt| InterruptResponse::new(interrupt.id.clone(), json!(true)))
            .collect();
        result = agent.invoke(answers).await.unwrap();
    }
    assert_ne!(result.stop_reason(), StopReason::Interrupt);
    assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), "approved");
    agent.shutdown().await.unwrap();
}

async fn session_resume(model: &str) {
    let dir = tempfile::tempdir().unwrap();
    let session = || -> SessionOption {
        SessionConfig::builder()
            .id("live-resume")
            .dir(dir.path().join(".agent/sessions"))
            .build()
            .into()
    };
    let first_options = HarnessAgentOptions {
        session: Some(session()),
        builtin_tools: Some(Vec::new().into()),
        ..options(model)
    };
    let mut first = create_harness(first_options).await.unwrap();
    first
        .invoke("Remember that the codeword is AZURE-42. Reply OK.")
        .await
        .unwrap();
    first.shutdown().await.unwrap();
    drop(first);

    let second_options = HarnessAgentOptions {
        session: Some(session()),
        builtin_tools: Some(Vec::new().into()),
        ..options(model)
    };
    let mut second = create_harness(second_options).await.unwrap();
    second.initialize().await.unwrap();
    assert!(!second.messages().is_empty());
    let result = second
        .invoke("What is the codeword? Reply with the codeword only.")
        .await
        .unwrap();
    assert!(result.to_string().contains("AZURE-42"), "{result}");
    second.shutdown().await.unwrap();
}

macro_rules! live_provider {
    ($provider:ident, $feature:literal, $model:literal) => {
        mod $provider {
            use super::*;

            #[cfg(feature = $feature)]
            #[tokio::test(flavor = "multi_thread")]
            #[ignore = "live: needs provider credentials"]
            async fn live_builtin_tool_round_trip() {
                if credentials($model) {
                    builtin_tool_round_trip($model).await;
                }
            }

            #[cfg(feature = $feature)]
            #[tokio::test(flavor = "multi_thread")]
            #[ignore = "live: needs provider credentials"]
            async fn live_mcp_tool() {
                if credentials($model) {
                    mcp_tool($model).await;
                }
            }

            #[cfg(feature = $feature)]
            #[tokio::test(flavor = "multi_thread")]
            #[ignore = "live: needs provider credentials"]
            async fn live_interrupt_and_resume() {
                if credentials($model) {
                    interrupt_and_resume($model).await;
                }
            }

            #[cfg(feature = $feature)]
            #[tokio::test(flavor = "multi_thread")]
            #[ignore = "live: needs provider credentials"]
            async fn live_session_resume() {
                if credentials($model) {
                    session_resume($model).await;
                }
            }
        }
    };
}

live_provider!(bedrock, "bedrock", "bedrock/global.anthropic.claude-opus-5");
live_provider!(anthropic, "anthropic", "anthropic/claude-opus-4-8");
live_provider!(openai, "openai", "openai/gpt-5.6-sol");
live_provider!(bedrock_mantle, "mantle", "bedrock-mantle/openai.gpt-5.6-luna");
