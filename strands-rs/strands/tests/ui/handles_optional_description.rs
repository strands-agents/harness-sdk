use strands::{tool, tools};

#[tool]
async fn undocumented(value: String) -> String {
    value
}

/// Documented, but the override is empty.
#[tool(description = "")]
async fn blank_override(value: String) -> String {
    value
}

struct Inventory;

#[tools]
impl Inventory {
    #[tool]
    async fn check_stock(&self, sku: String) -> String {
        sku
    }
}

fn main() {}
