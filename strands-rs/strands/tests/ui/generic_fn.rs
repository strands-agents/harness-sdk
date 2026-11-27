use strands::tool;

/// Generic.
#[tool]
async fn generic<T: serde::de::DeserializeOwned>(value: T) -> String {
    let _ = value;
    String::new()
}

fn main() {}
