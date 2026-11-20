//! Tools from functions with `#[tool]`, and from methods of a stateful type with `#[tools]`.
//!
//! ```text
//! cargo run -p strands --example tools
//! ```

#![allow(clippy::print_stdout, reason = "an example reports to the terminal")]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use strands::{Agent, ToolContext, ToolError, tool, tool_list, tools};

const AWS_HELP: &str = "This example calls Amazon Bedrock. Configure AWS credentials (for example \
`aws configure` or AWS_PROFILE) and a region where the default model is enabled (AWS_REGION, \
default us-west-2).";

/// Get the current weather for a city.
#[tool]
async fn get_weather(
    /// City name, for example "Seattle".
    city: String,
) -> Result<String, ToolError> {
    Ok(format!("Sunny and 21°C in {city}"))
}

/// A small inventory shared by its tools.
struct Inventory {
    stock: Mutex<HashMap<String, u32>>,
}

#[tools]
impl Inventory {
    /// Look up how many units of a product are in stock.
    #[tool]
    async fn check_stock(
        &self,
        /// The product's SKU, for example "kb-01".
        sku: String,
    ) -> Result<u32, ToolError> {
        let stock = self
            .stock
            .lock()
            .map_err(|_| ToolError::msg("inventory is unavailable"))?;
        stock
            .get(&sku)
            .copied()
            .ok_or_else(|| ToolError::msg(format!("unknown SKU {sku}")))
    }

    /// Reserve units of a product for the user's region.
    #[tool]
    async fn reserve(
        &self,
        #[tool(context)] context: &ToolContext,
        /// The product's SKU.
        sku: String,
        /// How many units to reserve.
        quantity: u32,
    ) -> Result<String, ToolError> {
        let region = context.agent().app_state().get::<String>("region")?.unwrap_or_default();
        let mut stock = self
            .stock
            .lock()
            .map_err(|_| ToolError::msg("inventory is unavailable"))?;
        let available = stock
            .get_mut(&sku)
            .ok_or_else(|| ToolError::msg(format!("unknown SKU {sku}")))?;
        if *available < quantity {
            return Err(ToolError::msg(format!("only {available} units of {sku} left")));
        }
        *available -= quantity;
        Ok(format!("reserved {quantity} x {sku} for {region}"))
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}\n\n{AWS_HELP}");
        std::process::exit(1);
    }
}

async fn run() -> strands::Result<()> {
    let inventory = Arc::new(Inventory {
        stock: Mutex::new(HashMap::from([("kb-01".to_owned(), 3), ("ms-02".to_owned(), 0)])),
    });
    let mut agent = Agent::builder()
        .tools(tool_list![GetWeather, inventory.tools()])
        .app_state(serde_json::Map::from_iter([("region".to_owned(), "eu-west".into())]))
        .printer(false)
        .build()?;

    let names: Vec<String> = agent.tools().iter().map(|tool| tool.name().to_owned()).collect();
    println!("tools: {names:?}");

    let result = agent
        .invoke("What's the weather in Lisbon? Then reserve two kb-01 keyboards if they are in stock.")
        .await?;
    println!("{result}");

    // Tools can also be called directly, without the model.
    let stock = agent
        .tool("check_stock")
        .invoke(serde_json::json!({"sku": "kb-01"}))
        .await?;
    println!("direct call: {:?}", stock.content);
    agent.shutdown().await
}
