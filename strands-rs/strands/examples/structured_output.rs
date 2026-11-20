//! Structured output: the agent's final answer as a typed Rust value, validated against the
//! type's JSON schema.
//!
//! ```text
//! cargo run -p strands --example structured_output
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use schemars::JsonSchema;
use serde::Deserialize;
use strands::{Agent, InvokeOptions};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// A summary of a support thread.
#[derive(Deserialize, JsonSchema)]
struct Summary {
    /// A short title.
    title: String,
    /// The customer's sentiment: positive, neutral or negative.
    sentiment: String,
    /// The key points, one sentence each.
    points: Vec<String>,
}

const THREAD: &str = "Customer: My order arrived two days late and the box was damaged. \
Agent: Sorry about that, I've issued a refund for shipping. \
Customer: Thanks, that's fair. The keyboard itself works great.";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let mut agent = Agent::builder().printer(false).build()?;

    let summary: Summary = agent
        .invoke_with(
            format!("Summarize this support thread:\n{THREAD}"),
            InvokeOptions::default().structured_output_schema::<Summary>(),
        )
        .await?
        .structured_output()?;

    println!("{} ({})", summary.title, summary.sentiment);
    for point in &summary.points {
        println!("- {point}");
    }
    agent.shutdown().await
}
