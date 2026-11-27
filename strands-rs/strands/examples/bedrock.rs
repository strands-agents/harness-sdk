//! Amazon Bedrock with an explicit model and settings. Credentials come from the AWS default
//! chain; `BEDROCK_MODEL_ID` and `AWS_REGION` override the model and region.
//!
//! ```text
//! cargo run -p strands --example bedrock
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::Agent;
use strands::models::Model;
use strands::models::bedrock::BedrockModel;

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE), a region (AWS_REGION) and access to the model (BEDROCK_MODEL_ID).";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let model_id =
        std::env::var("BEDROCK_MODEL_ID").unwrap_or_else(|_| "global.anthropic.claude-sonnet-4-6".to_owned());
    let model = BedrockModel::builder()
        .model_id(model_id)
        .max_tokens(1024)
        .temperature(0.3)
        .maybe_region(std::env::var("AWS_REGION").ok())
        .build();
    println!("model: {}", model.model_id().unwrap_or_default());

    let mut agent = Agent::builder().model(model).printer(false).build()?;
    let result = agent
        .invoke("Name three uses of a Rust `enum` in one line each.")
        .await?;
    println!("{result}");
    agent.shutdown().await
}
