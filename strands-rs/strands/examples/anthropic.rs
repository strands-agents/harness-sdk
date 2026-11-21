//! The Anthropic API. The key comes from `ANTHROPIC_API_KEY`; `ANTHROPIC_MODEL_ID` overrides the
//! model.
//!
//! ```text
//! ANTHROPIC_API_KEY=... cargo run -p strands --no-default-features --features anthropic --example anthropic
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::Agent;
use strands::models::anthropic::AnthropicModel;

#[tokio::main]
async fn main() {
    let Ok(api_key) = std::env::var("ANTHROPIC_API_KEY") else {
        eprintln!("Set ANTHROPIC_API_KEY to an Anthropic API key to run this example.");
        std::process::exit(1);
    };
    if let Err(error) = run(api_key).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run(api_key: String) -> strands::Result<()> {
    let model_id = std::env::var("ANTHROPIC_MODEL_ID").unwrap_or_else(|_| "claude-sonnet-4-6".to_owned());
    let model = AnthropicModel::builder()
        .model_id(model_id)
        .max_tokens(1024)
        .api_key(api_key)
        .build()?;

    let mut agent = Agent::builder()
        .model(model)
        .system_prompt("You are a concise assistant.")
        .printer(false)
        .build()?;
    let result = agent
        .invoke("What does the borrow checker prevent? Two sentences.")
        .await?;
    println!("{result}");
    agent.shutdown().await
}
