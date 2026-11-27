use strands::tool;

/// Borrowed input.
#[tool]
async fn borrowed(city: &str) -> String {
    city.to_owned()
}

fn main() {}
