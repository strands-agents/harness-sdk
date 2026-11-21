use strands::tool;

/// Impl trait.
#[tool]
async fn impl_trait(value: Vec<impl ToString>) -> String {
    value.iter().map(ToString::to_string).collect()
}

fn main() {}
