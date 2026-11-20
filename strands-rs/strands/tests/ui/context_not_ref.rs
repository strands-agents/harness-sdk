use strands::{ToolContext, tool};

/// Owned context.
#[tool]
async fn owned_context(#[tool(context)] ctx: ToolContext) -> String {
    let _ = ctx;
    String::new()
}

fn main() {}
