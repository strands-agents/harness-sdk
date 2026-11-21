//! The OpenAI API, on the Responses API (the default) and on Chat Completions. The key comes from
//! `OPENAI_API_KEY`; `OPENAI_MODEL_ID` overrides the model.
//!
//! ```text
//! OPENAI_API_KEY=... cargo run -p strands --no-default-features --features openai --example openai
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::Agent;
use strands::models::openai::{OpenAIApi, OpenAIModel};

#[tokio::main]
async fn main() {
    let Ok(api_key) = std::env::var("OPENAI_API_KEY") else {
        eprintln!("Set OPENAI_API_KEY to an OpenAI API key to run this example.");
        std::process::exit(1);
    };
    if let Err(error) = run(api_key).await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run(api_key: String) -> strands::Result<()> {
    let model_id = std::env::var("OPENAI_MODEL_ID").unwrap_or_else(|_| "gpt-5.4-mini".to_owned());
    for api in [OpenAIApi::Responses, OpenAIApi::Chat] {
        let model = OpenAIModel::builder()
            .api(api)
            .model_id(model_id.clone())
            .api_key(api_key.clone())
            .build()?;
        let mut agent = Agent::builder().model(model).printer(false).build()?;
        let result = agent
            .invoke("Say hello in Portuguese, in three words or fewer.")
            .await?;
        println!("{api:?}: {result}");
        agent.shutdown().await?;
    }
    Ok(())
}
