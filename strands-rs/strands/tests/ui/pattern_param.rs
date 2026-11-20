use strands::tool;

/// Pattern.
#[tool]
async fn pattern((a, b): (u32, u32)) -> u32 {
    a + b
}

fn main() {}
