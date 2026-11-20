//! Streams an invocation: text as it arrives, tool calls and the final result.
//!
//! ```text
//! cargo run -p strands --example streaming
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use std::io::Write;

use futures::StreamExt;
use strands::{Agent, AgentStreamEvent, ToolError, tool};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// Add two numbers.
#[tool]
async fn add(
    /// The first number.
    a: f64,
    /// The second number.
    b: f64,
) -> Result<f64, ToolError> {
    Ok(a + b)
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let mut agent = Agent::builder().tools([Add]).printer(false).build()?;

    {
        let mut stream = agent.stream("What is 1234.5 plus 678.25? Use the tool.");
        while let Some(event) = stream.next().await {
            match event? {
                AgentStreamEvent::ModelStreamUpdate(update) => {
                    if let Some(text) = update.text_delta() {
                        print!("{text}");
                        let _ = std::io::stdout().flush();
                    }
                }
                AgentStreamEvent::BeforeToolCall(call) => println!("\n[calling {}]", call.tool_use.name),
                AgentStreamEvent::AgentResult(result) => println!("\n[done: {}]", result.stop_reason()),
                _ => {}
            }
        }
    }
    agent.shutdown().await
}
