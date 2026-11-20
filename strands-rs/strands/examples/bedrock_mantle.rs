//! Amazon Bedrock's OpenAI-compatible Mantle endpoint through `OpenAIModel`. The bearer token is
//! minted from the AWS default credential chain; `AWS_REGION` and `MANTLE_MODEL_ID` override the
//! region and model. Needs only the `openai` feature.
//!
//! ```text
//! cargo run -p strands --no-default-features --features openai --example bedrock_mantle
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::Agent;
use strands::models::openai::{BedrockMantleConfig, OpenAIModel, OpenAIModelOptions};

const AWS_HELP: &str = "This example calls Amazon Bedrock Mantle. Configure AWS credentials (for \
example `aws configure` or AWS_PROFILE), a region where Mantle serves the model (AWS_REGION, \
default us-east-1) and access to the model (MANTLE_MODEL_ID).";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let region = std::env::var("AWS_REGION").unwrap_or_else(|_| "us-east-1".to_owned());
    let model_id = std::env::var("MANTLE_MODEL_ID").unwrap_or_else(|_| "openai.gpt-oss-120b".to_owned());
    let model = OpenAIModel::bedrock_mantle(
        OpenAIModelOptions::builder().model_id(model_id).build_options(),
        BedrockMantleConfig::builder().region(region).build(),
    )?;

    let mut agent = Agent::builder().model(model).printer(false).build()?;
    let result = agent.invoke("Give one tip for writing readable Rust.").await?;
    println!("{result}");
    agent.shutdown().await
}
