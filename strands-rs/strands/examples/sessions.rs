//! Sessions: a `SessionManager` saves the conversation to a `LocalFileStorage` after every turn,
//! and a new agent with the same session id picks it up, as a process restart would.
//!
//! ```text
//! cargo run -p strands --example sessions
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use std::sync::Arc;

use strands::storage::{LocalFileStorage, Storage};
use strands::{Agent, SessionManager};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

const SESSION_ID: &str = "example-session";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

fn agent(storage: &Arc<dyn Storage>) -> strands::Result<Agent> {
    let session_manager = SessionManager::builder()
        .session_id(SESSION_ID)
        .storage(storage.clone())
        .build()?;
    Agent::builder()
        .system_prompt("You are a concise assistant.")
        .session_manager(session_manager)
        .printer(false)
        .build()
}

async fn run() -> strands::Result<()> {
    let dir = std::env::temp_dir().join("strands-sessions-example");
    let storage: Arc<dyn Storage> = Arc::new(LocalFileStorage::new(&dir));
    println!("sessions are stored under {}", dir.display());

    let mut first = agent(&storage)?;
    let reply = first.invoke("My favourite colour is teal. Please remember it.").await?;
    println!("first agent: {reply}");
    first.shutdown().await?;
    drop(first);

    let mut second = agent(&storage)?;
    let reply = second.invoke("What is my favourite colour?").await?;
    println!(
        "second agent ({} messages restored and added): {reply}",
        second.messages().len()
    );

    let keys = storage.list(&format!("session/{SESSION_ID}/")).await?;
    println!("stored keys: {keys:#?}");
    second.shutdown().await
}
