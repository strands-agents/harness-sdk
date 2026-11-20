use strands::tools;

struct Inventory;

#[tools]
impl Inventory {
    /// By value.
    #[tool]
    async fn by_value(self) -> u32 {
        1
    }

    /// Mutable.
    #[tool]
    async fn mutable(&mut self) -> u32 {
        2
    }

    /// No receiver.
    #[tool]
    async fn associated() -> u32 {
        3
    }
}

fn main() {}
