//! Hooks: observe and change the agent loop. A sync hook blocks a tool, an async hook audits
//! every tool call, and a hook type counts model calls across invocations.
//!
//! ```text
//! cargo run -p strands --example hooks
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use strands::hooks::{AfterInvocationEvent, BeforeModelCallEvent, BeforeToolCallEvent, Hook};
use strands::{Agent, BoxError, ToolError, async_trait, tool, tool_list};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// Read a file from the workspace.
#[tool]
async fn read_file(
    /// The file's path.
    path: String,
) -> Result<String, ToolError> {
    Ok(format!("contents of {path}: hello"))
}

/// Delete a file from the workspace.
#[tool]
async fn delete_file(
    /// The file's path.
    path: String,
) -> Result<String, ToolError> {
    Ok(format!("deleted {path}"))
}

/// Counts model calls.
struct ModelCallCounter(Arc<AtomicUsize>);

#[async_trait]
impl<'a> Hook<BeforeModelCallEvent<'a>> for ModelCallCounter {
    async fn handle(&self, _event: &mut BeforeModelCallEvent<'a>) -> Result<(), BoxError> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let mut agent = Agent::builder()
        .tools(tool_list![ReadFile, DeleteFile])
        .printer(false)
        .build()?;

    agent.add_hook(|event: &mut BeforeToolCallEvent| {
        if event.tool_use().name == "delete_file" {
            event.set_cancel("deleting files is disabled");
        }
    });
    agent.add_async_hook::<BeforeToolCallEvent>(|event| {
        Box::pin(async move {
            println!("[audit] {} {}", event.tool_use().name, event.tool_use().input);
        })
    });
    agent.add_hook(|event: &mut AfterInvocationEvent<'_>| {
        println!("[done] {} messages in history", event.agent().messages().len());
    });
    let model_calls = Arc::new(AtomicUsize::new(0));
    agent.add_hook_impl::<BeforeModelCallEvent<'_>>(ModelCallCounter(model_calls.clone()));

    let result = agent
        .invoke("Read notes.txt, then delete it. Tell me what happened.")
        .await?;
    println!("{result}");
    println!("model calls: {}", model_calls.load(Ordering::Relaxed));
    agent.shutdown().await
}
