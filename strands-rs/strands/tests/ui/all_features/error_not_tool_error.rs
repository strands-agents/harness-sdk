use strands::tool;

/// Integer errors convert into neither `ToolError` nor `BoxError`.
#[tool]
async fn get_weather() -> Result<String, u32> {
    Err(7)
}

fn main() {}
