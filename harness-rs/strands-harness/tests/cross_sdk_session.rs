//! Harness sessions interoperate with harness-ts both ways on the same `.agent` directory: a
//! session TS `createHarness` wrote is resumed by Rust `create_harness`, and one Rust wrote is
//! resumed by TS. Ignored by default; run it with `--ignored` and `STRANDS_CONFORMANCE_TS=1`,
//! through `npx tsx harness-rs/conformance/session.ts` (needs the repo's `node_modules`).

#![allow(
    clippy::unwrap_used,
    clippy::print_stderr,
    reason = "a test that fails by panicking and prints skips"
)]

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};
use strands::experimental::context_manager::ContextManagerStrategy;
use strands::testing::{MockModel, MockTurn};
use strands::types::Role;
use strands_harness::{
    BuiltinToolsOption, HarnessAgentOptions, MemoryOption, SessionConfig, SkillsOption, create_harness,
};

fn enabled() -> bool {
    let on = std::env::var("STRANDS_CONFORMANCE_TS").is_ok_and(|value| value == "1");
    if !on {
        eprintln!("skipping: set STRANDS_CONFORMANCE_TS=1 to run the TS side");
    }
    on
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Runs `session.ts` and returns its stdout.
fn ts(args: &[&str]) -> String {
    let output = Command::new("npx")
        .current_dir(repo_root())
        .env("TSX_TSCONFIG_PATH", "harness-rs/conformance/tsconfig.json")
        .args(["tsx", "harness-rs/conformance/session.ts"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

fn options(dir: &Path, id: &str, reply: &str) -> HarnessAgentOptions {
    HarnessAgentOptions {
        model: Some(MockModel::new().with_turn(MockTurn::text(reply)).into()),
        session: Some(SessionConfig::builder().id(id).dir(dir).build().into()),
        builtin_tools: Some(BuiltinToolsOption::List(Vec::new())),
        builtin_plugins: Some(Vec::new()),
        memory: Some(MemoryOption::Off),
        skills: Some(SkillsOption::Off),
        context_manager: Some(ContextManagerStrategy::Disabled),
        printer: Some(false),
        ..Default::default()
    }
}

fn turns(agent: &strands::Agent) -> Value {
    let turns: Vec<Value> = agent
        .messages()
        .iter()
        .map(|message| {
            let role = if message.role == Role::User {
                "user"
            } else {
                "assistant"
            };
            json!({ "role": role, "text": message.text() })
        })
        .collect();
    Value::Array(turns)
}

#[tokio::test]
#[ignore = "needs STRANDS_CONFORMANCE_TS=1 and node_modules"]
async fn resumes_a_ts_session_in_rust_and_a_rust_session_in_ts() {
    if !enabled() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join(".agent/sessions");
    let dir = sessions.to_string_lossy().into_owned();

    ts(&["write", &dir, "from-ts", "Hello from TS"]);
    let mut agent = create_harness(options(&sessions, "from-ts", "Rust reply"))
        .await
        .unwrap();
    agent.initialize().await.unwrap();
    assert_eq!(
        turns(&agent),
        json!([{ "role": "user", "text": "Hello from TS" }, { "role": "assistant", "text": "reply to: Hello from TS" }])
    );
    agent.invoke("Hello from Rust").await.unwrap();
    agent.shutdown().await.unwrap();
    drop(agent);
    let restored: Value = serde_json::from_str(&ts(&["read", &dir, "from-ts"])).unwrap();
    assert_eq!(
        restored,
        json!([
            { "role": "user", "text": "Hello from TS" },
            { "role": "assistant", "text": "reply to: Hello from TS" },
            { "role": "user", "text": "Hello from Rust" },
            { "role": "assistant", "text": "Rust reply" },
        ])
    );

    let mut agent = create_harness(options(&sessions, "from-rust", "First Rust reply"))
        .await
        .unwrap();
    agent.invoke("Hello first from Rust").await.unwrap();
    agent.shutdown().await.unwrap();
    drop(agent);
    ts(&["write", &dir, "from-rust", "Then from TS"]);
    let mut agent = create_harness(options(&sessions, "from-rust", "unused")).await.unwrap();
    agent.initialize().await.unwrap();
    assert_eq!(
        turns(&agent),
        json!([
            { "role": "user", "text": "Hello first from Rust" },
            { "role": "assistant", "text": "First Rust reply" },
            { "role": "user", "text": "Then from TS" },
            { "role": "assistant", "text": "reply to: Then from TS" },
        ])
    );
    let entries: Vec<String> = std::fs::read_dir(&sessions)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries.len(), 2);
}
