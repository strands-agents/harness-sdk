use strands::tool;

struct Inventory;

impl Inventory {
    /// Needs `#[tools]`.
    #[tool]
    async fn check_stock(&self) -> u32 {
        1
    }
}

fn main() {}
