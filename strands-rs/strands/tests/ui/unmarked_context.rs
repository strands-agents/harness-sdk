use strands::{ToolContext, tool};

/// Unmarked context.
#[tool]
async fn unmarked(ctx: &ToolContext) -> String {
    let _ = ctx;
    String::new()
}

fn main() {}
