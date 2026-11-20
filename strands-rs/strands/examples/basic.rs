//! An agent on the default model: Amazon Bedrock, with credentials and region from the AWS
//! default chain (environment, `~/.aws` profiles, SSO, instance roles).
//!
//! ```text
//! cargo run -p strands --example basic
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::Agent;

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let mut agent = Agent::builder().system_prompt("You are a concise assistant.").build()?;

    // The default printer streams the reply to stdout as it arrives.
    let result = agent.invoke("In one sentence, what is a model-driven agent?").await?;
    println!();

    if let Some(metrics) = result.metrics() {
        let usage = &metrics.accumulated_usage;
        println!(
            "stop reason: {}, tokens: {} in / {} out",
            result.stop_reason(),
            usage.input_tokens,
            usage.output_tokens
        );
    }
    agent.shutdown().await
}
