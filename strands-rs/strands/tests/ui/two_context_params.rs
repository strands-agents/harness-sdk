use strands::{ToolContext, tool};

/// Two contexts.
#[tool]
async fn two_contexts(#[tool(context)] first: &ToolContext, #[tool(context)] second: &ToolContext) -> String {
    let _ = (first, second);
    String::new()
}

fn main() {}
