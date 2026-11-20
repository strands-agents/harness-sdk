//! Human-in-the-loop approval: `HumanInTheLoop` asks on the terminal before tools that are not on
//! the allow list run, and the answer decides whether the call goes ahead.
//!
//! ```text
//! cargo run -p strands --example interventions
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use strands::vended_interventions::hitl::{HumanInTheLoop, HumanInTheLoopAsk, HumanInTheLoopConfig};
use strands::{Agent, ToolError, tool, tool_list};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// List the files in the workspace.
#[tool]
async fn list_files() -> Result<Vec<String>, ToolError> {
    Ok(vec!["notes.txt".to_owned(), "old-draft.txt".to_owned()])
}

/// Delete a file from the workspace.
#[tool]
async fn delete_file(
    /// The file's name.
    name: String,
) -> Result<String, ToolError> {
    Ok(format!("deleted {name}"))
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let approval = HumanInTheLoop::new(HumanInTheLoopConfig {
        allowed_tools: vec!["list_files".to_owned()],
        ask: Some(HumanInTheLoopAsk::Stdio),
        ..HumanInTheLoopConfig::default()
    });
    let mut agent = Agent::builder()
        .tools(tool_list![ListFiles, DeleteFile])
        .intervention(approval)
        .printer(false)
        .build()?;

    let result = agent
        .invoke("List the files, then delete any draft. Report what you did.")
        .await?;
    println!("{result}");
    agent.shutdown().await
}
